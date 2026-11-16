import type * as vscode from 'vscode';

/**
 * Locally saved favourite boards (本地喜愛看板).
 *
 * They live in VS Code's globalState (key kept as `boardlist` for backwards compatibility),
 * are shared by guest and account mode, survive logout, and are registered for Settings
 * Sync so they follow the user to other machines. Export/import to a JSON file covers
 * machines without Settings Sync.
 */

export const LOCAL_BOARDS_KEY = 'boardlist';
export const BOARD_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

export interface LocalBoardsExport {
  app: 'vscode-ptt';
  version: 1;
  exportedAt: string;
  boards: string[];
}

type StateLike = Pick<vscode.Memento, 'get' | 'update'>;

export function normalizeBoardNames(names: unknown[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    if (typeof raw !== 'string') {
      continue;
    }
    const name = raw.trim();
    if (!BOARD_NAME_PATTERN.test(name)) {
      continue;
    }
    // PTT board names are case-insensitive; keep the first spelling we saw
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, name);
    }
  }
  return [...seen.values()];
}

export class LocalBoards {
  constructor(private state: StateLike | undefined) {}

  list(): string[] {
    return normalizeBoardNames(this.state?.get<unknown[]>(LOCAL_BOARDS_KEY) ?? []);
  }

  has(name: string): boolean {
    return this.list().some(b => b.toLowerCase() === name.trim().toLowerCase());
  }

  /** Returns the boards that were not already saved. */
  async add(names: string[]): Promise<string[]> {
    const current = this.list();
    const merged = normalizeBoardNames([...current, ...names]);
    const added = merged.slice(current.length);
    if (added.length > 0) {
      await this.state?.update(LOCAL_BOARDS_KEY, merged);
    }
    return added;
  }

  async remove(name: string): Promise<boolean> {
    const current = this.list();
    const next = current.filter(b => b.toLowerCase() !== name.trim().toLowerCase());
    if (next.length === current.length) {
      return false;
    }
    await this.state?.update(LOCAL_BOARDS_KEY, next);
    return true;
  }

  toExport(now = new Date()): LocalBoardsExport {
    return { app: 'vscode-ptt', version: 1, exportedAt: now.toISOString(), boards: this.list() };
  }
}

/**
 * Accepts our own export format, a plain JSON array of board names, or plain text with
 * one board per line (e.g. a hand-written backup).
 */
export function parseLocalBoardsImport(text: string): string[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error('檔案不是有效的 JSON');
    }
    const list = Array.isArray(data)
      ? data
      : (data && typeof data === 'object' && Array.isArray((data as { boards?: unknown }).boards))
        ? (data as { boards: unknown[] }).boards
        : null;
    if (!list) {
      throw new Error('找不到看板清單（需要 boards 陣列）');
    }
    return normalizeBoardNames(list);
  }
  return normalizeBoardNames(trimmed.split(/[\r\n,]+/));
}
