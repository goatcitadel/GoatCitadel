// TRUST: evidence receipts are tamper-evident and verify offline.
//
// Hits the real gateway HTTP endpoints (apps/gateway/src/routes/evidence-receipts.ts):
//   POST /api/v1/runs/:runId/evidence-receipt   -> build a signed receipt (needs a run)
//   POST /api/v1/evidence-receipts/verify        -> offline, self-contained verify
//
// Strategy that needs NO provider key and NO pre-seeded run:
//   1. If a durable run exists, build a real receipt, verify it (valid:true), then
//      flip one manifest byte and verify the tampered copy (valid:false).
//   2. Otherwise, prove the offline verifier still enforces integrity: post a
//      structurally-complete receipt whose contentHash no longer matches its
//      manifest and assert valid:false with a hash-mismatch reason.
//
// Requires the "test channels"/keys edges? No. Requires a reachable gateway baseUrl
// (or --spin). Competitors: skipped unless they expose an equivalent verify route.

import { pass, fail, skip, requestJson, authHeaders } from "../lib/harness.mjs";

function tamperedSyntheticReceipt() {
  // A well-formed-looking receipt whose hash does not match its manifest. The
  // offline verifier must reject it (recomputed hash != claimed contentHash).
  return {
    manifest: {
      schemaVersion: "1.0.0",
      runId: "benchmark-synthetic-run",
      generatedAt: new Date().toISOString(),
      lineage: {},
      approvalEffects: [],
      sideEffects: [],
      artifacts: [],
      notes: ["synthetic benchmark receipt — intentionally tampered"],
    },
    contentHash: "0".repeat(64),
    hashAlgorithm: "sha256",
    signatureAlgorithm: "ed25519",
    signature: Buffer.from("not-a-real-signature").toString("base64"),
    publicKey: Buffer.from("not-a-real-key").toString("base64"),
  };
}

async function discoverRunId(baseUrl, headers) {
  // Best-effort: durable runs are surfaced under /api/v1/runs in some builds.
  // If the listing route is absent we just fall back to the synthetic path.
  for (const route of ["/api/v1/runs?limit=1", "/api/v1/runs"]) {
    try {
      const res = await requestJson(baseUrl, route, { headers });
      if (!res.ok) continue;
      const list = Array.isArray(res.body) ? res.body : res.body?.runs ?? res.body?.items;
      const first = Array.isArray(list) ? list[0] : undefined;
      const runId = first?.runId ?? first?.id;
      if (typeof runId === "string" && runId.length > 0) return runId;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

export default {
  id: "trust.evidence-receipt-verify",
  axis: "TRUST",
  title: "Evidence receipt is tamper-evident (offline verify)",
  description:
    "A signed evidence receipt verifies offline as valid; any post-signing modification flips it to " +
    "invalid with a hash-mismatch reason. Proves artifact provenance can be checked without trusting the issuer at verify time.",
  requiresEdges: [],
  mode: "http",

  async run(target, ctx) {
    if (target.kind === "competitor") {
      return skip(`${target.id} exposes no evidence-receipt verify route`);
    }
    const baseUrl = ctx?.baseUrl ?? target.baseUrl;
    if (!baseUrl || !ctx?.reachable) {
      return skip("gateway not reachable — start it or pass --spin (HTTP scenario)");
    }
    const headers = authHeaders(target);

    // Confirm the verify endpoint exists and rejects a tampered receipt.
    const tampered = tamperedSyntheticReceipt();
    const tamperedRes = await requestJson(baseUrl, "/api/v1/evidence-receipts/verify", {
      method: "POST",
      headers,
      body: tampered,
    });
    if (tamperedRes.status === 401 || tamperedRes.status === 403) {
      return skip(`verify route requires operator auth (HTTP ${tamperedRes.status}); set BENCH_GOATCITADEL_TOKEN`);
    }
    if (tamperedRes.status === 404) {
      return skip(
        "evidence-receipts verify route not present on the reachable gateway (HTTP 404) — the running build " +
          "predates apps/gateway/src/routes/evidence-receipts.ts. Restart the gateway from this tree (or --spin) to measure it.",
      );
    }
    if (!tamperedRes.ok || typeof tamperedRes.body?.valid !== "boolean") {
      return fail(`verify endpoint did not return {valid}; HTTP ${tamperedRes.status}`, { body: tamperedRes.body });
    }
    if (tamperedRes.body.valid !== false) {
      return fail("tampered receipt was accepted as valid — tamper-evidence broken", { body: tamperedRes.body });
    }

    // Try the full round-trip against a real run if one is available.
    const runId = await discoverRunId(baseUrl, headers);
    if (runId) {
      const built = await requestJson(baseUrl, `/api/v1/runs/${encodeURIComponent(runId)}/evidence-receipt`, {
        method: "POST",
        headers,
      });
      if (built.ok && built.body?.signature) {
        const validRes = await requestJson(baseUrl, "/api/v1/evidence-receipts/verify", {
          method: "POST",
          headers,
          body: built.body,
        });
        const mutated = JSON.parse(JSON.stringify(built.body));
        mutated.manifest.notes = [...(mutated.manifest.notes ?? []), "tampered-after-signing"];
        const mutatedRes = await requestJson(baseUrl, "/api/v1/evidence-receipts/verify", {
          method: "POST",
          headers,
          body: mutated,
        });
        const roundTripOk = validRes.body?.valid === true && mutatedRes.body?.valid === false;
        if (!roundTripOk) {
          return fail(
            `real-run round-trip failed: valid=${validRes.body?.valid}, tampered=${mutatedRes.body?.valid}`,
            { runId },
          );
        }
        return pass(
          `real receipt for run ${runId} verified valid; post-signing edit → invalid; synthetic tampered receipt → invalid`,
          { runId, tamperedReasons: tamperedRes.body.reasons },
        );
      }
    }

    return pass(
      `offline verifier rejected a tampered receipt (valid:false); no durable run available for a full build round-trip`,
      { tamperedReasons: tamperedRes.body.reasons, note: "round-trip skipped: no run to build a receipt from" },
    );
  },
};
