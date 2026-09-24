import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deflateRawSync, constants } from 'node:zlib';
import { createObserver } from './observer-proxy.mjs';
import { frameObserver, modelObserver } from './websocket-observer.mjs';
import { frame, accept, connect, until } from './websocket-test-helper.mjs';

async function fixture(t, handler, options = {}) {
  const sockets = new Set(), records = [], httpCalls = [];
  const server = http.createServer((req,res) => { httpCalls.push(req.url); res.writeHead(500).end(); });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', handler);
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const proxy = await createObserver({ upstream:`http://127.0.0.1:${server.address().port}/v1`, allowLoopbackUpstream:true, onObservation:r=>records.push(r), ...options });
  t.after(async () => { await proxy.close(); for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); });
  return { proxy, records, httpCalls };
}
test('raw frames and handshake pass unchanged both ways; sequential A/A then A/B have independent evidence', async t => {
  const sent = [], received = []; let peer;
  const {proxy,records,httpCalls} = await fixture(t,(req,socket) => {
    peer=socket; assert.equal(req.url,'/v1/responses'); assert.equal(req.headers.authorization,'Bearer PRIVATE_AUTH');
    accept(req,socket,{'openai-model':'connection-only','x-codex-turn-state':'opaque-sticky-state'});
    const parser=frameObserver(v=>{
      const id= 'resp_' + (sent.length + 1), name=v.model==='model-a'?'model-a':'model-b';
      const frames = Buffer.concat([
        frame({type:'response.created',response:{id,model:name}}),
        frame({type:'response.output_text.delta',response_id:id,delta:'PRIVATE_OUTPUT 日本'}),
        ...(v.model==='request-b'?[frame({type:'model/rerouted',from_model:'request-b',to_model:'model-b'})]:[]),
        frame({type:'response.completed',response:{id,model:name}})
      ]); sent.push(frames); socket.write(frames);
    }); socket.on('data',c=>{received.push(Buffer.from(c));parser.push(c);});
  });
  const client=await connect(proxy.baseUrl+'/responses',{authorization:'Bearer PRIVATE_AUTH',cookie:'PRIVATE_COOKIE'});
  assert.equal(client.headers['x-codex-turn-state'],'opaque-sticky-state');
  const one=frame({type:'response.create',model:'model-a',input:'PRIVATE_PROMPT'},{mask:true});
  // Split masked frame at arbitrary boundaries, including its header.
  for(const byte of one) client.socket.write(Buffer.from([byte]));
  await until(()=>records.filter(r=>r.kind==='turn').length===1);
  const two=frame({type:'response.create',model:'request-b',input:'PRIVATE_PROMPT'},{mask:true});client.socket.write(two);
  await until(()=>client.messages.filter(v=>v.type==='response.completed').length===2);
  const turns=records.filter(r=>r.kind==='turn');
  assert.equal(turns[0].modelDifference,false); assert.equal(turns[1].modelDifference,true);
  assert.equal(turns[1].explicitReroutes[0].toModel,'model-b');
  assert.equal(turns[0].reportedModel,'model-a'); assert.equal(turns[1].reportedModel,'model-b');
  assert.equal(records[0].kind,'connection'); assert.equal(records[0].reportedModel,'connection-only');
  assert.deepEqual(Buffer.concat(received),Buffer.concat([one,two]));
  assert.deepEqual(Buffer.concat(client.received),Buffer.concat(sent));
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE|opaque-sticky-state|cookie|authorization/); assert.equal(httpCalls.length,0);
  client.socket.destroy(); await until(()=>peer.readableEnded || peer.destroyed);
});
test('fragmented JSON, UTF8, ping/pong and binary are forwarded intact',async t=>{
  const raw=[];let peer;
  const {proxy,records}=await fixture(t,(req,socket)=>{peer=socket;accept(req,socket);socket.on('data',c=>raw.push(Buffer.from(c)));});
  const c=await connect(proxy.baseUrl+'/responses');
  const payload=Buffer.from(JSON.stringify({type:'response.create',model:'model-a',input:'日本'}));
  const bytes=Buffer.concat([frame(payload.subarray(0,30),{mask:true,fin:false}),frame('ping',{mask:true,opcode:9}),frame(payload.subarray(30),{mask:true,opcode:0})]);
  c.socket.write(bytes);await until(()=>Buffer.concat(raw).length===bytes.length);assert.deepEqual(Buffer.concat(raw),bytes);
  const answer=Buffer.concat([frame('pong',{opcode:10}),frame({type:'response.completed',response:{id:'resp_1',model:'model-a'}}),frame(Buffer.from([0,255,8]),{opcode:2})]);
  peer.write(answer);await until(()=>Buffer.concat(c.received).length===answer.length);assert.deepEqual(Buffer.concat(c.received),answer);
  assert.equal(records.find(r=>r.kind==='turn').requestedModel,'model-a');c.socket.destroy();
});
test('frame parser supports 16/64 bit lengths, bounded opaque messages and recovery',()=>{
  const values=[],opaque=[];const reader=frameObserver(v=>values.push(v),r=>opaque.push(r),70000);
  const bytes=Buffer.concat([frame({padding:'x'.repeat(66000)},{mask:true}),frame(Buffer.alloc(80000),{mask:true}),frame({model:'last'},{mask:true})]);
  for(let i=0;i<bytes.length;i+=317)reader.push(bytes.subarray(i,i+317));
  assert.equal(values.length,2);assert.equal(values[1].model,'last');assert.equal(opaque.length,1);
});
test('overlapping requests are marked ambiguous rather than attributed FIFO',()=>{
  const records=[],m=modelObserver(r=>records.push(r));
  m.client({type:'response.create',model:'a'});m.client({type:'response.create',model:'b'});
  m.server({type:'response.completed',response:{id:'resp_b',model:'b'}});m.close();
  assert.equal(records[0].outcome,'ambiguous_overlap');assert.equal(records[1].association,'unknown');assert.equal(records[1].reportedModel,null);
});
test('compressed frames pass unchanged and produce no fabricated model',async t=>{
  let peer;const {proxy,records}=await fixture(t,(req,socket)=>{peer=socket;accept(req,socket,{'sec-websocket-extensions':'permessage-deflate'});});
  const c=await connect(proxy.baseUrl+'/responses',{'sec-websocket-extensions':'permessage-deflate'});
  c.socket.write(frame({type:'response.create',model:'a'},{mask:true}));
  await new Promise(r=>setTimeout(r,20));
  const bytes=frame(Buffer.from([170,174,5,0]),{compressed:true});peer.write(bytes);
  await until(()=>c.received.length>0);assert.deepEqual(Buffer.concat(c.received),bytes);
  assert.equal(records.some(r=>r.kind==='turn' && r.reportedModel),false);c.socket.destroy();
});

test('negotiated compressed traffic stays byte-identical while model difference is observed',async t=>{
  const zip=value=>deflateRawSync(Buffer.from(JSON.stringify(value)),{flush:constants.Z_SYNC_FLUSH,finishFlush:constants.Z_SYNC_FLUSH}).subarray(0,-4);
  let peer;const sent=[];
  const ext='permessage-deflate; client_no_context_takeover; server_no_context_takeover';
  const {proxy,records}=await fixture(t,(req,socket)=>{peer=socket;accept(req,socket,{'sec-websocket-extensions':ext});socket.on('data',b=>sent.push(Buffer.from(b)));});
  const c=await connect(proxy.baseUrl+'/responses',{'sec-websocket-extensions':ext});
  const request=frame(zip({type:'response.create',model:'a',input:'PRIVATE'}),{compressed:true,mask:true});
  c.socket.write(request);await until(()=>Buffer.concat(sent).length===request.length);
  const response=frame(zip({type:'response.completed',response:{id:'resp_compressed',model:'b',output:'PRIVATE'}}),{compressed:true});
  peer.write(response);await until(()=>records.some(r=>r.kind==='turn'));
  assert.deepEqual(Buffer.concat(sent),request);assert.deepEqual(Buffer.concat(c.received),response);
  assert.equal(records.find(r=>r.kind==='turn').reportedModel,'b');assert.equal(records.find(r=>r.kind==='turn').modelDifference,true);
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE/);c.socket.destroy();
});
test('upstream disconnect ends client connection and records incomplete turn',async t=>{
  let peer;const {proxy,records}=await fixture(t,(req,socket)=>{peer=socket;accept(req,socket);socket.once('data',()=>socket.destroy());});
  const c=await connect(proxy.baseUrl+'/responses');c.socket.write(frame({type:'response.create',model:'a'},{mask:true}));
  await until(()=>c.socket.destroyed);assert.equal(peer.destroyed,true);assert.equal(records.find(r=>r.kind==='turn').outcome,'disconnected');
});
test('rejects browser-origin/wrong path upgrades without reaching upstream',async t=>{
  let upgrades=0;const {proxy}=await fixture(t,()=>upgrades++);
  await assert.rejects(connect(proxy.baseUrl+'/responses',{origin:'https://example.com'}),/403/);
  await assert.rejects(connect(proxy.baseUrl+'/other'),/403/);assert.equal(upgrades,0);
});
test('failed upstream handshake returns its status promptly',async t=>{
  const {proxy}=await fixture(t,(req,socket)=>socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  await assert.rejects(connect(proxy.baseUrl+'/responses'),/503/);
});
test('late completed response never contaminates the next turn; handshake model is not inherited',()=>{
  const records=[],m=modelObserver(r=>records.push(r));m.handshake('handshake-model');
  m.client({type:'response.create',model:'a',generate:false});m.server({type:'response.completed',response:{id:'resp_a',model:'a'}});
  m.client({type:'response.create',model:'b'});m.server({type:'response.completed',response:{id:'resp_a',model:'a'}});
  m.server({type:'response.completed',response:{id:'resp_b'}});
  assert.equal(records.length,3);assert.equal(records[1].generationRequested,false);assert.equal(records[2].reportedModel,null);assert.equal(records[2].modelDifference,null);
});
test('close control frame and immediate upstream head preserve bytes',async t=>{
  const greeting=frame({type:'greeting'}),closing=frame(Buffer.from([3,232]),{opcode:8});
  let closeReceived=Buffer.alloc(0);
  const {proxy}=await fixture(t,(req,socket)=>{
    accept(req,socket);socket.write(greeting);
    socket.on('data',chunk=>{closeReceived=Buffer.concat([closeReceived,chunk]);socket.end(closing);});
  });
  const c=await connect(proxy.baseUrl+'/responses');await until(()=>c.messages.length===1);
  const request=frame(Buffer.from([3,232]),{opcode:8,mask:true});c.socket.write(request);
  await until(()=>c.socket.destroyed);assert.deepEqual(closeReceived,request);assert.deepEqual(Buffer.concat(c.received),Buffer.concat([greeting,closing]));
});
