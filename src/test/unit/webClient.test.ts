import * as assert from 'assert';
import {
  WebPttClient,
  parseArticle,
  parseArticleList,
  parseHotBoards,
  decodeEntities,
  type FetchLike
} from '../../webClient';

const entry = (href: string | null, title: string, push = '', author = 'someone', date = '11/16', mark = '') => `
		<div class="r-ent">
			<div class="nrec">${push ? `<span class="hl f2">${push}</span>` : ''}</div>
			<div class="title">
			${href ? `<a href="${href}">${title}</a>` : title}
			</div>
			<div class="meta">
				<div class="author">${author}</div>
				<div class="article-menu"><div class="trigger">&#x22ef;</div></div>
				<div class="date">${date}</div>
				<div class="mark">${mark}</div>
			</div>
		</div>`;

const indexPage = (prev: number | null, entries: string[], pinned: string[] = []) => `
<div class="btn-group btn-group-paging">
	<a class="btn wide" href="/bbs/Test/index1.html">最舊</a>
	${prev ? `<a class="btn wide" href="/bbs/Test/index${prev}.html">&lsaquo; 上頁</a>` : '<a class="btn wide disabled">&lsaquo; 上頁</a>'}
	<a class="btn wide disabled">下頁 &rsaquo;</a>
</div>
<div class="r-list-container action-bar-margin bbs-screen">
${entries.join('\n')}
${pinned.length ? `<div class="r-list-sep"></div>\n${pinned.join('\n')}` : ''}
</div>`;

const searchPage = (prev: number | null, entries: string[]) => `
<a class="btn wide" href="/bbs/Test/search?page=9&amp;q=recommend%3A50">最舊</a>
${prev ? `<a class="btn wide" href="/bbs/Test/search?page=${prev}&amp;q=recommend%3A50">&lsaquo; 上頁</a>` : ''}
<div class="r-list-container">${entries.join('\n')}</div>`;

const articlePage = `
<div id="main-container">
    <div id="main-content" class="bbs-screen bbs-content"><div class="article-metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">alice (Alice)</span></div><div class="article-metaline-right"><span class="article-meta-tag">看板</span><span class="article-meta-value">Test</span></div><div class="article-metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">[閒聊] Hello &amp; world</span></div><div class="article-metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">Mon Nov 16 10:13:49 2026</span></div>
第一行內文
<a href="https://i.imgur.com/abc.jpg" target="_blank">https://i.imgur.com/abc.jpg</a>
<div class="richcontent"><img src="https://i.imgur.com/abc.jpg" alt="" /></div>
--
<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)
</span><div class="push"><span class="hl push-tag">推 </span><span class="f3 hl push-userid">bob</span><span class="f3 push-content">: 推推</span><span class="push-ipdatetime"> 11/16 10:17
</span></div><div class="push"><span class="f1 hl push-tag">噓 </span><span class="f3 hl push-userid">carol</span><span class="f3 push-content">: 不推 &lt;3</span><span class="push-ipdatetime"> 11/16 10:18
</span></div></div>

    <div id="article-polling" data-pollurl="/poll/x"></div>
<div class="bbs-screen bbs-footer-message">本網站已依台灣網站內容分級規定處理。</div>
</div>`;

const hotBoards = `
<div class="b-ent">
    <a class="board" href="/bbs/Stock/index.html">
        <div class="board-name">Stock</div>
        <div class="board-nuser"><span class="hl f4">5785</span></div>
        <div class="board-class">學術</div>
        <div class="board-title">&#9678;[股票] </div>
    </a>
</div>
<div class="b-ent">
    <a class="board" href="/bbs/C_Chat/index.html">
        <div class="board-name">C_Chat</div>
        <div class="board-nuser"><span class="hl f6">3000</span></div>
        <div class="board-class">閒談</div>
        <div class="board-title">◎[希洽] 板務</div>
    </a>
</div>`;

function fakeFetch(pages: Record<string, string>, requested: string[] = []): FetchLike {
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    assert.strictEqual(init?.headers?.cookie, 'over18=1', 'over18 cookie should always be sent');
    const path = url.replace('https://www.ptt.cc', '');
    requested.push(path);
    const body = pages[path];
    return {
      status: body === undefined ? 404 : 200,
      ok: body !== undefined,
      text: async () => body ?? ''
    };
  };
}

describe('WebPttClient (guest mode via www.ptt.cc)', () => {
  describe('parsers', () => {
    it('decodes HTML entities', () => {
      assert.strictEqual(decodeEntities('&lt;a&gt; &amp; &#9678; &#x22ef;'), '<a> & ◎ ⋯');
    });

    it('parses article list entries, deleted posts and pinned posts', () => {
      const html = indexPage(41, [
        entry('/bbs/Test/M.1.A.1.html', '[閒聊] one', '5'),
        entry(null, '(本文已被刪除) [someone]', '', '-'),
        entry('/bbs/Test/M.2.A.2.html', '[問題] two', '爆', 'bob', '11/15', 'M')
      ], [entry('/bbs/Test/M.0.A.0.html', '[公告] rules', '', 'admin')]);

      const parsed = parseArticleList(html);
      assert.strictEqual(parsed.prevPage, 41);
      assert.strictEqual(parsed.articles.length, 4);
      assert.strictEqual(parsed.pinnedFrom, 3);
      assert.deepStrictEqual(parsed.articles[0], {
        push: '5', date: '11/16', fixed: false, author: 'someone', status: '', title: '[閒聊] one'
      });
      assert.strictEqual(parsed.hrefs[1], null);
      assert.strictEqual(parsed.articles[2].push, '爆');
      assert.strictEqual(parsed.articles[2].status, 'M');
      assert.strictEqual(parsed.articles[3].fixed, true);
    });

    it('parses search page "previous" links', () => {
      assert.strictEqual(parseArticleList(searchPage(2, [])).prevPage, 2);
    });

    it('converts an article page into terminal-like lines', () => {
      const article = parseArticle(articlePage);
      assert.strictEqual(article.author, 'alice (Alice)');
      assert.strictEqual(article.title, '[閒聊] Hello & world');
      assert.deepStrictEqual(article.lines.slice(0, 4), [
        ' 作者  alice (Alice)  看板  Test',
        ' 標題  [閒聊] Hello & world',
        ' 時間  Mon Nov 16 10:13:49 2026',
        '─'.repeat(39)
      ]);
      assert.ok(article.lines.includes('第一行內文'));
      assert.ok(article.lines.includes('https://i.imgur.com/abc.jpg'));
      assert.ok(article.lines.includes('推 bob: 推推 11/16 10:17'));
      assert.ok(article.lines.includes('噓 carol: 不推 <3 11/16 10:18'));
      assert.strictEqual(article.lines[article.lines.length - 1], '噓 carol: 不推 <3 11/16 10:18');
      assert.ok(!article.lines.some(l => l.includes('分級規定')), 'footer must not leak into article');
      assert.ok(!article.lines.some(l => l.includes('<')  && l.includes('>') && !l.includes('<3')), 'no html tags');
    });

    it('parses hot boards as favorite items', () => {
      const boards = parseHotBoards(hotBoards);
      assert.deepStrictEqual(boards.map(b => b.boardname), ['Stock', 'C_Chat']);
      assert.strictEqual(boards[0].title, '◎[股票]');
      assert.strictEqual(boards[0].users, '5785');
      assert.strictEqual(boards[0].divider, false);
    });
  });

  describe('client', () => {
    const pages: Record<string, string> = {
      '/bbs/index.html': '<html></html>',
      '/bbs/hotboards.html': hotBoards,
      '/bbs/Test/index.html': indexPage(41, [
        entry('/bbs/Test/M.10.A.1.html', 'newest-1', '1'),
        entry('/bbs/Test/M.11.A.1.html', 'newest-2', '2')
      ], [entry('/bbs/Test/M.0.A.0.html', '[公告] rules')]),
      '/bbs/Test/index41.html': indexPage(40, [
        entry('/bbs/Test/M.8.A.1.html', 'older-1'),
        entry('/bbs/Test/M.9.A.1.html', 'older-2')
      ]),
      '/bbs/Test/M.11.A.1.html': articlePage,
      '/bbs/Test/M.8.A.1.html': articlePage,
      '/bbs/Test/search?page=1&q=recommend%3A50': searchPage(2, [
        entry('/bbs/Test/M.20.A.1.html', 'hot-1', '60'),
        entry('/bbs/Test/M.21.A.1.html', 'hot-2', '爆')
      ]),
      '/bbs/Test/search?page=2&q=recommend%3A50': searchPage(3, [
        entry('/bbs/Test/M.19.A.1.html', 'hot-0', '55')
      ])
    };

    it('logs in without credentials and reports connected state', async () => {
      const client = new WebPttClient(fakeFetch(pages));
      assert.strictEqual(await client.login(), true);
      assert.strictEqual(client.state.login, true);
      assert.strictEqual(client.state.connect, true);
    });

    it('fails login when the site is unreachable', async () => {
      const client = new WebPttClient(fakeFetch({}));
      assert.strictEqual(await client.login(), false);
    });

    it('returns hot boards from getFavorite', async () => {
      const client = new WebPttClient(fakeFetch(pages));
      const favs = await client.getFavorite();
      assert.deepStrictEqual(favs.map(f => f.boardname), ['Stock', 'C_Chat']);
    });

    it('checks board existence via enterBoard', async () => {
      const client = new WebPttClient(fakeFetch(pages));
      assert.strictEqual(await client.enterBoard('Test'), true);
      assert.strictEqual(await client.enterBoard('Nope'), false);
      assert.strictEqual(await client.enterBoard('../etc'), false);
    });

    it('assigns increasing sn per page and paginates to older pages', async () => {
      const requested: string[] = [];
      const client = new WebPttClient(fakeFetch(pages, requested));

      const newest = await client.getArticles('Test');
      // newest page is index42 (previous link points to 41)
      assert.deepStrictEqual(newest.map(a => [a.title, a.sn, a.fixed]), [
        ['newest-1', 4201, false],
        ['newest-2', 4202, false],
        ['[公告] rules', 4280, true]
      ]);

      // extension asks for "older than lastSn" with lastSn - 1
      const older = await client.getArticles('Test', 4201 - 1);
      assert.deepStrictEqual(older.map(a => [a.title, a.sn]), [['older-1', 4101], ['older-2', 4102]]);
      assert.ok(requested.includes('/bbs/Test/index41.html'));

      // page 0 does not exist
      assert.deepStrictEqual(await client.getArticles('Test', 101 - 1), []);
    });

    it('fetches an article by synthesized sn', async () => {
      const client = new WebPttClient(fakeFetch(pages));
      await client.getArticles('Test');
      const article = await client.getArticle('Test', 4202);
      assert.strictEqual(article.sn, 4202);
      assert.ok(article.lines.includes('推 bob: 推推 11/16 10:17'));
    });

    it('re-resolves an sn without a prior listing (e.g. restored editor tab)', async () => {
      const client = new WebPttClient(fakeFetch(pages));
      const article = await client.getArticle('Test', 4101);
      assert.strictEqual(article.title, '[閒聊] Hello & world');
    });

    it('throws a readable error for unknown articles', async () => {
      const client = new WebPttClient(fakeFetch(pages));
      await assert.rejects(() => client.getArticle('Test', 4299), /找不到文章/);
    });

    it('uses the web search for push-count conditions and paginates search results', async () => {
      const requested: string[] = [];
      const client = new WebPttClient(fakeFetch(pages, requested));
      client.setSearchCondition('push', '50');

      const first = await client.getArticles('Test');
      assert.deepStrictEqual(first.map(a => [a.title, a.push]), [['hot-1', '60'], ['hot-2', '爆']]);
      assert.ok(requested.includes('/bbs/Test/search?page=1&q=recommend%3A50'));

      const lastSn = Math.min(...first.map(a => a.sn));
      const second = await client.getArticles('Test', lastSn - 1);
      assert.deepStrictEqual(second.map(a => a.title), ['hot-0']);
      assert.ok(second[0].sn < lastSn);

      client.resetSearchCondition();
      const plain = await client.getArticles('Test');
      assert.strictEqual(plain[0].title, 'newest-1');
    });
  });
});
