const id = value => typeof value==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value) ? value : null;
export function requestScope(value) {
  const flat=value?.client_metadata;
  let nested=null;
  const raw=flat?.['x-codex-turn-metadata'];
  if(typeof raw==='string' && raw.length<=65536) {try{nested=JSON.parse(raw);}catch{}}
  if(!nested||typeof nested!=='object'||Array.isArray(nested))nested=null;
  const threadIds=[nested?.thread_id,flat?.thread_id].map(id).filter(Boolean);
  const turnIds=[nested?.turn_id,flat?.turn_id].map(id).filter(Boolean);
  const conflict=new Set(threadIds).size>1||new Set(turnIds).size>1;
  const requestKind=['turn','prewarm','compaction','memory'].includes(nested?.request_kind)?nested.request_kind:null;
  return {threadId:conflict?null:threadIds[0]??null,turnId:conflict?null:turnIds[0]??null,
    requestKind,scopeConflict:conflict,source:nested?'client_metadata.x-codex-turn-metadata':flat?'client_metadata':null};
}

// Deliberately do not infer scope from timing, model name, or a connection handshake.
export function scopedModel(records, threadId, turnId) {
  if(!id(threadId)||!id(turnId))return null;
  const matches=records.filter(r=>r.kind==='turn'&&r.scope?.threadId===threadId&&r.scope?.turnId===turnId&&
    !r.scope.scopeConflict&&r.scope.requestKind==='turn'&&r.generationRequested===true);
  if(!matches.length)return null;
  // Last successful response only, not a claim that every attempt in this turn was verified.
  const latest=matches.at(-1);
  if(latest.outcome!=='response.completed'||!latest.reportedModel)return null;
  if(matches.some(r=>r.association!=='single_inflight'||r.conflict))return null;
  const completed=matches.filter(r=>r.outcome==='response.completed');
  if(completed.some(r=>!r.reportedModel))return null;
  const models=new Set(matches.flatMap(r=>r.evidence?.map(e=>e.model)??(r.reportedModel?[r.reportedModel]:[])));
  return models.size===1?[...models][0]:null;
}
