/** Fail the real CLI if local inspection imports runtime/config/SDK or uses a network transport. */
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';

let violated = false;
function forbidden(reason: string): never {
  violated = true;
  throw new Error(reason);
}
process.on('beforeExit', () => { if (violated) process.exitCode = 90; });

registerHooks({
  load(url, context, nextLoad) {
    if (/\/(?:src\/(?:config|cli-main|agent\/runtime)\.[jt]s|@strands-agents\/sdk\/)/.test(url)) forbidden(`forbidden module: ${url}`);
    return nextLoad(url, context);
  },
});
net.Socket.prototype.connect = (() => { return forbidden('network forbidden'); }) as typeof net.Socket.prototype.connect;
dgram.createSocket = (() => { return forbidden('network forbidden'); }) as typeof dgram.createSocket;
const kill = process.kill.bind(process);
process.kill = ((pid, signal) => {
  if (signal !== 0) forbidden('only PID probe 0 is allowed');
  return kill(pid, signal);
}) as typeof process.kill;
function checkRead(file: unknown): void {
  const name = String(file);
  if (name.startsWith(`${os.homedir()}${path.sep}`) && path.basename(name) !== 'lease.json') forbidden(`forbidden HOME read: ${name}`);
}
const readSync = fs.readFileSync;
fs.readFileSync = ((...args: Parameters<typeof readSync>) => {
  checkRead(args[0]);
  return readSync(...args);
}) as typeof readSync;
const read = fsp.readFile;
fsp.readFile = ((...args: Parameters<typeof read>) => {
  checkRead(args[0]);
  return read(...args);
}) as typeof read;
const openedFiles = new Set<string>();
const open = fsp.open;
fsp.open = ((...args: Parameters<typeof open>) => {
  checkRead(args[0]);
  const file = String(args[0]);
  if (openedFiles.has(file)) forbidden(`duplicate lease read: ${file}`);
  openedFiles.add(file);
  return open(...args);
}) as typeof open;
const openedDirectories = new Set<string>();
const opendir = fsp.opendir;
fsp.opendir = ((...args: Parameters<typeof opendir>) => {
  const directory = String(args[0]);
  if (openedDirectories.has(directory)) forbidden(`duplicate project scan: ${directory}`);
  openedDirectories.add(directory);
  return opendir(...args);
}) as typeof opendir;
syncBuiltinESMExports();
// Negative controls prove a caught tripwire still fails the process.
try {
  switch (process.env['LIST_AGENTS_GUARD_PROBE']) {
    case 'read': await fsp.readFile(path.join(os.homedir(), '.darwin', 'config.json')); break;
    case 'network': net.connect({ port: 9, host: '127.0.0.1' }); break;
    case 'signal': process.kill(process.pid, 'SIGTERM'); break;
    case 'config': await import('../../src/config.js'); break;
  }
} catch { /* beforeExit remembers the violation */ }
await import('../../src/cli.js');
