// Read-only model metadata. Missing observations never mean a verified match.
export function clean(value) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160).trim() : null;
}

export function snapshot(manager, threadId, turnKey, selection) {
  let conversation = null, turn = null;
  try {
    if (threadId) {
      conversation = manager.getConversation(threadId);
      if (turnKey?.entityKey) turn = manager.getTurn(threadId, turnKey.entityKey);
    }
  } catch {
    return { unavailable: true, selection };
  }
  // Do not serialize the conversation, prompts, tool results or account state.
  const params = turn?.params;
  return {
    selection: {
      model: clean(selection?.model),
      effort: clean(selection?.reasoning_effort)
    },
    provider: clean(conversation?.modelProvider)||clean(selection?.provider),
    threadId: clean(threadId),
    turnId: clean(turn?.turnId),
    turnScope: clean(turnKey?.entityKey),
    status: clean(turn?.status),
    requested: clean(params?.collaborationMode?.settings?.model) || clean(params?.model),
    effort: clean(params?.collaborationMode?.settings?.reasoning_effort) || clean(params?.effort),
    reroutes: (turn?.items || []).filter(item => item.type === 'modelRerouted').map(item => ({
      from: clean(item.fromModel), to: clean(item.toModel), reason: clean(item.reason)
    }))
  };
}

export function derive(input = {}) {
  const selection = input.selection || {};
  const active = input.status === 'inProgress';
  // Idle dropdown changes must not inherit a different model's historical result.
  const changed = !active && selection.model && input.requested && selection.model !== input.requested;
  const requested = clean(active ? input.requested : selection.model || input.requested);
  const effort = clean(active ? input.effort : selection.effort || input.effort);
  const reroutes = !changed && input.turnId && !input.unavailable ? input.reroutes || [] : [];
  let expected = clean(input.requested), reported = null, conflict = false;
  for (const event of reroutes) {
    if (!event.from || !event.to) { conflict = true; continue; }
    if (expected && expected !== event.from) conflict = true;
    expected = event.to;
    reported = event.to;
  }
  const mismatch = !!reported && !!requested && reported !== requested;
  let risk = conflict ? '高' : reported ? (mismatch || reroutes.length ? '中' : '低') : '未知';
  let reason = conflict ? '同一轮次的模型路由证据不一致'
    : reported ? 'Codex 保存的 model/rerouted 事件；不代表模型权重证明'
    : '没有可用的服务端模型观测；未收到重路由通知不等于模型一致';
  if (input.unavailable) { risk = '未知'; reason = '当前版本的只读状态接口不可用'; }
  const provider = clean(input.provider);
  return {
    requested: requested || '未知', effort: effort || '未知',
    reported: reported || '未知', provider: provider === 'openai' ? 'OpenAI' : provider || '未知',
    current: reported || requested || '未知',
    currentNote: reported ? '服务端重路由报告：'+reported : '未检测到重路由，当前显示请求模型；并非服务端独立确认。',
    ip: '未知', risk, mismatch, reason,
    requestedNote: active ? '本轮提交参数' : '当前输入区设置；下一次请求的预期参数',
    reportedNote: !reported ? reason : (active ? '当前轮次' : '最近一轮') + '服务端路由报告',
    ipNote: '当前前端未提供可关联到本轮的出口或边缘节点地理信息'
  };
}

export function createInspector(React, writeRefresh) {
  const h = React.createElement;
  const delivered=new Set(),sending=new Set();
  function InspectorFrame({ root, manager, threadId, turnKey, selection }) {
    const model = clean(selection?.model), effort = clean(selection?.reasoning_effort);
    const read = () => derive(snapshot(manager, threadId, turnKey, {model, reasoning_effort: effort,provider:selection?.provider}));
    const [cached, setCached] = React.useState(() => ({key: '', value: read()}));
    const key = [threadId, turnKey?.entityKey, model, effort].join('|');
    const value = cached.key === key ? cached.value : read();
    const [exit,setExit] = React.useState(null);
    const [hover,setHover] = React.useState(false);
    const [clickBusy,setClickBusy]=React.useState(false);
    const [clickError,setClickError]=React.useState(null);
    const clickedAt=React.useRef(0);
    React.useEffect(()=>{
      let disposed=false,busy=false;
      const poll=async()=>{if(busy)return;busy=true;try{
        const response=await fetch('app://-/inspector-state.json',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(4000)});
        if(!response.ok)throw Error('Unavailable');
        const data=await response.json();if(!disposed){setExit(data);
          if(clickedAt.current&&data.refreshFinishedAt>=clickedAt.current){clickedAt.current=0;setClickBusy(false)}
        }
      }catch{if(!disposed)setClickError('无法读取后台状态；显示上次结果')}finally{
        if(!disposed&&clickedAt.current&&Date.now()-clickedAt.current>60000){clickedAt.current=0;setClickBusy(false);setClickError('刷新等待超时；保留上次结果')}
        busy=false}};
      poll();const timer=setInterval(poll,5000);return()=>{disposed=true;clearInterval(timer)};
    },[]);
    React.useEffect(()=>{
      if(!exit?.rerouteDirectory||!writeRefresh)return;
      let disposed=false;
      const record=async()=>{
        const data=snapshot(manager,threadId,turnKey,selection);
        if(data.unavailable)return;
        for(const [eventIndex,event] of (data.reroutes||[]).entries()){
          if(disposed||!event.from||!event.to)continue;
          const scope=data.turnId||data.turnScope;
          if(!scope)continue;
          const recordKey=JSON.stringify([data.threadId,scope,eventIndex,event.from,event.to]);
          if(delivered.has(recordKey)||sending.has(recordKey))continue;
          sending.add(recordKey);
          try{
            const payload={type:'modelRerouted',conversationId:data.threadId,turnId:data.turnId,scope,eventIndex,requestedModel:data.requested,fromModel:event.from,reroutedModel:event.to,reasoningEffort:data.effort,provider:data.provider};
            const result=await writeRefresh(exit.rerouteDirectory+'/'+crypto.randomUUID()+'.reroute.json',JSON.stringify(payload));
            if(result?.outcome==='saved'){delivered.add(recordKey);if(delivered.size>4096)delivered.delete(delivered.values().next().value)}
          }catch{}finally{sending.delete(recordKey)}
        }
      };
      void record();const timer=setInterval(()=>void record(),1000);
      return()=>{disposed=true;clearInterval(timer)};
    },[manager,threadId,turnKey?.entityKey,exit?.rerouteDirectory]);
    const network=exit;
    const ipRisk=network?.status?.ipRisk||'未知';
    const refreshing=clickBusy||!!exit?.refreshing;
    const refresh=async()=>{
      if(refreshing)return;
      clickedAt.current=Date.now();setClickBusy(true);setClickError(null);
      try{
        if(!writeRefresh||!exit?.requestDirectory)throw Error('not ready');
        const result=await writeRefresh(exit.requestDirectory+'/'+crypto.randomUUID()+'.request');
        if(result?.outcome!=='saved')throw Error('not saved');
      }catch{clickedAt.current=0;setClickBusy(false);setClickError('刷新请求未送达；保留上次结果')}
    };
    React.useEffect(() => {
      const update = () => {
        const next = read();
        setCached(old => old.key === key && JSON.stringify(old.value) === JSON.stringify(next)
          ? old : {key, value: next});
      };
      update();
      // A bounded read of only the active turn; no RPC or network subscription.
      const timer = setInterval(update, 750);
      return () => clearInterval(timer);
    }, [manager, threadId, turnKey?.entityKey, model, effort]);
    const colors = {
      yellow: 'var(--color-accent-yellow, #d6a000)',
      red: 'var(--color-text-danger, #d32f2f)'
    };
    const cells = [
      ['请求模型', value.requested, value.requestedNote],
      ['思考能力', value.effort, value.requestedNote],
      ['当前模型', value.current, value.currentNote+(exit?.logError?' 日记写入暂时失败，后台将重试。':''), value.mismatch ? colors.yellow : undefined],
      ['供应商', value.provider, 'Codex 任务配置中的供应商标识'],
      ['IP', refreshing?'刷新中…':network?.status?.ipRegion||'未知', null],
      ['IP风险', ipRisk, null, ipRisk === '高' ? colors.red : ipRisk === '中' ? colors.yellow : undefined]
    ];
    const bar = h('div', {
      key: 'codex-model-inspector-v02', 'data-codex-model-inspector': '0.4.0',
      role: 'status', 'aria-label': 'Codex 模型监视器',
      style: {
        display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: '2ch',
        minWidth: 0, maxWidth: '100%', boxSizing: 'border-box',
        width: '100%', margin: '0 0 6px',
        padding: '6px 10px', borderRadius: '8px',
        fontFamily: 'inherit', fontSize: '12px', lineHeight: '18px',
        color: 'var(--color-text, inherit)',
        background: 'var(--color-surface, transparent)',
        border: '1px solid var(--color-border, transparent)',
        overflowX: 'auto', whiteSpace: 'nowrap', scrollbarWidth: 'thin'
      }
    }, cells.map(([label, text, title, color]) => {
      const details=label==='IP'||label==='IP风险';
      return h('span', {key: label, title, tabIndex:details?0:undefined,role:label==='IP'?'button':undefined,
        'aria-label':label==='IP'?'刷新 IP 和 IP风险':undefined,'aria-disabled':label==='IP'?refreshing:undefined,
        onClick:label==='IP'?refresh:undefined,
        onMouseEnter:details?()=>setHover(true):undefined,onMouseLeave:details?()=>setHover(false):undefined,
        onFocus:details?()=>setHover(true):undefined,onBlur:details?()=>setHover(false):undefined,
        onKeyDown:details?e=>{if(e.key==='Escape')setHover(false);if(label==='IP'&&(e.key==='Enter'||e.key===' ')){e.preventDefault();void refresh()}}:undefined,
        style: {flexShrink: 0, color,cursor:label==='IP'?'pointer':details?'help':undefined}}, label + '：' + text);
    }));
    const d=network?.details,v=x=>x===true?'是':x===false?'否':x==null||x===''?'未知':String(x);
    const lines=d?[
      'IP：'+v(d.ip),
      '地区：'+[d.country,d.region,d.city].filter(Boolean).join(' · ')+' · AS'+String(d.asn||'?').replace(/^AS/i,''),
      '网络：'+v(d.isp||d.organization||d.company)+' · '+v(d.networkType),
      'VPN '+v(d.signals?.vpn)+' · 代理 '+v(d.signals?.proxy)+' · Tor '+v(d.signals?.tor),
      '机房 '+v(d.signals?.hosting)+' · 滥用标记 '+v(d.abuser),
      '来源：'+[d.regionSource,d.qualitySource].filter(Boolean).map(s=>{try{return new URL(s).hostname}catch{return '未知'}}).join(' / ')+' · '+new Date(d.observedAt).toLocaleTimeString()
    ]:['暂无有效出口观测；等待查询或检查网络连接'];
    if(clickError||exit?.refreshError)lines[lines.length-1]+=' · '+(clickError||exit.refreshError);
    const detail=h('div',{role:'tooltip','data-inspector-detail':'',
      onMouseEnter:()=>setHover(true),onMouseLeave:()=>setHover(false),
      style:{position:'absolute',bottom:'100%',right:0,zIndex:1000,width:'380px',maxWidth:'100%',boxSizing:'border-box',padding:'8px 10px',
        borderRadius:'5px',boxShadow:'none',border:'1px solid var(--color-border, #777)',
        background:'var(--color-surface, Canvas)',color:'var(--color-text, CanvasText)',fontSize:'12px',lineHeight:1.65,
        whiteSpace:'normal',overflowWrap:'anywhere',opacity:hover?1:0,visibility:hover?'visible':'hidden',
        transition:hover?'opacity 0.5s ease':'opacity 0.5s ease, visibility 0s linear 0.5s',pointerEvents:hover?'auto':'none'}},
      lines.map((line,i)=>h('div',{key:i},line)));
    const wrapper=h('div',{key:'inspector-wrapper',style:{position:'relative',width:'100%',minWidth:0}},bar,detail);
    // A real child in the Composer layout, preserving the existing React root.
    return React.cloneElement(root, undefined, wrapper, root.props.children);
  }
  return class InspectorBoundary extends React.Component {
    state = {failed: false};
    static getDerivedStateFromError() { return {failed: true}; }
    render() {
      // A display failure restores the untouched original Composer immediately.
      return this.state.failed ? this.props.root : h(InspectorFrame, this.props);
    }
  };
}
