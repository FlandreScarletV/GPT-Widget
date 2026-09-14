export function assessIpRisk(security, countryChanged=false) {
  const flags=['proxy','vpn','tor','hosting'];
  const signals=Object.fromEntries(flags.map(k=>[k,typeof security?.[k]==='boolean'?security[k]:null]));
  if(signals.tor===true)return {level:'高',reason:'数据源报告 Tor 出口',signals};
  if(countryChanged||signals.proxy===true||signals.vpn===true||signals.hosting===true)return {level:'中',reason:countryChanged?'30 分钟内观测到出口国家变化':'数据源报告代理、VPN 或托管网络属性',signals};
  if(flags.every(k=>signals[k]===false))return {level:'低',reason:'四项网络属性均为否；不代表没有滥用记录',signals};
  return {level:'未知',reason:'缺少网络属性，无法评估',signals};
}
