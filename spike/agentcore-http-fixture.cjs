/** Separate loopback server for real SDK HTTP and standalone Darwin CLI tests. No AWS. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const home = process.env.HOME;
const server = http.createServer(async (req, res) => {
  if (req.url === '/credentials') {
    fs.appendFileSync(path.join(home, 'fixture-credentials.jsonl'), JSON.stringify({ authorization: req.headers.authorization }) + '\n');
    res.end(JSON.stringify({ AccessKeyId: 'AKIDCONTAINER', SecretAccessKey: 'synthetic', Token: 'synthetic-session', Expiration: '2099-01-01T00:00:00Z' })); return;
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  if (text.startsWith('Action=AssumeRole&')) {
    fs.appendFileSync(path.join(home, 'fixture-sts.jsonl'), JSON.stringify({ input: Object.fromEntries(new URLSearchParams(text)), headers: req.headers }) + '\n');
    const control = JSON.parse(fs.readFileSync(path.join(home, 'fixture-control.json'), 'utf8'));
    if (control.pauseSts) {
      fs.writeFileSync(path.join(home, 'fixture-sts-paused'), 'ready');
      await new Promise(resolve => { const timer = setInterval(() => { if (fs.existsSync(path.join(home, 'fixture-sts-release')) || res.destroyed) { clearInterval(timer); resolve(); } }, 10); });
    }
    res.setHeader('content-type', 'text/xml');
    if (control.stsError) { res.statusCode = 503; res.end('<ErrorResponse><Error><Code>ServiceUnavailable</Code><Message>synthetic secret error</Message></Error></ErrorResponse>'); return; }
    res.end('<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>AKIDASSUMED</AccessKeyId><SecretAccessKey>synthetic</SecretAccessKey><SessionToken>synthetic-assumed-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult><ResponseMetadata><RequestId>synthetic-sts</RequestId></ResponseMetadata></AssumeRoleResponse>');
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').map(decodeURIComponent);
  const operation = req.method === 'DELETE' ? 'delete-memory-record' : req.method === 'GET' ? 'get-memory-record' : url.pathname.includes('retrieve') ? 'retrieve-memory-records' : 'create-event';
  const input = { ...(text ? JSON.parse(text) : {}), memoryId: parts[2], ...Object.fromEntries(url.searchParams), ...(req.method === 'GET' || req.method === 'DELETE' ? { memoryRecordId: parts[4] } : {}) };
  fs.appendFileSync(path.join(home, 'fixture-calls.jsonl'), JSON.stringify({ operation, input, text, headers: req.headers, path: req.url }) + '\n');
  const control = JSON.parse(fs.readFileSync(path.join(home, 'fixture-control.json'), 'utf8'));
  const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  if (control.pauseGet && operation === 'get-memory-record') {
    fs.writeFileSync(path.join(home, 'fixture-paused'), 'ready');
    await new Promise(resolve => { const timer = setInterval(() => { if (fs.existsSync(path.join(home, 'fixture-release')) || res.destroyed) { clearInterval(timer); resolve(); } }, 10); });
  }
  if (control.mode === 'hang') return;
  if (control.mode === 'body-hang') { res.writeHead(200); res.write('{'); return; }
  if (control.mode === 'large') { res.end('x'.repeat(262145)); return; }
  if (control.mode === 'diagnostics') { res.writeHead(500); res.end('x'.repeat(8193)); return; }
  if (control.mode === 'invalid-json') { res.end('not JSON'); return; }
  if (control.mode === 'error') { res.statusCode = 503; json({ message: 'secret service error not for model' }); return; }
  if (control.raw !== undefined) { res.end(control.raw); return; }
  if (control.response !== undefined) { json(control.response); return; }
  const records = (control.records || []).map(record => ({ ...record, createdAt: Date.parse(record.createdAt) / 1000 }));
  switch (operation) {
    case 'retrieve-memory-records': json({ memoryRecordSummaries: records }); break;
    case 'get-memory-record': json({ memoryRecord: records[0] }); break;
    case 'create-event': {
      const { extractionConfig, clientToken, ...event } = input;
      json({ event: { ...event, eventId: 'synthetic-event' } }); break;
    }
    case 'delete-memory-record': json({ memoryRecordId: input.memoryRecordId }); break;
  }
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
