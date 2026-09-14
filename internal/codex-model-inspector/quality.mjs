import {isIP} from 'node:net';
import {assessIpRisk} from './risk.mjs';
import {errorCategory} from './network.mjs';
export const qualitySource='https://api.ipapi.is/';
const bool=v=>typeof v==='boolean'?v:null;
const canonical=ip=>isIP(ip)===6?new URL('http://['+ip+']/').hostname:ip;
export function normalizeQuality(raw, requestedIp) {
  if(raw.error||!isIP(raw.ip)||canonical(raw.ip)!==canonical(requestedIp))throw Error('response_ip_mismatch');
  const security={proxy:bool(raw.is_proxy),vpn:bool(raw.is_vpn),tor:bool(raw.is_tor),hosting:bool(raw.is_datacenter)};
  const abuser=bool(raw.is_abuser);
  let assessment=assessIpRisk(security);
  if(abuser===true)assessment={...assessment,level:'高',reason:'数据源报告滥用标记；不是账号风控结论'};
  else if(assessment.level==='低'&&abuser!==false)assessment={...assessment,level:'未知',reason:'缺少滥用标记，不能完成五项筛查'};
  else if(assessment.level==='低')assessment={...assessment,reason:'五项标记均为否；仅代表该数据源本次未标记风险'};
  const clean=v=>typeof v==='string'?v.replace(/[\x00-\x1f]/g,' ').slice(0,240):typeof v==='number'?String(v):null;
  const details={asn:clean(raw.asn?.asn),organization:clean(raw.asn?.org),company:clean(raw.company?.name),networkType:clean(raw.company?.type),region:clean(raw.location?.state),city:clean(raw.location?.city)};
  return {...assessment,abuser,source:qualitySource,details};
}
export async function queryQuality(ip,key,fetcher=fetch) {
  if(!key)return {status:'not_configured',level:'未知',reason:'IP质量服务尚未配置密钥'};
  if(!isIP(ip))return {status:'invalid_ip',level:'未知',reason:'没有有效出口观测'};
  const attempts=[];
  for(const source of [qualitySource,'https://de.ipapi.is/']){
    try {
      const response=await fetcher(source,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'CodexModelInspector/0.3'},body:JSON.stringify({q:ip,key})});
      if(!response.ok)throw Error('HTTP_'+response.status);
      const text=await response.text();if(text.length>65536)throw Error('oversized');
      const quality=normalizeQuality(JSON.parse(text),ip);
      attempts.push({source,status:'ok'});
      return {status:'ok',...quality,source,attempts};
    }catch(e){
      const status=e.message==='response_ip_mismatch'?'response_ip_mismatch':errorCategory(e);
      attempts.push({source,status});
      // Only transport failures use the documented regional fallback. No retry for quota or credentials.
      if(!['connection_reset','dns_error','timeout'].includes(status)||source!==qualitySource)
        return {status,level:'未知',reason:'IP质量查询失败，未使用旧结果',attempts};
    }
  }
}
