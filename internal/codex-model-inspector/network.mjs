import {isIP} from 'node:net';
export const services=['https://ipwho.is/','https://ipapi.co/json/'];
export function errorCategory(e) {
  if(e.name==='TimeoutError'||e.name==='AbortError')return 'timeout';
  if(/^HTTP_\d+$/.test(e.message))return e.message;
  const code=e.cause?.code??e.code;
  if(code==='ECONNRESET')return 'connection_reset';
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return 'dns_error';
  if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))return 'tls_certificate_error';
  return 'invalid_response_or_connection_error';
}
async function boundedText(response) {
  if(!response.body?.getReader){const text=await response.text();if(text.length>65536)throw Error('oversized');return text;}
  const reader=response.body.getReader();let total=0;const chunks=[];
  try {while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>65536){await reader.cancel();throw Error('oversized');}chunks.push(Buffer.from(value));}}
  finally {reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
export async function queryExit(fetcher=fetch) {
  const attempts=[];
  for(const source of services){
    try {
      const response=await fetcher(source,{signal:AbortSignal.timeout(8000),redirect:'error',headers:{'User-Agent':'CodexModelInspector/0.3','Accept':'application/json'}});
      if(!response.ok)throw Error('HTTP_'+response.status);
      const raw=JSON.parse(await boundedText(response));
      if((source===services[0]&&raw.success!==true)||raw.error||!isIP(raw.ip)||! /^[A-Z]{2}$/.test(raw.country_code))throw Error('schema');
      const data=source===services[0]?raw:{ip:raw.ip,country_code:raw.country_code,connection:{asn:raw.asn,isp:null},security:null};
      attempts.push({source,status:'ok'});return {data,source,attempts};
    }catch(e){attempts.push({source,status:errorCategory(e)});}
  }
  throw Object.assign(Error('all_sources_failed'),{attempts});
}
