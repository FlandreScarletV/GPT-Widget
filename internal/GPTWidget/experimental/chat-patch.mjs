import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { archive, replaceFile, sha256 } from '../src/asar.mjs';

export function patchChatObserver(bytes, logDirectory, options = {}) {
  const ar = archive(bytes), candidates=[];
  for(const [name,e]of ar.entries){if(e.unpacked||e.link||!name.startsWith('webview/')||!name.endsWith('.js'))continue;const text=ar.read(name).toString();if(text.includes('async startCompletionStream({')&&text.includes('resumeCompletionStream({')&&text.includes('server_ste_metadata'))candidates.push({name,text});}
  if(candidates.length!==1)throw Error('Unsupported chat bundle count: '+candidates.length);
  const selected=candidates[0];let source=selected.text;
  if(source.includes('GPTWIDGET_CHAT_METADATA:'))throw Error('Already patched');
  const runtime=fs.readFileSync(new URL('./chat-observer.mjs',import.meta.url),'utf8').replaceAll('export function ','function ');
  const changes=[['async startCompletionStream({','async startCompletionStream(options){return this.__gwObservedStart(__gwChatWrap(options,`request`))}async __gwObservedStart({'],['resumeCompletionStream({','resumeCompletionStream(options){return this.__gwObservedResume(__gwChatWrap(options,`resume`))}__gwObservedResume({']];
  for(const[from,to]of changes){if(source.split(from).length!==2)throw Error('Nonunique method: '+from);source=source.replace(from,to);}
  const store = options.daily ? fs.readFileSync(new URL('./chat-display.mjs',import.meta.url),'utf8').replaceAll('export function ','function ') : '';
  const publish = options.daily ? 'globalThis[Symbol.for("GPTWidget.ChatObservations")].accept(record);' : '';
  source=`const __gwChatWrap=(()=>{${runtime}\n${store}\n${options.daily?'globalThis[Symbol.for("GPTWidget.ChatObservations")]=createChatDisplayStore(cleanChatRecord);':''}\nreturn (options,mode)=>{try{return wrapChatOptions(options,record=>{${publish}console.info('GPTWIDGET_CHAT_METADATA:'+JSON.stringify(record))},mode)}catch{return options}}})();\n`+source;
  const pkg=JSON.parse(ar.read('package.json'));const main=pkg.main.replace(/^\.\//,'');
  const clean=fs.readFileSync(new URL('./chat-observer.mjs',import.meta.url),'utf8').split('export function createChatObserver')[0].replace('export function ','function ');
  const sink=fs.readFileSync(new URL('./chat-log-sink.mjs',import.meta.url),'utf8').replace('export function ','function ');
  const lifecycle=fs.readFileSync(new URL('./chat-test-lifecycle.mjs',import.meta.url),'utf8').replace('export function ','function ');
  const stateFile=options.daily?fs.readFileSync(new URL('./chat-state-file.mjs',import.meta.url),'utf8').replaceAll('export function ','function '):'';
  const mainSource=`(()=>{${options.daily?'':'if(process.env.GPTWIDGET_CHAT_OBSERVER!=="1")return;'}${clean}\n${sink}\n${store}\n${stateFile}\n${lifecycle}\nconst fs=require('node:fs'),path=require('node:path'),app=require('electron').app,dir=${options.daily?'path.resolve(process.resourcesPath,"../../..","logs","chat-model")':JSON.stringify(logDirectory)};const publish=${options.daily?'installChatStateFile(fs,path,process.resourcesPath,createChatDisplayStore(cleanChatRecord))':'undefined'};installChatLogSink(app,fs,path,dir,cleanChatRecord,publish);installTestLifecycle(app,event=>{fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'test-lifecycle.jsonl');if(fs.existsSync(file)&&fs.statSync(file).size>131072)fs.renameSync(file,file+'.previous');fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),pid:process.pid,event})+'\\n','utf8');});})();\n`+ar.read(main).toString();
  for(const [name,code]of [[selected.name,source],[main,mainSource]]){const check=spawnSync(process.execPath,['--input-type='+ (name===main?'commonjs':'module'),'--check'],{input:code,encoding:'utf8'});if(check.status!==0)throw Error('Syntax failure '+name+': '+check.stderr);}
  let patched=replaceFile(bytes,selected.name,Buffer.from(source));patched=replaceFile(patched,main,Buffer.from(mainSource));
  const trayAssets=[];
  for(const [name] of ar.entries){
    if(!name.startsWith('.vite/build/')||!name.endsWith('.js'))continue;
    const text=ar.read(name).toString();
    const pattern=/new ([\w$]+)\.Tray\(([^,]+),process\.platform===`win32`&&\1\.app\.isPackaged\?([\w$]+)\(([^)]+)\):void 0\)/g;
    const matches=[...text.matchAll(pattern)];if(!matches.length)continue;
    if(matches.length!==1)throw Error('Ambiguous tray identity');
    const updated=text.replace(pattern,'new $1.Tray($2,process.platform===`win32`?`7753b2e9-599f-4ab6-a4a6-58df27d96ea2`:void 0)');
    patched=replaceFile(patched,name,Buffer.from(updated));trayAssets.push(name);
  }
  if(trayAssets.length!==1)throw Error('Unsupported tray identity count: '+trayAssets.length);
  return {bytes:patched,report:{version:pkg.version,originalSha256:sha256(bytes),patchedSha256:sha256(patched),assets:[selected.name,main,...trayAssets],logDirectory}};
}

