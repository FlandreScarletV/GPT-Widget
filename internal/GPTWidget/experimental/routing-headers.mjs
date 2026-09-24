// Header evidence describes a connection/response, never the physical executing model.
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value) ? value : null;
export function routingHeaders(headers = {}) {
  const get = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const enabled = get('x-codex-safety-buffering-enabled');
  return {
    upstreamRequestId: identifier(get('x-oai-request-id')) ?? identifier(get('x-request-id')),
    safetyBufferingEnabled: enabled === 'true' ? true : enabled === 'false' ? false : null,
    safetyBufferingFasterModel: identifier(get('x-codex-safety-buffering-faster-model')),
  };
}
