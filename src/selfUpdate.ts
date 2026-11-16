import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/**
 * `PTT: 從原始碼更新擴充功能` — rebuild the fork from a local checkout and install the
 * resulting .vsix through VS Code itself (same mechanism as "Install from VSIX…"), so the
 * running window's extension list is updated correctly.
 */

export const SOURCE_FOLDER_KEY = 'selfUpdate.sourceFolder';
export const VSIX_NAME = 'vscode-ptt.vsix';
export const BUILD_COMMAND = 'pnpm run package:local';

interface PackageInfo {
  name?: string;
  publisher?: string;
  version?: string;
}

export async function readPackageInfo(folder: string): Promise<PackageInfo | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')) as PackageInfo;
  } catch {
    return null;
  }
}

export function isForkSource(pkg: PackageInfo | null, selfId: string): boolean {
  if (!pkg?.name || !pkg.publisher) {
    return false;
  }
  return `${pkg.publisher}.${pkg.name}`.toLowerCase() === selfId.toLowerCase();
}

/** Remembered folder first, then any open workspace folder that is this extension's source. */
export async function findSourceFolder(
  candidates: (string | undefined)[],
  selfId: string,
  read: (folder: string) => Promise<PackageInfo | null> = readPackageInfo
): Promise<string | undefined> {
  for (const folder of candidates) {
    if (folder && isForkSource(await read(folder), selfId)) {
      return folder;
    }
  }
  return undefined;
}

/**
 * VS Code keeps a `.obsolete` JSON map next to the installed extensions; entries listed there
 * are deleted on the next start. Removes `key` (e.g. `kalpy.vscode-ptt-0.5.0`) from it.
 */
export async function clearObsoleteMarker(extensionsDir: string, key: string): Promise<boolean> {
  const file = path.join(extensionsDir, '.obsolete');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  const match = Object.keys(data).find(k => k.toLowerCase() === key.toLowerCase());
  if (!match) {
    return false;
  }
  delete data[match];
  try {
    if (Object.keys(data).length === 0) {
      await fs.rm(file, { force: true });
    } else {
      await fs.writeFile(file, JSON.stringify(data));
    }
    return true;
  } catch {
    return false;
  }
}

/** Where the `code` command-line launcher of the running VS Code lives. */
export function cliCandidates(appRoot: string, platform: NodeJS.Platform = process.platform): string[] {
  const name = platform === 'win32' ? 'code.cmd' : 'code';
  return [
    path.join(appRoot, '..', '..', 'bin', name), // Windows / Linux: <install>/resources/app
    path.join(appRoot, 'bin', name) // macOS: Code.app/Contents/Resources/app/bin/code
  ];
}

async function installWithCli(vsixPath: string): Promise<void> {
  let cli: string | undefined;
  for (const candidate of cliCandidates(vscode.env.appRoot)) {
    try {
      await fs.access(candidate);
      cli = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (!cli) {
    throw new Error('找不到 VS Code 的 code 指令');
  }
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile(
      cli as string,
      ['--install-extension', vsixPath, '--force'],
      { shell: process.platform === 'win32', windowsHide: true },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr?.trim() || err.message)) : resolve())
    );
  });
}

/**
 * Installs the VSIX even when the same version is already installed. VS Code's own installer
 * replaces the same-version folder; if it refuses, fall back to `code --install-extension
 * --force`.
 */
export async function forceInstallVsix(vsix: vscode.Uri): Promise<'workbench' | 'cli'> {
  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vsix);
    return 'workbench';
  } catch (err) {
    try {
      await installWithCli(vsix.fsPath);
      return 'cli';
    } catch (cliErr) {
      const first = err instanceof Error ? err.message : String(err);
      const second = cliErr instanceof Error ? cliErr.message : String(cliErr);
      throw new Error(`${first}；改用指令列 --force 也失敗：${second}`);
    }
  }
}

async function pickSourceFolder(selfId: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '選擇這個資料夾',
    title: '選擇 vscode-ptt 原始碼資料夾（含 package.json 的那一層）'
  });
  const folder = picked?.[0]?.fsPath;
  if (!folder) {
    return undefined;
  }
  if (!isForkSource(await readPackageInfo(folder), selfId)) {
    vscode.window.showErrorMessage(`這個資料夾不是 ${selfId} 的原始碼（找不到對應的 package.json）`);
    return undefined;
  }
  return folder;
}

function runBuild(folder: string): Promise<number | undefined> {
  const task = new vscode.Task(
    { type: 'shell', task: 'kalpy-ptt-package' },
    vscode.TaskScope.Workspace,
    '打包 VSCode PTT (kalpy)',
    'kalpy-ptt',
    new vscode.ShellExecution(BUILD_COMMAND, { cwd: folder })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true, panel: vscode.TaskPanelKind.Dedicated };

  return new Promise((resolve, reject) => {
    let execution: vscode.TaskExecution | undefined;
    const listener = vscode.tasks.onDidEndTaskProcess(e => {
      if (execution && e.execution === execution) {
        listener.dispose();
        resolve(e.exitCode);
      }
    });
    vscode.tasks.executeTask(task).then(
      exec => {
        execution = exec;
      },
      err => {
        listener.dispose();
        reject(err);
      }
    );
  });
}

export async function updateFromSource(context: vscode.ExtensionContext, options: { chooseFolder?: boolean } = {}): Promise<boolean> {
  const selfId = context.extension?.id ?? 'kalpy.vscode-ptt';
  const remembered = context.globalState.get<string>(SOURCE_FOLDER_KEY);
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  let folder = options.chooseFolder
    ? undefined
    : await findSourceFolder([remembered, ...workspaceFolders], selfId);
  if (!folder) {
    folder = await pickSourceFolder(selfId);
    if (!folder) {
      return false;
    }
  }
  await context.globalState.update(SOURCE_FOLDER_KEY, folder);

  let exitCode: number | undefined;
  try {
    exitCode = await runBuild(folder);
  } catch (err) {
    vscode.window.showErrorMessage(`無法執行打包：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (exitCode !== 0) {
    vscode.window.showErrorMessage(`打包失敗（結束代碼 ${exitCode ?? '未知'}），請看終端機裡「打包 VSCode PTT (kalpy)」的訊息。`);
    return false;
  }

  const vsix = vscode.Uri.file(path.join(folder, VSIX_NAME));
  const version = (await readPackageInfo(folder))?.version ?? '';
  const currentVersion: string | undefined = context.extension?.packageJSON?.version;
  const sameVersion = Boolean(version) && version === currentVersion;

  try {
    await forceInstallVsix(vsix);
  } catch (err) {
    vscode.window.showErrorMessage(`安裝失敗：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // A pending "removed" marker for this exact version would make VS Code delete the fresh
  // install on next start, so drop it.
  if (context.extensionPath && version) {
    await clearObsoleteMarker(path.dirname(context.extensionPath), `${selfId}-${version}`);
  }

  const summary = sameVersion
    ? `已用同版本 ${version} 強制覆蓋安裝 VSCode PTT (kalpy)`
    : `VSCode PTT (kalpy) 已從 ${currentVersion ?? '舊版'} 更新到 ${version}`;
  const answer = await vscode.window.showInformationMessage(
    `${summary}，重新載入視窗後生效。`,
    '重新載入視窗'
  );
  if (answer === '重新載入視窗') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  return true;
}
