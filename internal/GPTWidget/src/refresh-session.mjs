// A session retains the last successful grouped observation until explicit refresh.
export class RefreshSession {
  constructor(query,publish=()=>{}) {this.query=query;this.publish=publish;this.state={status:null,details:null,refreshing:false,refreshError:null};this.pending=null;}
  refresh() {
    if(this.pending)return this.pending;
    this.state={...this.state,refreshing:true,refreshError:null};this.publish(this.state);
    this.pending=Promise.resolve().then(this.query).then(result=>{
      const s=result.status;
      const failed=s.lookupStatus!=='ok'||!['ok','not_configured'].includes(s.qualityStatus);
      if(failed) {
        const codes=s.lookupStatus!=='ok'?(s.lookupAttempts||[]).map(a=>a.status):[s.qualityStatus];
        const detail=[...new Set(codes.filter(c=>typeof c==='string'&&/^[a-zA-Z0-9_]{1,64}$/.test(c)))].join(' / ');
        const reason=(s.lookupStatus!=='ok'?'出口查询失败':s.qualityStatus==='key_unavailable'?'无法读取本机质量服务配置':'IP质量查询失败')+(detail?'（'+detail+'）':'');
        this.state={...this.state,...(!this.state.status?result:{}),refreshing:false,refreshError:reason+'；保留上次成功结果（如有）'};
      } else this.state={...result,refreshing:false,refreshError:null};
    }).catch(()=>{this.state={...this.state,refreshing:false,refreshError:'刷新失败；保留上次成功结果（如有）'};})
      .finally(()=>{this.state={...this.state,refreshFinishedAt:Date.now()};this.pending=null;this.publish(this.state)});
    return this.pending;
  }
}
