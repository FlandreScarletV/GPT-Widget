import copy,json,os,pathlib,re,subprocess,sys,tomllib,datetime
ROOTS=('marketplaces','plugins','mcp_servers','apps')
HOST_MARKETS={'openai-bundled','openai-primary-runtime'}
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
  if root in src:
   incoming=copy.deepcopy(src[root])
   # Host-managed entries belong to the target runtime, not the source version.
   if root=='marketplaces':incoming={k:v for k,v in incoming.items() if k not in HOST_MARKETS}
   if root=='plugins':incoming={k:v for k,v in incoming.items() if k.rpartition('@')[2] not in HOST_MARKETS}
   wanted.setdefault(root,{}).update(incoming)
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

def inventory(cli,home,available=False):
 env=os.environ.copy();env['CODEX_HOME']=str(home)
 args=[cli,'plugin','list','--json']+(['--available'] if available else [])
 try:
  r=subprocess.run(args,env=env,capture_output=True,timeout=45)
  if r.returncode:return None
  return json.loads(r.stdout.decode('utf-8-sig'))
 except (subprocess.TimeoutExpired,ValueError):return None

def plan_plugins(config,source_inventory,target_inventory):
 selectors=dict(config)
 if source_inventory:
  for item in source_inventory.get('installed',[]):
   if item.get('installed') and item.get('enabled') and item.get('pluginId'):
    selectors.setdefault(item['pluginId'],{'enabled':True})
 selectors={k:v for k,v in selectors.items() if k.rpartition('@')[2] not in HOST_MARKETS}
 visible={x.get('pluginId') for x in (target_inventory or {}).get('available',[])+(target_inventory or {}).get('installed',[])}
 blocked=[k for k in selectors if selectors[k].get('enabled',True) and target_inventory is not None and k not in visible]
 return selectors,blocked

def failure_reason(raw):
 text=raw.decode('utf-8',errors='replace').lower()
 if 'handshake' in text or 'client error (connect)' in text or 'error sending request' in text:return 'network_or_tls_error'
 if 'unauthorized' in text or '401' in text:return 'authentication_required'
 if 'forbidden' in text or '403' in text:return 'permission_denied'
 return 'install_failed'

def run():
 source,target,cli=sys.argv[1:4];source=pathlib.Path(source).resolve();target=pathlib.Path(target).resolve()
 if source==target:raise ValueError('Source and target must differ')
 file=target/'config.toml';before=file.read_text(encoding='utf-8-sig')
 after,src=merge((source/'config.toml').read_text(encoding='utf-8-sig'),before)
 backup=file.with_name('config.toml.before-data-sync-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
 backup.write_text(before,encoding='utf-8')
 if file.read_text(encoding='utf-8-sig')!=before:raise ValueError('Configuration changed concurrently')
 tmp=file.with_suffix('.sync-tmp');tmp.write_text(after,encoding='utf-8');os.replace(tmp,file)
 env=os.environ.copy();env['CODEX_HOME']=str(target);failed=[];installed=[];reasons={}
 source_inventory=inventory(cli,source);target_inventory=inventory(cli,target,True)
 selectors,blocked=plan_plugins(src.get('plugins',{}),source_inventory,target_inventory)
 for selector,settings in selectors.items():
  if selector in blocked:continue
  if not settings.get('enabled',True):continue
  name,sep,market=selector.rpartition('@')
  if not sep:failed.append(selector);continue
  cache=target/'plugins'/'cache'/market/name
  if cache.exists() and any(cache.glob('*/.codex-plugin/plugin.json')):continue
  try:
   r=subprocess.run([cli,'plugin','add',selector,'--json'],env=env,capture_output=True,timeout=60)
   (installed if r.returncode==0 else failed).append(selector)
   if r.returncode:reasons[selector]=failure_reason(r.stderr)
  except subprocess.TimeoutExpired:failed.append(selector);reasons[selector]='timeout'
 print(json.dumps({'synced':{k:list(src.get(k,{})) for k in ROOTS},'installed':installed,'failed':failed,'notListedInTargetCatalog':blocked,'failureReasons':reasons,'hostManagedSkipped':sorted(HOST_MARKETS),'inventoryChecked':source_inventory is not None and target_inventory is not None,'privateChatCatalogStatus':'not_verified_by_cli','privateChatCatalogNote':'私人 Chat 插件入口由当前账号远程目录提供，本地同步不验证或复制该入口','backup':str(backup)},ensure_ascii=False))
 if failed or blocked or source_inventory is None or target_inventory is None:
  print('本地配置已同步；部分插件待处理，不阻止副本启动。')
  sys.exit(2)
if __name__=='__main__':run()
