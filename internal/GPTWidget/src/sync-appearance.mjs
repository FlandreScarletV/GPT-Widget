import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const appearanceKey=/^\s*(appearance\w*|sansFontSize|codeFontSize)\s*=/;
function split(text){let section='';return text.split(/\r?\n/).map(line=>{const header=line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);if(header)section=header[1].trim();return {line,section,header:!!header}})}
export function mergeAppearance(source,target){
  const rows=split(source),selected=rows.filter(r=>r.section.startsWith('desktop.appearance')||r.section==='desktop'&&!r.header&&appearanceKey.test(r.line));
  if(!selected.length)return target;
  const scalar=selected.filter(r=>r.section==='desktop').map(r=>r.line);
  const tables=selected.filter(r=>r.section!=='desktop').map(r=>r.line);
  // Copy only simple scalar lines and appearance tables, never other desktop preferences.
  if(selected.some(r=>r.line.includes('"""')||r.line.includes("'''")))throw Error('Unsupported multiline appearance setting');
  const kept=split(target).filter(r=>!r.section.startsWith('desktop.appearance')&&!(r.section==='desktop'&&!r.header&&appearanceKey.test(r.line)));
  const at=kept.findIndex(r=>r.header&&r.section==='desktop');
  const output=kept.map(r=>r.line);
  if(at>=0)output.splice(at+1,0,...scalar);else output.push('','[desktop]',...scalar);
  while(output.length&&!output.at(-1).trim())output.pop();
  output.push('',...tables);return output.join('\n').trimEnd()+'\n';
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [source,target]=process.argv.slice(2);
 if(!source||!target)throw Error('Expected source and target config');
 if(path.resolve(source)===path.resolve(target)||!fs.existsSync(source))process.exit(0);
 const before=fs.existsSync(target)?fs.readFileSync(target,'utf8'):'';
 const after=mergeAppearance(fs.readFileSync(source,'utf8'),before);
 if(after!==before){fs.mkdirSync(path.dirname(target),{recursive:true});if(before)fs.copyFileSync(target,target+'.appearance-backup-'+Date.now());fs.writeFileSync(target+'.appearance-tmp',after);fs.renameSync(target+'.appearance-tmp',target);console.log('已同步官方主题、配色和字体。');}
}
