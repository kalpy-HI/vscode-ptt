import { ArticleListItem } from './store';

export interface FavoriteBoardItem {
  bn: string | number;
  read: string | boolean;
  boardname: string;
  category: string;
  title: string;
  users: string;
  admin: string;
  folder: boolean;
  divider: boolean;
}

export interface PttArticleDetail {
  lines: string[];
  [key: string]: any;
}

export interface PttClientState {
  login: boolean;
  [key: string]: any;
}

/** 搜尋條件：title = 標題關鍵字、author = 作者、push = 推文數下限 */
export interface SearchCondition {
  type: 'title' | 'author' | 'push';
  criteria: string;
}

export interface IPttClient {
  state: PttClientState;
  _state?: PttClientState;
  login(username?: string, password?: string, kickLogin?: boolean): Promise<any>;
  getFavorite(): Promise<FavoriteBoardItem[]>;
  enterBoard(boardname: string): Promise<boolean>;
  /** `conditions` limits the listing to a search; omit it for the global (legacy) search state */
  getArticles(boardname: string, fromSn?: number, conditions?: SearchCondition[]): Promise<ArticleListItem[]>;
  getArticle(boardname: string, sn: string | number, conditions?: SearchCondition[]): Promise<PttArticleDetail>;
  setSearchCondition(type: string, criteria: string): void;
  resetSearchCondition(): void;
  send(keys: string): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): any;
  once?(event: string, listener: (...args: any[]) => void): any;
}
