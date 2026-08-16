import { open } from 'node:fs/promises';
import path from 'node:path';

import { ImageBlock, tool, type ImageFormat, type InvokableTool } from '@strands-agents/sdk';
import sharp from 'sharp';
import { z } from 'zod';

export const IMAGE_VIEWER_TOOL_NAME = 'imageViewer';

/** Bedrock Converse's per-image payload and dimension limits. */
export const MAX_IMAGE_BYTES = 3_932_160;
export const MAX_IMAGE_DIMENSION = 8_000;

/** Darwin-owned resource bounds for untrusted local input. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 100_000_000;
export const MAX_REQUEST_PATH_CHARS = 4_096;

const MIN_NORMALIZED_DIMENSION = 256;
const MAX_RESIZE_ATTEMPTS = 17;
const WEBP_QUALITIES = [85, 75, 65, 55, 45, 35] as const;

const EXTENSION_FORMATS = new Map<string, ImageFormat>([
  ['.png', 'png'],
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.gif', 'gif'],
  ['.webp', 'webp'],
]);

export function createImageViewerTool(projectRoot: string): InvokableTool<{ path: string }, ImageBlock> {
  // The SDK may execute several tool calls concurrently. Sharp's per-image pixel
  // bound would not bound their aggregate native memory, so one shared catalogue
  // serializes image decoding across the parent and every child agent.
  let decodeChain: Promise<void> = Promise.resolve();
  const queuedLoad = (requestedPath: string): Promise<ImageBlock> => {
    const result = decodeChain.then(() => loadLocalImage(projectRoot, requestedPath));
    decodeChain = result.then(() => undefined, () => undefined);
    return result;
  };

  return tool({
    name: IMAGE_VIEWER_TOOL_NAME,
    description:
      'Read a local PNG, JPEG, GIF, or WebP file and return its actual image content for visual inspection. ' +
      'Use this when the user asks you to analyze a screenshot, diagram, or other image path. ' +
      'Relative paths resolve from the project root. This tool is read-only; do not use fileEditor for images.',
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .max(MAX_REQUEST_PATH_CHARS)
        .describe('Local image path, absolute or relative to the project root'),
    }),
    callback: ({ path: requestedPath }) => queuedLoad(requestedPath),
  });
}

/**
 * Loads one local image for an SDK tool result, normalizing only when Bedrock's
 * byte/dimension limits or animation require it.
 */
export async function loadLocalImage(projectRoot: string, requestedPath: string): Promise<ImageBlock> {
  if (requestedPath.length === 0 || requestedPath.length > MAX_REQUEST_PATH_CHARS) {
    const displayPath = requestedPath.length === 0
      ? '(empty path)'
      : `${requestedPath.slice(0, 120)}…`;
    throw new Error(
      `Could not read image ${displayPath}: path must contain 1-${MAX_REQUEST_PATH_CHARS} characters`,
    );
  }
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(projectRoot, requestedPath);

  try {
    const expectedFormat = formatFromPath(resolvedPath);
    const source = await readBoundedFile(resolvedPath);
    // Do not select one page here: metadata.pages must reveal animation. The
    // normalization decoder below explicitly selects page zero.
    const metadata = await sharp(source, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'warning',
    }).metadata();

    if (metadata.format !== expectedFormat) {
      throw new Error(
        `extension declares ${expectedFormat}, but the decoded content is ${metadata.format ?? 'not a supported image'}`,
      );
    }

    const width = metadata.autoOrient.width ?? metadata.width;
    const height = metadata.autoOrient.height ?? metadata.height;
    if (width === undefined || height === undefined || width < 1 || height < 1) {
      throw new Error('could not determine positive image dimensions');
    }

    const animated = (metadata.pages ?? 1) > 1;
    if (
      !animated &&
      source.byteLength <= MAX_IMAGE_BYTES &&
      width <= MAX_IMAGE_DIMENSION &&
      height <= MAX_IMAGE_DIMENSION
    ) {
      return new ImageBlock({ format: expectedFormat, source: { bytes: source } });
    }

    const normalized = await normalizeImage(source, width, height);
    return new ImageBlock({ format: 'webp', source: { bytes: normalized } });
  } catch (error) {
    throw new Error(`Could not read image ${resolvedPath}: ${describe(error)}`, { cause: error });
  }
}

function formatFromPath(filePath: string): ImageFormat {
  const extension = path.extname(filePath).toLowerCase();
  const format = EXTENSION_FORMATS.get(extension);
  if (format !== undefined) return format;
  throw new Error(
    `unsupported extension ${extension === '' ? '(none)' : extension}; expected .png, .jpg, .jpeg, .gif, or .webp`,
  );
}

async function readBoundedFile(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('path is not a regular file');
    if (before.size === 0) throw new Error('file is empty');
    if (before.size > MAX_SOURCE_BYTES) {
      throw new Error(`source is ${before.size} bytes; maximum source size is ${MAX_SOURCE_BYTES} bytes`);
    }

    // Always cap the allocation at the source budget rather than trusting a
    // concurrently mutable stat size. One extra byte detects growth past it.
    const buffer = Buffer.allocUnsafe(Math.min(before.size + 1, MAX_SOURCE_BYTES + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SOURCE_BYTES) {
      throw new Error(`source grew beyond the maximum source size of ${MAX_SOURCE_BYTES} bytes while being read`);
    }
    if (offset === 0) throw new Error('file became empty while it was being read');

    const after = await handle.stat();
    if (after.size !== offset || before.size !== offset || after.mtimeMs !== before.mtimeMs) {
      throw new Error('file changed while it was being read; retry when it is stable');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function normalizeImage(source: Buffer, sourceWidth: number, sourceHeight: number): Promise<Buffer> {
  const initialScale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / sourceWidth,
    MAX_IMAGE_DIMENSION / sourceHeight,
  );
  let width = Math.max(1, Math.floor(sourceWidth * initialScale));
  let height = Math.max(1, Math.floor(sourceHeight * initialScale));

  for (let resizeAttempt = 0; resizeAttempt < MAX_RESIZE_ATTEMPTS; resizeAttempt += 1) {
    for (const quality of WEBP_QUALITIES) {
      const output = await sharp(source, {
        page: 0,
        pages: 1,
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'warning',
      })
        .autoOrient()
        .resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4, smartSubsample: true })
        .toBuffer();
      if (output.byteLength <= MAX_IMAGE_BYTES) return output;
    }

    const largestEdge = Math.max(width, height);
    if (largestEdge <= MIN_NORMALIZED_DIMENSION) break;
    const scale = Math.max(0.8, MIN_NORMALIZED_DIMENSION / largestEdge);
    const nextWidth = Math.max(1, Math.floor(width * scale));
    const nextHeight = Math.max(1, Math.floor(height * scale));
    if (nextWidth === width && nextHeight === height) break;
    width = nextWidth;
    height = nextHeight;
  }

  throw new Error(
    `could not compress the image below ${MAX_IMAGE_BYTES} bytes without reducing its largest edge below ` +
      `${MIN_NORMALIZED_DIMENSION}px`,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
