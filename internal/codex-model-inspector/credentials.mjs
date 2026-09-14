import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
export function readQualityKey(){
  if(process.platform!=='win32'||!process.env.LOCALAPPDATA)return '';
  const folders = ['GPTWidget', 'CodexWidget', 'CodexModelInspector'];
  let keyPath = '';
  for (const folder of folders) {
    const candidate = join(process.env.LOCALAPPDATA, folder, 'ipapi-is.key');
    if (existsSync(candidate)) { keyPath = candidate; break; }
  }
  if(!keyPath)return '';
  const command="$ErrorActionPreference='Stop';$s=(Get-Content -LiteralPath '"+keyPath.replace(/\\/g, '\\\\')+"' -Raw).Trim() | ConvertTo-SecureString;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p);$s.Dispose()}";
  const childEnv={...process.env};for(const name of Object.keys(childEnv)){if(name.toLowerCase()==='psmodulepath')delete childEnv[name];}
  return execFileSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{env:childEnv,windowsHide:true,timeout:5000,maxBuffer:8192,stdio:['ignore','pipe','pipe']}).toString('utf8').trim();
}

