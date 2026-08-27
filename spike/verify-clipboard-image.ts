/** Free contracts for clipboard helper selection, decoding, and bounded failures. */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import {
  clipboardImageCommand,
  clipboardImageFact,
  readClipboardImage,
} from '../src/tui/clipboard-image.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-clipboard-image-'));
try {
  header('clipboard image — platform selection is explicit');
  assert('Wayland uses a MIME-selecting wl-paste invocation',
    clipboardImageCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' }).command === 'wl-paste');
  assert('X11 uses a MIME-selecting xclip invocation',
    clipboardImageCommand('linux', { DISPLAY: ':1' }).command === 'xclip');
  assert('macOS uses pngpaste', clipboardImageCommand('darwin', {}).command === 'pngpaste');

  let unsupported = '';
  try {
    clipboardImageCommand('linux', {});
  } catch (error) {
    unsupported = error instanceof Error ? error.message : String(error);
  }
  assert('headless Linux failure is explicit', unsupported.includes('Wayland DISPLAY'));

  header('clipboard image — helper bytes use shared decoder');
  const source = await sharp({ create: { width: 18, height: 12, channels: 4, background: '#2468ac' } })
    .png()
    .toBuffer();
  const helper = path.join(root, 'wl-paste');
  await writeFile(helper, `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(process.env.CLIPBOARD_FIXTURE));\n`);
  await chmod(helper, 0o755);
  const fixture = path.join(root, 'clipboard.png');
  await writeFile(fixture, source);
  const image = await readClipboardImage({
    platform: 'linux',
    env: { PATH: root, WAYLAND_DISPLAY: 'test', CLIPBOARD_FIXTURE: fixture },
  });
  assert('clipboard image decodes as exact PNG bytes',
    image.format === 'png' && image.source.type === 'imageSourceBytes' && Buffer.from(image.source.bytes).equals(source));
  const fact = clipboardImageFact(image);
  assert('visible fact is bounded and truthful',
    fact.includes('image attached · PNG') && fact.includes('Ctrl+O remove') && !fact.includes(fixture));

  await writeFile(helper, `#!${process.execPath}\nprocess.stdout.write('not an image');\n`);
  let invalid = '';
  try {
    await readClipboardImage({ platform: 'linux', env: { PATH: root, WAYLAND_DISPLAY: 'test' } });
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  assert('invalid clipboard bytes fail explicitly', invalid.includes('invalid or unsupported'));

  let missing = '';
  try {
    await readClipboardImage({ platform: 'linux', env: { PATH: '/definitely/missing', WAYLAND_DISPLAY: 'test' } });
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error);
  }
  assert('missing helper failure stays explicit', missing.includes('wl-paste is not installed'));
} finally {
  await rm(root, { recursive: true, force: true });
}

report();
