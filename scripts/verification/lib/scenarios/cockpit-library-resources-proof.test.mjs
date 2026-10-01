import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { assertLibraryResourceOwnerAgreement, runCockpitLibraryResourcesProof } from "./cockpit-library-resources-proof.mjs";

test("requires the exact scoped resource from the matching owner window", () => {
  for (const [kind, key] of [["memory", "itemId"], ["notes", "noteId"]]) {
    const item = { [key]: "owned", workspaceId: "workspace" };
    assert.equal(assertLibraryResourceOwnerAgreement(kind, [item], "workspace", "owned"), item);
    assert.throws(() => assertLibraryResourceOwnerAgreement(kind, [item], "other", "owned"));
    assert.throws(() => assertLibraryResourceOwnerAgreement(kind, [item], "workspace", "missing"));
  }
});
test("files are deliberately installation shared and artifact evidence requires version and hash", () => {
  assert.equal(assertLibraryResourceOwnerAgreement("files", [{ relativePath: "proof.txt" }], "workspace", "proof.txt").relativePath, "proof.txt");
  const item = { artifactId: "artifact", workspaceId: "workspace", version: 1, contentHash: "a".repeat(64) };
  assert.equal(assertLibraryResourceOwnerAgreement("artifacts", [item], "workspace", "artifact"), item);
  assert.throws(() => assertLibraryResourceOwnerAgreement("artifacts", [{ ...item, contentHash: undefined }], "workspace", "artifact"));
});

test("owner-window failures retain the singular manifest error and safe stage evidence", async () => {
  const artifact = { artifactId: "artifact", workspaceId: "workspace", sessionId: "session", turnId: "turn", title: "Artifact" };
  const calls = [];
  const results = [];
  let closed = false;
  const page = { on() {}, async goto() {}, isClosed: () => true };
  const browserContext = { async addInitScript() {}, async newPage() { return page; }, async close() { closed = true; } };
  await runCockpitLibraryResourcesProof({
    context: {}, browser: { async newContext() { return browserContext; } },
    stack: { runtimeRoot: path.resolve("goatcitadel-usability-unit"), gatewayUrl: "http://fixture.invalid", uiUrl: "http://fixture.invalid" },
    citadelId: "personal", viewports: [{ variant: "desktop", viewport: { width: 1440, height: 900 } }],
    deps: {
      path, assertOk: (response) => assert.equal(response.status, 200),
      buildVerificationUiUrl: (base, route) => new URL(route, base).href,
      emptyArtifacts: (value) => value,
      async installMissionControlNextBrowserState() {},
      async runScenario(_context, _definition, run) { results.push(await run()); },
      async requestJson(_base, route, init) {
        calls.push({ route, init });
        const pathname = new URL(route, "http://fixture.invalid").pathname;
        const body = pathname === "/api/v1/dev/verification/seed" ? { workspaceId: "workspace", sessionId: "session" }
          : pathname.endsWith("/thread") ? { selectedTurnId: "turn", turns: [{ turnId: "turn", branch: { isSelectedPath: true }, generatedArtifacts: [artifact] }] }
          : pathname.endsWith("/generated-artifacts") ? { items: [artifact] }
          : pathname.endsWith("/memory-item-seed") ? { itemId: "memory" }
          : pathname === "/api/v1/notes" ? { noteId: "note" }
          : pathname === "/api/v1/memory/items" ? { items: [] } : {};
        return { status: 200, body };
      },
    },
  });
  // runScenario copies result.error into its serializable manifest; an `errors`
  // array silently loses the cause even while the scenario stays failed.
  const result = JSON.parse(JSON.stringify(results[0]));
  assert.equal(result.status, "failed");
  assert.match(result.error, /^memory: match owner window: AssertionError/u);
  assert.match(result.error, /seeded memory record is absent/u);
  assert.deepEqual(result.metrics, { failedStage: "memory: match owner window", resourceKind: "memory", ownerStatus: 200, ownerItemCount: 0 });
  assert.equal(closed, true);
  assert.match(calls.find(({ route }) => route === "/api/v1/files/upload").init.body.relativePath, /^000-library-resource-/u);
});
