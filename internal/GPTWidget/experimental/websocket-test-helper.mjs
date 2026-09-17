import http from 'node:http';
import { createHash } from 'node:crypto';
import { frameObserver } from './websocket-observer.mjs';

export function frame(value, { mask = false, opcode = 1, fin = true, compressed = false } = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const extra = body.length < 126 ? 0 : body.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 128 : 0) | (compressed ? 64 : 0) | opcode;
  header[1] = (mask ? 128 : 0) | (extra === 0 ? body.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(body.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(body.length), 2);
  const data = Buffer.from(body);
  if (mask) { const key = Buffer.from([1, 8, 2, 9]); key.copy(header, header.length - 4); for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3]; }
  return Buffer.concat([header, data]);
}
export function accept(req, socket, extra = {}) {
  const hash = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + hash + '\r\n' + Object.entries(extra).map(([k,v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
}
export async function connect(url, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...extra } });
    req.on('error', reject);
    req.on('response', res => { res.resume(); reject(Error('upgrade_status_' + res.statusCode)); });
    req.on('upgrade', (res, socket, head) => {
      const received = [], messages = [], reader = frameObserver(v => messages.push(v));
      const consume = c => { received.push(Buffer.from(c)); reader.push(c); };
      socket.on('data', consume); socket.on('error', () => {}); if (head.length) consume(head);
      resolve({ socket, received, messages, headers: res.headers });
    }); req.end();
  });
}
export async function until(check, timeout = 2500) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw Error('test_timeout'); await new Promise(r => setTimeout(r, 5)); }
}
