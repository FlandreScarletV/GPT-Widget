import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {archive,replaceFile,sha256} from '../src/asar.mjs';
import {patchChatObserver} from './chat-patch.mjs';
export function mergeDailyObserver(bytes){
 const ar=archive(bytes);const hits=[...ar.entries].filter(([n,e])=>n.startsWith('webview/')&&n.endsWith('.js')&&!e.unpacked&&ar.read(n).toString().includes('/* CODEX_MODEL_INSPECTOR_V02 */'));
 if(hits.length!==1)throw Error('Expected one existing widget');
 const name=hits[0][0];let source=ar.read(name).toString();
 const baseline=fs.readFileSync(new URL('../src/status.mjs',import.meta.url),'utf8').replaceAll('export function ','function ');
 if(!source.includes(baseline))throw Error('Existing UI differs: refusing to overwrite customizations');
 let ui=baseline;
 const replace=(from,to)=>{if(ui.split(from).length!==2)throw Error('UI feature missing or ambiguous: '+from);ui=ui.replace(from,to);};
 const description=fs.readFileSync(new URL('./chat-display.mjs',import.meta.url),'utf8').split('export function describeChatObservation')[1];
 ui='function describeChatObservation'+description+'\n'+ui;
 replace('selection }) {','selection, chatConversationId, isChat }) {');
 replace('const [hover,setHover] = React.useState(false);',`const [hover,setHover] = React.useState(false);
    const [detailType,setDetailType] = React.useState('ip');
    const [chatRecord,setChatRecord] = React.useState(null);
    React.useEffect(()=>{
      let disposed=false,busy=false;
      const update=async()=>{
        if(busy)return;busy=true;
        let next=null;
        try {
          if(isChat&&chatConversationId){
            const response=await fetch('app://-/inspector-chat-state.json',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(4000)});
            if(!response.ok)throw Error('state unavailable');
            const state=await response.json();
            if(state.schema!==1||!Array.isArray(state.records))throw Error('invalid state');
            next=state.records.find(r=>r.conversationId===chatConversationId)??null;
          }
        } catch { next=isChat?globalThis[Symbol.for('GPTWidget.ChatObservations')]?.get(chatConversationId)??null:null; }
        finally {busy=false;}
        if(!disposed)setChatRecord(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
      };
      void update();const timer=setInterval(()=>void update(),1000);return()=>{disposed=true;clearInterval(timer)};
    },[isChat,chatConversationId]);
    const observed=chatRecord?.conversationId===chatConversationId?chatRecord:null;
    const chatDisplay=describeChatObservation(observed);`);
 replace("['当前模型', value.current, value.currentNote+(exit?.logError?' 日记写入暂时失败，后台将重试。':''), value.mismatch ? colors.yellow : undefined]", "[isChat?'遥测模型':'当前模型', isChat?chatDisplay.model:value.current, isChat?undefined:value.currentNote+(exit?.logError?' 日记写入暂时失败，后台将重试。':''), (isChat?chatDisplay.difference:value.mismatch) ? colors.yellow : undefined]");
 replace("const details=label==='IP'||label==='IP风险';", "const details=label==='IP'||label==='IP风险'||(isChat&&label==='遥测模型');\n      const showDetails=()=>{setDetailType(label==='遥测模型'?'model':'ip');setHover(true)};");
 replace('onMouseEnter:details?()=>setHover(true):undefined','onMouseEnter:details?showDetails:undefined');
 replace('onFocus:details?()=>setHover(true):undefined','onFocus:details?showDetails:undefined');
 replace("lines.map((line,i)=>h('div',{key:i},line))", "(detailType==='model'?chatDisplay.lines:lines).map((line,i)=>h('div',{key:i},line))");
 source=source.replace(baseline,ui);
 const contexts=[...source.matchAll(/root:([\w$]+),selection:\{model:([\w$]+)\.slug,reasoning_effort:\2\.thinkingEffort\?\?`即时`,provider:`OpenAI`\}/g)];
 if(contexts.length!==1)throw Error('Expected one Chat widget binding');
 const ctx=contexts[0];
 const begin=[...source.slice(0,ctx.index).matchAll(/function ([\w$]+)\(e\)\{/g)].at(-1)?.index;
 const body=source.slice(begin,ctx.index);
 const conv=body.match(/conversationId:([\w$]+)/)?.[1];
 if(!conv||!body.includes('selectedModel:'+ctx[2])||!body.includes('kind:`chatgpt`'))throw Error('Chat context not proven');
 source=source.slice(0,ctx.index)+ctx[0].replace('root:'+ctx[1]+',','root:'+ctx[1]+',isChat:true,chatConversationId:'+conv+',')+source.slice(ctx.index+ctx[0].length);
 const checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});if(checked.status!==0)throw Error(checked.stderr);
 const withUI=replaceFile(bytes,name,Buffer.from(source));
 const result=patchChatObserver(withUI,null,{daily:true});
 return {bytes:result.bytes,report:{...result.report,baseDailySha256:sha256(bytes),patchedSha256:sha256(result.bytes),assets:[name,...result.report.assets],logDirectory:'<copy-root>/logs/chat-model',strategy:'daily-chat-observer-2',desktopAcceptance:'pending'}};
}
