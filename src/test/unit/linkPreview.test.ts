import assert from 'node:assert';
import {
  LinkPreviewService,
  getYouTubeId,
  getStaticLinkPreview,
  parseLinkPreview,
  type LinkFetch
} from '../../linkPreview';

function fakeFetch(
  body: Uint8Array | string,
  contentType: string | null = 'text/html; charset=utf-8',
  calls: { url: string; headers: Record<string, string> }[] = [],
  finalUrl?: string
): LinkFetch {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return {
      ok: true,
      status: 200,
      url: finalUrl ?? url,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    };
  };
}

describe('linkPreview', () => {
  describe('getYouTubeId', () => {
    it('recognises common YouTube URL forms', () => {
      assert.strictEqual(getYouTubeId('https://www.youtube.com/watch?v=9TtAwAeXP60&t=30'), '9TtAwAeXP60');
      assert.strictEqual(getYouTubeId('https://m.youtube.com/watch?v=9TtAwAeXP60'), '9TtAwAeXP60');
      assert.strictEqual(getYouTubeId('https://youtu.be/9TtAwAeXP60?si=x'), '9TtAwAeXP60');
      assert.strictEqual(getYouTubeId('https://www.youtube.com/shorts/abcDEF12345'), 'abcDEF12345');
      assert.strictEqual(getYouTubeId('https://www.youtube.com/embed/abcDEF12345'), 'abcDEF12345');
      assert.strictEqual(getYouTubeId('https://www.youtube.com/@channel'), null);
      assert.strictEqual(getYouTubeId('https://example.com/watch?v=abcDEF12345'), null);
    });

    it('builds a static thumbnail preview', () => {
      assert.deepStrictEqual(getStaticLinkPreview('https://youtu.be/abcDEF12345'), {
        url: 'https://youtu.be/abcDEF12345',
        image: 'https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg',
        siteName: 'YouTube'
      });
    });
  });

  describe('parseLinkPreview', () => {
    it('prefers og tags, resolves relative images and decodes entities', () => {
      const preview = parseLinkPreview(`<head>
        <title>Fallback</title>
        <meta content="Hello &quot;world&quot;" property="og:title" />
        <meta name='description' content='desc'>
        <meta property="og:image" content="../a.jpg">
      </head><body><meta property="og:image" content="/ignored.jpg"></body>`, 'https://example.com/x/y/page');
      assert.deepStrictEqual(preview, {
        url: 'https://example.com/x/y/page',
        image: 'https://example.com/x/a.jpg',
        title: 'Hello "world"',
        description: 'desc',
        siteName: undefined
      });
    });

    it('falls back to twitter card and <title>', () => {
      const preview = parseLinkPreview('<title> 標題 </title><meta name="twitter:image" content="https://cdn.example.com/t.png">', 'https://example.com');
      assert.strictEqual(preview?.title, '標題');
      assert.strictEqual(preview?.image, 'https://cdn.example.com/t.png');
    });

    it('rejects non-http image URLs', () => {
      const preview = parseLinkPreview('<meta property="og:image" content="javascript:alert(1)"><title>t</title>', 'https://example.com');
      assert.strictEqual(preview?.image, undefined);
    });

    it('returns null when there is nothing to show', () => {
      assert.strictEqual(parseLinkPreview('<html><body>plain</body></html>', 'https://example.com'), null);
    });

    it('truncates long descriptions', () => {
      const preview = parseLinkPreview(`<meta property="og:description" content="${'字'.repeat(500)}">`, 'https://example.com');
      assert.strictEqual(preview?.description?.length, 200);
      assert.ok(preview?.description?.endsWith('…'));
    });
  });

  describe('LinkPreviewService', () => {
    it('fetches a page once and caches the result', async () => {
      const calls: { url: string; headers: Record<string, string> }[] = [];
      const service = new LinkPreviewService(fakeFetch('<meta property="og:image" content="https://x.com/i.png">', 'text/html', calls));
      const a = await service.get('https://example.com/a');
      const b = await service.get('https://example.com/a');
      assert.strictEqual(a?.image, 'https://x.com/i.png');
      assert.strictEqual(b, a);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].headers.cookie, undefined);
    });

    it('sends the over18 cookie only to ptt.cc', async () => {
      const calls: { url: string; headers: Record<string, string> }[] = [];
      const service = new LinkPreviewService(fakeFetch('<title>t</title>', 'text/html', calls));
      await service.get('https://www.ptt.cc/bbs/Gossiping/M.1.A.1.html');
      await service.get('https://evilptt.cc/');
      assert.strictEqual(calls[0].headers.cookie, 'over18=1');
      assert.strictEqual(calls[1].headers.cookie, undefined);
    });

    it('treats links that turn out to be images as images', async () => {
      const service = new LinkPreviewService(fakeFetch(new Uint8Array([1, 2, 3]), 'image/png', [], 'https://cdn.example.com/real.png'));
      const preview = await service.get('https://example.com/short');
      assert.strictEqual(preview?.image, 'https://cdn.example.com/real.png');
    });

    it('ignores non-HTML responses', async () => {
      const service = new LinkPreviewService(fakeFetch('{}', 'application/json'));
      assert.strictEqual(await service.get('https://example.com/api'), null);
    });

    it('decodes Big5 pages using the declared charset', async () => {
      // "<title>測試</title>" encoded in Big5
      const big5 = new Uint8Array([
        ...new TextEncoder().encode('<meta charset="big5"><title>'),
        0xb4, 0xfa, 0xb8, 0xd5,
        ...new TextEncoder().encode('</title>')
      ]);
      const service = new LinkPreviewService(fakeFetch(big5, 'text/html'));
      const preview = await service.get('https://example.com/big5');
      assert.strictEqual(preview?.title, '測試');
    });

    it('returns null on network errors and times out slow sites', async () => {
      const failing = new LinkPreviewService(async () => {
        throw new Error('offline');
      });
      assert.strictEqual(await failing.get('https://example.com/down'), null);

      const slow = new LinkPreviewService((_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }), 20);
      assert.strictEqual(await slow.get('https://example.com/slow'), null);
    });

    it('ignores non-http URLs', async () => {
      const service = new LinkPreviewService(fakeFetch('<title>x</title>'));
      assert.strictEqual(await service.get('ftp://example.com/file'), null);
    });
  });
});
