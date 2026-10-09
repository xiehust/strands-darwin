/** Parent user-command writer, deliberately outside the CLI listing's import closure. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  checkedLabelDirectory, checkedLabelFile, sessionLabelPath, validateSessionLabel,
  MAX_SESSION_LABEL_BYTES,
} from './session-label.js';

export async function writeSessionLabel(projectRoot: string, sessionId: string, raw: string): Promise<string> {
  const parsed = validateSessionLabel(raw);
  if ('problem' in parsed) throw new Error(parsed.problem);
  const file = sessionLabelPath(projectRoot, sessionId);
  const directory = path.dirname(file);
  const before = await checkedLabelDirectory(directory);
  await checkedLabelFile(file);
  const bytes = `${JSON.stringify({ version: 1, label: parsed.label })}\n`;
  if (Buffer.byteLength(bytes) > MAX_SESSION_LABEL_BYTES) throw new Error('Session label metadata exceeds bound');
  const temp = path.join(directory, `.label-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const after = await checkedLabelDirectory(directory);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Session label state path changed');
    await checkedLabelFile(file);
    await rename(temp, file);
    created = false;
    // Persist the directory entry as well as the new file's bytes.
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    return parsed.label;
  } finally {
    await handle?.close();
    if (created) await unlink(temp);
  }
}
