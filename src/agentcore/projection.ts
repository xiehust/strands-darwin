import { open } from 'node:fs/promises';
import { parseRecordLine } from '../trajectory/record.js';
import type { TurnSettlement } from '../trajectory/writer.js';
import { isSensitiveMemoryText } from '../memory/state.js';

export const OMISSIONS = 'Lossy allowlist: no system/skills, reasoning, images, file contents/diffs, logs, sensitive paths, child transcript or memory results. Unrecognized arguments/results omitted. Assistant prose omitted after any tool or memory exposure. endTurn is not task success.';
export function publicProse(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1000 || value.split('\n').length > 3 || /[\u0000-\u001f<>`{}]|(?:\/|\\)[\w.]|\b(?:token|secret|password|credential|private.key)\b/i.test(value) || isSensitiveMemoryText(value)) return undefined;
  return value;
}
/** Read only a newly settled turn from a bounded tail; never scan/backfill an archive. */
export async function projectTurn(file: string, settlement: Extract<TurnSettlement, { durable: true }>, memoryExposed: boolean) {
  const handle = await open(file, 'r'); let text: string;
  try {
    const stat = await handle.stat(); const start = Math.max(0, stat.size - 1048576); const buffer = Buffer.alloc(Math.min(stat.size, 1048576));
    const read = await handle.read(buffer, 0, buffer.length, start); text = buffer.subarray(0, read.bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally { await handle.close(); }
  const lines = text.split('\n');
  // A damaged line could hide a memory/tool exposure. Never project around it.
  if (lines.some((line) => line.trim() !== '' && parseRecordLine(line) === undefined)) throw new Error('Damaged trajectory tail; upload projection omitted');
  const records = lines.flatMap((line) => { const parsed = parseRecordLine(line); return parsed === undefined ? [] : [parsed]; });
  return projectRecords(records, settlement, memoryExposed);
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function projectRecords(records: NonNullable<ReturnType<typeof parseRecordLine>>[], settlement: Extract<TurnSettlement, { durable: true }>, memoryExposed: boolean) {
  const turn = records.filter((record) => record.turn === settlement.turn && record.seq <= settlement.seq);
  if (!turn.some((r) => r.type === 'userInput') || !turn.some((r) => r.type === 'turnEnded' && r.seq === settlement.seq)) throw new Error('New turn unavailable in bounded trajectory tail; omitted');
  const steps: object[] = []; let omitted = 0; const calls = new Map<string, string>();
  for (const record of turn) {
    if (steps.length >= 24) { omitted++; continue; }
    if (record.type === 'userInput') {
      const text = publicProse(record.text); if (text === undefined) omitted++; else steps.push({ seq: record.seq, role: 'USER', goal: text });
    } else if ('data' in record) {
      const data = object(record.data);
      if (record.type === 'beforeToolCallEvent') {
        memoryExposed = true; // Even file/shell reads can expose private data later paraphrased by the assistant.
        const use = object(data.toolUse); const name = use.name;
        if (typeof name !== 'string' || !['bash', 'fileEditor'].includes(name)) { memoryExposed = true; omitted++; continue; }
        const input = object(use.input); const id = String(use.toolUseId);
        calls.set(id, name);
        const args: Record<string, unknown> = {};
        if (name === 'bash' && input.mode === 'execute' && typeof input.command === 'string' && /^(?:pnpm (?:test|typecheck|build)|git status --short)$/.test(input.command)) args.command = input.command;
        if (name === 'fileEditor' && ['view', 'create', 'str_replace', 'insert'].includes(String(input.command))) args.command = input.command;
        steps.push({ seq: record.seq, tool: name, arguments: args, omitted: 'other arguments and contents' });
      } else if (record.type === 'afterToolCallEvent') {
        const result = object(data.result); const id = String(result.toolUseId ?? object(data.toolUse).toolUseId);
        if (!calls.has(id)) { omitted++; continue; }
        const resultEvidence: Record<string, unknown> = { status: result.status === 'success' ? 'success' : 'error' };
        const content = Array.isArray(result.content) ? result.content : [];
        for (const block of content) { const json = object(object(block).json); if (Number.isInteger(json.exitCode)) resultEvidence.exitCode = json.exitCode; }
        steps.push({ seq: record.seq, tool: calls.get(id), result: resultEvidence, omitted: 'all free-form result text' });
      } else if (record.type === 'contentBlockEvent' && !memoryExposed) {
        const block = object(data.contentBlock);
        const text = publicProse(block.text);
        if (Object.keys(block).length === 1 && text !== undefined) steps.push({ seq: record.seq, role: 'ASSISTANT', statement: text }); else omitted++;
      }
    }
  }
  return { session: settlement.session, turn: settlement.turn, closingSeq: settlement.seq, at: settlement.at,
    outcome: settlement.failure ? 'failed' : settlement.stopReason === 'cancelled' ? 'cancelled' : settlement.partial || !settlement.stopReason ? 'incomplete' : 'closed', stopReason: settlement.stopReason ?? 'not reported', taskSuccess: 'not inferred', steps: steps.slice(0, 24), omitted, omissions: OMISSIONS };
}
