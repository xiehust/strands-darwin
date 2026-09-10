#!/usr/bin/env node
/** Real deterministic process fixture. Only synthetic input, never AWS. */
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const control = JSON.parse(fs.readFileSync(path.join(home, 'fixture-control.json'), 'utf8'));
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(home, 'fixture-calls.jsonl'), JSON.stringify({ args, input: stdin ? JSON.parse(stdin) : null, env: control.captureEnv ? Object.fromEntries(['AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_ENDPOINT_URL', 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'].map(key => [key, process.env[key]])) : undefined }) + '\n');
  if (control.pauseGet && args[1] === 'get-memory-record') {
    fs.writeFileSync(path.join(home, 'fixture-paused'), 'ready');
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(home, 'fixture-release'))) return;
      clearInterval(timer); console.log(JSON.stringify({ memoryRecord: control.records[0] }));
    }, 10);
    return;
  }
  if (control.mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (control.mode === 'large') { process.stdout.write('x'.repeat(300000)); return; }
  if (control.mode === 'error') { process.stderr.write('secret service error not for model'); process.exitCode = 9; return; }
  if (args.includes('--generate-cli-skeleton')) { console.log(JSON.stringify(control.legacy ? {} : { extractionConfig: { namespaceVariables: { KeyName: '' } } })); return; }
  const input = JSON.parse(stdin);
  switch (args[1]) {
    case 'retrieve-memory-records': console.log(JSON.stringify({ memoryRecordSummaries: control.records || [] })); break;
    case 'get-memory-record': console.log(JSON.stringify({ memoryRecord: control.records[0] })); break;
    case 'create-event': console.log(JSON.stringify({ event: { ...input, eventId: 'synthetic-event' } })); break;
    case 'delete-memory-record': console.log('{}'); break;
    default: process.exitCode = 8;
  }
});
