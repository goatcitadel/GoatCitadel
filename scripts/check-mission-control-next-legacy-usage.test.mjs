import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { findProductionSourceExportAliases } from "./lib/mission-control-next-production-aliases.mjs";

const viteFile = path.resolve("apps/mission-control-next/vite.config.ts");
const tsconfigFile = path.resolve("apps/mission-control-next/tsconfig.json");
const imports =
  'import path from "node:path"; import {fileURLToPath} from "node:url"; import {defineConfig} from "vite";';
const base =
  imports +
  ' const configDir=path.dirname(fileURLToPath(import.meta.url)); const repoRoot=path.resolve(configDir,"../..");';
const check = (source) => findProductionSourceExportAliases(viteFile, source);

test("production @next remains safe beside real approval owner suffix metadata", () => {
  const source =
    base +
    ' const COCKPIT_APPROVAL_BODY_OWNER_SUFFIXES=[["/packages/mission-control-shared/src/content/approval-helpers.ts"],["/packages/mission-control-shared/src/content/communications-approval-evidence.ts"],["/packages/mission-control-shared/src/content/external-source-approval-evidence.ts"]]; const COCKPIT_APPROVAL_AUTHORITY_OWNER_SUFFIXES=["/packages/contracts/src/durable-chat-turn-payload.ts"]; export default defineConfig(()=>({resolve:{alias:[{find:"@next",replacement:path.resolve(configDir,"./src")}]}}));';
  assert.deepEqual(check(source), []);
});

for (const owner of ["contracts", "threaded-surface-core", "mission-control-shared"]) {
  test(`rejects direct production ${owner} source alias`, () => {
    assert.equal(
      check(
        base +
          ` export default {resolve:{alias:[{find:"@owner",replacement:path.resolve(repoRoot,"packages/${owner}/src")}]}};`,
      )[0]?.label,
      `source-exported ${owner} alias`,
    );
  });
  test(`rejects referenced production ${owner} source alias`, () => {
    const source =
      base +
      ` const sourcePath=path.resolve(repoRoot,"packages","${owner}","src"); const aliasEntries=[{find:/^@owner/,replacement:sourcePath}] as const; const resolver={alias:aliasEntries}; const config={resolve:resolver}; export default defineConfig(()=>config);`;
    assert.equal(check(source)[0]?.label, `source-exported ${owner} alias`);
  });
}

test("rejects source alias carried by a local object spread", () => {
  const source =
    base +
    ' const resolver={alias:{"@owner":path.resolve(repoRoot,"packages/contracts/src")}}; const config={resolve:resolver}; export default {...config,build:{}};';
  assert.equal(check(source)[0]?.label, "source-exported contracts alias");
});

test("rejects a referenced source alias carried by an array spread", () => {
  const source =
    base +
    ' const entries=[{find:"@owner",replacement:path.resolve(repoRoot,"packages/contracts/src")}]; export default {resolve:{alias:[...entries]}};';
  assert.equal(check(source)[0]?.label, "source-exported contracts alias");
});

test("retains alias checks when a path is constructed from literals", () => {
  const source =
    base +
    ' const owner="contracts"; export default {resolve:{alias:{"@owner":path.resolve(repoRoot,`packages/${owner}/src`)}}};';
  assert.equal(check(source)[0]?.label, "source-exported contracts alias");
});

test("test-only and unused alias definitions cannot become production aliases accidentally", () => {
  const source =
    base +
    ' const testAliases={"@owner":path.resolve(repoRoot,"packages/contracts/src")}; function buildWorkspaceSourceAliases(){return testAliases;} export default {test:{resolve:{alias:buildWorkspaceSourceAliases()}},resolve:{alias:{"@next":path.resolve(configDir,"./src")}}};';
  assert.deepEqual(check(source), []);
});

test("local callback definitions retain lexical precedence over outer metadata", () => {
  const source =
    base +
    ' const entries=["/packages/contracts/src"]; export default defineConfig(()=>{const entries=[{find:"@next",replacement:path.resolve(configDir,"./src")}];return {resolve:{alias:entries}};});';
  assert.deepEqual(check(source), []);
});

test("unresolved imported production alias helper fails closed", () => {
  const source =
    base +
    ' import {buildWorkspaceSourceAliases} from "./external.js"; export default {resolve:{alias:buildWorkspaceSourceAliases()}};';
  assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
});

test("shadowed Node path helpers cannot prove an unknown replacement safe", () => {
  const source = base + ' export default defineConfig(({path})=>({resolve:{alias:{"@owner":path.resolve("./src")}}}));';
  assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
});

test("shadowed URL helpers and config factories fail closed", () => {
  for (const source of [
    base +
      ' export default defineConfig(()=>{const fileURLToPath=customPath;const target=fileURLToPath(import.meta.url);return {resolve:{alias:{"@owner":path.dirname(target)}}};});',
    base + " const defineConfig=customFactory;export default defineConfig({resolve:{alias:[]}});",
  ])
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
});

test("catch-bound path and URL helpers cannot retain an outer import proof", () => {
  for (const source of [
    base +
      ' export default defineConfig(()=>{try{throw unknown;}catch(path){return {resolve:{alias:{"@owner":path.resolve("src")}}};}});',
    base +
      ' export default defineConfig(()=>{try{throw unknown;}catch(fileURLToPath){return {resolve:{alias:{"@owner":fileURLToPath(import.meta.url)}}};}});',
  ])
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
});

test("for-of and for-in alias/path bindings cannot fall through to outer values", () => {
  for (const source of [
    base +
      " const entries=[];export default defineConfig(()=>{for(const entries of unknown){return {resolve:{alias:entries}};}return {};});",
    base +
      " const entries=[];export default defineConfig(()=>{for(const entries in unknown){return {resolve:{alias:entries}};}return {};});",
    base +
      ' export default defineConfig(()=>{for(const path of unknown){return {resolve:{alias:{"@owner":path.resolve("src")}}};}return {};});',
    base +
      ' export default defineConfig(()=>{for(const path in unknown){return {resolve:{alias:{"@owner":path.resolve("src")}}};}return {};});',
  ])
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
});

for (const mutation of [
  'entries.push({find:"@owner",replacement:"/packages/contracts/src"});',
  'entries["push"]({find:"@owner",replacement:"/packages/contracts/src"});',
  'entries.splice(0,0,{find:"@owner",replacement:"/packages/contracts/src"});',
  'entries[0].replacement="/packages/contracts/src";',
  'entries[0]={find:"@owner",replacement:"/packages/contracts/src"};',
  "delete entries[0].replacement;",
  "unknownMutator(entries);",
  'Object.assign(entries[0],{replacement:"/packages/contracts/src"});',
  "const second=entries;unknownMutator(second);",
  'const container={entries};container.entries.push({find:"@owner",replacement:"/packages/contracts/src"});',
  'const getter=()=>entries;getter().push({find:"@owner",replacement:"/packages/contracts/src"});',
]) {
  test(`mutated/escaped const alias data fails closed: ${mutation}`, () => {
    const source =
      base +
      ' const entries=[{find:"@next",replacement:path.resolve(configDir,"./src")}];' +
      mutation +
      " export default {resolve:{alias:entries}};";
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
  });
}

test("unrelated mutable metadata remains outside the reached resolver data", () => {
  const source =
    base +
    ' const entries=[{find:"@next",replacement:path.resolve(configDir,"./src")}];const metadata=[];metadata.push("/packages/contracts/src");unknownMutator(metadata);export default {resolve:{alias:entries}};';
  assert.deepEqual(check(source), []);
});

test("destructured or runtime alias shadows cannot fall back to unrelated outer metadata", () => {
  for (const source of [
    base +
      " const entries=[];export default defineConfig(()=>{const {entries}=unknown;return {resolve:{alias:entries}};});",
    base + " const entries=[];export default defineConfig(({entries})=>({resolve:{alias:entries}}));",
    base +
      " const entries=[];export default defineConfig(()=>{try{throw unknown;}catch(entries){return {resolve:{alias:entries}};}});",
  ])
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
});

for (const source of [
  "const entries=entries;export default {resolve:{alias:entries}};",
  "let entries=[];export default {resolve:{alias:entries}};",
  'export default {resolve:{alias:[],alias:{"@owner":"packages/contracts/src"}}};',
  "export default {...unknown};",
  'export default {resolve:{alias:[{find:"@owner"}]}};',
  'export default {resolve:{alias:{[unknown]:"packages/contracts/src"}}};',
  "const entries=[];",
  "export default {resolve:{alias:[;",
]) {
  test(`ambiguous/unsupported production config remains a failing guard: ${source.slice(0, 42)}`, () => {
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
  });
}

test("tsconfig project references and supported @next paths are not source aliases", () => {
  const source = JSON.stringify({
    compilerOptions: { paths: { "@next/*": ["./src/*"] } },
    references: [{ path: "../../packages/contracts" }],
  });
  assert.deepEqual(findProductionSourceExportAliases(tsconfigFile, source), []);
});

test("tsconfig source paths fail even when baseUrl holds the package path", () => {
  const source = JSON.stringify({
    compilerOptions: { baseUrl: "../../packages/contracts", paths: { "@owner": ["src/index.ts"] } },
  });
  assert.equal(findProductionSourceExportAliases(tsconfigFile, source)[0]?.label, "source-exported contracts alias");
});

test("malformed tsconfig paths fail closed", () => {
  assert.equal(
    findProductionSourceExportAliases(tsconfigFile, '{"compilerOptions":{"paths":{"@owner":42}}}')[0]?.label,
    "unresolved production source-export alias configuration",
  );
});

test("unsupported tsconfig compilerOptions cannot hide alias configuration", () => {
  for (const compilerOptions of [null, 42, [], "packages/contracts/src"])
    assert.equal(
      findProductionSourceExportAliases(tsconfigFile, JSON.stringify({ compilerOptions }))[0]?.label,
      "unresolved production source-export alias configuration",
    );
});

// Revision5: guard only alias data and the helper bindings actually reached by it.
for (const mutation of [
  'for(const entry of entries){entry.replacement="/packages/contracts/src";}',
  'for(const [entry] of [entries]){entry.replacement="/packages/contracts/src";}',
  "for(const key in entries){unknownMutator(entries[key]);}",
  "new UnknownMutator(entries);",
  "unknownTag`${entries}`;",
]) {
  test(`iterator/constructor/tagged alias custody fails closed: ${mutation}`, () => {
    const source =
      base +
      ' const entries=[{find:"@next",replacement:path.resolve(configDir,"./src")}];' +
      mutation +
      " export default {resolve:{alias:entries}};";
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
  });
}

test("custom and unsupported alias entry resolver fields fail closed", () => {
  for (const field of [
    'customResolver:()=>"/packages/contracts/src"',
    'customResolver:{resolveId:()=>"/packages/contracts/src"}',
    "unsupportedResolver:unknownResolver",
  ]) {
    const source =
      base +
      ' export default {resolve:{alias:[{find:"@next",replacement:path.resolve(configDir,"./src"),' +
      field +
      "}]}};";
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
  }
});

for (const mutation of [
  'path.resolve=()=>"/packages/contracts/src";',
  'path["resolve"]=()=>"/packages/contracts/src";',
  "delete path.resolve;",
  "unknownMutator(path);",
  "new UnknownMutator(path);",
  "unknownTag`${path}`;",
  'Object.assign(path,{resolve:()=>"/packages/contracts/src"});',
  'const other=path;other.resolve=()=>"/packages/contracts/src";',
  'const box={path};box.path.resolve=()=>"/packages/contracts/src";',
  'for(const helper of [path]){helper.resolve=()=>"/packages/contracts/src";}',
  'fileURLToPath.custom="/packages/contracts/src";',
  "unknownMutator(fileURLToPath);",
]) {
  test(`reached imported helper mutation/escape fails closed: ${mutation}`, () => {
    const source = base + mutation + ' export default {resolve:{alias:{"@next":path.resolve(configDir,"./src")}}};';
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
  });
}

test("pure metadata path helpers and genuinely separate modules stay outside alias custody", () => {
  const source =
    base +
    ' import extraOs from "node:os"; const metadata=[];metadata.push(path.extname("file.ts"));unknownMutator(metadata);extraOs.resolve=unknown;new UnknownMutator(metadata);unknownTag`${metadata}`;function unrelated(){return path.join("a","b");}unrelated();export default {resolve:{alias:{"@next":path.resolve(configDir,"./src")}}};';
  assert.deepEqual(check(source), []);
});

// Local import aliases from a reached Node module cannot conceal shared helper mutation.
for (const [label, extraImport, mutation] of [
  ["default path alias write", 'import extraPath from "node:path";', "extraPath.resolve=unknown;"],
  ["default path alias escape", 'import extraPath from "node:path";', "unknownMutator(extraPath);"],
  ["namespace path default write", 'import * as extraPath from "node:path";', "extraPath.default.resolve=unknown;"],
  [
    "namespace path default escape",
    'import * as extraPath from "node:path";',
    "Object.assign(extraPath.default,{resolve:unknown});",
  ],
  ["named URL helper alias write", 'import {fileURLToPath as otherUrl} from "node:url";', "otherUrl.custom=unknown;"],
  ["named URL helper alias escape", 'import {fileURLToPath as otherUrl} from "node:url";', "unknownMutator(otherUrl);"],
  ["URL namespace helper escape", 'import * as otherUrl from "node:url";', "unknownMutator(otherUrl.fileURLToPath);"],
]) {
  test("reached Node module sibling import custody fails closed: " + label, () => {
    const source =
      base + extraImport + mutation + ' export default {resolve:{alias:{"@next":path.resolve(configDir,"./src")}}};';
    assert.equal(check(source)[0]?.label, "unresolved production source-export alias configuration");
  });
}

test("pure calls through sibling path imports remain safe metadata", () => {
  const source =
    base +
    ' import extraPath from "node:path";const metadata=[extraPath.extname("file.ts"),extraPath.dirname("a/b"),extraPath.join("a","b")];unknownMutator(metadata);export default {resolve:{alias:{"@next":path.resolve(configDir,"./src")}}};';
  assert.deepEqual(check(source), []);
});
