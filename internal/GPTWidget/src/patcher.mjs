import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {archive, replaceFile, sha256, writeNewAtomic} from './asar.mjs';
import {mergeDailyObserver} from '../experimental/daily-chat-patch.mjs';
import {patchWorkTelemetry} from '../experimental/work-ui-patch.mjs';

const marker = '/* CODEX_MODEL_INSPECTOR_V02 */';
const tick = String.fromCharCode(96);
const rootFeature = '"data-codex-composer-root":' + tick + tick;
const statusFile = fileURLToPath(new URL('./status.mjs', import.meta.url));
function unique(matches, name) {
  const list = Array.from(matches);
  if (list.length !== 1) throw Error('待适配版本: ' + name + ' matches=' + list.length);
  return list[0];
}
function match(text, regex, name) {
  const result = text.match(regex);
  if (!result) throw Error('待适配版本: missing ' + name);
  return result;
}
export function detect(original) {
  const ar = archive(original);
  const pkg = JSON.parse(ar.read('package.json'));
  if (pkg.name !== 'openai-codex-electron') throw Error('Unexpected application');
  const candidates = [];
  for (const [name, entry] of ar.entries) {
    if (!name.startsWith('webview/') || !name.endsWith('.js') || entry.unpacked) continue;
    const text = ar.read(name).toString();
    if (text.includes(rootFeature)) candidates.push({name, text});
  }
  const {name, text} = unique(candidates, 'Composer root bundle');
  if (text.includes(marker)) throw Error('Already patched; use the official original archive');
  const roots = [...text.matchAll(/"data-codex-composer-root":/g)].filter(hit => {
    const begin = [...text.slice(0, hit.index).matchAll(/function ([\w$]+)\([\w$]+\)\{/g)].at(-1)?.index;
    const finish = text.indexOf('function ', hit.index);
    const candidate = begin === undefined ? '' : text.slice(begin, finish);
    return /\{activeMode:[\w$]+,modes:/.test(candidate) && candidate.includes('threadId:');
  });
  const rootAt = unique(roots, 'Composer with live model and thread context').index;
  const starts = Array.from(text.slice(0, rootAt).matchAll(/function ([\w$]+)\([\w$]+\)\{/g));
  const start = starts.at(-1)?.index;
  if (start === undefined) throw Error('待适配版本: Composer function');
  const end = text.indexOf('function ', rootAt);
  if (end < 0) throw Error('待适配版本: Composer function boundary');
  const body = text.slice(start, end);
  const turnContext = match(body, /([\w$]+)=([\w$]+)\([\w$]+,([\w$]+)==null\?null:\{hostId:([\w$]+),threadId:\3\}\)\?\.at\(-1\)\?\?null/, 'turn context');
  const [, , useAtom, thread, host] = turnContext;
  const escaped = value => value.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&');
  const manager = match(body,new RegExp('([\\w$]+)=[\\w$]+\\('+escaped(thread)+'\\),'+escaped(host)+'='+escaped(useAtom)+'\\('),'manager binding')[1];
  const turn = match(body, new RegExp('([\\w$]+)=' + escaped(useAtom)
    + '\\([\\w$]+,' + escaped(thread) + '==null\\?null:\\{hostId:' + escaped(host)
    + ',threadId:' + escaped(thread) + '\\}\\)\\?\\.at\\(-1\\)\\?\\?null'), 'active turn binding')[1];
  const active = match(body, /\{activeMode:([\w$]+),modes:/, 'model settings')[1];
  const react = match(body, /\(0,([\w$]+)\.useState\)/, 'React binding')[1];
  const root = match(body, /([\w$]+)=\(0,([\w$]+)\.jsxs\)\([^;]{0,180}"data-codex-composer-root":/, 'root JSX');
  const [, rootVar, jsx] = root;
  if (!body.endsWith(',' + rootVar + '}')) throw Error('待适配版本: Composer return shape');
  const support = [];
  for (const [file, entry] of ar.entries) {
    if (file.startsWith('webview/') && file.endsWith('.js') && !entry.unpacked && entry.size > 1000000) {
      const source = ar.read(file).toString();
      if (/getTurn\(([\w$]+),([\w$]+)\)\{return this.threadStore.getTurn\(\1,\2\)\}/.test(source)
        && source.includes('type:' + tick + 'modelRerouted' + tick)
        && source.includes('model/rerouted')) support.push(file);
    }
  }
  if (!support.length) throw Error('待适配版本: read-only turn metadata API');
  return {name, text, start, end, body, thread, manager, host, turn, active, react, jsx, rootVar,
    version: pkg.version, support};
}

export function patch(original) {
  const d = detect(original);
  const runtime = fs.readFileSync(statusFile, 'utf8').replaceAll('export function ', 'function ');
  const legacyRpc=d.text.match(/([\w$]+)\(`write-file`,\{params:\{content:/)?.[1];
  let extraImport='',writeCall;
  if(legacyRpc)writeCall=legacyRpc+'(`write-file`,{params:{content,expectedMtimeMs:null,hostId:`local`,path}})';
  else {
    const files=archive(original);
    const storage=unique([...files.entries].filter(([n,e])=>!e.unpacked&&/^webview\/assets\/text-file-storage-[\w-]+\.js$/.test(n)),'text file storage');
    const storageSource=files.read(storage[0]).toString();
    const fn=match(storageSource,/async function ([\w$]+)\(\{cloudFileAccess:[\w$]+,content:/,'write function')[1];
    const exported=match(storageSource,new RegExp('\\b'+fn+' as ([\\w$]+)[,}]'),'write export')[1];
    extraImport='import{'+exported+' as __CMIWrite}from"./'+path.posix.basename(storage[0])+'";\n';
    writeCall='__CMIWrite({content,expectedMtimeMs:null,hostId:`local`,filePath:path})';
  }
  const factory = extraImport+'\n' + marker + '\nconst __CMICreate=(()=>{' + runtime
    + '\nreturn React=>createInspector(React,(path,content=`refresh`)=>'+writeCall+');})();let __CMIFrame;\n';
  const tail = ',(0,' + d.jsx + '.jsx)((__CMIFrame??=__CMICreate(' + d.react + ')),{root:'
    + d.rootVar + ',manager:' + d.manager + ',threadId:' + d.thread + ',turnKey:' + d.turn
    + ',selection:' + d.active + '.settings})}';
  const body = d.body.slice(0, -(d.rootVar.length + 2)) + tail;
  let source = factory + d.text.slice(0, d.start) + body + d.text.slice(d.end);
  const functions = [...source.matchAll(/function ([\w$]+)\(e\)\{/g)];
  const chats = functions.map((m,i)=>({start:m.index,text:source.slice(m.index,functions[i+1]?.index??source.length)}))
    .filter(f=>f.text.includes('aboveComposerHeaderContent:')&&f.text.includes('selectedModel:')&&f.text.includes('kind:`chatgpt`'));
  const chat = unique(chats,'ordinary chat composer');
  const selected = match(chat.text,/selectedModel:([\w$]+)/,'chat model')[1];
  const chatReact = match(chat.text,/\(0,([\w$]+)\.useState\)/,'chat React')[1];
  const chatJsx = match(chat.text,/\(0,([\w$]+)\.jsxs?\)/,'chat JSX')[1];
  // The header slot has its own horizontal inset. Insert at the outer provider
  // instead so the bar and form participate in the same full-width layout.
  const chatReturn=match(chat.text,/,([\w$]+)\}$/,'chat return')[1];
  const header=',(0,'+chatJsx+'.jsx)((__CMIFrame??=__CMICreate('+chatReact+')),{root:'+chatReturn+',selection:{model:'+selected+'.slug,reasoning_effort:'+selected+'.thinkingEffort??`即时`,provider:`OpenAI`}})}';
  const chatBody=chat.text.slice(0,-(chatReturn.length+2))+header;
  source=source.slice(0,chat.start)+chatBody+source.slice(chat.start+chat.text.length);
  const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {input: source, encoding: 'utf8'});
  if (check.status !== 0) throw Error('Patched JavaScript syntax failed: ' + check.stderr);
  const ar=archive(original);
  const closeFeature='.on(`close`,e=>{this.persistPrimaryWindowBounds(';
  const main=unique([...ar.entries].filter(([name,entry])=>name.startsWith('.vite/')&&name.endsWith('.js')&&!entry.unpacked&&ar.read(name).toString().includes(closeFeature)),'primary window close handler')[0];
  const mainSource=ar.read(main).toString();
  unique(mainSource.matchAll(/\.on\(`close`,e=>\{this\.persistPrimaryWindowBounds\(/g),'primary close handler');
  const quitCode=fs.readFileSync(new URL('./quit-copy.mjs',import.meta.url),'utf8').replace('export function requestCopyQuit','function __CMIRequestCopyQuit');
  const mainPatched=quitCode+'\n'+mainSource.replace(closeFeature,'.on(`close`,e=>{if(process.env.CMI_EXIT_ON_CLOSE===`1`&&!this.isAppQuitting){e.preventDefault();__CMIRequestCopyQuit(require(`electron`).app);return}this.persistPrimaryWindowBounds(');
  const mainCheck=spawnSync(process.execPath,['--check'],{input:mainPatched,encoding:'utf8'});
  if(mainCheck.status!==0)throw Error('Window close patch syntax failed');
  const baseResult = replaceFile(replaceFile(original, d.name, Buffer.from(source), true),main,Buffer.from(mainPatched));
  const integrated = mergeDailyObserver(baseResult);
  const workIntegrated = patchWorkTelemetry(integrated.bytes);
  const result = workIntegrated.bytes;
  return {bytes: result, report: {
    version: d.version, strategy: 'composer-return-metadata-v02',
    target: d.name, sourceSha256: sha256(original), patchedSha256: sha256(result),
    runtimeSha256: sha256(Buffer.from(runtime)), syntax: 'passed',
    workTelemetry:true, packedFilesPreserved: true, changedFiles:[...new Set([d.name,main,...integrated.report.assets,...workIntegrated.report.changedFiles])], support: d.support,
    note: 'Structural and byte verification; desktop acceptance is a separate test.'
  }};
}

export function build(input, output, backupRoot) {
  const original = fs.readFileSync(input), d = detect(original), hash = sha256(original);
  const backupDir = path.join(backupRoot, d.version + '-' + hash.slice(0, 16));
  fs.mkdirSync(backupDir, {recursive: true});
  const backup = path.join(backupDir, 'app.asar');
  if (!fs.existsSync(backup)) writeNewAtomic(backup, original);
  if (sha256(fs.readFileSync(backup)) !== hash) throw Error('Backup verification failed');
  const {bytes, report} = patch(original);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  writeNewAtomic(output, bytes);
  fs.writeFileSync(output + '.json', JSON.stringify({...report, backup}, null, 2));
  return {...report, backup};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, input, output, backup] = process.argv.slice(2);
    if (command === 'inspect') {
      const d = detect(fs.readFileSync(input));
      console.log(JSON.stringify({compatible: true, version: d.version, target: d.name, support: d.support}, null, 2));
    } else if (command === 'build' && input && output && backup) {
      console.log(JSON.stringify(build(input, output, backup), null, 2));
    } else throw Error('Usage: node src/patcher.mjs inspect INPUT | build INPUT OUTPUT BACKUPS');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
