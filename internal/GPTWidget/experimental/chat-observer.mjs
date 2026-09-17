export function cleanChatRecord(input) {
  const text = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(v) ? v : null;
  const bool = v => typeof v === 'boolean' ? v : null;
  if (!input || !/^[0-9a-f-]{36}$/i.test(input.observationId || '')) return null;
  const out = { observationId: input.observationId, mode: input.mode === 'resume' ? 'resume' : 'request' };
  for (const key of ['conversationId','turnId','turnTraceId','requestModel','serverTelemetryModel','assistantMessageModel','resolvedModelSlug','resolvedModelRole','requestedModelExperience','turnUseCase','clusterRegion','rerouteFrom','rerouteTo']) out[key] = text(input[key]);
  for (const key of ['requestDispatched','didAutoSwitchToReasoning','isAutoswitcherEnabled','resumeWithWebsockets']) out[key] = bool(input[key]);
  out.toolInvoked = typeof input.toolInvoked === 'boolean' ? input.toolInvoked : text(input.toolInvoked);
  out.explicitReroute = input.explicitReroute === true && !!out.rerouteFrom && !!out.rerouteTo;
  out.messages = Array.isArray(input.messages) ? input.messages.slice(-32).map(m=>({messageId:text(m?.messageId),role:text(m?.role),modelSlug:text(m?.modelSlug),resolvedModelSlug:text(m?.resolvedModelSlug)})) : [];
  const models = [out.requestModel,out.serverTelemetryModel,out.assistantMessageModel,out.resolvedModelSlug,...out.messages.flatMap(m=>[m.role==='assistant'?m.modelSlug:null,m.resolvedModelSlug])].filter(Boolean);
  if (out.explicitReroute) models.push(out.rerouteFrom,out.rerouteTo);
  out.metadataDifference = new Set(models).size > 1;
  return out;
}

export function createChatObserver(options, emit, mode = 'request', id = globalThis.crypto.randomUUID()) {
  const r = { observationId:id, mode, turnId:null, turnTraceId:options.turnTraceId,
    conversationId:options.request?.conversation_id, requestModel:mode === 'request' ? options.request?.model : null,
    requestDispatched:mode === 'request' ? false : null, messages:[], explicitReroute:false };
  let last = '';
  const publish = () => { const record = cleanChatRecord(r), encoded = JSON.stringify(record); if (encoded !== last) { last = encoded; try { emit(record); } catch {} } };
  function update(event) {
    if (!event || typeof event !== 'object') return;
    const ids = [event.conversationId,event.conversation_id,event.serverSteMetadata?.conversation_id,event.params?.conversationId,event.params?.conversation_id].filter(v=>typeof v==='string'&&v.length);
    if (new Set(ids).size > 1) return;
    const conversation = ids[0];
    if (r.conversationId && conversation && conversation !== r.conversationId) return;
    if (conversation) r.conversationId = conversation;
    if (event.type === 'server-ste-metadata' || event.type === 'server_ste_metadata') {
      const metadata = event.serverSteMetadata?.metadata ?? event.metadata;
      if (!metadata || typeof metadata !== 'object') return;
      r.serverTelemetryModel = metadata.model_slug;
      for (const [key,source] of Object.entries({requestedModelExperience:'requested_model_experience',didAutoSwitchToReasoning:'did_auto_switch_to_reasoning',isAutoswitcherEnabled:'is_autoswitcher_enabled',turnUseCase:'turn_use_case',toolInvoked:'tool_invoked',resumeWithWebsockets:'resume_with_websockets',clusterRegion:'cluster_region'})) r[key] = metadata[source];
    } else if (event.type === 'message') {
      const message = event.message;
      if (!message?.id || !message.author?.role) return;
      const meta = message.metadata ?? {}, role = message.author.role;
      const item = {messageId:message.id,role,modelSlug:meta.model_slug,resolvedModelSlug:meta.resolved_model_slug};
      const old = r.messages.findIndex(m=>m.messageId === message.id);
      if (old >= 0) r.messages[old] = item; else r.messages.push(item);
      if (r.messages.length > 32) r.messages.shift();
      if (role === 'assistant') r.assistantMessageModel = meta.model_slug;
      // Recompute from the latest message snapshots; removed fields must not stay cached.
      const resolved = [...r.messages].reverse().find(m=>typeof m.resolvedModelSlug === 'string');
      r.resolvedModelSlug = resolved?.resolvedModelSlug;
      r.resolvedModelRole = resolved?.role;
    } else if (['model/rerouted','modelRerouted'].includes(event.type ?? event.method)) {
      const p = event.params ?? event;
      // Do not cross-associate a Work thread notification with a Chat stream.
      if (p.threadId || p.thread_id) return;
      r.rerouteFrom = p.fromModel ?? p.from_model; r.rerouteTo = p.toModel ?? p.to_model; r.explicitReroute = true;
    } else return;
    publish();
  }
  return {
    update,
    dispatch() { if (mode === 'request') { r.requestDispatched = true; publish(); } },
    snapshot() { return cleanChatRecord(r); }
  };
}

export function wrapChatOptions(options, emit, mode) {
  const observer = createChatObserver(options, emit, mode);
  return {...options,
    onRequestStart(...args) { try { observer.dispatch(); } catch {} return options.onRequestStart?.apply(this,args); },
    onUpdate(event, ...args) { try { observer.update(event); } catch {} return options.onUpdate?.apply(this,[event,...args]); }
  };
}
