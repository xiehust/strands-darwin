/**
 * Offline proof of the parent-only `web_fetch` tool: URL policy, content
 * negotiation, HTML → readable text, bounds, redirects, cancellation, the
 * fail-closed permission path and the child-catalogue exclusion. A local
 * `http.createServer` fixture stands in for the web; nothing leaves 127.0.0.1.
 */
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  Agent,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type ToolContext,
} from '@strands-agents/sdk';
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request';

import { classify, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath } from '../src/config.js';
import {
  WEB_FETCH_ACCEPT,
  WEB_FETCH_LOSSY_NOTICE,
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_MAX_DOWNLOAD_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TRUNCATION_NOTICE,
  boundCodePoints,
  decodeEntities,
  fetchWebPage,
  formatTruncationNotice,
  htmlToText,
  normalizeWebFetchUrl,
  webFetch,
  webFetchInputSchema,
} from '../src/tools/web-fetch.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('web-fetch');

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rejects(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return message(error);
  }
}

// ---------------------------------------------------------------------------
header('web_fetch — tool shape and pure helpers');
{
  assert('tool is named web_fetch', webFetch.name === WEB_FETCH_TOOL_NAME && WEB_FETCH_TOOL_NAME === 'web_fetch');
  assert('description states the lossy projection and points at http_request for the raw body',
    webFetch.description.includes('lossy') && webFetch.description.includes('http_request'));
  assert('description quotes the truncation notice wording',
    webFetch.description.includes(WEB_FETCH_TRUNCATION_NOTICE) && WEB_FETCH_TRUNCATION_NOTICE === '[truncated: N of M code points]');
  assert('schema requires url', !webFetchInputSchema.safeParse({}).success);
  assert('schema rejects a non-positive maxChars', !webFetchInputSchema.safeParse({ url: 'https://a.invalid/', maxChars: 0 }).success);
  assert('schema accepts url alone and url with maxChars',
    webFetchInputSchema.safeParse({ url: 'https://a.invalid/' }).success
      && webFetchInputSchema.safeParse({ url: 'https://a.invalid/', maxChars: 500 }).success);

  const upgraded = normalizeWebFetchUrl('http://Example.com:8080/path?q=1#frag');
  assert('http:// is upgraded to https:// keeping host, port, path, query and fragment',
    upgraded.url === 'https://example.com:8080/path?q=1#frag' && upgraded.upgraded);
  const kept = normalizeWebFetchUrl('https://example.com/a');
  assert('https:// is kept as is', kept.url === 'https://example.com/a' && !kept.upgraded);
  for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
    let refused: string | undefined;
    try {
      normalizeWebFetchUrl(bad);
    } catch (error) {
      refused = message(error);
    }
    assert(`refuses ${JSON.stringify(bad)} before any request`, refused !== undefined && refused.startsWith('web_fetch:'));
  }

  assert('truncation notice is formatted from the shared template', formatTruncationNotice(1000, 5000) === '[truncated: 1000 of 5000 code points]');
  const emoji = boundCodePoints('a😀b😀c', 3);
  assert('boundCodePoints cuts at a code-point boundary and counts code points',
    emoji.body === 'a😀b' && emoji.shown === 3 && emoji.total === 5);
  const whole = boundCodePoints('abc', 3);
  assert('boundCodePoints keeps a body at the budget whole', whole.body === 'abc' && whole.shown === 3 && whole.total === 3);
  assert('named, decimal and hex entities decode; unknown names stay literal',
    decodeEntities('a &amp; b &#8212; c &#x41; &nbsp;&unknownthing; &lt;x&gt;') === 'a & b — c A \u00a0&unknownthing; <x>');

  const html = `<!DOCTYPE html><html><head><title>Docs &amp; Guides</title><style>body{color:red}</style>
<script>var hidden = "<b>SCRIPT_TEXT</b>";</script></head>
<body><nav><ul><li><a href="/home">NAV_TEXT</a></li></ul></nav><header><h1>HEADER_TEXT</h1></header>
<main>
<h1>Tools   reference</h1>
<p>Claude&nbsp;Code &mdash; uses <code>WebFetch</code> &#8212; see <a href="/docs/tools">the tools page</a> and <a href="https://example.com/abs">https://example.com/abs</a>.</p>
<h2>Section</h2>
<ul><li>first   item</li><li>second <em>item</em></li></ul>
<blockquote><p>quoted   text</p></blockquote>
<pre><code class="lang-ts">const a = 1;
  if (a &lt; 2) {}
</code></pre>
<img src="x.png" alt="diagram of flow"><br>after break
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<!-- COMMENT_TEXT --><template><p>TEMPLATE_TEXT</p></template><svg><text>SVG_TEXT</text></svg><noscript>NOSCRIPT_TEXT</noscript>
</main><footer>FOOTER_TEXT</footer><aside>ASIDE_TEXT</aside></body></html>`;
  const text = htmlToText(html, 'https://example.com/docs/index.html');
  const lines = text.split('\n');
  assert('title becomes the first heading with entities decoded', lines[0] === '# Docs & Guides');
  assert('h1/h2 become #-prefixed lines with whitespace collapsed',
    lines.includes('# Tools reference') && lines.includes('## Section'));
  assert('paragraph decodes nbsp/mdash/numeric entities, backticks inline code and renders links as text (absolute url)',
    lines.includes('Claude Code — uses `WebFetch` — see the tools page (https://example.com/docs/tools) and https://example.com/abs.'));
  assert('list items become "- " lines', lines.includes('- first item') && lines.includes('- second item'));
  assert('blockquote becomes "> " lines', lines.includes('> quoted text'));
  assert('pre is fenced and its whitespace preserved',
    text.includes('```\nconst a = 1;\n  if (a < 2) {}\n```'));
  assert('images become [image: alt] and br breaks the line', lines.includes('[image: diagram of flow]') && lines.includes('after break'));
  assert('table cells are separated by pipes', lines.includes('A | B') && lines.includes('1 | 2'));
  for (const dropped of ['SCRIPT_TEXT', 'NAV_TEXT', 'HEADER_TEXT', 'FOOTER_TEXT', 'ASIDE_TEXT', 'COMMENT_TEXT', 'TEMPLATE_TEXT', 'SVG_TEXT', 'NOSCRIPT_TEXT', 'color:red']) {
    assert(`drops ${dropped}`, !text.includes(dropped));
  }
  assert('blank-line runs are collapsed', !text.includes('\n\n\n'));
  assert('malformed markup degrades to text instead of failing',
    htmlToText('<p>a < b and <unclosed <b>bold', 'https://x.invalid/') === 'a < b and bold');
}

// ---------------------------------------------------------------------------
header('web_fetch — local fixture: negotiation, projection, bounds, redirects, cancel');
interface Recorded { path: string; accept: string | undefined; userAgent: string | undefined }
const recorded: Recorded[] = [];
const hanging: http.ServerResponse[] = [];
const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  recorded.push({ path: url, accept: req.headers.accept, userAgent: req.headers['user-agent'] });
  res.on('error', () => undefined);
  const send = (status: number, headers: Record<string, string>, body: string | Buffer) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  switch (url) {
    case '/markdown':
      return send(200, { 'Content-Type': 'text/markdown; charset=utf-8' }, '# Served markdown\n\n- kept *verbatim*  \n');
    case '/page':
      return send(200, { 'Content-Type': 'text/html; charset=utf-8' },
        '<html><head><title>Fixture</title><script>x()</script></head><body><nav>NAV</nav><h1>Heading</h1><p>Body &amp; <a href="/rel">rel</a></p></body></html>');
    case '/untyped':
      return send(200, {}, '<!doctype html><html><body><h1>Sniffed</h1></body></html>');
    case '/json':
      return send(200, { 'Content-Type': 'application/json' }, '{"a":1}');
    case '/binary':
      return send(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' }, Buffer.from([0, 1, 2]));
    case '/emoji':
      return send(200, { 'Content-Type': 'text/plain; charset=utf-8' }, '😀'.repeat(5000));
    case '/long':
      return send(200, { 'Content-Type': 'text/plain' }, 'y'.repeat(50_000));
    case '/huge': {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(256 * 1024, 'x');
      let written = 0;
      const pump = () => {
        while (written < WEB_FETCH_MAX_DOWNLOAD_BYTES + 1024 * 1024) {
          written += chunk.byteLength;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    case '/redirect-same':
      return send(302, { Location: '/final' }, '');
    case '/final':
      return send(200, { 'Content-Type': 'text/plain' }, 'final page');
    case '/redirect-cross':
      return send(302, { Location: 'https://other.invalid/landing' }, '');
    case '/loop':
      return send(301, { Location: '/loop' }, '');
    case '/missing':
      return send(404, { 'Content-Type': 'text/plain' }, 'gone');
    case '/hang':
      hanging.push(res);
      return;
    default:
      return send(500, { 'Content-Type': 'text/plain' }, `unexpected ${url}`);
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const origin = `https://127.0.0.1:${port}`;
const requested: string[] = [];
const originalFetch = globalThis.fetch;
/** The tool speaks https; the fixture is plain http. Rewrite only our own origin. */
const fixtureFetch: typeof fetch = (input, init) => {
  const url = String(input);
  requested.push(url);
  return originalFetch(url.startsWith(origin) ? `http://127.0.0.1:${port}${url.slice(origin.length)}` : url, init);
};
const lastRecorded = (): Recorded | undefined => recorded[recorded.length - 1];

try {
  const markdown = await fetchWebPage({ url: `${origin}/markdown` }, { fetchImpl: fixtureFetch });
  assert('markdown response is returned verbatim', markdown.body === '# Served markdown\n\n- kept *verbatim*  \n');
  assert('result reports status, content type and final url',
    markdown.status === 200 && markdown.contentType.startsWith('text/markdown') && markdown.url === `${origin}/markdown`);
  assert('markdown carries no projection or truncation notice', markdown.notice.length === 0);
  assert('result exposes exactly url, status, contentType, body and notice',
    Object.keys(markdown).join(',') === 'url,status,contentType,body,notice');
  assert('Accept header prefers markdown', lastRecorded()?.accept === WEB_FETCH_ACCEPT
    && WEB_FETCH_ACCEPT === 'text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1');
  assert('User-Agent names darwin', (lastRecorded()?.userAgent ?? '').includes('darwin'));

  requested.length = 0;
  const upgraded = await fetchWebPage({ url: `http://127.0.0.1:${port}/markdown` }, { fetchImpl: fixtureFetch });
  assert('an http:// input is requested over https:// and the result states the upgrade',
    requested[0] === `${origin}/markdown` && upgraded.url === `${origin}/markdown`
      && upgraded.notice.some((line) => line.includes('Upgraded http://127.0.0.1') && line.includes(origin)));

  const page = await fetchWebPage({ url: `${origin}/page` }, { fetchImpl: fixtureFetch });
  assert('HTML response becomes the readable projection with absolute links',
    page.body === `# Fixture\n\n# Heading\n\nBody & rel (${origin}/rel)`);
  assert('HTML result carries the lossy notice', page.notice.includes(WEB_FETCH_LOSSY_NOTICE));

  const untyped = await fetchWebPage({ url: `${origin}/untyped` }, { fetchImpl: fixtureFetch });
  assert('an untyped HTML body is sniffed and projected', untyped.body === '# Sniffed' && untyped.contentType === '');

  const json = await fetchWebPage({ url: `${origin}/json` }, { fetchImpl: fixtureFetch });
  assert('other text types are kept verbatim', json.body === '{"a":1}' && json.notice.length === 0);

  const binary = await rejects(() => fetchWebPage({ url: `${origin}/binary` }, { fetchImpl: fixtureFetch }));
  assert('a binary content type is a bounded error naming type and length, never bytes',
    binary !== undefined && binary.includes('application/octet-stream') && binary.includes('3 bytes') && !binary.includes('\u0000'));

  const emoji = await fetchWebPage({ url: `${origin}/emoji`, maxChars: 1000 }, { fetchImpl: fixtureFetch });
  assert('maxChars bounds the body in code points, not UTF-16 units',
    emoji.body === '😀'.repeat(1000) && [...emoji.body].length === 1000);
  assert('truncation notice states exact N of M', emoji.notice.includes('[truncated: 1000 of 5000 code points]'));

  const clamped = await fetchWebPage({ url: `${origin}/long`, maxChars: 10_000_000 }, { fetchImpl: fixtureFetch });
  assert('maxChars above the ceiling is clamped to the ceiling and stated',
    [...clamped.body].length === WEB_FETCH_MAX_CHARS
      && clamped.notice.includes(`[truncated: ${WEB_FETCH_MAX_CHARS} of 50000 code points]`)
      && clamped.notice.some((line) => line.includes('clamped')));
  const under = await fetchWebPage({ url: `${origin}/final` }, { fetchImpl: fixtureFetch });
  assert('a body under the budget has no truncation notice',
    under.body === 'final page' && !under.notice.some((line) => line.startsWith('[truncated:')));

  const huge = await fetchWebPage({ url: `${origin}/huge` }, { fetchImpl: fixtureFetch });
  assert('the raw download stops at the byte cap and says so',
    huge.notice.some((line) => line.includes(`${WEB_FETCH_MAX_DOWNLOAD_BYTES} bytes`))
      && huge.notice.includes(`[truncated: ${WEB_FETCH_MAX_CHARS} of ${WEB_FETCH_MAX_DOWNLOAD_BYTES} code points]`)
      && [...huge.body].length === WEB_FETCH_MAX_CHARS);

  requested.length = 0;
  const same = await fetchWebPage({ url: `${origin}/redirect-same` }, { fetchImpl: fixtureFetch });
  assert('a same-host redirect is followed and the final url reported',
    same.url === `${origin}/final` && same.status === 200 && same.body === 'final page' && requested.length === 2);

  requested.length = 0;
  const cross = await fetchWebPage({ url: `${origin}/redirect-cross` }, { fetchImpl: fixtureFetch });
  assert('a cross-host redirect is not followed: one request, original url, redirect status, empty body',
    requested.length === 1 && cross.url === `${origin}/redirect-cross` && cross.status === 302 && cross.body === '');
  assert('the cross-host notice names both URLs',
    cross.notice.some((line) => line.includes(`${origin}/redirect-cross`) && line.includes('https://other.invalid/landing')));

  requested.length = 0;
  const loop = await rejects(() => fetchWebPage({ url: `${origin}/loop` }, { fetchImpl: fixtureFetch }));
  assert('a redirect loop ends with a bounded error after the hop limit',
    loop !== undefined && loop.includes(`more than ${WEB_FETCH_MAX_REDIRECTS} redirects`) && requested.length === WEB_FETCH_MAX_REDIRECTS + 1);

  const missing = await fetchWebPage({ url: `${origin}/missing` }, { fetchImpl: fixtureFetch });
  assert('a non-2xx status keeps the body and states the status',
    missing.status === 404 && missing.body === 'gone' && missing.notice.some((line) => line.startsWith('HTTP 404')));

  // The tool callback itself: cancellation through ToolContext.cancelSignal.
  globalThis.fetch = fixtureFetch;
  const controller = new AbortController();
  const context = { cancelSignal: controller.signal } as unknown as ToolContext;
  const before = recorded.length;
  const pending = webFetch.invoke({ url: `${origin}/hang` }, context);
  await new Promise<void>((resolve) => {
    const tick = () => (recorded.length > before ? resolve() : setTimeout(tick, 5));
    tick();
  });
  controller.abort();
  const cancelled = await rejects(() => pending);
  assert('cancelSignal aborts the in-flight request with a bounded cancellation error',
    cancelled !== undefined && cancelled.includes('cancelled') && cancelled.includes(`GET ${origin}/hang`));
  assert('the cancelled request reached the fixture exactly once', recorded.length === before + 1);
  globalThis.fetch = originalFetch;
} finally {
  globalThis.fetch = originalFetch;
  for (const res of hanging) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
header('web_fetch — permission classification, parent registration, child exclusion');
const INPUT = { url: 'https://example.invalid/offline-proof' } as const;

class WebFetchModel extends Model<BaseModelConfig> {
  calls = 0;
  private config: BaseModelConfig = { modelId: 'fake.web-fetch-tool', contextWindowLimit: 32_000 };

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const hasResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: WEB_FETCH_TOOL_NAME, toolUseId: `fetch-${this.calls}` },
      };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(INPUT) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'denial observed' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function runtimeAgent(runtime: AgentRuntime): Agent {
  return (runtime as unknown as { agent: Agent }).agent;
}

async function createRuntime(
  root: string,
  model: WebFetchModel,
  permissionBridge: (request: AssessedPermissionRequest) => Promise<{ allowed: boolean }>,
  permissionModeOverride?: 'plan',
): Promise<AgentRuntime> {
  setRuntimeModelFactoryForTest(async () => model);
  return AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge,
    ...(permissionModeOverride === undefined ? {} : { permissionModeOverride }),
  });
}

function probeAgent(name: string, tools: string): string {
  return `---\nname: ${name}\ndescription: probe\ntools: ${tools}\n---\nProbe.\n`;
}

{
  const classified = classify(WEB_FETCH_TOOL_NAME, INPUT);
  assert('classify(web_fetch) takes the unknown-tool fail-closed path: execute, never read',
    classified.kind === 'execute' && classified.summary.includes('web_fetch'));
  assert('the permission details show the URL', classified.details.some((detail) => detail.value.includes(INPUT.url)));
}

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-web-fetch-'));
let fetchCalls = 0;
globalThis.fetch = (() => {
  fetchCalls += 1;
  throw new Error('offline test must never invoke fetch');
}) as typeof fetch;
let defaultRuntime: AgentRuntime | undefined;
let planRuntime: AgentRuntime | undefined;
try {
  await writeFile(configPath(), `${JSON.stringify({
    provider: 'bedrock', model: 'fake.web-fetch-tool', region: 'us-west-2', contextOffload: false,
  })}\n`);
  const agentsDir = path.join(root, '.darwin', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'wants-web-fetch.md'), probeAgent('wants-web-fetch', '["web_fetch"]'));
  await writeFile(path.join(agentsDir, 'wants-http-request.md'), probeAgent('wants-http-request', '["http_request"]'));
  await writeFile(path.join(agentsDir, 'wants-bash.md'), probeAgent('wants-bash', '["bash"]'));

  const asked: AssessedPermissionRequest[] = [];
  const defaultModel = new WebFetchModel();
  defaultRuntime = await createRuntime(root, defaultModel, async (request) => {
    asked.push(request);
    return { allowed: false };
  });
  const registered = runtimeAgent(defaultRuntime).tools.filter((tool) => tool.name === WEB_FETCH_TOOL_NAME);
  assert('fresh parent runtime registers exactly the web_fetch module export',
    registered.length === 1 && registered[0] === webFetch);
  assert('http_request is still registered alongside it, untouched',
    runtimeAgent(defaultRuntime).tools.filter((tool) => tool === httpRequest).length === 1);

  const problems = defaultRuntime.info.agentProblems;
  assert('a child definition asking for web_fetch is refused: the tool is not in the child catalogue',
    problems.some((problem) => problem.file.endsWith('wants-web-fetch.md') && problem.reason.includes('unknown tool "web_fetch"')));
  assert('a child definition asking for http_request is refused the same way',
    problems.some((problem) => problem.file.endsWith('wants-http-request.md') && problem.reason.includes('unknown tool "http_request"')));
  assert('the bash control definition loads', defaultRuntime.info.agentNames.includes('wants-bash')
    && !problems.some((problem) => problem.file.endsWith('wants-bash.md')));

  for await (const _event of defaultRuntime.send('fetch a page')) void _event;
  assert('ordinary permission bridge receives one web_fetch call', asked.length === 1);
  assert('web_fetch is presented as parent execute with the URL in its details',
    asked[0]?.toolName === WEB_FETCH_TOOL_NAME && asked[0].kind === 'execute' && asked[0].source.kind === 'parent'
      && asked[0].details.some((detail) => detail.value.includes(INPUT.url)));
  assert('denial returns through the ordinary SDK loop without invoking fetch',
    defaultModel.calls === 2 && fetchCalls === 0);

  const planAsked: AssessedPermissionRequest[] = [];
  const planModel = new WebFetchModel();
  planRuntime = await createRuntime(`${root}-plan`, planModel, async (request) => {
    planAsked.push(request);
    return { allowed: true };
  }, 'plan');
  for await (const _event of planRuntime.send('fetch a page in plan mode')) void _event;
  assert('plan mode denies web_fetch before prompting', planAsked.length === 0);
  assert('plan denial returns through the ordinary SDK loop without invoking fetch',
    planModel.calls === 2 && fetchCalls === 0);
} finally {
  await planRuntime?.shutdown();
  await defaultRuntime?.shutdown();
  setRuntimeModelFactoryForTest(undefined);
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
  await rm(`${root}-plan`, { recursive: true, force: true });
}

report();
