import * as vscode from 'vscode';
import WebSocket from 'ws';
import PTT, { keymap as key } from 'ptt-client';

(global as any).WebSocket = WebSocket;

import type { PttTreeDataProvider, Board } from './pttDataProvider';
import { PttTreeViewController, getBoardNameFromItem } from './views/PttTreeView';
import ContentProvider from './provider';
import PttHoverProvider from './hoverProvider';
import { LiveTracker } from './liveTracker';
import store, { type ArticleListItem } from './store';
import type { IPttClient, FavoriteBoardItem } from './types';
import logger from './logger';
import { WebPttClient, isWebClient } from './webClient';
import {
  LocalBoards,
  LOCAL_BOARDS_KEY,
  BOARD_NAME_PATTERN,
  normalizeBoardNames,
  parseLocalBoardsImport
} from './localBoards';
import { updateFromSource } from './selfUpdate';
import * as os from 'node:os';
import * as path from 'node:path';

export type { FavoriteBoardItem } from './types';

let ptt: IPttClient;
let ctx: vscode.ExtensionContext;
let pttProvider: PttTreeDataProvider | PttTreeViewController;
let pttViewController: PttTreeViewController;
let contentProvider: ContentProvider;
let liveTracker: LiveTracker;
// Last BBS (WebSocket) client, kept so leaving guest mode can reuse its connection
let bbsClient: IPttClient | undefined;

function intializePttClient (timeoutMs = 5000): Promise<IPttClient> {
  return new Promise(resolve => {
    const client = new PTT({ origin: 'https://term.ptt.cc' });
    const timer = setTimeout(() => {
      resolve(client);
    }, timeoutMs);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', () => {
      clearTimeout(timer);
      resolve(client);
    });
  });
}

let pttClientFactory = intializePttClient;
let webClientFactory: () => IPttClient = () => new WebPttClient();

export function setWebClientFactory (factory: () => IPttClient) {
  webClientFactory = factory;
}

export function isGuestMode (): boolean {
  return isWebClient(ptt);
}

export function setPttClientFactory (factory: (timeoutMs?: number) => Promise<IPttClient>) {
  pttClientFactory = factory;
}

export function updateLoginContext () {
  const loggedIn = checkLogin();
  vscode.commands.executeCommand('setContext', 'kalpyPtt:loggedIn', loggedIn);
  vscode.commands.executeCommand('setContext', 'kalpyPtt:guestMode', loggedIn && isWebClient(ptt));
}

export function refreshTreeView () {
  pttViewController?.refresh();
  (pttProvider as any)?.refresh?.();
}

export class PttQueue {
  private queue: Promise<unknown> = Promise.resolve();

  public run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => {}, () => {});
    return next;
  }
}

export const pttQueue = new PttQueue();

export function wrapPttWithQueue(client: IPttClient): IPttClient {
  if (!client || (client as any).__isQueued) {
    return client;
  }

  const asyncMethods = new Set([
    'getFavorite',
    'getArticles',
    'getArticle',
    'enterBoard',
    'login',
    'logout'
  ]);

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === '__isQueued') {
        return true;
      }
      const orig = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && asyncMethods.has(prop) && typeof orig === 'function') {
        return function (...args: unknown[]) {
          return pttQueue.run(() => orig.apply(target, args));
        };
      }
      return orig;
    }
  });
}

export function setPttClient (client: IPttClient) {
  const queuedClient = wrapPttWithQueue(client);
  if (client && !isWebClient(client)) {
    bbsClient = queuedClient;
  }
  ptt = queuedClient;
  (pttProvider as any)?.setPtt?.(queuedClient);
  pttViewController?.setPtt?.(queuedClient);
  contentProvider?.setPtt?.(queuedClient);
  contentProvider?.setEnsureLogin?.(async () => {
    if (!checkLogin()) {
      await login(true);
    }
    return checkLogin();
  });
  if (client?.on) {
    client.on('stateChange', () => {
      updateLoginContext();
    });
    client.on('disconnect', () => {
      liveTracker?.stopAll();
      updateLoginContext();
      refreshTreeView();
    });
  }
  updateLoginContext();
}

export function setExtensionContext (context: vscode.ExtensionContext) {
  ctx = context;
}

export function setPttProvider (provider: PttTreeDataProvider | PttTreeViewController) {
  pttProvider = provider;
}

export function setPttViewController (controller: PttTreeViewController) {
  pttViewController = controller;
}

export function setContentProvider (provider: ContentProvider) {
  contentProvider = provider;
}

export function setLiveTracker (tracker: LiveTracker) {
  liveTracker = tracker;
}

export function getLiveTracker (): LiveTracker {
  return liveTracker;
}

export function checkLogin () {
  return ptt?.state?.login ?? false;
}

let activeConnectPromise: Promise<boolean> | null = null;
let activeLoginPromise: Promise<boolean> | null = null;

export async function ensureConnectedPttClient (): Promise<boolean> {
  if (ptt?.state?.connect && !isWebClient(ptt)) {
    return true;
  }
  if (isWebClient(ptt) && bbsClient?.state?.connect) {
    ptt = bbsClient;
    (pttProvider as any)?.setPtt?.(bbsClient);
    pttViewController?.setPtt?.(bbsClient);
    contentProvider?.setPtt?.(bbsClient);
    updateLoginContext();
    return true;
  }
  if (activeConnectPromise) {
    return activeConnectPromise;
  }
  activeConnectPromise = (async () => {
    try {
      const newClient = await pttClientFactory();
      setPttClient(newClient);
      return Boolean(newClient?.state?.connect);
    } finally {
      activeConnectPromise = null;
    }
  })();
  return activeConnectPromise;
}

export async function getLoginCredential (silent = false, accountOnly = false): Promise<{ username?: string; password?: string }> {
  const isSilent = silent === true;
  let username = ctx?.globalState?.get<string>('username');
  const password = ctx?.globalState?.get<string>('password');

  // Older versions stored guest as a username; an explicit account login must ask instead
  if (accountOnly && username?.toLowerCase() === 'guest') {
    username = undefined;
  }

  const hasCredentials = Boolean(username && ((password !== undefined && password !== null) || username.toLowerCase() === 'guest'));

  if (hasCredentials || isSilent) {
    return { username, password: password ?? '' };
  }

  const inputUsername = await vscode.window.showInputBox({
    placeHolder: '帳號',
    prompt: '請輸入 PTT 登入帳號',
    value: username || ''
  });

  if (!inputUsername) {
    return {};
  }

  let inputPassword = '';
  if (inputUsername.toLowerCase() === 'guest') {
    inputPassword = '';
  } else {
    const enteredPassword = await vscode.window.showInputBox({
      placeHolder: '密碼',
      prompt: '請輸入 PTT 登入密碼',
      password: true
    });

    if (enteredPassword === undefined) {
      return {};
    }
    inputPassword = enteredPassword;
  }

  return { username: inputUsername, password: inputPassword };
}

export async function login (silent = false): Promise<boolean> {
  const isSilent = silent === true;
  if (checkLogin()) {
    return true;
  }

  if (activeLoginPromise) {
    const res = await activeLoginPromise;
    if (res || isSilent) {
      return res;
    }
  }

  activeLoginPromise = (async () => {
    try {
      return await performLogin(isSilent);
    } finally {
      activeLoginPromise = null;
    }
  })();

  return activeLoginPromise;
}

export const LOGIN_MODE_KEY = 'loginMode';
const FAVORITES_OWNER_KEY = 'favoritesOwner';

/** 我的最愛 / 熱門看板 are cached per identity; drop the cache when the identity changes. */
function clearFavoritesIfOwnerChanged (owner: string) {
  const normalized = owner.toLowerCase();
  const previous = ctx?.globalState?.get<string>(FAVORITES_OWNER_KEY)
    ?? (ctx?.globalState?.get<string>(LOGIN_MODE_KEY) === 'guest' ? 'guest' : ctx?.globalState?.get<string>('username'));
  if (previous && previous.toLowerCase() !== normalized) {
    store.clearFavorites();
    ctx.globalState.update('cachedFavorites', []);
  }
  ctx?.globalState?.update(FAVORITES_OWNER_KEY, normalized);
}

/** Ends the BBS session (if any) without touching saved credentials or local boards. */
async function logoutBbsSession () {
  if (!isWebClient(ptt) && checkLogin()) {
    await ptt.send(`${key.ArrowLeft.repeat(10)}${key.ArrowRight}y${key.Enter}`);
    if (ptt._state) {
      ptt._state.login = false;
    }
  }
}

/** `PTT: 以訪客身分瀏覽` — a separate entry point from account login. */
export async function loginAsGuestCommand (): Promise<boolean> {
  if (checkLogin() && isGuestMode()) {
    vscode.window.showInformationMessage('目前已是訪客模式');
    return true;
  }
  if (checkLogin()) {
    const username = ctx?.globalState?.get<string>('username') ?? '帳號';
    const answer = await vscode.window.showWarningMessage(
      `目前以 ${username} 登入。要切換到訪客模式嗎？`,
      { modal: true, detail: '帳號會登出，但帳密會保留，之後可以直接按「登入」切回帳號。本地喜愛看板兩邊共用。' },
      '切換到訪客模式'
    );
    if (answer !== '切換到訪客模式') {
      return false;
    }
    liveTracker?.stopAll();
    await logoutBbsSession();
  }
  return loginAsGuest(false);
}

/** `PTT: 登入` — always an account login, also used to leave guest mode. */
export async function loginWithAccountCommand (): Promise<boolean> {
  if (checkLogin() && !isGuestMode()) {
    return true;
  }
  if (!isGuestMode()) {
    return login(false);
  }
  const guestClient = ptt;
  const success = await performLogin(false, true);
  if (!success && isWebClient(guestClient) && !checkLogin()) {
    // Account login failed: stay in guest mode instead of ending up logged out
    setPttClient(guestClient);
    refreshTreeView();
  }
  return success;
}

/**
 * PTT rejects `guest` over the BBS interface ("請改用網頁版"), so guest mode switches to a
 * read-only client that scrapes https://www.ptt.cc instead.
 */
async function loginAsGuest (isSilent: boolean): Promise<boolean> {
  const webClient = webClientFactory();
  let success = false;
  try {
    success = Boolean(await webClient.login());
  } catch (err) {
    logger.error('[GuestLogin] Failed to reach www.ptt.cc:', err);
  }

  if (!success) {
    updateLoginContext();
    if (!isSilent) {
      vscode.window.showWarningMessage('無法連線至 PTT 網頁版 (www.ptt.cc)，請稍後再試。');
    }
    return false;
  }

  clearFavoritesIfOwnerChanged('guest');
  setPttClient(webClient);
  // Account credentials are kept so switching back to the account needs no re-typing
  ctx.globalState.update(LOGIN_MODE_KEY, 'guest');
  updateLoginContext();
  refreshTreeView();
  if (!isSilent) {
    vscode.window.showInformationMessage('以訪客身分登入（網頁版唯讀模式，側邊欄顯示「熱門看板」）');
  }
  return true;
}

async function performLogin (isSilent: boolean, accountOnly = false): Promise<boolean> {
  if (isSilent && ctx?.globalState?.get<string>(LOGIN_MODE_KEY) === 'guest') {
    return loginAsGuest(true);
  }

  let { username, password } = await getLoginCredential(isSilent, accountOnly);

  const isGuest = username?.toLowerCase() === 'guest';
  if (!username || (password === undefined && !isGuest)) {
    if (!isSilent) {
      vscode.window.showWarningMessage('需要帳密才能使用 VSCode PTT 噢！');
    }
    return false;
  }

  if (isGuest) {
    return loginAsGuest(isSilent);
  }

  // Ensure ptt client is connected
  const connected = await ensureConnectedPttClient();
  if (!connected) {
    if (!isSilent) {
      vscode.window.showWarningMessage('無法連線至 PTT 伺服器，請稍後再試。');
    }
    return false;
  }

  const attemptLogin = async (user: string, pass: string): Promise<boolean> => {
    try {
      const kick = Boolean(vscode.workspace.getConfiguration().get('kickLogin') ?? true);
      const loginPromise = ptt.login(user, pass ?? '', kick);
      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('Login timeout')), 15000)
      );
      await Promise.race([loginPromise, timeoutPromise]);
      return ptt.state?.login ?? false;
    } catch {
      return false;
    }
  };

  let success = await attemptLogin(username, password ?? '');

  // If login failed with stored credentials during manual login, prompt the user for new credentials
  if (!success && !isSilent) {
    const freshUsername = await vscode.window.showInputBox({
      placeHolder: '帳號',
      prompt: '登入失敗，請重新輸入 PTT 登入帳號',
      value: username || ''
    });

    if (freshUsername) {
      if (freshUsername.toLowerCase() === 'guest') {
        return loginAsGuest(isSilent);
      }
      let freshPassword = '';
      if (freshUsername.toLowerCase() !== 'guest') {
        const inputPass = await vscode.window.showInputBox({
          placeHolder: '密碼',
          prompt: '請輸入 PTT 登入密碼',
          password: true
        });
        if (inputPass !== undefined) {
          freshPassword = inputPass;
        } else {
          return false;
        }
      }
      username = freshUsername;
      password = freshPassword;
      success = await attemptLogin(username, password);
    }
  }

  if (success) {
    clearFavoritesIfOwnerChanged(username);
    ctx.globalState.update('username', username);
    ctx.globalState.update('password', password ?? '');
    ctx.globalState.update(LOGIN_MODE_KEY, 'account');
    updateLoginContext();
    refreshTreeView();
    if (!isSilent) {
      vscode.window.showInformationMessage(`以 ${username} 登入成功！`);
    }
    return true;
  }

  updateLoginContext();
  if (!isSilent) {
    vscode.window.showWarningMessage('登入失敗 QQ');
  }
  return false;
}

async function pickFavorite (): Promise<string | null> {
  await login();
  if (!checkLogin()) {
    return null;
  }

  const favorites: FavoriteBoardItem[] = await ptt.getFavorite();
  // TODO: exclude subscribed boards
  const favoriteItems: vscode.QuickPickItem[] = favorites.filter(f => !f.divider).map(fav => {
    return {
      label: fav.boardname,
      description: fav.title
    };
  });

  const board = await vscode.window.showQuickPick(favoriteItems, {
    placeHolder: isWebClient(ptt) ? '從熱門看板挑選要訂閱的看板（訪客模式）' : '從我的最愛挑選要訂閱的看板'
  });
  if (board){
    return board.label;
  }
  return null;
}

function setSearchCondition(type: string, criteria: string): void
{
  ptt.setSearchCondition(type, criteria);
}

export async function activate(context: vscode.ExtensionContext) {
  ctx = context;
  logger.init();
  logger.log('Extension activating...');

  const persistedFavorites = ctx.globalState.get<FavoriteBoardItem[]>('cachedFavorites');
  if (persistedFavorites && persistedFavorites.length > 0) {
    store.setFavorites(persistedFavorites);
    logger.log(`Loaded ${persistedFavorites.length} cached favorites from persistent state.`);
  }

  if (!ptt) {
    const initialClient = await intializePttClient();
    setPttClient(initialClient);
  }

  pttViewController = new PttTreeViewController(ptt, ctx, checkLogin);
  pttViewController.render();
  setPttProvider(pttViewController);

  contentProvider = new ContentProvider(ptt, async () => {
    if (!checkLogin()) {
      await login(true);
    }
    return checkLogin();
  });
  setContentProvider(contentProvider);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(ContentProvider.scheme, contentProvider, {
      isReadonly: true,
      isCaseSensitive: true
    })
  );

  const hoverProvider = new PttHoverProvider();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'ptt' }, { scheme: ContentProvider.scheme }],
      hoverProvider
    )
  );

  updateLoginContext();

  // 本地喜愛看板 follow the user to other machines through Settings Sync
  context.globalState.setKeysForSync?.([LOCAL_BOARDS_KEY]);
  const localBoards = new LocalBoards(context.globalState);

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.login', () => loginWithAccountCommand()));
  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.login-guest', () => loginAsGuestCommand()));
  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.logout', async () => {
    const res = await vscode.window.showInformationMessage(
      '你確定要登出嗎？會清除記住的帳密，本地喜愛看板會保留。',
      '好',
      '算了'
    );
    if (res === '好') {
      ctx.globalState.update('username', null);
      ctx.globalState.update('password', null);
      ctx.globalState.update(LOGIN_MODE_KEY, null);
      ctx.globalState.update(FAVORITES_OWNER_KEY, null);
      ctx.globalState.update('cachedFavorites', []);
      liveTracker?.stopAll();
      store.clearAll();
      refreshTreeView();

      if (isWebClient(ptt)) {
        await (ptt as WebPttClient).logout();
      } else {
        await logoutBbsSession();
      }
      updateLoginContext();

      vscode.window.showInformationMessage('已登出 PTT');
    }
  }));
	context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.add-board', async () => {
    await login();

    if (!checkLogin()) {
      return;
    }

    const rawName = await vscode.window.showInputBox({
      prompt: '輸入要加入本地喜愛看板的看板名稱',
      placeHolder: 'C_Chat',
      validateInput: value => (!value || BOARD_NAME_PATTERN.test(value.trim()) ? null : '看板名稱只能有英數字、底線、點與連字號')
    });

    const boardName = rawName?.trim();
    if (!boardName) {
      return;
    }
    if (localBoards.has(boardName)) {
      vscode.window.showInformationMessage(`${boardName} 已在本地喜愛看板`);
      return;
    }

    const checkBoard = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在檢查看板 ${boardName}...`
      },
      async () => ptt.enterBoard(boardName)
    );

    if (!checkBoard) {
      vscode.window.showInformationMessage("此看板不存在");
      return;
    }

    await localBoards.add([boardName]);
    refreshTreeView();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.add-to-local-boards', async (board: unknown) => {
    const boardname = typeof board === 'string' ? board : getBoardNameFromItem(board);
    if (!boardname) {
      return;
    }
    const added = await localBoards.add([boardname]);
    vscode.window.showInformationMessage(
      added.length > 0 ? `已加入本地喜愛看板：${boardname}` : `${boardname} 已在本地喜愛看板`
    );
    refreshTreeView();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.backup-favorites', async () => {
    if (!checkLogin()) {
      return;
    }
    const guest = isWebClient(ptt);
    let favorites = store.hasFavorites() ? store.getFavorites() : [];
    if (favorites.length === 0) {
      favorites = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: guest ? '正在讀取熱門看板...' : '正在讀取我的最愛...' },
        () => ptt.getFavorite()
      );
    }
    const names = normalizeBoardNames(favorites.filter(f => !f.divider && !f.folder).map(f => f.boardname));
    if (names.length === 0) {
      vscode.window.showInformationMessage(guest ? '目前沒有熱門看板可以加入' : '我的最愛目前沒有看板可以備份');
      return;
    }
    const source = guest ? '熱門看板' : '我的最愛';
    const answer = await vscode.window.showInformationMessage(
      `要把${source}的 ${names.length} 個看板全部加入本地喜愛看板嗎？`,
      { modal: true, detail: '已在本地喜愛看板的看板不會重複加入。' },
      '全部加入'
    );
    if (answer !== '全部加入') {
      return;
    }
    const added = await localBoards.add(names);
    vscode.window.showInformationMessage(`已從${source}加入 ${added.length} 個看板到本地喜愛看板（共 ${localBoards.list().length} 個）`);
    refreshTreeView();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.export-local-boards', async () => {
    const boards = localBoards.list();
    if (boards.length === 0) {
      vscode.window.showInformationMessage('本地喜愛看板是空的，沒有東西可以匯出');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'ptt-local-boards.json')),
      filters: { JSON: ['json'] },
      saveLabel: '匯出'
    });
    if (!target) {
      return;
    }
    const content = JSON.stringify(localBoards.toExport(), null, 2) + '\n';
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    vscode.window.showInformationMessage(`已匯出 ${boards.length} 個本地喜愛看板到 ${target.fsPath}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.import-local-boards', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { '看板清單': ['json', 'txt'] },
      openLabel: '匯入'
    });
    if (!picked || picked.length === 0) {
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      const names = parseLocalBoardsImport(new TextDecoder('utf-8').decode(bytes));
      if (names.length === 0) {
        vscode.window.showWarningMessage('檔案裡沒有找到看板名稱');
        return;
      }
      const added = await localBoards.add(names);
      vscode.window.showInformationMessage(`匯入完成：檔案有 ${names.length} 個看板，新增 ${added.length} 個`);
      refreshTreeView();
    } catch (err) {
      vscode.window.showErrorMessage(`匯入失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.update-from-source', () => updateFromSource(context)));
  context.subscriptions.push(vscode.commands.registerCommand(
    'kalpy.ptt.update-from-source-choose-folder',
    () => updateFromSource(context, { chooseFolder: true })
  ));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.show-article', async (sn, boardname) => {
    logger.log(`[ShowArticle] Opening /${boardname}/${sn}.ptt`);
    const uri = vscode.Uri.from({
      scheme: ContentProvider.scheme,
      path: `/${boardname}/${sn}.ptt`
    });
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在開啟文章 (${boardname} #${sn})...`
      },
      async () => {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
      }
    );
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.remove-board', async (board: Board | unknown) => {
    const boardname = getBoardNameFromItem(board);
    if (!boardname) {
      return;
    }
    await localBoards.remove(boardname);
    refreshTreeView();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.refresh-article', async () => {
    if (!checkLogin()) {
      return;
    }
    await vscode.window.withProgress({ location: { viewId: 'kalpyPttTree' } }, async () => {
      logger.log('[Refresh] Refreshing board list and favorites...');
      store.clearFavorites();
      ctx.globalState.update('cachedFavorites', []);
      ptt.resetSearchCondition();
      refreshTreeView();
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.refresh-board', async (board?: unknown) => {
    if (!checkLogin()) {
      return;
    }
    const specificBoard = typeof board === 'string' ? board : getBoardNameFromItem(board);
    if (specificBoard) {
      await vscode.window.withProgress({ location: { viewId: 'kalpyPttTree' } }, async () => {
        logger.log(`[RefreshBoard] Refreshing board: ${specificBoard}`);
        contentProvider?.clearCache(specificBoard);
        store.release(specificBoard);
        const articles = await ptt.getArticles(specificBoard);
        logger.log(`[RefreshBoard] Loaded ${articles?.length || 0} articles for ${specificBoard}`);
        store.add(specificBoard, articles);
        refreshTreeView();
      });
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.load-more-article', async (boardnameOrItem: string | unknown) => {
    const boardname = typeof boardnameOrItem === 'string'
      ? boardnameOrItem
      : getBoardNameFromItem(boardnameOrItem);

    logger.log('[LoadMore] Invoked with argument:', { raw: boardnameOrItem, resolvedBoard: boardname });
    if (!boardname) {
      logger.error('[LoadMore] Could not resolve board name from:', boardnameOrItem);
      return;
    }
    const lastSn = store.lastSn(boardname);
    logger.log(`[LoadMore] Current lastSn for ${boardname} is ${lastSn}`);

    if (lastSn <= 1 && !store.isEmpty(boardname)) {
      vscode.window.showInformationMessage('已載入此看板所有歷史文章');
      return;
    }

    await vscode.window.withProgress({ location: { viewId: 'kalpyPttTree' } }, async () => {
      const targetSn = lastSn > 0 ? Math.max(lastSn - 1, 1) : 0;
      logger.log(`[LoadMore] Fetching older articles for ${boardname} (target cursor SN: ${targetSn})...`);
      const articles = await ptt.getArticles(boardname, targetSn);
      logger.log(`[LoadMore] Received ${articles?.length || 0} older articles for ${boardname}`);

      if (articles?.length > 0) {
        store.add(boardname, articles);
        logger.log(`[LoadMore] Total articles now in store for ${boardname}: ${store.asList(boardname).length}`);
      }
      refreshTreeView();
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.release-board', async (board: Board | unknown) => {
    const boardname = getBoardNameFromItem(board);
    if (!boardname) {
      return;
    }
    contentProvider?.clearCache(boardname);
    store.release(boardname);
    refreshTreeView();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kalpy.ptt.search-board-by-push', async (board: Board | unknown) => {
    const boardname = getBoardNameFromItem(board);
    if (!boardname) {
      return;
    }
    let push = await vscode.window.showInputBox({
      prompt: '輸入推文數',
      placeHolder: '0 ~ 100'
    });

    if (Number(push) > 100) {
      push = '100';
    }

    if (!store.isEmpty(boardname)) {
      store.release(boardname);
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在以推文數 ${push} 搜尋看板 ${boardname}...`
      },
      async () => {
        setSearchCondition("push", push);
        const pushArticles: ArticleListItem[] = await ptt.getArticles(boardname);
        store.add(boardname, pushArticles);
        refreshTreeView();
      }
    );
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('kalpy.ptt.favorite-board', async () => {
      const boardName = await pickFavorite();
      if (!boardName) {
        return;
      }
      await localBoards.add([boardName]);
      refreshTreeView();
    })
  );

  liveTracker = new LiveTracker(contentProvider, checkLogin);
  context.subscriptions.push(liveTracker);

  context.subscriptions.push(
    vscode.commands.registerCommand('kalpy.ptt.toggle-live-tracking', async (uri) => liveTracker.toggle(uri))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('kalpy.ptt.start-live-tracking', async (uri) => liveTracker.startTracking(uri))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('kalpy.ptt.stop-live-tracking', (uri) => liveTracker.stopTracking(uri))
  );

  await login(true);
}

// this method is called when your extension is deactivated
export function deactivate() {
  liveTracker?.dispose();
}
