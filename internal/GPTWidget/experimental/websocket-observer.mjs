import { randomUUID } from 'node:crypto';

const safe = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(v) ? v : null;

// Passive RFC6455 frame reader. Forwarding never depends on successful parsing.
// Compression and binary messages remain opaque, rather than guessing their contents.
export function frameObserver(receive, opaque = () => {}, limit = 1024 * 1024) {
  let header = Buffer.alloc(14), used = 0, needed = 2, frame = null;
  let parts = [], size = 0, message = false, skip = false, disabled = false;
  const discard = () => { parts = []; size = 0; skip = true; };
  function completedFrame() {
    if (frame.op < 8 && frame.fin) {
      if (!skip && message) {
        try { receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))); }
        catch { opaque('unparsed_message'); }
      } else opaque('opaque_message');
      parts = []; size = 0; message = false; skip = false;
    }
    frame = null; used = 0; needed = 2;
  }
  return {
    push(chunk) {
      if (disabled) return;
      let offset = 0;
      while (offset < chunk.length) {
        if (!frame) {
          const count = Math.min(needed - used, chunk.length - offset);
          chunk.copy(header, used, offset, offset + count); used += count; offset += count;
          if (used < needed) continue;
          const len = header[1] & 127, masked = !!(header[1] & 128);
          const full = 2 + (len === 126 ? 2 : len === 127 ? 8 : 0) + (masked ? 4 : 0);
          if (needed !== full) { needed = full; continue; }
          const length = len === 126 ? header.readUInt16BE(2) : len === 127 ? header.readBigUInt64BE(2) : BigInt(len);
          if (BigInt(length) > BigInt(Number.MAX_SAFE_INTEGER)) { disabled = true; discard(); opaque('invalid_frame'); return; }
          const op = header[0] & 15, fin = !!(header[0] & 128);
          frame = { op, fin, remaining: Number(length), position: 0, mask: masked ? Buffer.from(header.subarray(full - 4, full)) : null };
          if (op < 8) {
            if (op !== 0) { if (message) opaque('invalid_fragment'); parts = []; size = 0; message = true; skip = op !== 1 || !!(header[0] & 112); }
            else if (!message || (header[0] & 112)) discard();
            if (size + frame.remaining > limit) discard();
          }
          if (!frame.remaining) { completedFrame(); continue; }
        }
        const count = Math.min(frame.remaining, chunk.length - offset);
        if (frame.op < 8 && !skip) {
          const payload = Buffer.from(chunk.subarray(offset, offset + count));
          if (frame.mask) for (let i = 0; i < count; i++) payload[i] ^= frame.mask[(frame.position + i) & 3];
          parts.push(payload); size += count;
        }
        offset += count; frame.remaining -= count; frame.position += count;
        if (!frame.remaining) completedFrame();
      }
    },
    end() { parts = []; header = Buffer.alloc(0); disabled = true; }
  };
}

export function modelObserver(emit) {
  const connectionId = randomUUID();
  const completedIds = new Set();
  let current = null, uncertain = false;
  function output(record) { try { emit({ transport: 'websocket', connectionId, observedAt: new Date().toISOString(), ...record }); } catch {} }
  function end(outcome) {
    if (!current) return;
    const names = [...new Set(current.evidence.map(e => e.model))];
    const reportedModel = names.length === 1 ? names[0] : null;
    output({ kind: 'turn', ...current, outcome, reportedModel, conflict: names.length > 1,
      modelDifference: current.association === 'single_inflight' && current.requestedModel && reportedModel ? current.requestedModel !== reportedModel : null });
    if (current.responseId) { completedIds.add(current.responseId); if (completedIds.size > 1024) completedIds.delete(completedIds.values().next().value); }
    current = null;
  }
  function evidence(source, value) {
    const name = safe(value);
    if (current && name && current.evidence.length < 32 && !current.evidence.some(e => e.source === source && e.model === name)) current.evidence.push({ source, model: name });
  }
  return {
    handshake(value) { output({ kind: 'connection', source: 'handshake.openai-model', reportedModel: safe(value) }); },
    opaque() { if (current) current.association = 'unknown'; end('observation_incomplete'); uncertain = true; },
    client(value) {
      if (value?.type !== 'response.create') return;
      if (current) { current.association = 'unknown'; end('ambiguous_overlap'); uncertain = true; }
      current = { requestId: randomUUID(), requestedModel: safe(value.model), responseId: null,
        generationRequested: value.generate !== false,
        association: uncertain ? 'unknown' : 'single_inflight', evidence: [], explicitReroutes: [] };
    },
    server(value) {
      if (!current || uncertain) return;
      const id = safe(value?.response?.id ?? value?.response_id);
      if (id && completedIds.has(id)) return;
      if (id && current.responseId && id !== current.responseId) return;
      if (id) current.responseId = id;
      evidence('event.headers.openai-model', value?.headers?.['openai-model']);
      if (['response.created', 'response.in_progress', 'response.completed', 'response.failed', 'response.incomplete'].includes(value?.type)) evidence('response.model', value.response?.model);
      if (['modelRerouted', 'model/rerouted'].includes(value?.type ?? value?.method)) {
        const info = value.params ?? value;
        const fromModel = safe(info.fromModel ?? info.from_model), toModel = safe(info.toModel ?? info.to_model);
        if (fromModel && toModel && current.explicitReroutes.length < 16) {
          current.explicitReroutes.push({ fromModel, toModel }); evidence('model/rerouted', toModel);
        }
      }
      if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(value?.type)) end(value.type);
    },
    close(outcome = 'disconnected') { end(outcome); }
  };
}
