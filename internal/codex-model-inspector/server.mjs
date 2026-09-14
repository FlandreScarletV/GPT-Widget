import { queryQuality } from './quality.mjs';
import { readQualityKey } from './credentials.mjs';
import { queryExit } from './network.mjs';
import { assessIpRisk } from './risk.mjs';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
export class Inspector {
  constructor(fetcher = fetch, clock = Date.now, keyReader = () => '') { this.fetcher = fetcher; this.keyReader = keyReader; this.qualityStatus = 'not_configured'; this.clock = clock; this.observation = null; this.previous = null; this.lastAttempt = -Infinity; this.localRisk = '未知'; this.lookupStatus = 'not_queried'; this.quality = assessIpRisk(null); this.lookupAttempts = []; }
  async refresh() {
    const now = this.clock();
    if (now - this.lastAttempt < 60000) return this.publicStatus();
    this.lastAttempt = now; this.observation = null; this.localRisk = '未知'; this.quality = assessIpRisk(null);
    try {
      const { data: d, source, attempts } = await queryExit(this.fetcher); this.lookupAttempts = attempts;
      const country = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(d.country_code);
      this.observation = { ip: d.ip, country, countryCode: d.country_code, asn: d.connection?.asn ?? null, isp: d.connection?.isp ?? null, source, observedAt: now };
      if (this.previous && now - this.previous.observedAt <= 1800000 && this.previous.countryCode !== d.country_code) this.localRisk = '中';
      this.quality = assessIpRisk(d.security, this.localRisk === '中'); this.localRisk = this.quality.level; this.lookupStatus = 'ok';
      let key = '';
      try { key = this.keyReader(); this.qualityStatus = key ? 'pending' : 'not_configured'; } catch { this.qualityStatus = 'key_unavailable'; }
      if (key) { const q = await queryQuality(d.ip, key, this.fetcher); this.qualityStatus = q.status; this.quality = q; this.localRisk = q.level; key = ''; }
      this.previous = this.observation;
    } catch (e) { this.lookupStatus = 'all_sources_failed'; this.lookupAttempts = e.attempts ?? []; }
    return this.publicStatus();
  }
  uiDetails() {
    if (!this.observation || this.clock() - this.observation.observedAt >= 300000) return null;
    const o = this.observation, q = this.quality;
    return { ip: o.ip, country: o.country, asn: q.details?.asn ?? o.asn, isp: o.isp, organization: q.details?.organization ?? null, company: q.details?.company ?? null, networkType: q.details?.networkType ?? null, region: q.details?.region ?? null, city: q.details?.city ?? null, signals: q.signals ?? {}, abuser: q.abuser ?? null, regionSource: o.source, qualitySource: q.source ?? null, observedAt: new Date(o.observedAt).toISOString(), reason: q.reason };
  }
  publicStatus() {
    const fresh = this.observation && this.clock() - this.observation.observedAt < 300000;
    return {
      requestedModel: '未知', reasoningEffort: '未知', upstreamModel: '未知', provider: '未知', ipRegion: fresh ? this.observation.country : '未知',
      localRisk: fresh ? this.localRisk : '未知', risk: fresh ? this.localRisk : '未知',
      qualityStatus: this.qualityStatus, qualitySource: fresh ? (this.quality.source ?? null) : null, lookupStatus: this.lookupStatus, lookupAttempts: this.lookupAttempts, ipRisk: fresh ? this.quality.level : '未知', riskReason: fresh ? this.quality.reason : '没有有效的出口观测',
      source: '公网出口查询；IP风险为网络属性筛查，不是账号风控或滥用信誉保证',
      observedAt: fresh ? new Date(this.observation.observedAt).toISOString() : null,
      limitation: '正式插件尚未接入宿主当前模型、轮次；首次或无异常样本不代表低风险'
    };
  }
}
const uri = 'ui://codex-model-inspector/status-v2.html';
export async function handle(msg, inspector) {
  const { method, params = {} } = msg;
  if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'codex-model-inspector', version: '0.3.0' } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: [{ name: 'inspect_status', description: 'Query the Inspector public egress region (ipwho.is, fallback ipapi.co). When locally configured, queries IP quality at api.ipapi.is with its own API key. No Codex credentials or prompts are sent. Shows unknown for unavailable host metadata and IP quality evidence.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, _meta: { ui: { resourceUri: uri }, 'openai/outputTemplate': uri } }] };
  if (method === 'resources/list') return { resources: [{ uri, name: 'Inspector status', mimeType: 'text/html;profile=mcp-app' }] };
  if (method === 'resources/read' && params.uri === uri) return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: readFileSync(new URL('./status.html', import.meta.url), 'utf8') }] };
  if (method === 'tools/call' && params.name === 'inspect_status') {
    if (Object.keys(params.arguments ?? {}).length) throw Object.assign(Error('No arguments accepted'), { code: -32602 });
    const d = await inspector.refresh();
    return { content: [{ type: 'text', text: '请求模型：' + d.requestedModel + '  思考能力：' + d.reasoningEffort + '  上游模型：' + d.upstreamModel + '  供应商：' + d.provider + '  IP：' + d.ipRegion + '  IP风险：' + d.risk }], structuredContent: d, _meta: { inspectorDetails: inspector.uiDetails() } };
  }
  throw Object.assign(Error('Unsupported method or resource'), { code: -32601 });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inspector = new Inspector(fetch, Date.now, readQualityKey); const lines = createInterface({ input: process.stdin }); let queue = Promise.resolve();
  lines.on('line', line => { queue = queue.then(async () => { let m; try { m = JSON.parse(line); if (m.id === undefined) return; const result = await handle(m, inspector); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'); } catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: e.code ?? -32700, message: 'Inspector request failed' } }) + '\n'); } }) });
}
