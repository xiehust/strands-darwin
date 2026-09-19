/** Descriptor-relative, bounded file access for the offline setup importer. */
import { constants as C, closeSync, fstatSync, mkdirSync, openSync, opendirSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';

export const IMPORT_LIMITS = Object.freeze({ entries: 400, fileBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024, depth: 6, outputBytes: 32 * 1024 });
export class ImportProblem extends Error {}
// Linux asm-generic/fcntl.h: O_PATH = 010000000 (not exposed by Node constants).
const LINUX_O_PATH = 0x200000;

/** Linux /proc/self/fd gives Node an openat-like seam. Other hosts fail closed. */
function descriptorPath(fd: number, name = ''): string {
  if (process.platform !== 'linux') throw new ImportProblem('descriptor-safe import requires Linux; migrate manually on this host');
  return `/proc/self/fd/${fd}${name ? `/${name}` : ''}`;
}
function parts(file: string): string[] {
  if (!path.isAbsolute(file) || file.split(path.sep).some(p => p === '..' || p === '.')) throw new ImportProblem('unsafe path');
  return file.split(path.sep).filter(Boolean);
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/** Every ancestor is opened no-follow, pinned until its child is opened. */
function directory(file: string, create = false): number {
  const names = parts(file);
  let fd = openSync('/', C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const name of names) {
      const next = descriptorPath(fd, name);
      if (create) {
        try { mkdirSync(next, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
      const child = openSync(next, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      closeSync(fd);
      fd = child;
    }
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}
function withFile<T>(file: string, flags: number, createParents: boolean, use: (fd: number) => T): T {
  parts(file);
  const parent = directory(path.dirname(file), createParents);
  try {
    const target = descriptorPath(parent, path.basename(file));
    if (flags & C.O_CREAT) {
      const fd = openSync(target, flags | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
      try { return use(fd); } finally { closeSync(fd); }
    }
    // Linux O_PATH pins an inode without opening a FIFO/device for I/O. Then open
    // only that checked regular inode through procfs, never re-resolve the name.
    const pin = openSync(target, LINUX_O_PATH | C.O_NOFOLLOW);
    try {
      const stat = fstatSync(pin);
      if (!stat.isFile() || stat.nlink !== 1) throw new ImportProblem('not a single-link regular file');
      const fd = openSync(descriptorPath(pin), flags | C.O_NONBLOCK);
      try { return use(fd); } finally { closeSync(fd); }
    } finally { closeSync(pin); }
  } finally { closeSync(parent); }
}

function readDescriptor(fd: number): Buffer {
  const before = fstatSync(fd);
  if (before.size > IMPORT_LIMITS.fileBytes) throw new ImportProblem('file byte cap (262144) exceeded');
  const buffer = Buffer.alloc(before.size + 1);
  let used = 0;
  while (used < buffer.length) {
    const n = readSync(fd, buffer, used, buffer.length - used, used);
    if (!n) break;
    used += n;
  }
  const after = fstatSync(fd);
  if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new ImportProblem('file changed while reading');
  return buffer.subarray(0, used);
}

export class ImportReader {
  entries = 0;
  bytes = 0;
  readonly files = new Map<string, Buffer | undefined>();
  readonly directories = new Map<string, string[]>();
  read(file: string): Buffer | undefined {
    if (this.files.has(file)) return this.files.get(file);
    let data: Buffer | undefined;
    if (this.bytes >= IMPORT_LIMITS.totalBytes) throw new ImportProblem('total byte cap (4194304) exceeded');
    try {
      data = withFile(file, C.O_RDONLY, false, fd => {
        if (fstatSync(fd).size > IMPORT_LIMITS.totalBytes - this.bytes) throw new ImportProblem('total byte cap (4194304) exceeded');
        return readDescriptor(fd);
      });
    }
    catch (e) { if (!missing(e)) throw new ImportProblem(e instanceof ImportProblem ? e.message : 'unsafe or unreadable file (symlink/special file/ancestor refused)'); }
    if (data) {
      this.bytes += data.length;
      if (this.bytes > IMPORT_LIMITS.totalBytes) throw new ImportProblem('total byte cap (4194304) exceeded');
    }
    this.files.set(file, data);
    return data;
  }
  kind(file: string): 'file' | 'directory' {
    const parent = directory(path.dirname(file));
    try {
      const fd = openSync(descriptorPath(parent, path.basename(file)), LINUX_O_PATH | C.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (stat.isDirectory()) return 'directory';
        if (stat.isFile() && stat.nlink === 1) return 'file';
        throw new ImportProblem('special file or hard link refused');
      } finally { closeSync(fd); }
    } catch { throw new ImportProblem('symlink, special file or unreadable entry refused'); }
    finally { closeSync(parent); }
  }
  list(file: string): string[] {
    const cached = this.directories.get(file);
    if (cached) return cached;
    if (this.entries >= IMPORT_LIMITS.entries) throw new ImportProblem('entry cap (400) exceeded; remaining entries omitted');
    let fd: number;
    try { fd = directory(file); }
    catch (e) { if (missing(e)) { this.directories.set(file, []); return []; } throw new ImportProblem('unsafe or unreadable directory (symlink refused)'); }
    const names: string[] = [];
    try {
      const dir = opendirSync(descriptorPath(fd));
      try {
        for (;;) {
          const entry = dir.readSync();
          if (!entry) break;
          if (++this.entries > IMPORT_LIMITS.entries) throw new ImportProblem('entry cap (400) exceeded; remaining entries omitted');
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(entry.name) || entry.name === '..') throw new ImportProblem('unsupported entry name; directory omitted');
          names.push(entry.name);
        }
      } finally { dir.closeSync(); }
    } finally { closeSync(fd); }
    names.sort();
    this.directories.set(file, names);
    return names;
  }
}

/** Complete pre-write revalidation: no mutation if a saved file/list changed. */
export function verifySnapshot(reader: ImportReader): void {
  const current = new ImportReader();
  for (const [file, expected] of reader.files) {
    const actual = current.read(file);
    if (expected === undefined ? actual !== undefined : actual === undefined || !actual.equals(expected)) throw new ImportProblem('file changed since scan; apply refused');
  }
  for (const [file, expected] of reader.directories) {
    if (JSON.stringify(current.list(file)) !== JSON.stringify(expected)) throw new ImportProblem('directory changed since scan; apply refused');
  }
}

export interface ImportWrite { source: string; target: string; data: Buffer; before?: Buffer; }

/** Exclusive creation; existing AGENTS bytes are never rewritten or truncated. */
export function writeImport(item: ImportWrite): void {
  const flags = item.before === undefined ? C.O_WRONLY | C.O_CREAT | C.O_EXCL : C.O_RDWR | C.O_APPEND;
  withFile(item.target, flags, item.before === undefined, fd => {
    if (item.before !== undefined && !readDescriptor(fd).equals(item.before)) throw new ImportProblem('destination changed since scan');
    let used = 0;
    while (used < item.data.length) {
      const n = writeSync(fd, item.data, used, item.data.length - used);
      if (n === 0) throw new ImportProblem('short write');
      used += n;
    }
  });
}
