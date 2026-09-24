const id=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(v)?v:null;
export function createWorkState(limit=8) {
  const turns=new Map();
  return {
    clear(){turns.clear();},
    accept(r){
      const s=r?.scope;
      if(!s||s.scopeConflict||!id(s.threadId)||!id(s.turnId)||s.requestKind!=='turn'||r.generationRequested!==true||!id(r.requestId))return;
      const key=s.threadId+'|'+s.turnId;
      let t=turns.get(key);
      if(!t){t={threadId:s.threadId,turnId:s.turnId,active:new Set(),ended:new Set(),models:new Set(),requestedModel:null,reportedModel:null,status:'unknown',invalid:false};turns.set(key,t);}
      if(r.kind==='request-start'){
        if(t.ended.has(r.requestId))return;
        t.active.add(r.requestId);t.status='pending';t.requestedModel=id(r.requestedModel);t.reportedModel=null;
        if(t.active.size>1)t.invalid=true;
      }else if(r.kind==='turn'){
        if(t.ended.has(r.requestId))return;
        if(!t.active.has(r.requestId))t.invalid=true; // No matching start => never treat stale/replayed completion as current.
        t.active.delete(r.requestId);t.ended.add(r.requestId);
        if(t.ended.size>128)t.invalid=true;
        const model=id(r.reportedModel);
        if(r.association!=='single_inflight'||r.conflict)t.invalid=true;
        if(model)t.models.add(model);
        if(t.models.size>1)t.invalid=true;
        t.status=t.active.size?'pending':!t.invalid&&r.outcome==='response.completed'&&model?'complete':'unknown';
        t.reportedModel=t.status==='complete'?model:null;
      }else return;
      if(t.ended.size>128)t.ended.delete(t.ended.values().next().value);
      if(t.active.size>128){t.active.clear();t.status='unknown';t.invalid=true;}
      turns.delete(key);turns.set(key,t);
      while(turns.size>limit)turns.delete(turns.keys().next().value);
    },
    snapshot(){return [...turns.values()].map(t=>({threadId:t.threadId,turnId:t.turnId,requestedModel:t.requestedModel,reportedModel:t.reportedModel,status:t.status}));}
  };
}

export function describeWorkTelemetry(state,threadId,turnId,selectedModel,now=Date.now()) {
  if(state?.schema!==1||!state.alive||!Number.isFinite(state.updatedAt)||now-state.updatedAt>15000||now<state.updatedAt||!Array.isArray(state.records))return null;
  const record=state.records.find(r=>r.threadId===threadId&&r.turnId===turnId);
  if(!record||!threadId||!turnId||record.status!=='complete'||typeof record.reportedModel!=='string'||!record.reportedModel||record.requestedModel!==selectedModel)return null;
  return {model:record.reportedModel,difference:record.reportedModel!==record.requestedModel,note:'当前任务本轮最近成功响应报告模型；不代表每次尝试或内部物理模型。'};
}
