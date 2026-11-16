import assert from 'node:assert';
import type * as vscode from 'vscode';
import {
  addCondition,
  describeSearch,
  toSearchCondition,
  validateSearchInput
} from '../../search';
import store, { type ArticleListItem } from '../../store';
import {
  runBoardSearch,
  clearBoardSearch,
  searchBoardCommand,
  setPttClient,
  setExtensionContext
} from '../../extension';
import { MockPttClient } from './mockPttClient';
import { WebPttClient } from '../../webClient';
import { mockVscode } from './setup';

const article = (sn: number, title: string): ArticleListItem => ({
  sn, title, push: '', date: '11/16', fixed: false, author: 'someone', status: ''
});

describe('文章搜尋 (keyword / author / push)', () => {
  describe('input helpers', () => {
    it('validates keyword, author and push input', () => {
      assert.strictEqual(validateSearchInput('title', '  閒聊 '), null);
      assert.ok(validateSearchInput('title', '   '));
      assert.ok(validateSearchInput('title', '字'.repeat(41)));
      assert.strictEqual(validateSearchInput('author', 'kalpy01'), null);
      assert.ok(validateSearchInput('author', '中文'));
      assert.strictEqual(validateSearchInput('push', '50'), null);
      assert.ok(validateSearchInput('push', '-1'));
      assert.ok(validateSearchInput('push', 'abc'));
    });

    it('normalises conditions and clamps push to 100 (爆)', () => {
      assert.deepStrictEqual(toSearchCondition('title', ' 心得 '), { type: 'title', criteria: '心得' });
      assert.deepStrictEqual(toSearchCondition('push', '250'), { type: 'push', criteria: '100' });
    });

    it('describes searches in Chinese', () => {
      assert.strictEqual(
        describeSearch([{ type: 'title', criteria: '閒聊' }, { type: 'author', criteria: 'abc' }, { type: 'push', criteria: '30' }]),
        '標題「閒聊」、作者 abc、推文 ≥ 30'
      );
      assert.strictEqual(describeSearch([{ type: 'push', criteria: '100' }]), '推文 爆');
    });

    it('narrows an existing search, replacing a condition of the same type', () => {
      const first = addCondition([], { type: 'title', criteria: '閒聊' });
      const second = addCondition(first, { type: 'push', criteria: '50' });
      const third = addCondition(second, { type: 'title', criteria: '心得' });
      assert.deepStrictEqual(third, [{ type: 'push', criteria: '50' }, { type: 'title', criteria: '心得' }]);
    });
  });

  describe('per-board search state', () => {
    let mockPtt: MockPttClient;

    beforeEach(() => {
      store.clearAll();
      mockPtt = new MockPttClient(true);
      mockPtt.articlesByBoard = { C_Chat: [article(1, '一般文章')], Stock: [article(5, '股票文章')] };
      mockPtt.searchResultsByBoard = { C_Chat: [article(9, '[閒聊] 找到了')] };
      setPttClient(mockPtt);
    });

    it('shows search results for one board and passes conditions explicitly', async () => {
      const count = await runBoardSearch('C_Chat', [{ type: 'title', criteria: '閒聊' }]);

      assert.strictEqual(count, 1);
      assert.deepStrictEqual(store.asList('C_Chat').map(a => a.title), ['[閒聊] 找到了']);
      assert.ok(store.isSearching('C_Chat'));
      assert.ok(store.isSearchLoaded('C_Chat'));
      const call = mockPtt.getArticlesCalls.at(-1);
      assert.deepStrictEqual(call?.conditions, [{ type: 'title', criteria: '閒聊' }]);
      assert.strictEqual(mockPtt.searchCondition, null, 'global search state is not used');
    });

    it('does not leak a search into other boards', async () => {
      await runBoardSearch('C_Chat', [{ type: 'title', criteria: '閒聊' }]);
      assert.deepStrictEqual(store.getSearch('Stock'), []);
      assert.strictEqual(store.isSearching('Stock'), false);
    });

    it('marks an empty result as loaded so the tree can say 找不到符合的文章', async () => {
      const count = await runBoardSearch('Stock', [{ type: 'author', criteria: 'nobody' }]);
      assert.strictEqual(count, 0);
      assert.ok(store.isSearching('Stock'));
      assert.ok(store.isSearchLoaded('Stock'));
    });

    it('clearing a search restores the full article list', async () => {
      await runBoardSearch('C_Chat', [{ type: 'title', criteria: '閒聊' }]);
      await clearBoardSearch('C_Chat');

      assert.strictEqual(store.isSearching('C_Chat'), false);
      assert.deepStrictEqual(store.asList('C_Chat').map(a => a.title), ['一般文章']);
      assert.deepStrictEqual(mockPtt.getArticlesCalls.at(-1)?.conditions, []);
    });

    it('search command: pick keyword, type it, see results', async () => {
      setExtensionContext({ globalState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext);
      const originalPick = mockVscode.window.showQuickPick;
      const originalInput = mockVscode.window.showInputBox;
      mockVscode.window.showQuickPick = async (items: any) => (items as any[]).find(i => i.type === 'title');
      mockVscode.window.showInputBox = async (options: any) => {
        assert.strictEqual(options.validateInput('閒聊'), null);
        return '閒聊';
      };
      try {
        const count = await searchBoardCommand('C_Chat');
        assert.strictEqual(count, 1);
        assert.deepStrictEqual(store.getSearch('C_Chat'), [{ type: 'title', criteria: '閒聊' }]);
      } finally {
        mockVscode.window.showQuickPick = originalPick;
        mockVscode.window.showInputBox = originalInput;
      }
    });
  });

  describe('web client (guest mode)', () => {
    it('builds the web search query for each condition type', () => {
      assert.strictEqual(WebPttClient.searchQuery([]), null);
      assert.strictEqual(
        WebPttClient.searchQuery([{ type: 'title', criteria: '閒聊' }, { type: 'author', criteria: 'abc' }, { type: 'push', criteria: '50' }]),
        '閒聊 author:abc recommend:50'
      );
    });

    it('uses explicit conditions instead of the global ones', async () => {
      const requested: string[] = [];
      const client = new WebPttClient(async (url: string) => {
        requested.push(url.replace('https://www.ptt.cc', ''));
        return { status: 200, ok: true, text: async () => '<div class="r-list-container"></div>' };
      });
      client.setSearchCondition('push', '99');

      await client.getArticles('C_Chat', 0, [{ type: 'title', criteria: '閒聊' }]);
      await client.getArticles('Stock', 0, []);

      assert.deepStrictEqual(requested, [
        `/bbs/C_Chat/search?page=1&q=${encodeURIComponent('閒聊')}`,
        '/bbs/Stock/index.html'
      ]);
    });
  });
});
