// Renderer-local, bounded observations; never reuse one conversation for another.
export function createChatDisplayStore(clean) {
  const streams=new Map(),latest=new Map();let sequence=0;
  return {
    accept(input){
      const r=clean(input);if(!r)return;
      let entry=streams.get(r.observationId);
      if(!entry){entry={order:++sequence};streams.set(r.observationId,entry);}
      if(!r.conversationId)return;
      const previous=latest.get(r.conversationId);
      if(previous&&previous.order>entry.order)return;
      latest.delete(r.conversationId);latest.set(r.conversationId,{order:entry.order,record:r});
      if(latest.size>128)latest.delete(latest.keys().next().value);
      if(streams.size>1024)streams.delete(streams.keys().next().value);
    },
    get(conversationId){return conversationId?latest.get(conversationId)?.record??null:null;},
    snapshot(){return Array.from(latest.values(),entry=>entry.record);}
  };
}

export function describeChatObservation(record) {
  const r=record;
  const values=r?[r.serverTelemetryModel,r.assistantMessageModel,r.resolvedModelSlug,...(r.messages||[]).flatMap(m=>[m.role==='assistant'?m.modelSlug:null,m.resolvedModelSlug])].filter(Boolean):[];
  const all=values.concat(r?.requestModel&&r.requestModel!=='auto'?[r.requestModel]:[]);
  const difference=new Set(all).size>1;
  const complete=!!(r?.serverTelemetryModel&&r?.assistantMessageModel&&r?.resolvedModelSlug);
  const status=!r?'暂无本次启动的观测':r.explicitReroute?'收到明确重路由':difference?'模型元数据差异':!complete?'观测字段不完整':r.requestModel==='auto'?'自动选择（响应字段一致）':'已观测字段一致';
  return {label:'遥测模型',model:r?.serverTelemetryModel||'未知',difference,
    lines:[
      '本次启动最近一轮请求：'+(r?.requestModel||'未知'),
      '服务器遥测：'+(r?.serverTelemetryModel||'未知'),
      '助手消息：'+(r?.assistantMessageModel||'未知'),
      'Resolved：'+(r?.resolvedModelSlug||'未知')+'（'+(r?.resolvedModelRole||'未知')+'）',
      status+'；不代表内部实际执行模型'
    ]};
}
