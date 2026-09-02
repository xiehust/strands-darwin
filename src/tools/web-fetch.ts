/**
 * `web_fetch` — one GET of one web page, returned as a bounded readable text
 * projection. A sibling of the SDK `http_request` singleton, never a wrapper
 * around it: `http_request` keeps returning the raw body, this tool trades the
 * raw bytes for something a model can read in one round (HTML → text, a stated
 * code-point budget, a truncation notice). It is registered on the parent only
 * and stays classified through the unknown-tool fail-closed `execute` path.
 */
import { tool, type InvokableTool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';

export const WEB_FETCH_TOOL_NAME = 'web_fetch';

/** Hard ceiling on the returned body; `maxChars` may lower it, never raise it. */
export const WEB_FETCH_MAX_CHARS = 40_000;
/** The raw download stops here so one huge page never fills memory. */
export const WEB_FETCH_MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
/** Same-host redirect hops followed before the fetch gives up. */
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_TIMEOUT_SECONDS = 30;
export const WEB_FETCH_MAX_URL_CHARS = 4_096;

/** Markdown first: servers with content negotiation then skip the HTML round entirely. */
export const WEB_FETCH_ACCEPT = 'text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1';
export const WEB_FETCH_USER_AGENT = 'darwin-coding-agent (+https://github.com/xiehust/strands-darwin)';

/** Wording of the truncation notice; `N` is the code points shown, `M` the total. */
export const WEB_FETCH_TRUNCATION_NOTICE = '[truncated: N of M code points]';
export const WEB_FETCH_LOSSY_NOTICE =
  'HTML converted to readable text (lossy: scripts, styles, navigation, layout and attributes dropped); use http_request for the raw body.';

export function formatTruncationNotice(shown: number, total: number): string {
  return WEB_FETCH_TRUNCATION_NOTICE.replace('N', String(shown)).replace('M', String(total));
}

export const webFetchInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(WEB_FETCH_MAX_URL_CHARS)
    .describe('Absolute http(s) URL of the page to fetch; http:// is upgraded to https://'),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Lower the returned body's code-point budget (default and ceiling ${WEB_FETCH_MAX_CHARS})`),
});

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

export interface WebFetchResult {
  /** Final URL after upgrade and followed same-host redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
  /** Bounded statements about what changed between the wire and this result. */
  notice: string[];
}

export interface WebFetchOptions {
  /** Defaults to `globalThis.fetch`, resolved per call. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Validates the scheme and upgrades `http:` to `https:`. Anything that is not an
 * absolute http(s) URL is refused here, before any request is made.
 */
export function normalizeWebFetchUrl(raw: string): { url: string; upgraded: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`web_fetch: not an absolute URL: ${clip(raw, 200)}`);
  }
  if (parsed.protocol === 'https:') return { url: parsed.href, upgraded: false };
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
    return { url: parsed.href, upgraded: true };
  }
  throw new Error(`web_fetch: only http(s) URLs are fetched, not ${parsed.protocol.replace(/:$/, '')}: ${clip(raw, 200)}`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Performs the GET, redirect policy, content classification and bounding. */
export async function fetchWebPage(input: WebFetchInput, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const notice: string[] = [];
  const budget = Math.min(input.maxChars ?? WEB_FETCH_MAX_CHARS, WEB_FETCH_MAX_CHARS);
  if (input.maxChars !== undefined && input.maxChars > WEB_FETCH_MAX_CHARS) {
    notice.push(`maxChars ${input.maxChars} exceeds the ceiling; clamped to ${WEB_FETCH_MAX_CHARS} code points.`);
  }

  const first = normalizeWebFetchUrl(input.url);
  if (first.upgraded) notice.push(`Upgraded ${input.url} to ${first.url}.`);
  let current = first.url;
  const requestInit: RequestInit = {
    method: 'GET',
    headers: { Accept: WEB_FETCH_ACCEPT, 'User-Agent': WEB_FETCH_USER_AGENT },
    redirect: 'manual',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  let response: Response | undefined;
  for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop += 1) {
    response = await fetchImpl(current, requestInit);
    if (!REDIRECT_STATUSES.has(response.status)) break;

    const location = response.headers.get('location');
    const contentType = response.headers.get('content-type') ?? '';
    await discardBody(response);
    if (location === null) {
      notice.push(`HTTP ${response.status} without a Location header; nothing to follow.`);
      return { url: current, status: response.status, contentType, body: '', notice };
    }
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw new Error(`web_fetch: HTTP ${response.status} from ${current} redirects to an invalid Location: ${clip(location, 200)}`);
    }
    if (target.host !== new URL(current).host) {
      notice.push(
        `Redirect not followed: ${current} → ${target.href} (host ${target.host} differs from ${new URL(current).host}). ` +
          'Call web_fetch with the target URL to follow it.',
      );
      return { url: current, status: response.status, contentType, body: '', notice };
    }
    const next = normalizeWebFetchUrl(target.href);
    if (next.upgraded) notice.push(`Upgraded redirect target ${target.href} to ${next.url}.`);
    if (hop === WEB_FETCH_MAX_REDIRECTS) {
      throw new Error(`web_fetch: more than ${WEB_FETCH_MAX_REDIRECTS} redirects starting from ${first.url}; last target ${next.url}`);
    }
    current = next.url;
    response = undefined;
  }
  if (response === undefined) throw new Error(`web_fetch: no response for ${current}`);

  const rawContentType = response.headers.get('content-type') ?? '';
  const { mediaType, charset } = parseContentType(rawContentType);
  if (!response.ok) notice.push(`HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}.`);

  const declaredKind = mediaType === '' ? undefined : classifyMediaType(mediaType);
  if (declaredKind === 'binary') {
    const length = response.headers.get('content-length');
    await discardBody(response);
    throw new Error(
      `web_fetch: ${current} returned non-text content (${mediaType}${length === null ? ', unknown length' : `, ${length} bytes`}); ` +
        'the body was not read. Use http_request or bash (curl -o) if the bytes are needed.',
    );
  }

  const download = await readBounded(response);
  if (download.capped) {
    notice.push(`Download stopped at ${WEB_FETCH_MAX_DOWNLOAD_BYTES} bytes; the page continues beyond what was read.`);
  }
  const kind = declaredKind ?? sniffKind(download.bytes);
  if (kind === 'binary') {
    throw new Error(
      `web_fetch: ${current} returned non-text content (no content type declared, ${download.bytes.byteLength} bytes read); ` +
        'the body was not returned.',
    );
  }
  let text = decodeText(download.bytes, charset);
  if (download.capped) text = text.replace(/\uFFFD$/, '');
  if (kind === 'html') {
    text = htmlToText(text, current);
    notice.push(WEB_FETCH_LOSSY_NOTICE);
  }
  const bounded = boundCodePoints(text, budget);
  if (bounded.total > bounded.shown) notice.push(formatTruncationNotice(bounded.shown, bounded.total));
  return { url: current, status: response.status, contentType: rawContentType, body: bounded.body, notice };
}

export const webFetch: InvokableTool<WebFetchInput, WebFetchResult> = tool({
  name: WEB_FETCH_TOOL_NAME,
  description:
    'Fetches one web page with GET and returns a bounded readable text projection: markdown and plain text are kept as is, ' +
    'HTML is converted to headings, paragraphs, lists, links as "text (url)" and fenced code — a lossy projection that drops ' +
    'scripts, styles, navigation and layout. http:// is upgraded to https://; same-host redirects are followed, cross-host ' +
    `redirects are reported instead of followed. The body is capped at ${WEB_FETCH_MAX_CHARS} code points (maxChars may lower it) ` +
    `with an explicit "${WEB_FETCH_TRUNCATION_NOTICE}" notice. Use http_request for the raw, unconverted body or other methods.`,
  inputSchema: webFetchInputSchema,
  callback: async (input, context?: ToolContext) => {
    // Abort on timeout or tool-execution cancellation, whichever comes first —
    // the same composition the SDK http_request callback uses, built here.
    const timeoutSignal = AbortSignal.timeout(WEB_FETCH_TIMEOUT_SECONDS * 1000);
    const signal = context ? AbortSignal.any([timeoutSignal, context.cancelSignal]) : timeoutSignal;
    try {
      return await fetchWebPage(input, { signal });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        const reason = timeoutSignal.aborted ? `timed out after ${WEB_FETCH_TIMEOUT_SECONDS} seconds` : 'cancelled';
        throw new Error(`web_fetch: request ${reason}: GET ${clip(input.url, 200)}`, { cause: error });
      }
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Response handling

type BodyKind = 'html' | 'text' | 'binary';

const TEXTUAL_APPLICATION_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-sh',
  'application/graphql',
  'application/x-ndjson',
  'application/sql',
  'application/x-www-form-urlencoded',
]);

function classifyMediaType(mediaType: string): BodyKind {
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';
  if (mediaType.startsWith('text/')) return 'text';
  if (TEXTUAL_APPLICATION_TYPES.has(mediaType) || mediaType.endsWith('+json') || mediaType.endsWith('+xml')) return 'text';
  return 'binary';
}

/** Only consulted when the server declared no content type at all. */
function sniffKind(bytes: Uint8Array): BodyKind {
  const sample = bytes.subarray(0, 1024);
  if (sample.includes(0)) return 'binary';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(sample).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') ? 'html' : 'text';
}

function parseContentType(raw: string): { mediaType: string; charset: string | undefined } {
  const [type = '', ...params] = raw.split(';');
  const mediaType = type.trim().toLowerCase();
  let charset: string | undefined;
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(param);
    if (match?.[1] !== undefined) charset = match[1].trim();
  }
  return { mediaType, charset };
}

function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? 'utf-8', { fatal: false });
  } catch {
    decoder = new TextDecoder('utf-8', { fatal: false });
  }
  return decoder.decode(bytes).replace(/^\uFEFF/, '');
}

async function readBounded(response: Response): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const stream = response.body;
  if (stream === null) return { bytes: new Uint8Array(0), capped: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > WEB_FETCH_MAX_DOWNLOAD_BYTES) {
        chunks.push(value.subarray(0, WEB_FETCH_MAX_DOWNLOAD_BYTES - total));
        total = WEB_FETCH_MAX_DOWNLOAD_BYTES;
        capped = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, capped };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that is already consumed or errored has nothing left to release.
  }
}

/** Cuts at a code-point boundary and reports both figures for the notice. */
export function boundCodePoints(text: string, budget: number): { body: string; shown: number; total: number } {
  let total = 0;
  let cut = text.length;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0;
    if (total === budget) cut = Math.min(cut, index);
    total += 1;
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (total <= budget) return { body: text, shown: total, total };
  return { body: text.slice(0, cut), shown: budget, total };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// HTML → readable text (dependency-free projection)

/** Subtrees that never carry readable content; `head` keeps only its `title`. */
const DROPPED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'aside']);
/** Raw-text elements whose content is not parsed for tags. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'blockquote', 'body', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'html', 'legend', 'li', 'main',
  'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Elements that separate paragraphs rather than lines. */
const PARAGRAPH_ELEMENTS = new Set([
  'article', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figure', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'main', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', times: '×', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', hArr: '⇔', check: '✓', ne: '≠',
  le: '≤', ge: '≥', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', shy: '', zwj: '\u200d', zwnj: '\u200c',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return code === 0 ? '' : String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? whole;
  });
}

/** Accumulates lines, applying block-quote prefixes and whitespace collapsing outside `pre`. */
class TextBuilder {
  private readonly lines: string[] = [];
  private current = '';
  private quoteDepth = 0;
  private preDepth = 0;
  private pendingBlank = false;
  private pendingBlankDepth = 0;

  get length(): number {
    return this.current.length;
  }

  sliceCurrent(from: number): string {
    return this.current.slice(from);
  }

  inPre(): boolean {
    return this.preDepth > 0;
  }

  enterPre(): void {
    this.preDepth += 1;
  }

  leavePre(): void {
    this.preDepth = Math.max(0, this.preDepth - 1);
  }

  enterQuote(): void {
    this.quoteDepth += 1;
  }

  leaveQuote(): void {
    this.quoteDepth = Math.max(0, this.quoteDepth - 1);
  }

  text(raw: string): void {
    if (raw === '') return;
    if (this.preDepth > 0) {
      const parts = raw.split('\n');
      for (const [index, part] of parts.entries()) {
        if (index > 0) this.endLine(true);
        this.current += part;
      }
      return;
    }
    const collapsed = raw.replace(/[\t\n\f\r \u00a0]+/g, ' ');
    if (collapsed === ' ' && (this.current === '' || this.current.endsWith(' '))) return;
    const startsWithSpace = collapsed.startsWith(' ');
    if (startsWithSpace && (this.current === '' || this.current.endsWith(' '))) {
      this.current += collapsed.slice(1);
    } else {
      this.current += collapsed;
    }
  }

  /** Appends without whitespace collapsing (markers such as `- ` or a link URL). */
  literal(marker: string): void {
    this.current += marker;
  }

  endLine(keepBlank = false): void {
    const prefix = '> '.repeat(this.quoteDepth);
    const line = this.preDepth > 0 ? this.current : this.current.trimEnd();
    if (line !== '' || keepBlank) {
      if (this.pendingBlank && this.lines.length > 0) this.lines.push('> '.repeat(this.pendingBlankDepth).trimEnd());
      this.pendingBlank = false;
      this.lines.push(`${prefix}${line}`);
    }
    this.current = '';
  }

  /** A paragraph separator; consecutive requests collapse to the shallowest quote depth. */
  blank(): void {
    this.endLine();
    this.pendingBlankDepth = this.pendingBlank ? Math.min(this.pendingBlankDepth, this.quoteDepth) : this.quoteDepth;
    this.pendingBlank = true;
  }

  toString(): string {
    this.endLine();
    return this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}

interface Tag {
  name: string;
  attributes: Map<string, string>;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

function parseTag(html: string, start: number): Tag | undefined {
  // `start` points at '<'. Returns undefined when this is not a tag.
  let index = start + 1;
  let closing = false;
  if (html[index] === '/') {
    closing = true;
    index += 1;
  }
  const nameStart = index;
  while (index < html.length && /[A-Za-z0-9:-]/.test(html[index]!)) index += 1;
  if (index === nameStart) return undefined;
  const name = html.slice(nameStart, index).toLowerCase();
  const attributes = new Map<string, string>();
  let selfClosing = false;
  for (;;) {
    while (index < html.length && /\s/.test(html[index]!)) index += 1;
    if (index >= html.length) return { name, attributes, closing, selfClosing, end: html.length };
    const char = html[index]!;
    if (char === '>') return { name, attributes, closing, selfClosing, end: index + 1 };
    if (char === '/') {
      selfClosing = true;
      index += 1;
      continue;
    }
    const attrStart = index;
    while (index < html.length && !/[\s=/>]/.test(html[index]!)) index += 1;
    if (index === attrStart) {
      index += 1;
      continue;
    }
    const attrName = html.slice(attrStart, index).toLowerCase();
    let value = '';
    let probe = index;
    while (probe < html.length && /\s/.test(html[probe]!)) probe += 1;
    if (html[probe] === '=') {
      probe += 1;
      while (probe < html.length && /\s/.test(html[probe]!)) probe += 1;
      const quote = html[probe];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, probe + 1);
        value = close === -1 ? html.slice(probe + 1) : html.slice(probe + 1, close);
        index = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = probe;
        while (probe < html.length && !/[\s>]/.test(html[probe]!)) probe += 1;
        value = html.slice(valueStart, probe);
        index = probe;
      }
    }
    if (!attributes.has(attrName)) attributes.set(attrName, decodeEntities(value));
  }
}

function skipUntilClose(html: string, from: number, name: string): number {
  // Raw-text and dropped subtrees: for raw-text elements only the literal close
  // tag ends them; for others, nested same-name elements are counted.
  if (RAW_TEXT_ELEMENTS.has(name)) {
    const close = new RegExp(`</${name}\\s*>`, 'ig');
    close.lastIndex = from;
    const match = close.exec(html);
    return match === null ? html.length : match.index + match[0].length;
  }
  let depth = 1;
  let index = from;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) return html.length;
    const tag = parseTag(html, lt);
    if (tag === undefined) {
      index = lt + 1;
      continue;
    }
    if (tag.name === name) {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) return tag.end;
      } else if (!tag.selfClosing && !VOID_ELEMENTS.has(name)) {
        depth += 1;
      }
    }
    index = tag.end;
  }
  return html.length;
}

function resolveHref(href: string, baseUrl: string): string | undefined {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return undefined;
  try {
    const resolved = new URL(trimmed, baseUrl);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' || resolved.protocol === 'mailto:'
      ? resolved.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts one HTML document to readable markdown-ish text: headings, paragraphs,
 * `- ` list items, `> ` quotes, fenced `pre`, `text (url)` links, `[image: alt]`.
 * Every decision is local to one tag, so malformed markup degrades to plain text
 * instead of failing.
 */
export function htmlToText(html: string, baseUrl: string): string {
  const out = new TextBuilder();
  const openLinks: { href: string | undefined; start: number }[] = [];
  let title: string | undefined;
  let rowHasCell = false;
  let index = 0;

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      out.text(decodeEntities(html.slice(index)));
      break;
    }
    if (lt > index) out.text(decodeEntities(html.slice(index, lt)));

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const close = html.indexOf('>', lt);
      index = close === -1 ? html.length : close + 1;
      continue;
    }
    const tag = parseTag(html, lt);
    if (tag === undefined) {
      out.text('<');
      index = lt + 1;
      continue;
    }
    index = tag.end;
    const { name } = tag;

    if (!tag.closing && name === 'title' && title === undefined) {
      const end = skipUntilClose(html, index, name);
      const inner = html.slice(index, end).replace(/<\/title\s*>$/i, '');
      title = decodeEntities(inner).replace(/\s+/g, ' ').trim();
      index = end;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && (DROPPED_ELEMENTS.has(name) || RAW_TEXT_ELEMENTS.has(name))) {
      index = skipUntilClose(html, index, name);
      continue;
    }
    if (name === 'head') continue;

    if (name === 'br') {
      out.endLine();
      continue;
    }
    if (name === 'img') {
      const alt = (tag.attributes.get('alt') ?? '').trim();
      out.text(alt === '' ? '[image]' : `[image: ${alt}]`);
      continue;
    }
    if (name === 'hr') {
      out.blank();
      out.literal('---');
      out.blank();
      continue;
    }
    if (name === 'a') {
      if (!tag.closing) {
        openLinks.push({ href: resolveHref(tag.attributes.get('href') ?? '', baseUrl), start: out.length });
      } else {
        const link = openLinks.pop();
        if (link?.href !== undefined) {
          const text = out.sliceCurrent(link.start).trim();
          if (text !== '' && text !== link.href) out.literal(` (${link.href})`);
          else if (text === '') out.text(link.href);
        }
      }
      continue;
    }
    if (name === 'code' && !out.inPre()) {
      out.literal('`');
      continue;
    }
    if (name === 'pre') {
      if (!tag.closing) {
        out.blank();
        out.literal('```');
        out.endLine();
        out.enterPre();
      } else {
        out.endLine();
        out.leavePre();
        out.literal('```');
        out.blank();
      }
      continue;
    }
    if (name === 'blockquote') {
      if (!tag.closing) {
        out.blank();
        out.enterQuote();
      } else {
        out.leaveQuote();
        out.blank();
      }
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      out.blank();
      if (!tag.closing) out.literal(`${'#'.repeat(Number(name[1]))} `);
      continue;
    }
    if (name === 'li') {
      out.endLine();
      if (!tag.closing) out.literal('- ');
      continue;
    }
    if (name === 'tr') {
      rowHasCell = false;
      out.endLine();
      continue;
    }
    if (name === 'td' || name === 'th') {
      if (!tag.closing) {
        if (rowHasCell) out.literal(' | ');
        rowHasCell = true;
      }
      continue;
    }
    if (PARAGRAPH_ELEMENTS.has(name)) {
      out.blank();
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) {
      out.endLine();
      continue;
    }
  }

  const body = out.toString();
  if (title !== undefined && title !== '' && !body.startsWith(`# ${title}`)) {
    return body === '' ? `# ${title}` : `# ${title}\n\n${body}`;
  }
  return body;
}
