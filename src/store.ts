import type { FavoriteBoardItem, SearchCondition } from './types';

export interface ArticleListItem {
  sn: number;
  push: string;
  date: string;
  fixed: boolean;
  author: string;
  status: string;
  title: string;
}

class ArticleStore {
  private articleStore: { [boardname: string]: { [sn: number]: ArticleListItem } } = {};
  private articleIds: { [boardname: string]: Array<number> } = {};
  private favorites: FavoriteBoardItem[] = [];
  private favoritesLoaded = false;

  getFavorites(): FavoriteBoardItem[] {
    return this.favorites;
  }

  setFavorites(favorites: FavoriteBoardItem[]): void {
    this.favorites = favorites || [];
    this.favoritesLoaded = true;
  }

  hasFavorites(): boolean {
    return this.favoritesLoaded;
  }

  clearFavorites(): void {
    this.favorites = [];
    this.favoritesLoaded = false;
  }

  clearAll(): void {
    this.articleStore = {};
    this.articleIds = {};
    this.favorites = [];
    this.favoritesLoaded = false;
    this.searches = {};
    this.searchLoaded.clear();
  }

  // Per-board search (關鍵字 / 作者 / 推文數). Articles stored for a board while it has a search
  // are the search results.
  private searches: { [boardname: string]: SearchCondition[] } = {};

  getSearch(boardname: string): SearchCondition[] {
    return this.searches[boardname] ?? [];
  }

  isSearching(boardname: string): boolean {
    return this.getSearch(boardname).length > 0;
  }

  setSearch(boardname: string, conditions: SearchCondition[]): void {
    this.searchLoaded.delete(boardname);
    if (conditions.length === 0) {
      delete this.searches[boardname];
    } else {
      this.searches[boardname] = [...conditions];
    }
  }

  /** Marks that the first page of search results arrived (possibly empty). */
  markSearchLoaded(boardname: string): void {
    this.searchLoaded.add(boardname);
  }

  isSearchLoaded(boardname: string): boolean {
    return this.searchLoaded.has(boardname);
  }

  clearAllSearches(): string[] {
    const boards = Object.keys(this.searches);
    this.searches = {};
    this.searchLoaded.clear();
    return boards;
  }

  private searchLoaded = new Set<string>();

  asList(boardname: string): ArticleListItem[] {
    return (this.articleIds[boardname] || [])
      .map(id => this.articleStore[boardname]?.[id])
      .filter(Boolean)
      .sort((a, b) => {
        if (a.fixed && !b.fixed) {
          return -1;
        }
        if (!a.fixed && b.fixed) {
          return 1;
        }
        return b.sn - a.sn;
      });
  }

  add(boardname: string, articles: Array<ArticleListItem>) {
    if (!articles || articles.length === 0) {
      return;
    }
    this.articleStore[boardname] = this.articleStore[boardname] || {};
    for (const article of articles) {
      this.articleStore[boardname][article.sn] = article;
    }
    const ids = this.articleIds[boardname] || [];
    this.articleIds[boardname] = [...new Set(ids.concat(articles.map(art => art.sn)))];
  }

  release(boardname: string) {
    this.articleStore[boardname] = {};
    this.articleIds[boardname] = [];
  }

  /**
   * Returns the minimum sequence number (oldest article SN) loaded for this board,
   * excluding pinned/fixed posts. Used as the pagination cursor for loading older articles.
   */
  lastSn(boardname: string): number {
    const list = this.asList(boardname).filter(a => !a.fixed && a.sn > 0);
    if (list.length === 0) {
      return 0;
    }
    return list[list.length - 1].sn;
  }

  minSn(boardname: string): number {
    return this.lastSn(boardname);
  }

  maxSn(boardname: string): number {
    const list = this.asList(boardname).filter(a => !a.fixed && a.sn > 0);
    return list.length > 0 ? list[0].sn : 0;
  }

  isEmpty(boardname: string): boolean {
    return this.asList(boardname).length === 0;
  }

  getBoardNames(): string[] {
    return Object.keys(this.articleStore);
  }
}

export default new ArticleStore();
