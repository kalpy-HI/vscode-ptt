/**
 * Link previews for external (non-image) URLs: YouTube thumbnails are derived from the
 * video id, everything else is read from the page's Open Graph / Twitter card metadata.
 */

export interface LinkPreview {
  url: string;
  image?: string;
  title?: string;
  description?: string;
  siteName?: string;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type LinkFetch = (url: string, init: {
  headers: Record<string, string>;
  redirect: 'follow';
  signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

const MAX_HTML_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_LIMIT = 200;

export function getYouTubeId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
    let id: string | null = null;
    if (host === 'youtu.be') {
      id = url.pathname.split('/')[1] || null;
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') {
        id = url.searchParams.get('v');
      } else {
        const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
        id = m ? m[1] : null;
      }
    }
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Previews that need no network request. */
export function getStaticLinkPreview(rawUrl: string): LinkPreview | null {
  const ytId = getYouTubeId(rawUrl);
  if (ytId) {
    return { url: rawUrl, image: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`, siteName: 'YouTube' };
  }
  return null;
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return named[e.toLowerCase()] ?? m;
  });
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function normalizeText(text: string | undefined, max: number): string | undefined {
  if (!text) {
    return undefined;
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function toHttpUrl(value: string | undefined, base: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const resolved = new URL(value.trim(), base);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseLinkPreview(html: string, pageUrl: string): LinkPreview | null {
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const meta: Record<string, string> = {};
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(head)) !== null) {
    const attrs = parseAttributes(m[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && meta[key] === undefined) {
      meta[key] = attrs.content;
    }
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);

  const image = toHttpUrl(
    meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] ||
    meta['twitter:image'] || meta['twitter:image:src'] || meta['image'],
    pageUrl
  );
  const title = normalizeText(meta['og:title'] || meta['twitter:title'] || (titleTag ? decodeHtmlEntities(titleTag[1]) : undefined), 120);
  const description = normalizeText(meta['og:description'] || meta['twitter:description'] || meta['description'], 200);
  const siteName = normalizeText(meta['og:site_name'], 60);

  if (!image && !title && !description) {
    return null;
  }
  return { url: pageUrl, image, title, description, siteName };
}

function charsetFrom(contentType: string | null, bytes: Uint8Array): string {
  const fromHeader = contentType && /charset=["']?([\w-]+)/i.exec(contentType);
  if (fromHeader) {
    return fromHeader[1].toLowerCase();
  }
  const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff);
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = charsetFrom(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export class LinkPreviewService {
  private cache = new Map<string, Promise<LinkPreview | null>>();

  constructor(
    private fetchImpl: LinkFetch | undefined = (globalThis as { fetch?: LinkFetch }).fetch,
    private timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  get(rawUrl: string, isCancelled?: () => boolean): Promise<LinkPreview | null> {
    const staticPreview = getStaticLinkPreview(rawUrl);
    if (staticPreview) {
      return Promise.resolve(staticPreview);
    }

    const cached = this.cache.get(rawUrl);
    if (cached) {
      // refresh LRU order
      this.cache.delete(rawUrl);
      this.cache.set(rawUrl, cached);
      return cached;
    }

    const pending = this.fetchPreview(rawUrl, isCancelled);
    this.cache.set(rawUrl, pending);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    // Don't keep cancelled lookups around: the next hover should try again.
    pending.then(result => {
      if (result === null && isCancelled?.()) {
        this.cache.delete(rawUrl);
      }
    });
    return pending;
  }

  private async fetchPreview(rawUrl: string, isCancelled?: () => boolean): Promise<LinkPreview | null> {
    if (!this.fetchImpl) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = setTimeout(() => controller?.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        // Many sites only serve Open Graph tags to link-preview bots
        'user-agent': 'Mozilla/5.0 (compatible; vscode-ptt link preview)',
        accept: 'text/html,application/xhtml+xml'
      };
      if (url.hostname === 'ptt.cc' || url.hostname.endsWith('.ptt.cc')) {
        headers.cookie = 'over18=1';
      }
      const res = await this.fetchImpl(url.toString(), {
        headers,
        redirect: 'follow',
        signal: controller?.signal
      });
      if (!res.ok || isCancelled?.()) {
        return null;
      }
      const contentType = res.headers.get('content-type');
      const finalUrl = res.url || url.toString();
      if (contentType && /^image\//i.test(contentType)) {
        return { url: rawUrl, image: finalUrl };
      }
      if (contentType && !/html|xml/i.test(contentType)) {
        return null;
      }
      const buffer = new Uint8Array(await res.arrayBuffer());
      const html = decodeBody(buffer.subarray(0, MAX_HTML_BYTES), contentType);
      const preview = parseLinkPreview(html, finalUrl);
      return preview ? { ...preview, url: rawUrl } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
