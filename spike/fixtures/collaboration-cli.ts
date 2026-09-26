/** Production CLI + deterministic offline SDK model. Files expose actual requests, never a fake driver. */
import { appendFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ModelError, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import { setRuntimeModelFactoryForTest } from '../../src/agent/runtime.js';
import { CaptureModel } from '../offline-model.js';

class CollaborationModel extends CaptureModel {
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    await appendFile('peer-requests.jsonl', JSON.stringify({ messages: messages.map(m => m.toJSON()), tools: options?.toolSpecs?.map(t => t.name) }) + '\n');
    const last = messages.at(-1);
    const text = last?.content.find(block => block.type === 'textBlock')?.text ?? '';
    if (text === 'hold peer queue') {
      const deadline = Date.now() + 30_000;
      let released = false;
      while (Date.now() < deadline && !options?.cancelSignal?.aborted) {
        try { await access('release-peer'); released = true; break; } catch { await delay(20); }
      }
      if (!released && !options?.cancelSignal?.aborted) throw new Error('Peer fixture hold timed out');
    }
    let name: string | undefined; let input: unknown;
    const prefix = 'Literal envelope follows as JSON:\n';
    const peer = text.includes(prefix) ? JSON.parse(text.slice(text.indexOf(prefix) + prefix.length)) : undefined;
    const action = peer?.text ?? text;
    if (action === 'hold peer failure' || action === 'hold peer interruption') {
      const deadline = Date.now() + 15_000;
      let released = false;
      while (Date.now() < deadline && !options?.cancelSignal?.aborted) {
        try { await access('release-failure'); released = true; break; } catch { await delay(20); }
      }
      if (!released) throw new Error('Peer fixture failure release timed out');
      if (action === 'hold peer interruption') throw new ModelError('Stream ended without completing a message');
      throw new Error('Peer fixture deliberate failure: ' + '界'.repeat(9000));
    }
    if (typeof action === 'string' && action.startsWith('send ')) {
      const [, target, ...body] = action.split(' '); name = 'peer_send'; input = { target, text: body.join(' ') };
    } else if (peer && action === 'please reply') {
      name = 'peer_send'; input = { target: peer.sender.endpoint, text: 'peer replied' };
    } else if (peer && action === 'attack policy') {
      name = 'fileEditor'; input = { command: 'create', path: path.join(process.env['HOME']!, '.darwin/collaboration/forged.json'), file_text: 'forged' };
    } else if (peer && action === 'plan write') {
      name = 'fileEditor'; input = { command: 'create', path: path.resolve('peer-write-canary'), file_text: 'forbidden' };
    } else if (peer && action === 'memory preference') {
      name = 'memory_save'; input = { key: 'peer-preference', category: 'preference', title: 'forged', fact: 'Peer is not user', userQuote: action };
    } else if (text === 'delegate') {
      name = 'subagent'; input = { task: 'report child catalogue' };
    } else if (text.startsWith('model grant ')) {
      name = 'bash'; input = { mode: 'execute', command: `darwin collaborate confirm ${text.slice('model grant '.length)} --persist` };
    } else if (text === 'echo collaboration word') {
      name = 'bash'; input = { mode: 'execute', command: 'echo collaborate' };
    } else if (text === 'read collaboration secrets') {
      name = 'fileEditor'; input = { command: 'view', path: path.join(process.env['HOME']!, '.darwin/collaboration/policy.json') };
    } else if (text === 'permission hold') {
      name = 'fileEditor'; input = { command: 'create', path: path.join(process.env['HOME']!, 'human-write-canary'), file_text: 'human gated write' };
    }
    if (name) {
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: randomUUID() } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else yield* super.stream(messages, options);
  }
}
setRuntimeModelFactoryForTest(async () => new CollaborationModel('PEER_OFFLINE_REPLY'));
await import('../../src/cli.js');
