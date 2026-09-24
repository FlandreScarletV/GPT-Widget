import test from 'node:test';import assert from 'node:assert/strict';
import {createWorkState,describeWorkTelemetry} from './work-state.mjs';
const base={requestId:'req1',scope:{threadId:'task1',turnId:'turn1',requestKind:'turn'},generationRequested:true,requestedModel:'a',association:'single_inflight'};
const start=(s,r=base)=>s.accept({...r,kind:'request-start'});
const end=(s,r=base)=>s.accept({...r,kind:'turn',outcome:'response.completed',reportedModel:'a'});
test('new request clears previous success immediately and failed retry stays unknown',()=>{
 const s=createWorkState();start(s);end(s);assert.equal(s.snapshot()[0].reportedModel,'a');
 const retry={...base,requestId:'req2'};start(s,retry);assert.equal(s.snapshot()[0].reportedModel,null);
 s.accept({...retry,kind:'turn',outcome:'disconnected'});assert.equal(s.snapshot()[0].status,'unknown');
 const last={...base,requestId:'req3'};start(s,last);end(s,last);assert.equal(s.snapshot()[0].status,'complete');
});
test('orphans and overlapping requests never appear as verified',()=>{
 const s=createWorkState();end(s);assert.equal(s.snapshot()[0].reportedModel,null);
 const t=createWorkState();start(t);start(t,{...base,requestId:'req2'});end(t);end(t,{...base,requestId:'req2'});assert.equal(t.snapshot()[0].reportedModel,null);
});
test('prewarm excluded, retention bounded, stale/dead/wrong turn hidden',()=>{
 const s=createWorkState(1);s.accept({...base,kind:'request-start',generationRequested:false});assert.equal(s.snapshot().length,0);start(s);end(s);
 const state={schema:1,alive:true,updatedAt:100,records:s.snapshot()};assert.equal(describeWorkTelemetry(state,'task1','turn1','a',110).model,'a');
 for(const args of [[state,'task1','turn2','a',110],[state,'task1','turn1','b',110],[state,'task1','turn1','a',16000],[{...state,alive:false},'task1','turn1','a',110]])assert.equal(describeWorkTelemetry(...args),null);
 start(s,{...base,scope:{...base.scope,threadId:'task2'}});assert.equal(s.snapshot().length,1);
});
