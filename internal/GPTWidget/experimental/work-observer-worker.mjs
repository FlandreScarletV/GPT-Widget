import fs from 'node:fs';import path from 'node:path';
import {createObserver} from './observer-proxy.mjs';import {createWorkState} from './work-state.mjs';
const [stateFile,readyFile,ownerFile]=process.argv.slice(2);
if(!stateFile||!readyFile||!ownerFile)throw Error('Expected state, ready, owner paths');
const store=createWorkState();let stopped=false;
function write(file,value){for(const p of [file,file+'.tmp'])if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('Invalid state path');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);}
const save=alive=>write(stateFile,{schema:1,alive,updatedAt:Date.now(),records:alive?store.snapshot():[]});
save(false);
const accept=r=>{if(r.kind==='request-start'&&!r.scope)store.clear();else store.accept(r);save(true);};
const proxy=await createObserver({upstream:'https://chatgpt.com/backend-api/codex',onObservation:accept,onRequestStart:accept});
write(readyFile,{pid:process.pid,baseUrl:proxy.baseUrl});save(true);
async function stop(){if(stopped)return;stopped=true;clearInterval(timer);await proxy.close();save(false);process.exit(0);}
const timer=setInterval(()=>{try{const owner=JSON.parse(fs.readFileSync(ownerFile,'utf8').replace(/^\uFEFF/,''));if(!Number.isInteger(owner.pid)||owner.pid<1)throw Error('owner');process.kill(owner.pid,0);save(true);}catch{void stop();}},2000);
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
