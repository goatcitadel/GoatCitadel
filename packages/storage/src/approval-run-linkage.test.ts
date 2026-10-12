import { DatabaseSync } from "node:sqlite";
import { APPROVAL_EXECUTION_LINKAGE_SQLITE_SQL } from "./approval-execution-linkage-migration.js";
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalRepository } from "./approval-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
const files=new TempSqliteFiles();
afterEach(()=>files.cleanup());
const fixture=()=>{const db=files.open({dbPath:":memory:"});return {db,repo:new ApprovalRepository(db)};};
it("finds old canonical and legacy run approvals beyond the latest 1000 workspace records",()=>{
  const {db,repo}=fixture();
  const create=(workspaceId:string,runId:string)=>repo.create({kind:"tool.invoke",riskLevel:"safe",payload:{},preview:{},linkage:{workspaceId,runId,sessionId:"session"}});
  const original=create("one","run");
  const legacy=create("one","run");
  db.prepare("UPDATE approvals SET linkage_json=NULL WHERE approval_id=?").run(legacy.approvalId);
  const other=create("two","run");
  db.transaction("immediate",()=>{for(let index=0;index<1100;index++)create("one",`other-${index}`);});
  assert.equal(typeof repo.listByRunLinkage,"function");
  const result=repo.listByRunLinkage({workspaceId:"one",runId:"run",sessionId:"session",limit:100});
  assert.deepEqual(result.items.map(item=>item.approvalId).sort(),[original.approvalId,legacy.approvalId].sort());
  assert.equal(result.nextCursor,undefined);
  assert.ok(!result.items.some(item=>item.approvalId===other.approvalId));
});
it("keeps canonical linkage precedence and updates the index when linkage changes",()=>{
  const {db,repo}=fixture();
  assert.equal(typeof repo.listByRunLinkage,"function");
  const row=repo.create({kind:"tool.invoke",riskLevel:"safe",payload:{},preview:{},linkage:{workspaceId:"one",runId:"old"}});
  repo.mergeLinkage(row.approvalId,{runId:"new"});
  assert.equal(repo.listByRunLinkage({workspaceId:"one",runId:"old"}).items.length,0);
  assert.equal(repo.listByRunLinkage({workspaceId:"one",runId:"new"}).items[0]?.approvalId,row.approvalId);
  db.prepare("UPDATE approvals SET linkage_json=?, payload_json=? WHERE approval_id=?").run(JSON.stringify({sessionId:"canonical-only"}),JSON.stringify({__gcApprovalLinkage:{workspaceId:"one",runId:"new"}}),row.approvalId);
  assert.equal(repo.listByRunLinkage({workspaceId:"one",runId:"new"}).items.length,0);
});
it("pages exact run linkage without leaking foreign sessions or relying on workspace scans",()=>{
  const {repo}=fixture();
  assert.equal(typeof repo.listByRunLinkage,"function");
  for(let index=0;index<3;index++)repo.create({kind:"tool.invoke",riskLevel:"safe",payload:{},preview:{},linkage:{workspaceId:"one",durableRunId:"run",sessionId:"session"}});
  repo.create({kind:"tool.invoke",riskLevel:"safe",payload:{},preview:{},linkage:{workspaceId:"one",runId:"run",sessionId:"foreign"}});
  const first=repo.listByRunLinkage({workspaceId:"one",runId:"run",sessionId:"session",limit:2});
  assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const second=repo.listByRunLinkage({workspaceId:"one",runId:"run",sessionId:"session",limit:2,cursor:first.nextCursor});
  assert.equal(second.items.length,1);assert.equal(second.nextCursor,undefined);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.approvalId)).size,3);
});

it("backfills legacy linkage without rewriting records and tolerates malformed historical JSON",()=>{
 const db=new DatabaseSync(":memory:");
 try {
  db.exec("CREATE TABLE approvals(approval_id TEXT PRIMARY KEY, linkage_json TEXT, payload_json TEXT, preview_json TEXT, created_at TEXT)");
  const insert=db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?)");
  insert.run("legacy",null,JSON.stringify({__gcApprovalLinkage:{workspaceId:"one",runId:"run"}}),"{}","2026-01-01");
  insert.run("malformed","bad-json","bad-json",JSON.stringify({__gcApprovalLinkage:{workspaceId:"one",durableRunId:"run"}}),"2026-01-02");
  insert.run("canonical-session",JSON.stringify({sessionId:"session"}),JSON.stringify({__gcApprovalLinkage:{workspaceId:"one",runId:"run"}}),"{}","2026-01-03");
  const before=db.prepare("SELECT * FROM approvals ORDER BY approval_id").all();
  db.exec(APPROVAL_EXECUTION_LINKAGE_SQLITE_SQL);
  assert.deepEqual(db.prepare("SELECT approval_id FROM approval_execution_linkages ORDER BY approval_id").all().map(row=>row.approval_id),["legacy","malformed"]);
  assert.deepEqual(db.prepare("SELECT * FROM approvals ORDER BY approval_id").all(),before);
  const plans=db.prepare("EXPLAIN QUERY PLAN SELECT approval_id FROM approval_execution_linkages WHERE workspace_id = ? AND run_id = ? UNION SELECT approval_id FROM approval_execution_linkages WHERE workspace_id = ? AND durable_run_id = ?").all("one","run","one","run");
  assert.ok(plans.some(row=>String(row.detail).includes("idx_approval_execution_run")));
  assert.ok(plans.some(row=>String(row.detail).includes("idx_approval_execution_durable_run")));
 } finally { db.close(); }
});

it("interprets duplicate historical JSON keys like the canonical record reader",()=>{
 const db=new DatabaseSync(":memory:");try{
  db.exec("CREATE TABLE approvals(approval_id TEXT PRIMARY KEY, linkage_json TEXT, payload_json TEXT, preview_json TEXT, created_at TEXT)");
  const insert=db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?)");
  insert.run("duplicate-scope",'{"workspaceId":"foreign","workspaceId":"one","runId":"run"}',"{}","{}","2026-01-01");
  insert.run("duplicate-legacy",null,'{"__gcApprovalLinkage":{"workspaceId":"foreign","runId":"run"},"__gcApprovalLinkage":{"workspaceId":"one","runId":"run"}}',"{}","2026-01-02");
  insert.run("duplicate-cleared",'{"workspaceId":"one","workspaceId":null,"runId":"run"}',"{}","{}","2026-01-03");
  db.exec(APPROVAL_EXECUTION_LINKAGE_SQLITE_SQL);
  const rows=db.prepare("SELECT approval_id, workspace_id FROM approval_execution_linkages ORDER BY approval_id").all();
  assert.deepEqual(rows.map(row=>[row.approval_id,row.workspace_id]),[["duplicate-legacy","one"],["duplicate-scope","one"]]);
 }finally{db.close();}
});

it("filters linked status before paging and keeps the full historical view",()=>{
 const {db,repo}=fixture();
 for(let i=0;i<3;i++)repo.create({kind:"tool.invoke",riskLevel:"safe",payload:{},preview:{},linkage:{workspaceId:"one",runId:"run"}});
 const rejected=repo.create({kind:"tool.invoke",riskLevel:"safe",payload:{},preview:{},linkage:{workspaceId:"one",runId:"run"}});
 db.prepare("UPDATE approvals SET status='rejected' WHERE approval_id=?").run(rejected.approvalId);
 const page=repo.listByRunLinkage({workspaceId:"one",runId:"run",status:"rejected",limit:1});
 assert.deepEqual(page.items.map(row=>row.approvalId),[rejected.approvalId]);assert.equal(page.nextCursor,undefined);
 assert.equal(repo.listByRunLinkage({workspaceId:"one",runId:"run"}).items.length,4);
});
