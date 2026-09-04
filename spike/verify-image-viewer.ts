/** Offline contract tests for the read-only local image tool. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ImageBlock, Message, TextBlock, ToolResultBlock } from '@strands-agents/sdk';
import sharp from 'sharp';

import {
  createImageViewerTool,
  loadLocalImage,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  decodeImageBytes,
  normalizeRestoredImages,

  MAX_INPUT_PIXELS,
  MAX_REQUEST_PATH_CHARS,
  MAX_SOURCE_BYTES,
} from '../src/tools/image-viewer.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-image-viewer-'));

function bytesOf(block: ImageBlock): Buffer {
  if (block.source.type !== 'imageSourceBytes') throw new Error('expected byte-backed image');
  return Buffer.from(block.source.bytes);
}

async function errorOf(filePath: string): Promise<string> {
  try {
    await loadLocalImage(root, filePath);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

try {
  header('image viewer — supported formats and path resolution');

  const fixtures = path.join(root, 'screenshots');
  await mkdir(fixtures);
  const sources = new Map<string, Buffer>([
    ['sample.png', await sharp({ create: { width: 32, height: 24, channels: 4, background: '#336699' } }).png().toBuffer()],
    ['sample.JPG', await sharp({ create: { width: 31, height: 23, channels: 3, background: '#993366' } }).jpeg().toBuffer()],
    ['sample.gif', await sharp({ create: { width: 30, height: 22, channels: 4, background: '#669933' } }).gif().toBuffer()],
    ['sample.webp', await sharp({ create: { width: 29, height: 21, channels: 4, background: '#663399' } }).webp().toBuffer()],
  ]);

  for (const [name, source] of sources) await writeFile(path.join(fixtures, name), source);

  const relative = await loadLocalImage(root, 'screenshots/sample.png');
  assert('relative path resolves from project root', relative.format === 'png');
  assert('compliant static PNG preserves exact bytes', bytesOf(relative).equals(sources.get('sample.png')!));

  const absolute = await loadLocalImage('/some/other/root', path.join(fixtures, 'sample.JPG'));
  assert('absolute path is used as given', absolute.format === 'jpeg');
  assert('uppercase .JPG maps to canonical jpeg', bytesOf(absolute).equals(sources.get('sample.JPG')!));

  for (const [name, expected] of [['sample.gif', 'gif'], ['sample.webp', 'webp']] as const) {
    const block = await loadLocalImage(root, `screenshots/${name}`);
    assert(`${expected} static input passes through`, block.format === expected && bytesOf(block).equals(sources.get(name)!));
  }

  header('image viewer — bounded normalization');

  // A tiny uncompressed PNG exceeds the byte cap but is cheap to decode and
  // becomes a small WebP, proving the byte-triggered path without a huge fixture.
  const noisy = Buffer.alloc(1400 * 1400 * 3);
  let seed = 0x12345678;
  for (let index = 0; index < noisy.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noisy[index] = seed & 0xff;
  }
  const oversizedPng = await sharp(noisy, { raw: { width: 1400, height: 1400, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  assert('generated input exceeds Bedrock byte limit', oversizedPng.byteLength > MAX_IMAGE_BYTES);
  await writeFile(path.join(fixtures, 'oversized.png'), oversizedPng);
  const compressed = await loadLocalImage(root, 'screenshots/oversized.png');
  const compressedBytes = bytesOf(compressed);
  const compressedMetadata = await sharp(compressedBytes).metadata();
  assert('oversized image is converted to WebP', compressed.format === 'webp' && compressedMetadata.format === 'webp');
  assert('compressed payload fits Bedrock byte limit', compressedBytes.byteLength <= MAX_IMAGE_BYTES);
  assert(
    'compressed dimensions fit Bedrock limits',
    (compressedMetadata.width ?? Infinity) <= MAX_IMAGE_DIMENSION &&
      (compressedMetadata.height ?? Infinity) <= MAX_IMAGE_DIMENSION,
  );

  const widePng = await sharp({ create: { width: 8100, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  await writeFile(path.join(fixtures, 'wide.png'), widePng);
  const resized = await loadLocalImage(root, 'screenshots/wide.png');
  const resizedMetadata = await sharp(bytesOf(resized)).metadata();
  assert('over-dimension image is converted to WebP', resized.format === 'webp');
  assert('over-dimension image is resized within the dimension cap', (resizedMetadata.width ?? Infinity) <= MAX_IMAGE_DIMENSION);

  // Anthropic rejects any image over 2000px on either edge once a request
  // carries more than 20 images ("many-image requests"); tool-result images
  // accumulate across turns, so the cap is exactly that limit.
  assert('dimension cap is the many-image limit of 2000px', MAX_IMAGE_DIMENSION === 2000);
  const atCap = await sharp({ create: { width: 2000, height: 4, channels: 3, background: 'green' } }).png().toBuffer();
  const atCapBlock = await decodeImageBytes(atCap, '.png');
  assert('an image exactly at the cap passes through unchanged', atCapBlock.format === 'png' && bytesOf(atCapBlock).equals(atCap));
  const overCap = await sharp({ create: { width: 2001, height: 4, channels: 3, background: 'green' } }).png().toBuffer();
  const overCapBlock = await decodeImageBytes(overCap, '.png');
  const overCapMetadata = await sharp(bytesOf(overCapBlock)).metadata();
  assert('one pixel over the cap is normalized',
    overCapBlock.format === 'webp' && (overCapMetadata.width ?? Infinity) <= MAX_IMAGE_DIMENSION);

  // Sharp's create input can stamp EXIF orientation. The normalized result should
  // have physical dimensions matching the auto-oriented view.
  const orientedJpeg = await sharp({ create: { width: 8100, height: 3, channels: 3, background: 'blue' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  await writeFile(path.join(fixtures, 'oriented.jpg'), orientedJpeg);
  const oriented = await loadLocalImage(root, 'screenshots/oriented.jpg');
  const orientedMetadata = await sharp(bytesOf(oriented)).metadata();
  assert(
    'normalization applies EXIF orientation before resize',
    (orientedMetadata.width ?? 0) < (orientedMetadata.height ?? 0) &&
      (orientedMetadata.height ?? Infinity) <= MAX_IMAGE_DIMENSION,
  );

  const animatedGif = Buffer.from(
    '47494638396101000100800000000000ffffff21ff0b4e45545343415045322e300301000000' +
      '21f904000a0000002c0000000001000100000202440100' +
      '21f904000a0000002c00000000010001000002024401003b',
    'hex',
  );
  await writeFile(path.join(fixtures, 'animated.gif'), animatedGif);
  const flattened = await loadLocalImage(root, 'screenshots/animated.gif');
  const flattenedMetadata = await sharp(bytesOf(flattened)).metadata();
  assert('animated GIF is flattened to WebP', flattened.format === 'webp' && flattenedMetadata.format === 'webp');
  assert('animated GIF result contains one static frame', (flattenedMetadata.pages ?? 1) === 1);
  header('image decoder — shared byte source policy');

  const decodedClipboardBytes = await decodeImageBytes(sources.get('sample.png')!, '.png', 'clipboard image');
  assert('byte source preserves a compliant PNG exactly',
    decodedClipboardBytes.format === 'png' && bytesOf(decodedClipboardBytes).equals(sources.get('sample.png')!));
  let mismatchedBytes = '';
  try {
    await decodeImageBytes(sources.get('sample.JPG')!, '.png', 'clipboard image');
  } catch (error) {
    mismatchedBytes = error instanceof Error ? error.message : String(error);
  }
  assert('byte source rejects MIME/decoded-format mismatch through shared policy',
    mismatchedBytes.includes('clipboard image: extension declares png'));

  header('restored history — oversized images are re-normalized in place');

  // A session saved under the old 8000px cap: one oversized tool-result image,
  // one compliant one, one oversized direct user image, text and a corrupt
  // image block that must be left alone.
  const compliantBytes = sources.get('sample.png')!;
  const corrupt = new ImageBlock({ format: 'png', source: { bytes: Buffer.from('not an image') } });
  const keptText = new TextBlock('screenshot follows');
  const restored = [
    new Message({ role: 'user', content: [keptText, new ImageBlock({ format: 'png', source: { bytes: overCap } })] }),
    new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'image-1',
          status: 'success',
          content: [new ImageBlock({ format: 'png', source: { bytes: widePng } })],
        }),
        new ToolResultBlock({
          toolUseId: 'image-2',
          status: 'success',
          content: [new ImageBlock({ format: 'png', source: { bytes: compliantBytes } }), corrupt],
        }),
      ],
    }),
    new Message({ role: 'assistant', content: [new TextBlock('ok')] }),
  ];
  const beforeLengths = restored.map((message) => message.content.length);
  const repairedCount = await normalizeRestoredImages(restored);
  assert('exactly the two oversized images are counted', repairedCount === 2);
  assert('message and block counts are unchanged', restored.every((message, index) => message.content.length === beforeLengths[index]));
  assert('non-image blocks keep identity', restored[0]!.content[0] === keptText && restored[2]!.content[0]!.type === 'textBlock');
  const userImage = restored[0]!.content[1];
  const userImageMetadata = userImage instanceof ImageBlock ? await sharp(bytesOf(userImage)).metadata() : undefined;
  assert('oversized direct user image is shrunk within the cap',
    userImage instanceof ImageBlock && userImage.format === 'webp' && (userImageMetadata?.width ?? Infinity) <= MAX_IMAGE_DIMENSION);
  const firstResult = restored[1]!.content[0];
  const toolImage = firstResult instanceof ToolResultBlock ? firstResult.content[0] : undefined;
  const toolImageMetadata = toolImage instanceof ImageBlock ? await sharp(bytesOf(toolImage)).metadata() : undefined;
  assert('oversized tool-result image is shrunk within the cap',
    toolImage instanceof ImageBlock && toolImage.format === 'webp' && (toolImageMetadata?.width ?? Infinity) <= MAX_IMAGE_DIMENSION);
  const secondResult = restored[1]!.content[1];
  const compliantImage = secondResult instanceof ToolResultBlock ? secondResult.content[0] : undefined;
  assert('compliant tool-result image keeps its exact bytes',
    compliantImage instanceof ImageBlock && compliantImage.format === 'png' && bytesOf(compliantImage).equals(compliantBytes));
  assert('undecodable image block is left untouched, not thrown',
    secondResult instanceof ToolResultBlock && secondResult.content[1] === corrupt);
  assert('a second pass finds nothing to repair', (await normalizeRestoredImages(restored)) === 0);
  assert('empty history is a no-op', (await normalizeRestoredImages([])) === 0);



  header('image viewer — SDK tool result');

  const viewer = createImageViewerTool(root);
  const direct = await viewer.invoke({ path: 'screenshots/sample.png' });
  assert('direct tool invocation returns an ImageBlock', direct instanceof ImageBlock);
  const stream = viewer.stream({
    toolUse: { name: viewer.name, toolUseId: 'image-1', input: { path: 'screenshots/sample.png' } },
  } as never);
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  const toolResult = step.value;
  assert('SDK wraps the image in a successful tool result', toolResult.status === 'success');
  assert('SDK tool result carries image content', toolResult.content[0] instanceof ImageBlock);

  const firstQueued = viewer.invoke({ path: 'screenshots/missing.png' }).catch(() => undefined);
  const secondQueued = viewer.invoke({ path: 'screenshots/sample.png' });
  const [, afterFailure] = await Promise.all([firstQueued, secondQueued]);
  assert('a failed queued read does not block the next image', afterFailure instanceof ImageBlock);

  header('image viewer — failures and resource bounds');

  await mkdir(path.join(fixtures, 'directory.png'));
  await writeFile(path.join(fixtures, 'empty.png'), '');
  await writeFile(path.join(fixtures, 'plain.txt'), 'not an image');
  await writeFile(path.join(fixtures, 'spoofed.png'), sources.get('sample.JPG')!);
  await writeFile(path.join(fixtures, 'broken.png'), 'not an image');

  assert('missing path error names the resolved path', (await errorOf('screenshots/missing.png')).includes(path.join(fixtures, 'missing.png')));
  assert('directory is rejected as non-regular', (await errorOf('screenshots/directory.png')).includes('not a regular file'));
  assert('empty file is rejected', (await errorOf('screenshots/empty.png')).includes('file is empty'));
  assert('unsupported extension lists accepted formats', (await errorOf('screenshots/plain.txt')).includes('expected .png, .jpg, .jpeg, .gif, or .webp'));
  assert('extension/content mismatch is rejected', (await errorOf('screenshots/spoofed.png')).includes('extension declares png'));
  assert('corrupt supported content is rejected', (await errorOf('screenshots/broken.png')).includes('Could not read image'));
  assert(
    'direct loader bounds untrusted path input',
    (await errorOf('x'.repeat(MAX_REQUEST_PATH_CHARS + 1))).includes('path must contain'),
  );

  const tooLarge = path.join(fixtures, 'too-large.png');
  const largeHandle = await import('node:fs/promises').then(({ open }) => open(tooLarge, 'w'));
  await largeHandle.truncate(MAX_SOURCE_BYTES + 1);
  await largeHandle.close();
  assert('source byte bound rejects before decode', (await errorOf('screenshots/too-large.png')).includes('maximum source size'));

  const tooManyPixels = await sharp({ create: { width: 10_001, height: 10_001, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  await writeFile(path.join(fixtures, 'too-many-pixels.png'), tooManyPixels);
  assert(
    'decoded pixel bound is actionable',
    (await errorOf('screenshots/too-many-pixels.png')).toLowerCase().includes('pixel limit'),
  );
  assert('resource constants retain intended ordering', MAX_INPUT_PIXELS === 100_000_000 && MAX_SOURCE_BYTES > MAX_IMAGE_BYTES);

  // A failed tool call becomes a normal SDK error result rather than rejecting
  // the agent loop's stream.
  const failed = viewer.stream({
    toolUse: { name: viewer.name, toolUseId: 'image-2', input: { path: 'screenshots/missing.png' } },
  } as never);
  let failedStep = await failed.next();
  while (!failedStep.done) failedStep = await failed.next();
  assert('callback failure becomes an SDK error tool result', failedStep.value.status === 'error');
  assert(
    'error tool result keeps the actionable path',
    failedStep.value.content.some((content) => content.type === 'textBlock' && content.text.includes('missing.png')),
  );

  // The tool is read-only: all original fixture bytes still match after calls.
  assert('image inspection does not modify source bytes', (await readFile(path.join(fixtures, 'sample.png'))).equals(sources.get('sample.png')!));
} finally {
  await rm(root, { recursive: true, force: true });
}

report();
