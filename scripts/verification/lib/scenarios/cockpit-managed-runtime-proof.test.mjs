import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { assertManagedRuntimeSaved, collectManagedRuntimeReadyView } from "./cockpit-managed-runtime-proof.mjs";
const runtime = { enabled: false, autoStart: false, managementMode: "managed", baseUrl: "http://127.0.0.1:8080/v1",
  alias: "original", command: "llama-server", modelPath: "/models/existing.gguf" };
const fixture = () => ({ before: { revision: 41, llamaCpp: { ...runtime } }, after: { revision: 42, llamaCpp: { ...runtime, alias: "reviewed" } },
  alias: "reviewed", request: { expectedRevision: 41, llamaCpp: { enabled: false, autoStart: false, baseUrl: runtime.baseUrl, alias: "reviewed" } } });
describe("managed runtime browser owner assertions", () => {
  it("observes only one ready managed owner with disclosed version and its alias/endpoint", () => {
    const observe = (change = {}) => {
      const state = { present: true, ready: true, disclosed: true, mode: "Mode: Managed · Process: Stopped", ...change };
      const panel = { querySelectorAll(selector) {
        if (selector === "button") return [{ textContent: "Refresh runtime settings", disabled: !state.ready }];
        if (selector === "label") return ["Model alias", "Runtime endpoint"].map(textContent => ({ textContent,
          querySelector: () => ({ value: textContent === "Model alias" ? "owner-alias" : "http://127.0.0.1:8080/v1" }) }));
        if (selector === "p") return [{ textContent: state.mode }];
        if (selector === "details[open] p") return state.disclosed ? [{ textContent: "Settings version 41" }] : [];
        throw new Error("Unexpected unscoped readiness query");
      } };
      return runInNewContext(`(${collectManagedRuntimeReadyView.toString()})()`, { document: {
        getElementById(id) { assert.equal(id, "managed-runtime"); return state.present ? panel : null; },
      } });
    };
    assert.deepEqual(JSON.parse(JSON.stringify(observe())), { alias: "owner-alias", endpoint: "http://127.0.0.1:8080/v1", revision: "Settings version 41" });
    for (const change of [{ present: false }, { ready: false }, { disclosed: false }, { mode: "Mode: External · Process: Stopped" }])
      assert.equal(observe(change), null);
  });
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
