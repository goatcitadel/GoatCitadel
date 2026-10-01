import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertManagedRuntimeSaved } from "./cockpit-managed-runtime-proof.mjs";
const runtime = { enabled: false, autoStart: false, managementMode: "managed", baseUrl: "http://127.0.0.1:8080/v1",
  alias: "original", command: "llama-server", modelPath: "/models/existing.gguf" };
const fixture = () => ({ before: { revision: 41, llamaCpp: { ...runtime } }, after: { revision: 42, llamaCpp: { ...runtime, alias: "reviewed" } },
  alias: "reviewed", request: { expectedRevision: 41, llamaCpp: { enabled: false, autoStart: false, baseUrl: runtime.baseUrl, alias: "reviewed" } } });
describe("managed runtime browser owner assertions", () => {
  it("accepts the reviewed non-path configuration and canonical owner revision", () => assert.doesNotThrow(() => assertManagedRuntimeSaved(fixture())));
  it("rejects path fields or stale revisions in the mutation", () => {
    const value = fixture();
    assert.throws(() => assertManagedRuntimeSaved({ ...value, request: { ...value.request, expectedRevision: 40 } }));
    assert.throws(() => assertManagedRuntimeSaved({ ...value, request: { ...value.request, llamaCpp: { ...value.request.llamaCpp, command: "other" } } }));
  });
  it("rejects enabled processes, changed paths and mismatched saved values", () => {
    for (const change of [{ enabled: true }, { autoStart: true }, { modelPath: "/models/other.gguf" }, { alias: "other" }, { managementMode: "external" }]) {
      const value = fixture(); assert.throws(() => assertManagedRuntimeSaved({ ...value, after: { ...value.after, llamaCpp: { ...value.after.llamaCpp, ...change } } }));
    }
  });
});
