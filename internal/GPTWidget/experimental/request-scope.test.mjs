import test from 'node:test';import assert from 'node:assert/strict';
import {requestScope,scopedModel} from './request-scope.mjs';
test('only per-request allowlisted identity leaves metadata parser',()=>{
 const scope=requestScope({client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'task-a',turn_id:'turn-a',request_kind:'turn',workspaces:{PRIVATE:'PRIVATE'},installation_id:'PRIVATE'})}});
 assert.equal(scope.threadId,'task-a');assert.equal(scope.turnId,'turn-a');assert.doesNotMatch(JSON.stringify(scope),/PRIVATE|installation/);
 assert.equal(requestScope({client_metadata:{thread_id:'wrong','x-codex-turn-metadata':'{"thread_id":"task-a","turn_id":"turn-a"}'}}).scopeConflict,true);
 assert.equal(requestScope({}).threadId,null);
});
test('exact turn selection excludes prewarm and other tasks; ambiguous/incomplete evidence stays unknown',()=>{
 const r={kind:'turn',scope:{threadId:'task-a',turnId:'turn-a',requestKind:'turn'},generationRequested:true,association:'single_inflight',outcome:'response.completed',reportedModel:'model-a'};
 assert.equal(scopedModel([r],'task-a','turn-a'),'model-a');
 assert.equal(scopedModel([r],'task-b','turn-a'),null);assert.equal(scopedModel([r],'task-a','turn-b'),null);
 assert.equal(scopedModel([{...r,generationRequested:false}],'task-a','turn-a'),null);
 assert.equal(scopedModel([{...r,scope:{...r.scope,requestKind:'compaction'}}],'task-a','turn-a'),null);
 assert.equal(scopedModel([r,{...r,reportedModel:'model-b'}],'task-a','turn-a'),null);
 assert.equal(scopedModel([r,{...r,outcome:'disconnected'}],'task-a','turn-a'),null);
 assert.equal(scopedModel([{...r,outcome:'disconnected',reportedModel:null},r],'task-a','turn-a'),'model-a');
});
