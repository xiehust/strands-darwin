/**
 * RESEARCH PROBE (task 08-17-live-frame-chrome) — not part of spike/.
 *
 * Question: the landed fix bounds `liveText`. Does the *draft* still make the live
 * frame taller than the terminal, and at how many rows?
 *
 * Method: start the real TUI in a pty (no submit, so no model call at all), then
 * grow the draft one visual row at a time and count `ESC[3J` (whole-screen +
 * scrollback clear) per step. The first step with a non-zero count is the
 * threshold. Also prints the startup frame so the header's row count can be read
 * off a real run rather than counted by hand in JSX.
 *
 * The draft is grown through **bracketed paste** (`ESC[200~ … ESC[201~`, parsed by
 * `ink/build/input-parser.js` and delivered to `usePaste`), which is both the
 * reported trigger and the only growth path that provably cannot submit.
 *
 * The first version of this probe wrote `"\nrow1"` as one keystroke event and
 * *submitted* it instead: `App.tsx`'s batched-Enter path (the chunked-Enter
 * regression fix) treats leading/trailing CR/LF in a multi-character event as one
 * Enter plus printable text, so the run spent a real model turn and measured
 * nothing. A bare `"\n"` alone is Ctrl+J and does insert a newline — the
 * difference is only the write boundary, which a pty does not preserve. Hence
 * paste, plus an explicit check below that the busy hint never appears.
 *
 * HOME is repointed at an owned temp dir (same reason verify-tui.ts does it) so
 * the real ~/.darwin is untouched; the model config is copied in so the header's
 * model line is the real one. No mcp.json is copied — spawning this machine's six
 * MCP servers would cost seconds and network; the real header has one extra
 * `mcp: N server(s)` row on top of what this prints.
 *
 * Run: pnpm tsx .trellis/tasks/08-17-live-frame-chrome/research/probe-chrome-paste.ts [rows] [cols] [maxRows]
 */
import { mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const OWNED_HOME = '/tmp/darwin-chrome-research-home';
const REAL_HOME = os.homedir();
await rm(OWNED_HOME, { recursive: true, force: true });
await mkdir(path.join(OWNED_HOME, '.darwin'), { recursive: true });
try {
  await copyFile(path.join(REAL_HOME, '.darwin', 'config.json'), path.join(OWNED_HOME, '.darwin', 'config.json'));
} catch {
  // No config: the default model is used, one shorter header line.
}
process.env['HOME'] = OWNED_HOME;
process.env['AWS_CONFIG_FILE'] ??= path.join(REAL_HOME, '.aws', 'config');
process.env['AWS_SHARED_CREDENTIALS_FILE'] ??= path.join(REAL_HOME, '.aws', 'credentials');

const { startTui, REPO_ROOT } = await import('../../../../spike/tui-driver.js');

const rows = Number(process.argv[2] ?? 24);
const cols = Number(process.argv[3] ?? 80);
const maxDraftRows = Number(process.argv[4] ?? 20);

const tui = startTui({ cwd: REPO_ROOT, rows, cols });

function clears(raw: string): number {
  return raw.split('\u001b[3J').length - 1;
}

try {
  await tui.waitFor('/exit to quit', { timeoutMs: 90_000, settleMs: 600 });

  const startupFrame = tui.frame;
  console.log(`=== viewport ${cols}x${rows} — startup frame (${startupFrame.split('\n').length} lines) ===`);
  console.log(startupFrame.replace(/^/gm, '  | '));
  console.log(`=== clears during startup: ${clears(tui.raw)} ===\n`);

  let previous = tui.raw.length;
  for (let n = 1; n <= maxDraftRows; n += 1) {
    const mark = tui.mark();
    // Bracketed paste: Ink routes the payload to `usePaste`, which inserts it in
    // the draft. Never the keystroke path, which would read the newline as Enter.
    tui.send(`\u001b[200~\nrow${n}\u001b[201~`);
    await tui.waitFor(`...> row${n}`, { timeoutMs: 20_000, from: mark, settleMs: 250 });
    const raw = tui.raw.slice(previous);
    previous = tui.raw.length;
    const frame = tui.frame;
    console.log(
      `draft rows: ${n + 1}  frame lines: ${frame.split('\n').length}  ` +
        `ESC[3J this step: ${clears(raw)}  bytes: ${raw.length}`,
    );
  }

  // Proof that this run cost nothing: the streaming hint is drawn only while a
  // turn is in flight, so its absence means no prompt was ever submitted.
  console.log(
    tui.screen.includes('working…')
      ? '\n!! a turn was submitted — the measurement above is not paste-only'
      : '\nno turn was submitted at any point (no model call)',
  );

  console.log(`\ntotal ESC[3J for the whole run: ${clears(tui.raw)}`);
  const tail = tui.frame;
  console.log('=== final frame ===');
  console.log(tail.replace(/^/gm, '  | '));
} finally {
  tui.kill();
}
