import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertProviderCatalogProof, matchProviderCatalogRead, readProviderCatalogResult, requireFreshProviderCatalog, selectProviderCatalogRead, revealProviderConfiguration } from "./cockpit-provider-catalog-proof.mjs";

function proof() {
  const before = { revision: 4, activeProviderId: "stub", activeModel: "test-model",
    providers: [{ providerId: "stub", label: "Loopback stub" }] };
  return { before, after: { ...before }, providerId: "stub", modelCatalog: { source: "live", catalogStatus: "fresh", items: [{ id: "test-model" }] },
    rendered: { providerIds: ["stub"], selectedProviderId: "stub", savedDefault: "Saved Chat default: Loopback stub / test-model", models: ["test-model"] }, mutations: [] };
}

describe("provider catalog browser proof assertions", () => {
  it("opens collapsed advanced controls and keeps already-open controls open", async () => {
    for (const initial of ["false", "true"]) {
      let expanded = initial, clicks = 0, mountedReads = 0;
      const disclosure = { waitFor: async () => {}, getAttribute: async () => expanded,
        click: async () => { clicks += 1; expanded = expanded === "false" ? "true" : "false"; } };
      const controls = { waitFor: async () => { mountedReads += 1; assert.equal(expanded, "true"); } };
      await revealProviderConfiguration(disclosure, controls);
      assert.equal(clicks, initial === "false" ? 1 : 0);
      assert.equal(mountedReads, 1);
      assert.equal(expanded, "true");
    }
  });
  it("rejects missing disclosure semantics or a click that leaves advanced controls closed", async () => {
    await assert.rejects(revealProviderConfiguration({ waitFor: async () => {}, getAttribute: async () => null }, {}), /disclosure state/);
    await assert.rejects(revealProviderConfiguration({ waitFor: async () => {}, getAttribute: async () => "false", click: async () => {} },
      { waitFor: async () => {} }), /did not open/);
  });
  it("binds a newly started read before a coalescible pending read", () => {
    const pending = {}, fresh = {};
    assert.equal(selectProviderCatalogRead([pending], [fresh]), fresh);
  });
  it("accepts the actual owner read still pending when refresh joins it", () => {
    const pending = {};
    assert.equal(selectProviderCatalogRead([pending], []), pending);
  });
  it("rejects refresh without a new or still-pending read", () => {
    assert.throws(() => selectProviderCatalogRead([], []), /no new or in-flight/);
  });
  it("reads only the exact provider's owner row from a startup packet", async () => {
    const direct = (path) => ({ method: () => "GET", url: () => `http://fixture.invalid${path}` });
    const paths = ["/api/v1/llm/config", "/api/v1/llm/models?providerId=other", "/api/v1/llm/models?providerId=stub"];
    const packet = (reads) =>
      direct("/api/v1/startup-reads?" + new URLSearchParams({
        reads: JSON.stringify(reads.map((path, index) => ({ path, correlationId: `synthetic-${index}` }))),
      }));
    const request = packet(paths);
    const modelRead = matchProviderCatalogRead(request, "stub");
    assert.deepEqual(modelRead, { transport: "startup_batch", index: 2, count: 3 });
    assert.deepEqual(matchProviderCatalogRead(request), { transport: "startup_batch", index: 0, count: 3 });
    assert.equal(matchProviderCatalogRead(request, "absent"), null);
    assert.deepEqual(matchProviderCatalogRead(direct(paths[2]), "stub"), { transport: "direct" });
    assert.equal(matchProviderCatalogRead(direct(paths[2] + "&providerId=other"), "stub"), null);
    assert.throws(() => matchProviderCatalogRead(packet([...paths, paths[2]]), "stub"), /ambiguous/);
    const models = proof().modelCatalog;
    const items = [{ status: 200, bodyText: "{}" }, { status: 500, bodyText: "{}" }, { status: 200, bodyText: JSON.stringify(models) }];
    const response = (rows) => ({ status: () => 200, json: async () => ({ items: rows }) });
    assert.deepEqual(await readProviderCatalogResult(response(items), modelRead), models);
    await assert.rejects(readProviderCatalogResult(response(items.slice(1)), modelRead), /does not match/);
    await assert.rejects(readProviderCatalogResult(response([...items.slice(0, 2), { ...items[2], directReadRequired: true }]), modelRead), /successful batch item/);
  });
  it("waits for a real fresh catalog after stale and fallback owner reads", async () => {
    const fresh = proof().modelCatalog;
    const replies = [{ ...fresh, catalogStatus: "stale" }, { source: "template_fallback", items: fresh.items }, fresh];
    let reads = 0; const pauses = [];
    assert.equal(await requireFreshProviderCatalog(async () => replies[reads++], async ms => pauses.push(ms)), fresh);
    assert.equal(reads, 3); assert.deepEqual(pauses, [250, 250]);
  });
  it("fails bounded readiness without treating stale, fallback or empty data as fresh", async () => {
    for (const response of [{ ...proof().modelCatalog, catalogStatus: "stale" }, { source: "template_fallback", items: [{ id: "test-model" }] }, { source: "live", items: [] }]) {
      let reads = 0, pauses = 0;
      await assert.rejects(requireFreshProviderCatalog(async () => { reads += 1; return response; }, async () => { pauses += 1; }), /did not reach/);
      assert.equal(reads, 30); assert.equal(pauses, 29);
    }
  });
  it("propagates a failed canonical owner read", async () => {
    await assert.rejects(requireFreshProviderCatalog(async () => { throw new Error("owner unavailable"); }), /owner unavailable/);
  });
  it("accepts a model catalog that matches the live owner without a settings mutation", () => {
    assert.doesNotThrow(() => assertProviderCatalogProof(proof()));
  });
  it("rejects stale and fallback model evidence", () => {
    for (const modelCatalog of [{ source: "live", catalogStatus: "stale" }, { source: "template_fallback" }]) {
      assert.throws(() => assertProviderCatalogProof({ ...proof(), modelCatalog }), /fallback|stale/);
    }
  });
  it("rejects an omitted provider, incorrect selection, or substituted saved model", () => {
    for (const change of [{ providerIds: [] }, { selectedProviderId: "other" }, { savedDefault: "Saved Chat default: Loopback stub / substituted" }, { models: ["substituted"] }]) {
      const input = proof();
      assert.throws(() => assertProviderCatalogProof({ ...input, rendered: { ...input.rendered, ...change } }));
    }
  });
  it("rejects changed routing, revision, or a mutation request even if the final route matches", () => {
    for (const change of [{ activeProviderId: "other" }, { activeModel: "other" }, { revision: 5 }]) {
      const input = proof();
      assert.throws(() => assertProviderCatalogProof({ ...input, after: { ...input.after, ...change } }));
    }
    assert.throws(() => assertProviderCatalogProof({ ...proof(), mutations: ["PATCH /api/v1/settings"] }), /mutation/);
  });
});
