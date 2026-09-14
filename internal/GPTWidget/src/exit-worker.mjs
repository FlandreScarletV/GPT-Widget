// Shares only Inspector's whitelisted observations through an unpacked local asset.
// No listening socket, debugger, Codex credentials, or host messages are involved.
import fs from 'node:fs';
import path from 'node:path';
import {Inspector} from '../../codex-model-inspector/server.mjs';
import {readQualityKey} from '../../codex-model-inspector/credentials.mjs';
import {RerouteLog,drainReroutes} from './reroute-log.mjs';
import {RefreshSession} from './refresh-session.mjs';
const [target,pid,logDirectory]=process.argv.slice(2);
if(!target||!/^\d+$/.test(pid||''))throw Error('Expected state path and owned app PID');
fs.mkdirSync(path.dirname(target),{recursive:true});
const requestDirectory=target+'.requests';fs.mkdirSync(requestDirectory,{recursive:true});
function requests(){return fs.readdirSync(requestDirectory).filter(n=>/^[a-f0-9-]{36}\.request$/.test(n));}
for(const name of requests())fs.unlinkSync(path.join(requestDirectory,name));
const logRoot=logDirectory||path.resolve(path.dirname(target),'../../../../..','logs');
const log=new RerouteLog(logRoot);
const rerouteDirectory=path.join(path.dirname(logRoot),'reroute-inbox');fs.mkdirSync(rerouteDirectory,{recursive:true});
let logError=null;
function write(value){const data=JSON.stringify({...value,requestDirectory,rerouteDirectory,logError});if(Buffer.byteLength(data)>16384)throw Error('State too large');fs.writeFileSync(target+'.tmp',Buffer.concat([Buffer.from(data),Buffer.alloc(16384-Buffer.byteLength(data),32)]));fs.renameSync(target+'.tmp',target);}
const session=new RefreshSession(async()=>{const inspector=new Inspector(fetch,Date.now,readQualityKey);await inspector.refresh();return {status:inspector.publicStatus(),details:inspector.uiDetails()}},write);
let running=true;
const watcher=setInterval(()=>{try{process.kill(Number(pid),0)}catch{running=false;write({});clearInterval(watcher);process.exit(0)}},5000);
void session.refresh();
// Only local control-file polling. No timer initiates an internet query.
setInterval(()=>{if(!running)return;const found=requests();for(const name of found)fs.unlinkSync(path.join(requestDirectory,name));if(found.length&&!session.pending)void session.refresh()},500);

setInterval(()=>{if(!running)return;const before=logError;try{drainReroutes(rerouteDirectory,log);logError=null}catch{logError='write_failed'}if(before!==logError)write(session.state)},1000);
