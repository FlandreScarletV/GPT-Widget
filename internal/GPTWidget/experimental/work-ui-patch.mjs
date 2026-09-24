import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {archive,replaceFile,sha256} from '../src/asar.mjs';
export function patchWorkTelemetry(bytes){
 const ar=archive(bytes);let output=bytes;const changed=[];
 const ui=[...ar.entries].filter(([n,e])=>!e.unpacked&&n.startsWith('webview/')&&n.endsWith('.js')&&ar.read(n).toString().includes('const network=exit;'));
 if(ui.length!==1)throw Error('Work UI anchor not unique');
 const name=ui[0][0];let source=ar.read(name).toString();
 const helper=fs.readFileSync(new URL('./work-state.mjs',import.meta.url),'utf8').split('export function describeWorkTelemetry')[1];
 const anchor="[isChat?'遥测模型':'当前模型', isChat?chatDisplay.model:value.current, isChat?undefined:value.currentNote+(exit?.logError?' 日记写入暂时失败，后台将重试。':''), (isChat?chatDisplay.difference:value.mismatch) ? colors.yellow : undefined]";
 if(source.split(anchor).length!==2)throw Error('Daily model cell differs; preserve custom UI');
 source='function describeWorkTelemetry'+helper+'\n'+source;
 source=source.replace('const network=exit;',`const network=exit;
    const workSnapshot=snapshot(manager,threadId,turnKey,selection);
    const workDisplay=!isChat?describeWorkTelemetry(exit?.workTelemetry,workSnapshot.threadId,workSnapshot.turnId,value.requested):null;`);
 source=source.replace(anchor,"['遥测模型', isChat?chatDisplay.model:(workDisplay?.model||'未知'), isChat?undefined:(workDisplay?.note||'当前任务本轮尚无可靠的服务端模型观测'), (isChat?chatDisplay.difference:workDisplay?.difference) ? colors.yellow : undefined]");
 let checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});if(checked.status!==0)throw Error('Work UI syntax');
 output=replaceFile(output,name,Buffer.from(source));changed.push(name);
 const localResolver=/function [\w$]+\(e\)\{let t=e\.hostConfig\.codex_cli_command;[\s\S]*?source:r\.source\}:null\}/g;
 const candidates=[...ar.entries].filter(([n,e])=>!e.unpacked&&n.startsWith('.vite/')&&n.endsWith('.js')&&[...ar.read(n).toString().matchAll(localResolver)].length>0);
 if(candidates.length!==1)throw Error('Local desktop resolver file not unique');
 const main=candidates[0][0];let mainSource=ar.read(main).toString();
 const resolvers=[...mainSource.matchAll(localResolver)];
 if(resolvers.length!==1)throw Error('Local desktop resolver not unique');
 const resolver=resolvers[0][0];
 const args=resolver.match(/executablePath:n,args:([\w$]+\(\))/)?.[1];
 if(!args||!resolver.includes('executablePath:r.executablePath,args:'+args)||!resolver.includes('executablePath:e,args:n,source:'))throw Error('Local desktop resolver changed');
 mainSource=mainSource.replace(resolver,resolver
   .replace('executablePath:e,args:n,source:','executablePath:e,args:__gwWorkArgs(e,n),source:')
   .replace('executablePath:n,args:'+args,'executablePath:n,args:__gwWorkArgs(n,'+args+')')
   .replace('executablePath:r.executablePath,args:'+args,'executablePath:r.executablePath,args:__gwWorkArgs(r.executablePath,'+args+')'));
 const pattern=/let\{args:([\w$]+),command:([\w$]+),cwd:([\w$]+)\}=this\.options,([\w$]+)=\(async\(\)=>\{this\.logger\.info\(`Starting local app-server sidecar`/g;
 if(mainSource.includes('Starting local app-server sidecar')&&[...mainSource.matchAll(pattern)].length!==1)throw Error('App Server startup shape changed');
 mainSource=mainSource.replace(pattern,'let{args:$1,command:$2,cwd:$3}=this.options;$1=__gwWorkArgs($2,$1);let $4=(async()=>{this.logger.info(`Starting local app-server sidecar`');
 mainSource=`function __gwWorkArgs(command,args){const u=process.env.GPTWIDGET_OBSERVER_URL;if(!u||!/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/[a-f0-9]{48}\\/backend-api\\/codex$/.test(u)||!Array.isArray(args)||!args.includes('app-server')||!/(?:^|[\\\\/])codex(?:\\.exe)?$/i.test(command))return args;return [...args,'-c','openai_base_url='+JSON.stringify(u)];}\n`+mainSource;
 checked=spawnSync(process.execPath,['--check'],{input:mainSource,encoding:'utf8'});if(checked.status!==0)throw Error('App Server hook syntax');
 output=replaceFile(output,main,Buffer.from(mainSource));changed.push(main);
 return {bytes:output,report:{sourceSha256:sha256(bytes),patchedSha256:sha256(output),changedFiles:changed,desktopAcceptance:'pending'}};
}
