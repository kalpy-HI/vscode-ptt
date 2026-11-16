import { IPttClient, FavoriteBoardItem, PttArticleDetail, PttClientState, SearchCondition } from '../../types';
import { ArticleListItem } from '../../store';

export class MockPttClient implements IPttClient {
  state: PttClientState = { login: false, connect: true };
  _state?: PttClientState = this.state;
  private listeners: Record<string, ((...args: any[]) => void)[]> = {};

  public searchCondition: { type?: string; criteria?: string } | null = null;
  public sentKeys: string[] = [];
  public articlesByBoard: Record<string, ArticleListItem[]> = {};
  public articleDetails: Record<string, PttArticleDetail> = {};
  public favorites: FavoriteBoardItem[] = [];

  constructor(initialLogin = false) {
    this.state.login = initialLogin;
    this.state.connect = true;
  }

  on(event: string, listener: (...args: any[]) => void) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(listener);
    return this;
  }

  emit(event: string, ...args: any[]) {
    const list = this.listeners[event] || [];
    this.listeners[event] = [];
    list.forEach(fn => fn(...args));
  }

  async login(username?: string, password?: string, _kickLogin?: boolean): Promise<boolean> {
    if (username && (password || username.toLowerCase() === 'guest' || password === '')) {
      this.state.login = true;
      return true;
    }
    return false;
  }

  async getFavorite(): Promise<FavoriteBoardItem[]> {
    return this.favorites;
  }

  async enterBoard(boardname: string): Promise<boolean> {
    return boardname.length > 0;
  }

  public getArticlesCalls: { boardname: string; fromSn?: number; conditions?: SearchCondition[] }[] = [];
  /** Optional search results by board, used when conditions are passed */
  public searchResultsByBoard: Record<string, ArticleListItem[]> = {};

  async getArticles(boardname: string, fromSn?: number, conditions?: SearchCondition[]): Promise<ArticleListItem[]> {
    this.getArticlesCalls.push({ boardname, fromSn, conditions });
    if (conditions && conditions.length > 0) {
      return this.searchResultsByBoard[boardname] || [];
    }
    return this.articlesByBoard[boardname] || [];
  }

  async getArticle(boardname: string, sn: string | number, _conditions?: SearchCondition[]): Promise<PttArticleDetail> {
    const key = `${boardname}/${sn}`;
    return this.articleDetails[key] || { lines: ['[No Content]'] };
  }

  setSearchCondition(type: string, criteria: string): void {
    this.searchCondition = { type, criteria };
  }

  resetSearchCondition(): void {
    this.searchCondition = null;
  }

  async send(keys: string): Promise<void> {
    this.sentKeys.push(keys);
  }
}
