import { LinkPreviewService, type LinkPreview } from './linkPreview';
import * as vscode from 'vscode';

const RESERVED_IMGUR_PATHS = new Set([
  'about',
  'blog',
  'help',
  'apps',
  'jobs',
  'privacy',
  'tos',
  'rules',
  'signin',
  'register',
  'upload',
  'tools',
  'user',
  'account',
  't',
  'search',
  'gallery'
]);

export function getImagePreviewUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // 1. Imgur support
    if (hostname === 'imgur.com' || hostname.endsWith('.imgur.com')) {
      // Check for album or gallery: /a/{id} or /gallery/{id}
      const albumMatch = pathname.match(/^\/(?:a|gallery)\/([A-Za-z0-9]+)/i);
      if (albumMatch) {
        return `https://i.imgur.com/${albumMatch[1]}.jpg`;
      }

      // Check for single image with extension: /abc1234.jpg, /i/abc1234.png
      const singleImageWithExtMatch = pathname.match(/^\/(?:i\/)?([A-Za-z0-9]+)\.(jpg|jpeg|png|gif|webp|gifv)/i);
      if (singleImageWithExtMatch) {
        const id = singleImageWithExtMatch[1];
        let ext = singleImageWithExtMatch[2].toLowerCase();
        if (ext === 'gifv') {
          ext = 'gif';
        }
        return `https://i.imgur.com/${id}.${ext}`;
      }

      // Check for single image without extension: /abc1234, /i/abc1234
      const singleImageMatch = pathname.match(/^\/(?:i\/)?([A-Za-z0-9]+)\/?$/i);
      if (singleImageMatch) {
        const id = singleImageMatch[1];
        if (!RESERVED_IMGUR_PATHS.has(id.toLowerCase())) {
          return `https://i.imgur.com/${id}.jpg`;
        }
      }
    }

    // 2. Gyazo support
    if (hostname === 'gyazo.com' || hostname.endsWith('.gyazo.com')) {
      const match = pathname.match(/^\/([A-Za-z0-9]+)\/?$/i);
      if (match) {
        return `https://i.gyazo.com/${match[1]}.png`;
      }
    }

    // 3. Direct image extensions in pathname
    const imageExtRegex = /\.(jpe?g|png|gif|webp|bmp|svg|ico)$/i;
    if (imageExtRegex.test(pathname)) {
      return rawUrl;
    }

    // 4. Image hosts with format search parameters (e.g. Twitter/X images)
    if (hostname === 'pbs.twimg.com' && parsed.searchParams.has('format')) {
      return rawUrl;
    }

    return null;
  } catch {
    return null;
  }
}

export function extractUrlsWithRange(lineText: string, lineIndex: number): Array<{ url: string; range: vscode.Range }> {
  const urlRegex = /https?:\/\/[^\s<>"'`]+/g;
  const results: Array<{ url: string; range: vscode.Range }> = [];
  let match = urlRegex.exec(lineText);

  while (match !== null) {
    let rawUrl = match[0];
    const startChar = match.index;

    // Trim trailing punctuation that are unlikely to be part of the URL in normal text
    const trailingPunctuationRegex = /[.,;:!?)>\]]+$/;
    const trailingMatch = rawUrl.match(trailingPunctuationRegex);
    if (trailingMatch) {
      rawUrl = rawUrl.slice(0, -trailingMatch[0].length);
    }

    const endChar = startChar + rawUrl.length;
    const range = new vscode.Range(lineIndex, startChar, lineIndex, endChar);
    results.push({ url: rawUrl, range });

    match = urlRegex.exec(lineText);
  }

  return results;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function imageMarkdown(imageUrl: string, width: number): string {
  return width > 0
    ? `<img src="${escapeAttr(imageUrl)}" width="${width}" />`
    : `![](${imageUrl.replace(/[()\s]/g, encodeURIComponent)})`;
}

export function buildLinkPreviewMarkdown(preview: LinkPreview, width: number): vscode.MarkdownString {
  // Page metadata is untrusted: no command links, and text is escaped.
  const markdown = new vscode.MarkdownString('', false);
  markdown.isTrusted = false;
  markdown.supportHtml = true;
  markdown.appendMarkdown(`[${escapeMarkdownLinkText(preview.url)}](${preview.url.replace(/[()\s]/g, encodeURIComponent)})\n\n`);
  if (preview.title) {
    markdown.appendMarkdown('**');
    markdown.appendText(preview.title);
    markdown.appendMarkdown('**');
    if (preview.siteName) {
      markdown.appendMarkdown(' · ');
      markdown.appendText(preview.siteName);
    }
    markdown.appendMarkdown('\n\n');
  }
  if (preview.description) {
    markdown.appendText(preview.description);
    markdown.appendMarkdown('\n\n');
  }
  if (preview.image) {
    markdown.appendMarkdown(imageMarkdown(preview.image, width));
  }
  return markdown;
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([\\[\]*_`])/g, '\\$1');
}

/** Pages without og:image (e.g. PTT articles) often mention an image link in their description. */
export function withImageFromDescription(preview: LinkPreview): LinkPreview {
  if (preview.image || !preview.description) {
    return preview;
  }
  for (const { url } of extractUrlsWithRange(preview.description, 0)) {
    const image = getImagePreviewUrl(url);
    if (image) {
      return { ...preview, image };
    }
  }
  return preview;
}

export default class PttHoverProvider implements vscode.HoverProvider {
  constructor(private linkPreviews: LinkPreviewService = new LinkPreviewService()) {}

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const config = vscode.workspace.getConfiguration();
    const isEnabled = config.get<boolean>('previewImages') ?? true;
    if (!isEnabled) {
      return null;
    }

    const lineText = document.lineAt(position.line).text;
    const urls = extractUrlsWithRange(lineText, position.line);
    const previewWidth = config.get<number>('previewImageWidth') ?? 320;

    for (const item of urls) {
      if (position.character >= item.range.start.character && position.character <= item.range.end.character) {
        const previewUrl = getImagePreviewUrl(item.url);
        if (previewUrl) {
          const imageContent = imageMarkdown(previewUrl, previewWidth);

          const markdown = new vscode.MarkdownString(`[${item.url}](${item.url})\n\n${imageContent}`);
          markdown.isTrusted = true;
          markdown.supportHtml = true;
          return new vscode.Hover(markdown, item.range);
        }

        const linkPreviewEnabled = config.get<boolean>('previewLinks') ?? true;
        if (!linkPreviewEnabled) {
          return null;
        }
        return this.linkPreviews
          .get(item.url, () => Boolean(token?.isCancellationRequested))
          .then(found => {
            const preview = found ? withImageFromDescription(found) : found;
            if (!preview || token?.isCancellationRequested || (!preview.image && !preview.title)) {
              return null;
            }
            return new vscode.Hover(buildLinkPreviewMarkdown(preview, previewWidth), item.range);
          });
      }
    }

    return null;
  }
}
