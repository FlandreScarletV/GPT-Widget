import test from 'node:test';
import assert from 'node:assert/strict';
import { routingHeaders } from './routing-headers.mjs';
test('routing header allowlist retains explicit false and ignores unrelated sensitive headers', () => {
  assert.deepEqual(routingHeaders({'X-OAI-Request-ID':'req-123', 'x-codex-safety-buffering-enabled':'false',
    'x-codex-safety-buffering-faster-model':'candidate-model',authorization:'PRIVATE', 'set-cookie':'PRIVATE'}), {
    upstreamRequestId:'req-123',safetyBufferingEnabled:false,safetyBufferingFasterModel:'candidate-model'});
});
test('absent or malformed values stay unknown; duplicate arrays are not coerced', () => {
  assert.deepEqual(routingHeaders({'x-oai-request-id':['a','b'],'x-request-id':'req-fallback',
    'x-codex-safety-buffering-enabled':'maybe','x-codex-safety-buffering-faster-model':'PRIVATE\nTEXT'}), {
    upstreamRequestId:'req-fallback',safetyBufferingEnabled:null,safetyBufferingFasterModel:null});
  assert.equal(routingHeaders({'x-codex-safety-buffering-enabled':'true'}).safetyBufferingEnabled,true);
});
