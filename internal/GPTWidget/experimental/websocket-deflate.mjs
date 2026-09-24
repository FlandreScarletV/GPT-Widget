import { inflateRawSync, constants } from 'node:zlib';

// Unknown extension combinations stay opaque. Interpret only negotiated RFC7692.
export function deflateParameters(header, direction) {
  if (!['client','server'].includes(direction) || typeof header !== 'string') return null;
  const extensions = header.split(',');
  if (extensions.length !== 1) return null;
  const [name, ...parameters] = extensions[0].split(';').map(s => s.trim().toLowerCase());
  if (name !== 'permessage-deflate') return null;
  const values = new Map();
  for (const part of parameters) {
    const match = /^(client|server)_(no_context_takeover|max_window_bits)(?:\s*=\s*(?:"(\d+)"|(\d+)))?$/.exec(part);
    if (!match) return null;
    const key = `${match[1]}_${match[2]}`, value = match[3] ?? match[4];
    if (values.has(key)) return null;
    if (match[2] === 'no_context_takeover' ? value !== undefined : value === undefined || Number(value)<8 || Number(value)>15) return null;
    values.set(key, value);
  }
  return { reset: values.has(`${direction}_no_context_takeover`), windowBits:Number(values.get(`${direction}_max_window_bits`) ?? 15) };
}

export function deflateDecoder(parameters, limit) {
  let dictionary = Buffer.alloc(0), failed = false;
  return bytes => {
    if (failed) throw Error('decoder_unavailable');
    try {
      const decoded = inflateRawSync(Buffer.concat([bytes, Buffer.from([0,0,255,255])]), {
        windowBits:parameters.windowBits, finishFlush:constants.Z_SYNC_FLUSH,
        maxOutputLength:limit, ...(dictionary.length ? {dictionary} : {})
      });
      dictionary = parameters.reset ? Buffer.alloc(0) : Buffer.from(Buffer.concat([dictionary,decoded]).subarray(-(1 << parameters.windowBits)));
      return decoded;
    } catch {
      failed = true; dictionary = Buffer.alloc(0); throw Error('decompression_failed');
    }
  };
}
