import type { ArticleListItem } from './store';
import type { FavoriteBoardItem, IPttClient, PttArticleDetail, PttClientState } from './types';

/**
 * Read-only PTT client backed by the web version (https://www.ptt.cc/bbs).
 *
 * PTT refuses `guest` logins over the BBS/WebSocket interface ("請改用網頁版"), so guest
 * mode scrapes the web pages instead. It implements the subset of IPttClient used by the
 * extension.
 *
 * Article serial numbers (sn) are synthesized because the web version has no BBS index:
 *   index mode:  sn = pageNumber * 100 + position          (index{pageNumber}.html)
 *   search mode: sn = (SEARCH_BASE - page) * 100 + position (search?page={page}&q=...)
 * Both grow towards newer articles, so the extension's "load older" cursor (lastSn - 1)
 * maps back to the right page via {@link WebPttClient.pageKeyForOffset}.
 */

export const WEB_ORIGIN = 'https://www.ptt.cc';
const SEARCH_BASE = 10_000_000;
const PINNED_POSITION_BASE = 80;

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

interface ListingPage {
  pageKey: number;
  articles: ArticleListItem[];
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
  lsaquo: '‹',
  rsaquo: '›'
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

export function parseArticleList(html: string): { articles: Omit<ArticleListItem, 'sn'>[]; hrefs: (string | null)[]; pinnedFrom: number; prevPage: number | null } {
  const sepIndex = html.indexOf('r-list-sep');
  const entRegex = /<div class="r-ent">([\s\S]*?)<div class="mark">([\s\S]*?)<\/div>/g;
  const articles: Omit<ArticleListItem, 'sn'>[] = [];
  const hrefs: (string | null)[] = [];
  let pinnedFrom = -1;
  let match: RegExpExecArray | null;

  while ((match = entRegex.exec(html)) !== null) {
    const block = match[1];
    const isPinned = sepIndex !== -1 && match.index > sepIndex;
    if (isPinned && pinnedFrom === -1) {
      pinnedFrom = articles.length;
    }
    const nrec = /<div class="nrec">([\s\S]*?)<\/div>/.exec(block);
    const titleBlock = /<div class="title">([\s\S]*?)<\/div>/.exec(block);
    const link = titleBlock ? /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(titleBlock[1]) : null;
    const author = /<div class="author">([\s\S]*?)<\/div>/.exec(block);
    const date = /<div class="date">([\s\S]*?)<\/div>/.exec(block);

    const title = link ? stripTags(link[2]).trim() : stripTags(titleBlock?.[1] ?? '').trim();
    articles.push({
      push: stripTags(nrec?.[1] ?? '').trim(),
      date: stripTags(date?.[1] ?? '').trim(),
      fixed: isPinned,
      author: stripTags(author?.[1] ?? '').trim(),
      status: stripTags(match[2]).trim(),
      title
    });
    hrefs.push(link ? decodeEntities(link[1]) : null);
  }

  const prev = /<a class="btn wide" href="[^"]*?(?:index(\d+)\.html|[?&;]page=(\d+)[^"]*)">&lsaquo; 上頁<\/a>/.exec(html);
  let prevPage: number | null = null;
  if (prev) {
    prevPage = Number(prev[1] ?? prev[2]);
  }

  return { articles, hrefs, pinnedFrom, prevPage };
}

export function parseArticle(html: string): PttArticleDetail {
  const start = html.indexOf('<div id="main-content"');
  if (start === -1) {
    throw new Error('找不到文章內容');
  }
  let body = html.slice(html.indexOf('>', start) + 1);
  for (const marker of ['<div id="article-polling"', '<div class="bbs-screen bbs-footer-message"', '<div id="main-container"']) {
    const idx = body.indexOf(marker);
    if (idx !== -1) {
      body = body.slice(0, idx);
    }
  }
  const end = body.lastIndexOf('</div>');
  if (end !== -1) {
    body = body.slice(0, end);
  }

  const meta: Record<string, string> = {};
  body = body.replace(
    /<div class="article-metaline(?:-right)?"><span class="article-meta-tag">([^<]*)<\/span><span class="article-meta-value">([\s\S]*?)<\/span><\/div>/g,
    (_m, tag: string, value: string) => {
      meta[tag.trim()] = stripTags(value).trim();
      return '';
    }
  );

  // Embedded previews (YouTube / images) are rendered next to the URL on the web; drop them.
  body = body.replace(/<div class="richcontent">[\s\S]*?<\/div><\/div><\/div>/g, '');
  body = body.replace(/<div class="richcontent">[\s\S]*?<\/div>/g, '');

  body = body.replace(
    /<div class="push">\s*<span[^>]*push-tag[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*push-userid[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*push-content[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*push-ipdatetime[^>]*>([\s\S]*?)<\/span>\s*<\/div>/g,
    (_m, tag: string, user: string, content: string, ipdatetime: string) => {
      const line = `${stripTags(tag).trim()} ${stripTags(user).trim()}${stripTags(content).replace(/\s+$/, '')} ${stripTags(ipdatetime).trim()}`;
      return `\n${line}\n`;
    }
  );

  const text = stripTags(body).replace(/\r/g, '');
  const contentLines = text.split('\n');
  while (contentLines.length && !contentLines[0].trim()) {
    contentLines.shift();
  }
  // Collapse the blank lines introduced around push rows
  const lines: string[] = [];
  for (const line of contentLines) {
    const isPush = /^(推|噓|→) /.test(line);
    if (isPush && lines.length && !lines[lines.length - 1].trim() && /^(推|噓|→) /.test(lines[lines.length - 2] ?? '')) {
      lines.pop();
    }
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }

  const header: string[] = [];
  if (meta['作者']) {
    header.push(` 作者  ${meta['作者']}${meta['看板'] ? `  看板  ${meta['看板']}` : ''}`);
  }
  if (meta['標題']) {
    header.push(` 標題  ${meta['標題']}`);
  }
  if (meta['時間']) {
    header.push(` 時間  ${meta['時間']}`);
  }
  if (header.length) {
    header.push('─'.repeat(39));
  }

  return {
    author: meta['作者'] ?? '',
    title: meta['標題'] ?? '',
    timestamp: meta['時間'] ?? '',
    lines: header.concat(lines)
  };
}

export function parseHotBoards(html: string): FavoriteBoardItem[] {
  const result: FavoriteBoardItem[] = [];
  const regex = /<div class="b-ent">([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  let bn = 1;
  while ((match = regex.exec(html)) !== null) {
    const block = match[1];
    const name = /<div class="board-name">([\s\S]*?)<\/div>/.exec(block);
    if (!name) {
      continue;
    }
    const users = /<div class="board-nuser">([\s\S]*?)<\/div>/.exec(block);
    const category = /<div class="board-class">([\s\S]*?)<\/div>/.exec(block);
    const title = /<div class="board-title">([\s\S]*?)<\/div>/.exec(block);
    result.push({
      bn: bn++,
      read: false,
      boardname: stripTags(name[1]).trim(),
      category: stripTags(category?.[1] ?? '').trim(),
      title: stripTags(title?.[1] ?? '').trim(),
      users: stripTags(users?.[1] ?? '').trim(),
      admin: '',
      folder: false,
      divider: false
    });
  }
  return result;
}

export class WebPttClient implements IPttClient {
  public readonly isWebClient = true;
  public state: PttClientState = { connect: true, login: false, position: { boardname: '' } };
  public get _state(): PttClientState {
    return this.state;
  }

  private searchConditions: { type: string; criteria: string }[] = [];
  private links = new Map<string, string>();
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(private fetchImpl: FetchLike = (globalThis as any).fetch, private origin = WEB_ORIGIN) {}

  on(event: string, listener: (...args: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void) {
    const wrapped = (...args: any[]) => {
      this.listeners.get(event)?.delete(wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  private emit(event: string, ...args: any[]) {
    for (const l of [...(this.listeners.get(event) ?? [])]) {
      l(...args);
    }
  }

  private async get(path: string): Promise<{ status: number; body: string }> {
    const res = await this.fetchImpl(`${this.origin}${path}`, {
      headers: { cookie: 'over18=1' }
    });
    return { status: res.status, body: res.ok ? await res.text() : '' };
  }

  async login(): Promise<boolean> {
    const { status } = await this.get('/bbs/index.html');
    this.state.login = status === 200;
    this.emit('stateChange', this.state);
    return this.state.login;
  }

  async logout(): Promise<boolean> {
    this.state.login = false;
    this.emit('stateChange', this.state);
    return true;
  }

  async send(): Promise<void> {
    // No terminal behind the web client.
  }

  setSearchCondition(type: string, criteria: string): void {
    if (criteria === undefined || criteria === null || String(criteria).trim() === '') {
      return;
    }
    this.searchConditions.push({ type, criteria: String(criteria).trim() });
  }

  resetSearchCondition(): void {
    this.searchConditions = [];
  }

  async getFavorite(): Promise<FavoriteBoardItem[]> {
    const { status, body } = await this.get('/bbs/hotboards.html');
    if (status !== 200) {
      throw new Error(`無法取得熱門看板 (HTTP ${status})`);
    }
    return parseHotBoards(body);
  }

  async enterBoard(boardname: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_.-]+$/.test(boardname)) {
      return false;
    }
    const { status, body } = await this.get(`/bbs/${boardname}/index.html`);
    const ok = status === 200 && (body.includes('r-ent') || body.includes('r-list-container'));
    if (ok) {
      this.state.position = { boardname };
    }
    return ok;
  }

  private searchQuery(): string | null {
    if (this.searchConditions.length === 0) {
      return null;
    }
    const parts = this.searchConditions.map(({ type, criteria }) => {
      switch (type) {
        case 'push':
          return `recommend:${criteria}`;
        case 'author':
          return `author:${criteria}`;
        default:
          return criteria;
      }
    });
    return parts.join(' ');
  }

  /** Maps the extension's "older than" cursor to a page key (see class docs). */
  static pageKeyForOffset(offset: number): { pageKey: number; maxSn: number } {
    const base = Math.floor(offset / 100);
    const position = offset % 100;
    return position === 0
      ? { pageKey: base - 1, maxSn: Number.POSITIVE_INFINITY }
      : { pageKey: base, maxSn: offset };
  }

  private async fetchListing(boardname: string, pageKey: number | null): Promise<ListingPage | null> {
    const q = this.searchQuery();
    let path: string;
    if (q !== null) {
      const page = pageKey === null ? 1 : SEARCH_BASE - pageKey;
      if (page < 1) {
        return null;
      }
      path = `/bbs/${boardname}/search?page=${page}&q=${encodeURIComponent(q)}`;
    } else {
      if (pageKey !== null && pageKey < 1) {
        return null;
      }
      path = pageKey === null ? `/bbs/${boardname}/index.html` : `/bbs/${boardname}/index${pageKey}.html`;
    }

    const { status, body } = await this.get(path);
    if (status !== 200) {
      return null;
    }
    const parsed = parseArticleList(body);

    let key: number;
    if (q !== null) {
      key = SEARCH_BASE - (pageKey === null ? 1 : SEARCH_BASE - pageKey);
    } else if (pageKey !== null) {
      key = pageKey;
    } else {
      key = parsed.prevPage !== null ? parsed.prevPage + 1 : 1;
    }

    const articles: ArticleListItem[] = [];
    let normalPos = 1;
    let pinnedPos = PINNED_POSITION_BASE;
    parsed.articles.forEach((item, i) => {
      const position = item.fixed ? pinnedPos++ : normalPos++;
      const sn = key * 100 + Math.min(position, 99);
      const href = parsed.hrefs[i];
      if (href) {
        this.links.set(`${boardname}/${sn}`, href);
      }
      articles.push({ ...item, sn });
    });

    return { pageKey: key, articles };
  }

  async getArticles(boardname: string, offset = 0): Promise<ArticleListItem[]> {
    let listing: ListingPage | null;
    if (!offset || offset <= 0) {
      listing = await this.fetchListing(boardname, null);
    } else {
      const { pageKey, maxSn } = WebPttClient.pageKeyForOffset(offset);
      listing = await this.fetchListing(boardname, pageKey);
      if (listing) {
        // Pinned posts only matter on the newest page
        listing.articles = listing.articles.filter(a => !a.fixed && a.sn <= maxSn);
      }
    }
    if (listing) {
      this.state.position = { boardname };
    }
    return listing?.articles ?? [];
  }

  async getArticle(boardname: string, sn: string | number): Promise<PttArticleDetail> {
    const key = `${boardname}/${sn}`;
    let href = this.links.get(key);
    if (!href) {
      // e.g. an editor tab restored after reload: re-read the listing page that sn came from
      const numericSn = Number(sn);
      const pageKey = Math.floor(numericSn / 100);
      if (pageKey < SEARCH_BASE / 2) {
        const saved = this.searchConditions;
        this.searchConditions = [];
        try {
          await this.fetchListing(boardname, pageKey);
        } finally {
          this.searchConditions = saved;
        }
      } else {
        await this.fetchListing(boardname, pageKey);
      }
      href = this.links.get(key);
    }
    if (!href) {
      throw new Error(`找不到文章 ${boardname} #${sn}（可能已被刪除）`);
    }
    const { status, body } = await this.get(href);
    if (status !== 200) {
      throw new Error(`無法取得文章 (HTTP ${status})`);
    }
    return { sn, ...parseArticle(body) };
  }
}

export function isWebClient(client: unknown): client is WebPttClient {
  return Boolean(client && (client as { isWebClient?: boolean }).isWebClient);
}
