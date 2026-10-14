import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readMissionControlNextReleaseAuthority } from "./mission-control-next-release-source.mjs";

const root = path.resolve("fixture-root");
const definitions = `
export type PrimaryArea = "chat" | "cowork" | "code" | "projects" | "library" | "ops" | "settings";
export type CoworkSection = "workspace";
export type LibrarySection = "skills";
export type OpsSection = "activity";
export type SettingsSection = "general";
export type ReleaseSurfaceStatus = "ship" | "hide" | "experimental" | "needs_release_polish";
`;
const rows = [
  ["chat", "root", "ship"], ["cowork", "workspace", "hide"], ["code", "root", "hide"],
  ["projects", "root", "ship"], ["library", "skills", "ship"], ["ops", "activity", "experimental"], ["settings", "general", "needs_release_polish"],
].map(([area, section, status]) => ({ area, section, status, releaseAction: "Inspect \"canonical\" record.", verification: "named proof", note: "Retain scope and policy." }));
const literal = (entries = rows) => "export const ROUTE_RELEASE_SCOPE: readonly RouteReleaseScope[] = " + JSON.stringify(entries, null, 2) + ";";
function fixture({ model = definitions + '\nexport { ROUTE_RELEASE_SCOPE } from "./route-release-scope";', scope = literal(), additional = {} } = {}) {
  const app = path.join(root, "apps/mission-control-next/src/app");
  const files = new Map([[path.join(app, "route-model.ts"), model], [path.join(app, "route-release-scope.ts"), scope], ...Object.entries(additional).map(([name, content]) => [path.join(app, name), content])]);
  const reads = [];
  const readSource = async (file) => { reads.push(file); if (!files.has(file)) throw new Error("Missing fixture source"); return files.get(file); };
  return { reads, load: () => readMissionControlNextReleaseAuthority(root, { readSource }) };
}

test("reads typed canonical rows through the named physical owner without hardcoded counts", async () => {
  const f = fixture(), result = await f.load();
  assert.equal(result.scopes.length, rows.length); assert.equal(result.routeKeys.length, rows.length);
  assert.equal(result.scopeOwner, "apps/mission-control-next/src/app/route-release-scope.ts");
  assert.deepEqual(result.scopes.map(({ expectedArea, expectedSection, status, releaseAction, verification, note }) => ({ area: expectedArea, section: expectedSection, status, releaseAction, verification, note })), rows);
  assert.deepEqual(result.sectionsByArea, { cowork: ["workspace"], library: ["skills"], ops: ["activity"], settings: ["general"] });
  assert.equal(f.reads.length, 2);
});
test("retains inline as-const/satisfies and safely resolves a named alias owner", async () => {
  const inline = literal().replace(": readonly RouteReleaseScope[]", "").replace(/;$/u, " as const satisfies readonly RouteReleaseScope[];");
  assert.equal((await fixture({ model: definitions + inline }).load()).scopes.length, rows.length);
  assert.equal((await fixture({ model: definitions + '\nexport { canonical as ROUTE_RELEASE_SCOPE } from "./route-release-scope";', scope: literal().replace("ROUTE_RELEASE_SCOPE", "canonical") }).load()).scopes.length, rows.length);
});
test("does not execute application top-level code or match literal-looking comments", async () => {
  const marker = "__governance_route_reader_not_executed__";
  assert.equal(globalThis[marker], undefined);
  await fixture({ scope: `globalThis.${marker} = "executed";\n/* export const ROUTE_RELEASE_SCOPE = []; */\n` + literal() }).load();
  assert.equal(globalThis[marker], undefined);
});
test("cannot pass with missing or empty canonical inventories", async () => {
  await assert.rejects(fixture({ model: definitions }).load(), /export ROUTE_RELEASE_SCOPE exactly once/);
  await assert.rejects(fixture({ scope: "export const ROUTE_RELEASE_SCOPE = [];" }).load(), /nonempty literal array/);
  await assert.rejects(fixture({ scope: literal(rows.slice(1)) }).load(), /missing route chat\/root/);
  await assert.rejects(fixture({ model: definitions.replace('export type LibrarySection = "skills";', '') }).load(), /LibrarySection exactly once/);
});
test("rejects duplicate route records, fields, union members and exported owners", async () => {
  await assert.rejects(fixture({ scope: literal([...rows, rows[0]]) }).load(), /repeats route chat\/root/);
  await assert.rejects(fixture({ scope: literal().replace('"area": "chat"', '"area": "chat", "area": "chat"') }).load(), /duplicate field area/);
  await assert.rejects(fixture({ model: definitions.replace('"workspace";', '"workspace" | "workspace";') + '\nexport { ROUTE_RELEASE_SCOPE } from "./route-release-scope";' }).load(), /duplicate literals/);
  await assert.rejects(fixture({ model: definitions + '\nexport { ROUTE_RELEASE_SCOPE } from "./route-release-scope";\nexport { ROUTE_RELEASE_SCOPE } from "./other";' }).load(), /exactly once/);
});
test("rejects unknown route/status, missing copy and unsupported computed literals", async () => {
  await assert.rejects(fixture({ scope: literal([...rows, { ...rows[0], area: "future" }]) }).load(), /unknown route future\/root/);
  await assert.rejects(fixture({ scope: literal(rows.map((row, i) => i ? row : { ...row, status: "unsupported" })) }).load(), /unsupported status/);
  await assert.rejects(fixture({ scope: literal(rows.map((row, i) => i ? row : { ...row, note: " " })) }).load(), /note must be a nonempty string literal/);
  await assert.rejects(fixture({ scope: literal().replace('"status": "ship"', '"status": readStatus()') }).load(), /status must be a nonempty string literal/);
  await assert.rejects(fixture({ scope: "export const ROUTE_RELEASE_SCOPE = buildScope();" }).load(), /nonempty literal array/);
  await assert.rejects(fixture({ scope: "export const ROUTE_RELEASE_SCOPE = [ {...row} ];" }).load(), /literal assignments/);
});
test("rejects nonlocal ownership, wildcard exports, export cycles and malformed syntax", async () => {
  const external = fixture({ model: definitions + '\nexport { ROUTE_RELEASE_SCOPE } from "../outside";' });
  await assert.rejects(external.load(), /Nonlocal canonical route export/); assert.equal(external.reads.length, 1);
  await assert.rejects(fixture({ model: definitions + '\nexport * from "./route-release-scope";' }).load(), /exactly once/);
  await assert.rejects(fixture({ scope: 'export { ROUTE_RELEASE_SCOPE } from "./route-model";' }).load(), /export cycle/);
  await assert.rejects(fixture({ scope: "export const ROUTE_RELEASE_SCOPE = [;" }).load(), /invalid syntax/);
});
test("binds actual repository type declarations to the actual exported scope owner", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const authority = await readMissionControlNextReleaseAuthority(repoRoot);
  assert.ok(authority.routeKeys.length > 0); assert.equal(authority.routeKeys.length, authority.scopes.length);
  assert.equal(new Set(authority.routeKeys).size, authority.routeKeys.length);
  assert.ok(authority.routeKeys.includes("chat/root")); assert.ok(authority.scopes.some((row) => row.status === "hide"));
  for (const row of authority.scopes) assert.ok(row.releaseAction.trim() && row.verification.trim() && row.note.trim());
});
