/** Bounded, dependency-free operating-system clipboard image acquisition. */
import { spawn } from 'node:child_process';

import type { ImageBlock } from '@strands-agents/sdk';

import { decodeImageBytes, MAX_SOURCE_BYTES } from '../tools/image-viewer.js';

export interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly extension: string;
}

export interface ClipboardImageOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

export const CLIPBOARD_IMAGE_TIMEOUT_MS = 5_000;

/** Selects only helpers that can request an image MIME type without a shell. */
export function clipboardImageCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ClipboardCommand {
  if (platform === 'darwin') {
    return { command: 'pngpaste', args: ['-'], extension: '.png' };
  }
  if (platform !== 'linux') {
    throw new Error(`clipboard image input is not supported on ${platform}`);
  }
  if (env['WAYLAND_DISPLAY']) {
    return { command: 'wl-paste', args: ['--no-newline', '--type', 'image/png'], extension: '.png' };
  }
  if (env['DISPLAY']) {
    return {
      command: 'xclip',
      args: ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      extension: '.png',
    };
  }
  throw new Error('clipboard image input needs a Wayland DISPLAY, X11 DISPLAY, or macOS pngpaste');
}

/** One bounded truthful composer fact; no clipboard payload or fabricated path. */
export function clipboardImageFact(image: ImageBlock): string {
  const bytes = image.source.type === 'imageSourceBytes' ? image.source.bytes.byteLength : 0;
  const size = bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KiB`;
  return `image attached · ${image.format.toUpperCase()} · ${size} · Ctrl+O remove`;
}

/** Reads, bounds, and normalizes one clipboard image through imageViewer policy. */
export async function readClipboardImage(options: ClipboardImageOptions = {}): Promise<ImageBlock> {
  const env = options.env ?? process.env;
  const command = clipboardImageCommand(options.platform ?? process.platform, env);
  const source = await readCommand(command, env, options.timeoutMs ?? CLIPBOARD_IMAGE_TIMEOUT_MS);
  try {
    return await decodeImageBytes(source, command.extension, 'clipboard image');
  } catch (error) {
    throw new Error(`clipboard image is invalid or unsupported: ${describe(error)}`, { cause: error });
  }
}

async function readCommand(
  selected: ClipboardCommand,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(selected.command, [...selected.args], {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(chunks, bytes));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`clipboard helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    child.on('error', (error) => {
      const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${selected.command} is not installed`
        : describe(error);
      finish(new Error(`clipboard helper failed: ${hint}`, { cause: error }));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        child.kill('SIGTERM');
        finish(new Error(`clipboard image exceeds the ${MAX_SOURCE_BYTES}-byte source limit`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 512) stderr += chunk.toString('utf8', 0, 512 - stderr.length);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 240);
        finish(new Error(
          `clipboard helper exited ${signal ?? code ?? 'without a status'}${detail === '' ? '' : `: ${detail}`}`,
        ));
        return;
      }
      if (bytes === 0) {
        finish(new Error('clipboard contains no PNG image data'));
        return;
      }
      finish();
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
