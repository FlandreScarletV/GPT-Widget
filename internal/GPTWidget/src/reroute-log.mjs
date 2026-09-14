import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const field=v=>typeof v==='string'&&v.length<=160?v.replace(/[\u0000-\u001f\u007f]/g,'').trim()||null:null;
export function normalizeReroute(event){
  if(event?.type!=='modelRerouted')return null;
  const fromModel=field(event.fromModel),reroutedModel=field(event.reroutedModel);
  if(!fromModel||!reroutedModel)return null;
  const conversationId=field(event.conversationId),turnId=field(event.turnId),scope=field(event.scope);
  if(!conversationId&&!turnId&&!scope)return null;
  const eventIndex=Number.isSafeInteger(event.eventIndex)&&event.eventIndex>=0&&event.eventIndex<10000?event.eventIndex:0;
  const record={conversationId,turnId,requestedModel:field(event.requestedModel),fromModel,reroutedModel,reasoningEffort:field(event.reasoningEffort),provider:field(event.provider),eventIndex};
  const key=createHash('sha256').update(JSON.stringify([conversationId,turnId||scope,eventIndex,fromModel,reroutedModel])).digest('hex');
  return {key,...record};
}
export class RerouteLog {
  constructor(directory,{maxBytes=1024*1024,files=5,clock=()=>new Date()}={}){this.directory=directory;this.maxBytes=maxBytes;this.files=files;this.clock=clock;}
  append(event){
    const record=normalizeReroute(event);if(!record)return {status:'invalid'};
    fs.mkdirSync(this.directory,{recursive:true});
    const file=path.join(this.directory,'reroute-history.jsonl'),lock=file+'.lock';
    let fd;
    try{fd=fs.openSync(lock,'wx');}catch(e){
      if(e.code!=='EEXIST')throw e;
      const owner=Number(fs.readFileSync(lock,'utf8'));
      if(!Number.isSafeInteger(owner)||owner<=0)throw Error('log_locked');
      try{process.kill(owner,0);throw Error('log_locked');}catch(check){if(check.code!=='ESRCH')throw check;}
      fs.unlinkSync(lock);fd=fs.openSync(lock,'wx');
    }
    try{
      fs.writeFileSync(fd,String(process.pid));
      // Deduplicate against retained history, including after restart and across workers.
      for(let i=0;i<this.files;i++){
        const p=i?file+'.'+i:file;if(!fs.existsSync(p))continue;
        for(const line of fs.readFileSync(p,'utf8').split('\n')){try{if(JSON.parse(line).key===record.key)return {status:'duplicate'};}catch{}}
      }
      const line=JSON.stringify({observedAt:this.clock().toISOString(),source:'Codex modelRerouted observation',...record})+'\n';
      if(fs.existsSync(file)&&fs.statSync(file).size+Buffer.byteLength(line)>this.maxBytes){
        const last=file+'.'+(this.files-1);if(fs.existsSync(last))fs.unlinkSync(last);
        for(let i=this.files-2;i>=0;i--){const p=i?file+'.'+i:file;if(fs.existsSync(p))fs.renameSync(p,file+'.'+(i+1));}
      }
      if(fs.existsSync(file)&&fs.statSync(file).size){const h=fs.openSync(file,'r');try{const b=Buffer.alloc(1);fs.readSync(h,b,0,1,fs.statSync(file).size-1);if(b[0]!==10)fs.appendFileSync(file,'\n');}finally{fs.closeSync(h)}}
      fs.appendFileSync(file,line,'utf8');return {status:'written'};
    }finally{fs.closeSync(fd);fs.unlinkSync(lock)}
  }
}
export function drainReroutes(directory,log){
  for(const name of fs.readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.reroute\.json$/.test(n)).slice(0,20)){
    const file=path.join(directory,name),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())continue;
    if(stat.size>8192){fs.unlinkSync(file);continue}
    let event;try{event=JSON.parse(fs.readFileSync(file,'utf8'))}catch{fs.unlinkSync(file);continue}
    log.append(event);fs.unlinkSync(file);
  }
}
