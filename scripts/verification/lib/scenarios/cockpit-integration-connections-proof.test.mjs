import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertIntegrationDialogBounds, assertIntegrationEnabledSaved, checkReviewBounds } from "./cockpit-integration-connections-proof.mjs";

const proof = () => {
  const before = { connectionId: "one", catalogId: "github", kind: "productivity", key: "github", label: "GitHub",
    workspaceId: "workspace-one", revision: "a".repeat(64), enabled: false, status: "paused", config: { owner: "fixture" } };
  const after = { ...before, enabled: true, revision: "b".repeat(64) };
  return { before, after, response: after, request: { expectedRevision: before.revision, enabled: true }, enabled: true };
};
describe("native integration enabled browser proof", () => {
  it("accepts exact owner enabled acknowledgement", () => assert.doesNotThrow(() => assertIntegrationEnabledSaved(proof())));
  it("rejects substituted binding, config, status, or stale revisions", () => {
    for (const patch of [{ connectionId: "other" }, { workspaceId: "other" }, { revision: "a".repeat(64) },
      { config: { owner: "other" } }, { status: "connected" }, { enabled: false }]) {
      const value = proof(); assert.throws(() => assertIntegrationEnabledSaved({ ...value, after: { ...value.after, ...patch } }));
    }
  });
  it("rejects extra mutation fields and a receipt differing from canonical readback", () => {
    const value = proof();
    assert.throws(() => assertIntegrationEnabledSaved({ ...value, request: { ...value.request, config: {} } }));
    assert.throws(() => assertIntegrationEnabledSaved({ ...value, response: { ...value.response, enabled: false } }));
  });
  it("rejects clipped modal or action bounds even when the document reports no overflow", () => {
    const box = { x: 16, y: 100, width: 358, height: 400 };
    const value = { viewport: { width: 390, height: 844 }, dialog: box,
      buttons: { confirm: { x: 30, y: 420, width: 300, height: 44 } } };
    assert.doesNotThrow(() => assertIntegrationDialogBounds(value));
    assert.throws(() => assertIntegrationDialogBounds({ ...value, dialog: { ...box, x: -80, width: 550 } }));
    assert.throws(() => assertIntegrationDialogBounds({ ...value, buttons: { confirm: { x: 30, y: 820, width: 300, height: 44 } } }));
  });
  it("waits for the asynchronously reopened review and its actions before measuring", async () => {
    let releaseOwnerRead;
    let visible = false;
    const calls = [];
    const ownerRead = new Promise((resolve) => { releaseOwnerRead = resolve; });
    const dialog = {
      waitFor: async (options) => {
        assert.deepEqual(options, { state: "visible" });
        calls.push("wait-dialog");
        await ownerRead;
        visible = true;
      },
      getByRole: (role, { name, exact }) => {
        assert.equal(visible, true, "Actions were queried before owner review became visible.");
        assert.equal(role, "button"); assert.equal(exact, true);
        let actionReady = false;
        return {
          waitFor: async (options) => {
            assert.deepEqual(options, { state: "visible" });
            calls.push(`wait-${name}`); actionReady = true;
          },
          isVisible: async () => actionReady,
          boundingBox: async () => {
            assert.equal(actionReady, true);
            return { x: 30, y: 420, width: 300, height: 44 };
          },
        };
      },
      boundingBox: async () => ({ x: 16, y: 100, width: 358, height: 400 }),
    };
    const pending = checkReviewBounds(dialog, { width: 390, height: 844 }, "Enable reviewed integration");
    assert.deepEqual(calls, ["wait-dialog"]);
    releaseOwnerRead();
    await pending;
    assert.deepEqual(calls, ["wait-dialog", "wait-Enable reviewed integration", "wait-Keep current state"]);
  });
});
