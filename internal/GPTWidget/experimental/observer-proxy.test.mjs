import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createObserver, sseCapture } from './observer-proxy.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const records = [];
  const proxy = await createObserver({ upstream: `http://127.0.0.1:${server.address().port}/v1`, allowLoopbackUpstream: true, onObservation: r => records.push(r) });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { proxy, records };
}
function post(url, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...extra } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts), headers: res.headers })); res.on('error', reject);
    }); req.on('error', reject); req.end(body);
  });
}
test('forwards exact bytes and auth in memory; records only model whitelist and conflicts', async t => {
  const payload = '{ "model":"requested-model", "input":"PRIVATE_PROMPT" }';
  const wire = 'data: {"type":"response.created","response":{"model":"served-a","output":"PRIVATE_OUTPUT"}}\r\n\r\ndata: {"type":"response.completed","response":{"model":"served-a"}}\n\ndata: [DONE]\n\n';
  const { proxy, records } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, 'Bearer PRIVATE_TOKEN');
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      assert.equal(body, payload); res.writeHead(200, { 'content-type': 'text/event-stream', 'openai-model': 'served-b' });
      for (const byte of Buffer.from(wire)) res.write(Buffer.from([byte])); res.end();
    });
  });
  const result = await post(proxy.baseUrl + '/responses', payload, { authorization: 'Bearer PRIVATE_TOKEN' });
  assert.equal(result.body.toString(), wire); assert.equal(records.length, 1);
  assert.equal(records[0].requestedModel, 'requested-model'); assert.equal(records[0].conflict, true); assert.equal(records[0].reportedModel, null);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|authorization|input|output/);
});
test('missing evidence remains unknown; no request-model fallback', async t => {
  const { proxy, records } = await fixture(t, (req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
  await post(proxy.baseUrl + '/responses', '{"model":"requested-model"}');
  assert.equal(records[0].reportedModel, null); assert.deepEqual(records[0].evidence, []);
});
test('JSON response observation and HTTP errors retain status/body', async t => {
  const body = '{"object":"response","model":"served-a","output":[]}';
  const { proxy, records } = await fixture(t, (req, res) => { req.resume(); req.on('end', () => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '10' }); res.end(body); }); });
  const result = await post(proxy.baseUrl + '/responses', '{}');
  assert.equal(result.status, 429); assert.equal(result.headers['retry-after'], '10'); assert.equal(result.body.toString(), body); assert.equal(records[0].reportedModel, 'served-a');
});
test('bounded SSE handles split UTF8, multiline JSON, oversized event recovery', () => {
  const values = [], parser = sseCapture(v => values.push(v), 128);
  const wire = 'data: ' + 'x'.repeat(1024) + '\n\ndata: {"type":"response.completed",\r\ndata: "response":{"model":"served-a"},"extra":"日本"}\r\n\r\n';
  for (const b of Buffer.from(wire)) parser.push(Buffer.from([b])); parser.end();
  assert.equal(values.length, 1); assert.equal(values[0].extra, '日本');
});
test('rejects wrong capability, browser origins and arbitrary paths without forwarding', async t => {
  let count = 0;
  const { proxy } = await fixture(t, (req, res) => { count++; res.end(); });
  assert.equal((await post(new URL('/v1/responses', proxy.baseUrl), '{}')).status, 403);
  assert.equal((await post(proxy.baseUrl + '/responses', '{}', { origin: 'https://example.com' })).status, 403);
  assert.equal((await post(proxy.baseUrl + '/responses?url=https://example.com', '{}')).status, 403);
  assert.equal(count, 0);
});
test('compressed response bytes preserved; payload observation skipped', async t => {
  const zipped = gzipSync('{"object":"response","model":"served-a"}');
  const { proxy, records } = await fixture(t, (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(zipped); }); });
  assert.deepEqual((await post(proxy.baseUrl + '/responses', '{}')).body, zipped); assert.equal(records[0].reportedModel, null);
});
test('upstream failure emits sanitized error once', async t => {
  const { proxy, records } = await fixture(t, req => req.socket.destroy());
  const result = await post(proxy.baseUrl + '/responses', '{"input":"PRIVATE"}');
  assert.equal(result.status, 502); assert.equal(records.length, 1); assert.equal(records[0].outcome, 'upstream_error'); assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});
test('redirect response is relayed without following it', async t => {
  let count = 0;
  const { proxy } = await fixture(t, (req, res) => { count++; req.resume(); req.on('end', () => { res.writeHead(307, { location: 'https://example.invalid/responses' }); res.end('redirect'); }); });
  const result = await post(proxy.baseUrl + '/responses', '{}', { authorization: 'Bearer PRIVATE_TOKEN' });
  assert.equal(result.status, 307); assert.equal(result.body.toString(), 'redirect'); assert.equal(count, 1);
});
test('client receives streaming data before upstream completes and cancellation closes upstream', async t => {
  let closed;
  const upstreamClosed = new Promise(r => closed = r);
  const { proxy, records } = await fixture(t, (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"response.created","response":{"model":"served-a"}}\n\n'); });
    res.on('close', closed);
  });
  await new Promise((resolve, reject) => {
    const req = http.request(proxy.baseUrl + '/responses', { method: 'POST' }, res => { res.once('data', () => { res.destroy(); resolve(); }); });
    req.on('error', reject); req.end('{}');
  });
  await Promise.race([upstreamClosed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('upstream not cancelled')), 2000); timer.unref(); })]);
  assert.equal(records.length, 1); assert.equal(records[0].outcome, 'client_cancelled');
});
