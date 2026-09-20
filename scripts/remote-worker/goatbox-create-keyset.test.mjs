import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFirstKeyset, emptyState } from './goatbox-create-keyset.mjs';

function fixture(t, variant) {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'goat-keyset-test-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const output=path.join(parent,'once'); let inspections=0; let creates=0;
  const bytes=Buffer.alloc(32,1); const key=Buffer.alloc(44,2);
  const api={
    inspectWindowsProtectedService:async()=>++inspections===1 ? {
      custodyPosture:variant==='stale'?'active':'empty',activeGeneration:0n,
      highestBurnedGeneration:0n,committedGenerationCount:0,stateSha256:Buffer.from(emptyState,'hex'),
    } : {activeGeneration:1n,committedGenerationCount:1,custodyPosture:'active',
      activeKeysetReceiptSha256:bytes,stateSha256:variant==='mismatch'?Buffer.alloc(32):bytes,
      runtimeManifestSpki:key,admissionEvidenceSpki:key},
    createWindowsProtectedKeyset:async(client,input)=>{
      creates++; const saved=JSON.parse(fs.readFileSync(path.join(output,'prepared-request.json')));
      assert.equal(saved.operationId,Buffer.from(input.operationId).toString('hex'));
      if(variant==='uncertain')throw Error('response lost');
      return {...input,disposition:'created',observedStateSha256:bytes,resultingStateSha256:bytes,
        keysetReceiptSha256:bytes,runtimeManifestSpkiSha256:bytes,admissionEvidenceSpkiSha256:bytes,
        runtimeManifestSpki:key,admissionEvidenceSpki:key,privateSecret:'must not export'};
    },
  };
  let pid=0;
  return {args:{api,client:'fixture',output,ready:async()=>++pid},creates:()=>creates};
}
test('creates once, persists intent first, verifies inspection, exports only public fields',async t=>{
  const f=fixture(t); const result=await createFirstKeyset(f.args);
  assert.equal(result.inspectionPassed,true);assert.equal(f.creates(),1);
  assert.equal('privateSecret' in result,false);
  await assert.rejects(createFirstKeyset(f.args),/EEXIST/);assert.equal(f.creates(),1);
});
test('changed custody refuses before mutation',async t=>{
  const f=fixture(t,'stale');await assert.rejects(createFirstKeyset(f.args),/Custody differs/);assert.equal(f.creates(),0);
});
test('uncertain response preserves request and forbids automatic replay',async t=>{
  const f=fixture(t,'uncertain');await assert.rejects(createFirstKeyset(f.args),/response lost/);
  assert.ok(fs.existsSync(path.join(f.args.output,'prepared-request.json')));
  await assert.rejects(createFirstKeyset(f.args),/EEXIST/);assert.equal(f.creates(),1);
});
test('inspection mismatch retains mutation receipt without success claim',async t=>{
  const f=fixture(t,'mismatch');await assert.rejects(createFirstKeyset(f.args),/inspection mismatch/);
  assert.ok(fs.existsSync(path.join(f.args.output,'creation-result.json')));
  assert.equal(fs.existsSync(path.join(f.args.output,'verified-public-keyset.json')),false);
});
for(const engine of ['powershell.exe','pwsh.exe'])test(engine+' refuses wrong host before loading files',()=>{
  const r=spawnSync(engine,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/remote-worker/initialize-goatbox-keyset.ps1')],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.notEqual(r.status,0);assert.match(r.stderr+r.stdout,/GOATBOX only/);
});
