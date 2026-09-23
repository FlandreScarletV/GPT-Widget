import copy,json,os,pathlib,re,subprocess,sys,tomllib,datetime
ROOTS=('marketplaces','plugins','mcp_servers','apps')
def scalar(v):
 if isinstance(v,bool):return str(v).lower()
 if isinstance(v,(int,float)):return str(v)
 if isinstance(v,str):return json.dumps(v,ensure_ascii=False)
 if isinstance(v,list):return '['+', '.join(scalar(x) for x in v)+']'
 raise ValueError('Unsupported configuration value')
def table(keys,obj):
 out=['['+'.'.join(json.dumps(k,ensure_ascii=False) for k in keys)+']']
 for k,v in obj.items():
  if not isinstance(v,dict):out.append(json.dumps(k)+' = '+scalar(v))
 for k,v in obj.items():
  if isinstance(v,dict):out+=table(keys+[k],v)
 return out+['']
def merge(source,target):
 src=tomllib.loads(source);dst=tomllib.loads(target);wanted=copy.deepcopy(dst)
 for root in ROOTS:
  if root in src:wanted.setdefault(root,{}).update(copy.deepcopy(src[root]))
 out=[];drop=False
 for line in target.splitlines():
  if re.match(r'^\s*\[',line):
   try:key=next(iter(tomllib.loads(line)))
   except Exception:key=None
   drop=key in ROOTS
  if not drop:out.append(line)
 for root in ROOTS:
  if root in wanted:out+=table([root],wanted[root])
 result='\n'.join(out)+'\n'
 if tomllib.loads(result)!=wanted:raise ValueError('Unsupported configuration layout; original unchanged')
 return result,src

def run():
 source,target,cli=sys.argv[1:4];source=pathlib.Path(source).resolve();target=pathlib.Path(target).resolve()
 if source==target:raise ValueError('Source and target must differ')
 file=target/'config.toml';before=file.read_text(encoding='utf-8-sig')
 after,src=merge((source/'config.toml').read_text(encoding='utf-8-sig'),before)
 backup=file.with_name('config.toml.before-data-sync-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
 backup.write_text(before,encoding='utf-8')
 if file.read_text(encoding='utf-8-sig')!=before:raise ValueError('Configuration changed concurrently')
 tmp=file.with_suffix('.sync-tmp');tmp.write_text(after,encoding='utf-8');os.replace(tmp,file)
 env=os.environ.copy();env['CODEX_HOME']=str(target);failed=[];installed=[]
 for selector,settings in src.get('plugins',{}).items():
  if not settings.get('enabled',True):continue
  name,sep,market=selector.rpartition('@')
  if not sep:failed.append(selector);continue
  cache=target/'plugins'/'cache'/market/name
  if cache.exists() and any(cache.glob('*/.codex-plugin/plugin.json')):continue
  try:
   r=subprocess.run([cli,'plugin','add',selector,'--json'],env=env,capture_output=True,timeout=60)
   (installed if r.returncode==0 else failed).append(selector)
  except subprocess.TimeoutExpired:failed.append(selector)
 print(json.dumps({'synced':{k:list(src.get(k,{})) for k in ROOTS},'installed':installed,'failed':failed,'backup':str(backup)},ensure_ascii=False))
 if failed:sys.exit(2)
if __name__=='__main__':run()
