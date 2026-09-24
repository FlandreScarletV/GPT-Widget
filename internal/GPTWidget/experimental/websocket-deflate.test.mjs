import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeflateRaw, constants } from 'node:zlib';
import { frameObserver, modelObserver } from './websocket-observer.mjs';
import { frame } from './websocket-test-helper.mjs';
import { deflateParameters } from './websocket-deflate.mjs';

async function compressMessages(messages) {
  const stream=createDeflateRaw(), output=[];
  let chunks=[]; stream.on('data',b=>chunks.push(b));
  try { for(const value of messages) {
    stream.write(JSON.stringify(value));
    await new Promise((resolve,reject)=>stream.flush(constants.Z_SYNC_FLUSH,e=>e?reject(e):resolve()));
    output.push(Buffer.concat(chunks).subarray(0,-4)); chunks=[];
  } } finally {stream.destroy();}
  return output;
}
test('negotiation uses directional context/window settings and rejects unsupported combinations',()=>{
  const h='permessage-deflate; client_no_context_takeover; server_max_window_bits=10';
  assert.deepEqual(deflateParameters(h,'client'),{reset:true,windowBits:15});
  assert.deepEqual(deflateParameters(h,'server'),{reset:false,windowBits:10});
  for(const h of ['permessage-zstd','permessage-deflate, unknown','permessage-deflate; server_max_window_bits=7','permessage-deflate; client_no_context_takeover=1','permessage-deflate; mystery=1']) assert.equal(deflateParameters(h,'server'),null);
});
test('compressed masked fragmented messages decode across chunks and context takeover',async()=>{
  const values=[{type:'response.create',model:'model-a',input:'PRIVATE 日本'.repeat(200)}, {type:'response.create',model:'model-b',input:'PRIVATE 日本'.repeat(200)}];
  const compressed=await compressMessages(values), received=[], opaque=[];
  const reader=frameObserver(v=>received.push(v),r=>opaque.push(r)); reader.setExtensions('permessage-deflate','client');
  for(const message of compressed) {
    const mid=Math.floor(message.length/2);
    const bytes=Buffer.concat([frame(message.subarray(0,mid),{mask:true,compressed:true,fin:false}),frame('ping',{mask:true,opcode:9}),frame(message.subarray(mid),{mask:true,opcode:0})]);
    for(let i=0;i<bytes.length;i+=3)reader.push(bytes.subarray(i,i+3));
  }
  assert.deepEqual(received,values); assert.deepEqual(opaque,[]);reader.end();
});
test('independent compressed messages respect no-context-takeover',async()=>{
  const got=[],reader=frameObserver(v=>got.push(v)); reader.setExtensions('permessage-deflate; server_no_context_takeover','server');
  for(const value of [{model:'one'},{model:'two'}])reader.push(frame((await compressMessages([value]))[0],{compressed:true}));
  assert.deepEqual(got,[{model:'one'},{model:'two'}]);reader.end();
});
test('decompression limit and unknown compression produce no model evidence',async()=>{
  const values=[],errors=[],reader=frameObserver(v=>values.push(v),r=>errors.push(r),256);
  reader.setExtensions('permessage-deflate','server');
  const bomb=(await compressMessages([{padding:'x'.repeat(10000)}]))[0];reader.push(frame(bomb,{compressed:true}));
  assert.equal(values.length,0);assert.equal(errors.length,1);
  reader.push(frame((await compressMessages([{model:'after-error'}]))[0],{compressed:true}));
  assert.equal(values.length,0);reader.end();
});
test('compressed response model is extracted without retaining private text',async()=>{
  const records=[],state=modelObserver(r=>records.push(r));state.client({type:'response.create',model:'a'});
  const reader=frameObserver(v=>state.server(v),()=>state.opaque());reader.setExtensions('permessage-deflate','server');
  const messages=await compressMessages([{type:'response.output_text.delta',delta:'PRIVATE'}, {type:'response.completed',response:{id:'r1',model:'b',output:'PRIVATE'}}]);
  for(const message of messages)reader.push(frame(message,{compressed:true}));
  assert.equal(records[0].reportedModel,'b');assert.equal(records[0].modelDifference,true);assert.doesNotMatch(JSON.stringify(records),/PRIVATE/);reader.end();
});
