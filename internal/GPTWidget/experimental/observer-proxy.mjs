import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { frameObserver, modelObserver } from './websocket-observer.mjs';

const model = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(v) ? v : null;
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headers(input) {
  const skip = new Set([...hop, ...String(input.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(input).filter(([k]) => !skip.has(k.toLowerCase())));
}

// Observation is bounded and disposable; forwarded bytes never pass through JSON serialization.
function jsonCapture(limit, receive) {
  let chunks = [], size = 0, overflow = false;
  return {
    push(chunk) { size += chunk.length; if (size > limit) { overflow = true; chunks = []; } else if (!overflow) chunks.push(Buffer.from(chunk)); },
    end() { if (!overflow) { try { receive(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {} } chunks = []; }
  };
}
export function sseCapture(receive, limit = 256 * 1024) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', data = [], size = 0, dropping = false, longLine = false;
  function line(value) {
    if (value === '') {
      if (!dropping && data.length) { try { receive(JSON.parse(data.join('\n'))); } catch {} }
      data = []; size = 0; dropping = false; return;
    }
    if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /, ''); size += part.length;
      if (size > limit) { dropping = true; data = []; } else if (!dropping) data.push(part);
    }
  }
  return {
    push(chunk) {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const value = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (longLine) { longLine = false; dropping = true; } else line(value);
      }
      if (buffer.length > limit) { buffer = ''; longLine = true; dropping = true; data = []; }
    },
    end() { buffer = ''; data = []; decoder.end(); }
  };
}

function tee(capture) {
  return new Transform({
    transform(chunk, encoding, done) { try { capture.push(chunk); } catch {} done(null, chunk); },
    flush(done) { try { capture.end(); } catch {} done(); }
  });
}

/** Experimental HTTP/SSE/WS. No config mutation, authentication lookup, or disk logging. */
export async function createObserver({ upstream, onObservation = () => {}, allowLoopbackUpstream = false, idleTimeout = 120000 } = {}) {
  const target = new URL(upstream);
  if (target.username || target.password || target.search || target.hash ||
      !(target.protocol === 'https:' || (allowLoopbackUpstream && target.protocol === 'http:' && target.hostname === '127.0.0.1'))) {
    throw Error('invalid_upstream');
  }
  const token = randomBytes(24).toString('hex');
  const basePath = `/${token}${target.pathname.replace(/\/$/, '')}`;
  const active = new Set();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== `${basePath}/responses` || req.headers.origin || req.headers['sec-fetch-site']) {
      res.writeHead(403).end(); return;
    }
    const state = { requestId: randomUUID(), requestedModel: null, evidence: [], statusCode: null, outcome: 'pending' };
    let finished = false;
    function evidence(source, value) {
      const name = model(value);
      if (name && state.evidence.length < 32 && !state.evidence.some(e => e.source === source && e.model === name)) state.evidence.push({ source, model: name });
    }
    function observe(value) {
      if (!value || typeof value !== 'object') return;
      evidence('event.headers.openai-model', value.headers?.['openai-model']);
      if (['response.created', 'response.in_progress', 'response.completed'].includes(value.type)) evidence('response.model', value.response?.model);
      if (value.object === 'response') evidence('response.model', value.model);
    }
    function finish(outcome) {
      if (finished) return; finished = true;
      const models = [...new Set(state.evidence.map(e => e.model))];
      try { onObservation({ ...state, outcome, observedAt: new Date().toISOString(), reportedModel: models.length === 1 ? models[0] : null, conflict: models.length > 1 }); } catch {}
    }
    const outHeaders = headers(req.headers); outHeaders.host = target.host;
    const transport = target.protocol === 'https:' ? https : http;
    const out = transport.request(new URL(`${target.pathname.replace(/\/$/, '')}/responses`, target.origin), {
      method: 'POST', headers: outHeaders
    });
    active.add(out); out.on('close', () => active.delete(out));
    const requestTap = tee(jsonCapture(1024 * 1024, value => { state.requestedModel = model(value?.model); }));
    req.pipe(requestTap).pipe(out);
    out.setTimeout(idleTimeout, () => out.destroy(Error('idle_timeout')));
    req.on('aborted', () => { finish('client_cancelled'); out.destroy(); });
    req.on('error', () => { finish('client_error'); out.destroy(); });
    res.on('close', () => { if (!res.writableFinished) { finish('client_cancelled'); out.destroy(); } });
    out.on('error', () => {
      finish('upstream_error'); req.unpipe(requestTap); requestTap.destroy(); req.resume();
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Observer upstream error'); else res.destroy();
    });
    out.on('response', incoming => {
      state.statusCode = incoming.statusCode;
      evidence('http.openai-model', incoming.headers['openai-model']);
      const compressed = incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity';
      const type = String(incoming.headers['content-type'] || '').toLowerCase();
      const capture = compressed ? { push() {}, end() {} } : type.includes('text/event-stream') ? sseCapture(observe) : jsonCapture(1024 * 1024, observe);
      const responseTap = tee(capture);
      res.writeHead(incoming.statusCode, headers(incoming.headers));
      incoming.pipe(responseTap).pipe(res);
      incoming.on('end', () => finish('complete'));
      incoming.on('error', () => { finish('upstream_incomplete'); res.destroy(); });
      res.on('close', () => { incoming.destroy(); responseTap.destroy(); });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const reject = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.method !== 'GET' || req.url !== `${basePath}/responses` || req.headers.origin || req.headers['sec-fetch-site'] || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      reject('403 Forbidden'); return;
    }
    socket.pause();
    const observation = modelObserver(onObservation);
    const clientFrames = frameObserver(v => observation.client(v), () => observation.opaque());
    const serverFrames = frameObserver(v => observation.server(v), () => observation.opaque());
    const transport = target.protocol === 'https:' ? https : http;
    const outHeaders = headers(req.headers);
    Object.assign(outHeaders, { host: target.host, connection: 'Upgrade', upgrade: 'websocket' });
    const out = transport.request(new URL(`${target.pathname.replace(/\/$/, '')}/responses`, target.origin), { method: 'GET', headers: outHeaders });
    let peer, connected = false, stopped = false, shutdownTimer;
    const timer = setTimeout(() => { reject('504 Gateway Timeout'); out.destroy(); }, Math.min(idleTimeout, 15000));
    timer.unref();
    function cleanup() {
      if (stopped) return; stopped = true; clearTimeout(timer); clearTimeout(shutdownTimer);
      observation.close(); clientFrames.end(); serverFrames.end();
      active.delete(socket); if (peer) active.delete(peer); active.delete(out);
      socket.destroy(); peer?.destroy(); out.destroy();
    }
    function halfClose() {
      socket.end(); peer?.end();
      if (!shutdownTimer) { shutdownTimer = setTimeout(cleanup, 1000); shutdownTimer.unref(); }
    }
    active.add(socket); active.add(out);
    socket.on('error', cleanup); socket.on('close', cleanup); socket.on('end', halfClose);
    out.on('error', () => { if (!connected && !socket.destroyed) reject('502 Bad Gateway'); else cleanup(); });
    out.on('response', incoming => {
      clearTimeout(timer);
      const response = new http.ServerResponse(req);
      response.assignSocket(socket); response.shouldKeepAlive = false;
      response.writeHead(incoming.statusCode, headers(incoming.headers)); incoming.pipe(response);
      incoming.on('error', cleanup); socket.resume();
    });
    out.on('upgrade', (incoming, upstreamSocket, upstreamHead) => {
      clearTimeout(timer);
      if (stopped) { upstreamSocket.destroy(); return; }
      connected = true; peer = upstreamSocket; active.add(peer);
      peer.on('error', cleanup); peer.on('close', cleanup); peer.on('end', halfClose);
      socket.setTimeout(idleTimeout, cleanup); peer.setTimeout(idleTimeout, cleanup);
      observation.handshake(incoming.headers['openai-model']);
      // Preserve the upstream handshake fields, including accept, extensions and sticky state.
      const lines = [];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) lines.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      const toUpstream = tee(clientFrames), toClient = tee(serverFrames);
      socket.on('close', () => { toUpstream.destroy(); toClient.destroy(); });
      if (head.length) socket.unshift(head);
      if (upstreamHead.length) peer.unshift(upstreamHead);
      socket.pipe(toUpstream).pipe(peer); peer.pipe(toClient).pipe(socket);
      socket.resume();
    });
    out.end();
  });
  server.on('connect', (req, socket) => socket.destroy());
  server.on('clientError', (error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}${basePath}`,
    async close() { for (const req of active) req.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
