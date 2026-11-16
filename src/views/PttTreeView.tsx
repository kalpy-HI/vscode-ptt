import React, { useState, useEffect, useCallback, type FC } from 'react';
import * as vscode from 'vscode';
import ReactTreeView, { TreeItem } from '@hackmd/react-vsc-treeview';
import store, { type ArticleListItem } from '../store';
import type { IPttClient, FavoriteBoardItem } from '../types';
import logger from '../logger';
import { isWebClient } from '../webClient';
import { LocalBoards } from '../localBoards';

export interface PttTreeViewProps {
  ptt: IPttClient;
  context: vscode.ExtensionContext;
  isLoggedIn: boolean;
  version?: number;
}

export const LOCAL_ID_PREFIX = 'local:';
const LOCAL_ID_PREFIX_RE = /^local:/;
const ROOT_IDS = new Set([
  'favorite-root',
  'custom-boards-root',
  'not-logged-in',
  'not-logged-in-guest',
  'no-boards',
  'local-boards-empty'
]);

export function getBoardNameFromItem(boardItem: unknown): string | undefined {
  if (!boardItem) {
    return undefined;
  }
  // Boards in 本地喜愛看板 may also appear under 我的最愛 / 熱門看板, so their tree ids
  // carry a prefix to stay unique.
  const stripLocal = (id: string) => id.replace(LOCAL_ID_PREFIX_RE, '');
  if (typeof boardItem === 'string') {
    boardItem = stripLocal(boardItem);
  }

  const ignoreLabels = new Set([
    '我的最愛',
    '熱門看板',
    '目前沒有熱門看板',
    '載入熱門看板中...',
    '其他看板',
    '本地喜愛看板',
    '尚未加入本地喜愛看板',
    '以帳號登入',
    '以訪客身分瀏覽',
    '尚未登入 PTT',
    '尚未訂閱任何看板',
    '載入更多文章',
    '已載入所有歷史文章',
    '我的最愛目前沒有看板',
    '看板尚無文章',
    '載入文章列表中...',
    '載入我的最愛中...'
  ]);

  if (typeof boardItem === 'string') {
    if (boardItem.startsWith('loadmore-')) {
      return boardItem.replace('loadmore-', '');
    }
    if (boardItem.startsWith('board-')) {
      return boardItem.replace('board-', '');
    }
    if (ROOT_IDS.has(boardItem) || ignoreLabels.has(boardItem)) {
      return undefined;
    }
    return boardItem;
  }
  const item = boardItem as Record<string, unknown>;
  if (typeof item.boardname === 'string' && item.boardname.trim().length > 0) {
    return item.boardname;
  }

  if (item.value && typeof item.value === 'object') {
    const val = item.value as Record<string, unknown>;
    if (typeof val.id === 'string') {
      const id = stripLocal(val.id);
      if (id.startsWith('loadmore-')) {
        return id.replace('loadmore-', '');
      }
      if (id.startsWith('board-')) {
        return id.replace('board-', '');
      }
      if (ROOT_IDS.has(id)) {
        return undefined;
      }
    }
    if (typeof val.boardname === 'string') {
      return val.boardname;
    }
    if (typeof val.label === 'string' && !ignoreLabels.has(val.label) && !val.label.startsWith('載入')) {
      return val.label;
    }
    if (val.label && typeof val.label === 'object' && 'label' in val.label) {
      const lbl = (val.label as { label: string }).label;
      if (!ignoreLabels.has(lbl) && !lbl.startsWith('載入')) {
        return lbl;
      }
    }
  }
  if (typeof item.id === 'string') {
    const id = stripLocal(item.id);
    if (id.startsWith('loadmore-')) {
      return id.replace('loadmore-', '');
    }
    if (id.startsWith('board-')) {
      return id.replace('board-', '');
    }
    if (ROOT_IDS.has(id)) {
      return undefined;
    }
  }
  if (typeof item.label === 'string' && !ignoreLabels.has(item.label) && !item.label.startsWith('載入')) {
    return item.label;
  }
  if (item.label && typeof item.label === 'object' && 'label' in item.label) {
    const lbl = (item.label as { label: string }).label;
    if (!ignoreLabels.has(lbl) && !lbl.startsWith('載入')) {
      return lbl;
    }
  }
  return undefined;
}

export const ArticleNode: FC<{
  article: ArticleListItem;
  boardName: string;
  idPrefix?: string;
}> = ({ article, boardName, idPrefix = '' }) => {
  const getIcon = () => {
    if (article.fixed) {
      return new vscode.ThemeIcon('pin');
    }
    if (article.push === '爆' || Number(article.push) >= 50) {
      return new vscode.ThemeIcon('flame');
    }
    if (article.push && Number(article.push) > 0) {
      return new vscode.ThemeIcon('comment');
    }
    return new vscode.ThemeIcon('file-text');
  };

  const lines = [
    article.title,
    `作者: ${article.author}`,
    `日期: ${article.date}`,
    `推文: ${article.push || '0'}`,
    article.status ? `狀態: ${article.status}` : '',
    `文章編號: ${article.sn}`
  ].filter(Boolean);
  const tooltip = lines.join('\n');

  const pushBadge = article.push ? `[${article.push}]` : '';
  const description = [pushBadge, article.author, article.date].filter(Boolean).join(' ');

  return (
    <TreeItem
      id={`${idPrefix}${boardName}-${article.sn}`}
      label={article.title}
      description={description}
      tooltip={tooltip}
      iconPath={getIcon()}
      contextValue="article"
      command={{
        command: 'kalpy.ptt.show-article',
        title: '開啟文章',
        arguments: [article.sn, boardName]
      }}
    />
  );
};

export const BoardNode: FC<{
  boardName: string;
  boardTitle?: string;
  ptt?: IPttClient;
  isLoggedIn?: boolean;
  version?: number;
  /** 'board' = 本地喜愛看板 (removable), 'remoteBoard' = 我的最愛 / 熱門看板 */
  contextValue?: 'board' | 'remoteBoard';
  idPrefix?: string;
}> = ({ boardName, boardTitle, contextValue = 'board', idPrefix = '' }) => {
  const articles = store.asList(boardName);
  const articleCount = articles.length;
  const description = articleCount > 0 ? `${articleCount} 篇` : boardTitle;
  const tooltip = boardTitle ? `${boardName} (${boardTitle})` : boardName;
  const oldestSn = store.lastSn(boardName);
  const hasReachedBeginning = oldestSn <= 1 && articleCount > 0;

  return (
    <TreeItem
      id={`${idPrefix}board-${boardName}`}
      label={boardName}
      description={description}
      tooltip={tooltip}
      iconPath={new vscode.ThemeIcon(contextValue === 'board' ? 'heart' : 'bookmark')}
      contextValue={contextValue}
    >
      {articleCount === 0 && (
        <TreeItem
          id={`${idPrefix}loading-${boardName}`}
          label="載入文章中..."
          iconPath={new vscode.ThemeIcon('loading~spin')}
          command={{
            command: 'kalpy.ptt.refresh-board',
            title: '載入文章',
            arguments: [boardName]
          }}
        />
      )}

      {articles.map(article => (
        <ArticleNode
          key={`${boardName}-${article.sn}`}
          article={article}
          boardName={boardName}
          idPrefix={idPrefix}
        />
      ))}

      {articleCount > 0 && !hasReachedBeginning && (
        <TreeItem
          id={`${idPrefix}loadmore-${boardName}`}
          label="載入更多文章"
          iconPath={new vscode.ThemeIcon('arrow-down')}
          contextValue="loadMore"
          command={{
            command: 'kalpy.ptt.load-more-article',
            title: '載入更多文章',
            arguments: [boardName]
          }}
        />
      )}

      {hasReachedBeginning && (
        <TreeItem
          id={`${idPrefix}end-${boardName}`}
          label="已載入所有歷史文章"
          iconPath={new vscode.ThemeIcon('check')}
        />
      )}
    </TreeItem>
  );
};

/**
 * Guest mode reads the web version, which has no personal favorites; the same tree node
 * then shows PTT's hot boards, so it must not be called 我的最愛.
 */
export function getFavoriteLabels(isGuest: boolean) {
  return isGuest
    ? {
        root: '熱門看板',
        description: '訪客模式',
        tooltip: 'PTT 網頁版的熱門看板（訪客沒有個人的我的最愛）',
        icon: 'flame',
        loading: '載入熱門看板中...',
        empty: '目前沒有熱門看板',
        error: '載入熱門看板失敗'
      }
    : {
        root: '我的最愛',
        description: undefined,
        tooltip: '你的 PTT 帳號的我的最愛',
        icon: 'star',
        loading: '載入我的最愛中...',
        empty: '我的最愛目前沒有看板',
        error: '載入我的最愛失敗'
      };
}

export const FavoriteNode: FC<{
  ptt: IPttClient;
  context: vscode.ExtensionContext;
  isLoggedIn: boolean;
  version?: number;
}> = ({ ptt, context, isLoggedIn, version }) => {
  const labels = getFavoriteLabels(isWebClient(ptt));
  const [favorites, setFavorites] = useState<FavoriteBoardItem[]>(() => {
    const inStore = store.getFavorites();
    if (inStore && inStore.length > 0) {
      return inStore;
    }
    const persisted = context?.globalState?.get<FavoriteBoardItem[]>('cachedFavorites');
    if (persisted && persisted.length > 0) {
      store.setFavorites(persisted);
      return persisted;
    }
    return [];
  });
  const [loading, setLoading] = useState(() => isLoggedIn && !store.hasFavorites());
  const [error, setError] = useState<string | null>(null);

  const fetchFavorites = useCallback(async (force = false) => {
    if (!isLoggedIn || !ptt?.state?.login) {
      return;
    }
    if (!force && store.hasFavorites()) {
      const cached = store.getFavorites();
      logger.log(`[Favorites] Using cached favorites (${cached.length} items)`);
      setFavorites(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    logger.log('[Favorites] Fetching live favorites from PTT...');
    try {
      const data = await ptt.getFavorite();
      const validFavorites = (data || []).filter(
        item => !item.divider && Boolean(item.boardname?.trim()) && /^[A-Za-z0-9_.-]+$/.test(item.boardname.trim())
      );
      logger.log(`[Favorites] Successfully loaded and cached ${validFavorites.length} favorite boards.`);
      store.setFavorites(validFavorites);
      context?.globalState?.update('cachedFavorites', validFavorites);
      setFavorites(validFavorites);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : labels.error;
      logger.error('[Favorites] Failed to load favorites:', message);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [ptt, isLoggedIn, context, labels.error]);

  useEffect(() => {
    if (isLoggedIn && ptt?.state?.login) {
      fetchFavorites(false);
    } else {
      setFavorites([]);
      setLoading(false);
    }
  }, [version, isLoggedIn, fetchFavorites]);

  return (
    <TreeItem
      id="favorite-root"
      label={labels.root}
      description={labels.description}
      tooltip={labels.tooltip}
      iconPath={new vscode.ThemeIcon(labels.icon)}
      contextValue="favoriteRoot"
    >
      {loading && (
        <TreeItem
          id="favorite-loading"
          label={labels.loading}
          iconPath={new vscode.ThemeIcon('loading~spin')}
        />
      )}

      {error && (
        <TreeItem
          id="favorite-error"
          label={`載入失敗: ${error}`}
          description="點擊重試"
          iconPath={new vscode.ThemeIcon('error')}
          command={{
            command: 'kalpy.ptt.refresh-article',
            title: '重新整理'
          }}
        />
      )}

      {!loading && !error && favorites.length === 0 && (
        <TreeItem
          id="favorite-empty"
          label={labels.empty}
          iconPath={new vscode.ThemeIcon('info')}
        />
      )}

      {!loading &&
        favorites.map(fav => (
          <BoardNode
            key={fav.boardname}
            boardName={fav.boardname}
            boardTitle={fav.title?.trim()}
            contextValue="remoteBoard"
            ptt={ptt}
            isLoggedIn={isLoggedIn}
            version={version}
          />
        ))}
    </TreeItem>
  );
};

export const LocalBoardsNode: FC<{
  ptt: IPttClient;
  context: vscode.ExtensionContext;
  isLoggedIn: boolean;
  version?: number;
}> = ({ ptt, context, isLoggedIn, version }) => {
  const [boardList, setBoardList] = useState<string[]>(() => new LocalBoards(context?.globalState).list());

  useEffect(() => {
    setBoardList(new LocalBoards(context?.globalState).list());
  }, [context, version]);

  const boards = [...boardList].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  return (
    <TreeItem
      id="custom-boards-root"
      label="本地喜愛看板"
      description={boards.length > 0 ? `${boards.length} 個 · 存在本機` : '存在本機'}
      tooltip="存在這台電腦的看板清單，訪客與帳號模式共用；登出、換帳號都不會清除，可匯出備份"
      iconPath={new vscode.ThemeIcon('heart')}
      contextValue="localBoardsRoot"
    >
      {boards.length === 0 && (
        <TreeItem
          id="local-boards-empty"
          label="尚未加入本地喜愛看板"
          description="點擊新增"
          iconPath={new vscode.ThemeIcon('add')}
          command={{ command: 'kalpy.ptt.add-board', title: '新增本地喜愛看板' }}
        />
      )}
      {boards.map(boardName => (
        <BoardNode
          key={`local-${boardName}`}
          boardName={boardName}
          ptt={ptt}
          isLoggedIn={isLoggedIn}
          version={version}
          contextValue="board"
          idPrefix={LOCAL_ID_PREFIX}
        />
      ))}
    </TreeItem>
  );
};

export const PttTreeView: FC<PttTreeViewProps> = ({ ptt, context, isLoggedIn, version }) => {
  if (!isLoggedIn) {
    return (
      <>
        <TreeItem
          id="not-logged-in"
          label="以帳號登入"
          description="登入 PTT 帳號"
          iconPath={new vscode.ThemeIcon('sign-in')}
          command="kalpy.ptt.login"
        />
        <TreeItem
          id="not-logged-in-guest"
          label="以訪客身分瀏覽"
          description="唯讀，免帳號"
          tooltip="不需要帳號，透過 PTT 網頁版瀏覽（只能看，不能推文或發文）"
          iconPath={new vscode.ThemeIcon('eye')}
          command="kalpy.ptt.login-guest"
        />
      </>
    );
  }

  return (
    <>
      <LocalBoardsNode
        ptt={ptt}
        context={context}
        isLoggedIn={isLoggedIn}
        version={version}
      />
      <FavoriteNode
        ptt={ptt}
        context={context}
        isLoggedIn={isLoggedIn}
        version={version}
      />
    </>
  );
};

export class PttTreeViewController {
  private treeView?: vscode.TreeView<unknown>;
  private version = 0;
  private didHookExpand = false;

  constructor(
    private ptt: IPttClient,
    private context: vscode.ExtensionContext,
    private getIsLoggedIn: () => boolean
  ) {}

  public setPtt(ptt: IPttClient) {
    this.ptt = ptt;
    this.refresh();
  }

  public render(): vscode.TreeView<unknown> {
    const isLoggedIn = this.getIsLoggedIn();
    this.treeView = ReactTreeView.render(
      <PttTreeView
        ptt={this.ptt}
        context={this.context}
        isLoggedIn={isLoggedIn}
        version={this.version}
      />,
      'kalpyPttTree'
    );

    const tv = this.treeView as vscode.TreeView<unknown> | undefined;
    if (tv && typeof tv.onDidExpandElement === 'function') {
      tv.onDidExpandElement(async (e: { element: unknown }) => {
        const boardName = getBoardNameFromItem(e.element);
        logger.log('[TreeView.onDidExpandElement] Node expanded:', {
          resolvedBoardName: boardName,
          rawElement: e.element
        });
        if (boardName && store.isEmpty(boardName)) {
          logger.log(`[AutoLoad] Board disclosure expanded: ${boardName}`);
          if (typeof vscode.window?.withProgress === 'function') {
            await vscode.window.withProgress({ location: { viewId: 'kalpyPttTree' } }, async () => {
              const articles = await this.ptt.getArticles(boardName);
              logger.log(`[AutoLoad] Loaded ${articles?.length || 0} articles for ${boardName}`);
              store.add(boardName, articles);
              this.refresh();
            });
          } else {
            const articles = await this.ptt.getArticles(boardName);
            store.add(boardName, articles);
            this.refresh();
          }
        }
      });
    }

    return this.treeView;
  }

  public refresh(): void {
    this.version += 1;
    this.render();
  }

  public getTreeView(): vscode.TreeView<unknown> | undefined {
    return this.treeView;
  }
}
