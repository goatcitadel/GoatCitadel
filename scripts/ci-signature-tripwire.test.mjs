import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFreshToLedger,
  diffSignatures,
  extractLaneSignatures,
  formatReport,
  matchesLedgerEntry,
  normalizeSignatureText,
  parseJobLane,
} from "./ci-signature-tripwire.mjs";

test("parseJobLane extracts the lane slug from a required-lanes job name", () => {
  assert.equal(parseJobLane("required-lanes (verify:realtime:truth, realtime-truth, ubuntu-latest)"), "realtime-truth");
  assert.equal(parseJobLane("required-lanes (verify:visual:regression, visual-regression, ubuntu-latest)"), "visual-regression");
  assert.equal(parseJobLane("no parenthetical"), undefined);
});

test("normalizeSignatureText strips run-specific noise into stable text", () => {
  const raw =
    "Error at 2026-08-16T07:34:57.874Z run verify-f391bc70-ba0c-49a6-a540-81a5a2b37e65 " +
    "on http://127.0.0.1:61609/ops/activity took 30.5 s at /home/runner/work/GoatCitadel/scripts/x.mjs";
  const normalized = normalizeSignatureText(raw);
  assert.ok(!normalized.includes("2026-08-16T"), "timestamp survived");
  assert.ok(!normalized.includes("f391bc70"), "uuid survived");
  assert.ok(!normalized.includes("61609"), "port survived");
  assert.ok(!normalized.includes("/home/runner"), "path survived");
  assert.ok(normalized.includes("<ts>") && normalized.includes("<uuid>"));
  // Same defect on a different run must produce the identical signature.
  const rerun = raw
    .replace("07:34:57.874", "09:11:02.001")
    .replace("f391bc70-ba0c-49a6-a540-81a5a2b37e65", "11111111-2222-3333-4444-555555555555")
    .replace("61609", "50123")
    .replace("30.5 s", "12.1 s");
  assert.equal(normalizeSignatureText(rerun), normalized);
});

test("normalizeSignatureText strips ANSI color sequences with and without the escape byte", () => {
  const esc = String.fromCharCode(27);
  assert.equal(normalizeSignatureText(`${esc}[31mFAIL${esc}[39m plain [2mdim[22m`), "FAIL plain dim");
});

test("extractLaneSignatures maps review.json items to lane signatures", () => {
  const review = {
    items: [
      { scenarioId: "realtime-truth.disconnect-reconnect-resubscribe", summary: "locator.waitFor: Timeout 15000ms exceeded." },
      { scenarioId: "realtime-truth.explicit-compatibility-replay-gap", summary: "expected visible realtime replay recovery" },
    ],
  };
  const signatures = extractLaneSignatures("realtime-truth", review);
  assert.equal(signatures.length, 2);
  assert.equal(signatures[0].lane, "realtime-truth");
  assert.ok(signatures[0].text.includes("locator.waitFor"));
});

const LEDGER_ENTRIES = [
  {
    lanes: ["operator-proof"],
    scenarioId: "operator-proof.install.verify-install",
    match: "SECRET_STORE_UNAVAILABLE",
    classification: "environmental",
  },
  { lanes: ["visual-regression"], scenarioId: "*", match: "*", classification: "environmental" },
];

test("matchesLedgerEntry requires lane, scenario, and text agreement", () => {
  const signature = {
    lane: "operator-proof",
    scenarioId: "operator-proof.install.verify-install",
    text: normalizeSignatureText('{"secret":{"error":"...","code":"SECRET_STORE_UNAVAILABLE"}}'),
  };
  assert.equal(matchesLedgerEntry(signature, LEDGER_ENTRIES[0]), true);
  assert.equal(matchesLedgerEntry({ ...signature, lane: "surface-regression" }, LEDGER_ENTRIES[0]), false);
  assert.equal(matchesLedgerEntry({ ...signature, text: "different failure" }, LEDGER_ENTRIES[0]), false);
});

test("wildcard scenario + match entries tolerate any failure in their lanes only", () => {
  const oversized = { lane: "visual-regression", scenarioId: "*", text: "artifact too large to inspect (140MB)" };
  assert.equal(matchesLedgerEntry(oversized, LEDGER_ENTRIES[1]), true);
  assert.equal(matchesLedgerEntry({ ...oversized, lane: "realtime-truth" }, LEDGER_ENTRIES[1]), false);
});

test("diffSignatures splits chronic from fresh and formatReport flags NEW", () => {
  const signatures = [
    {
      lane: "operator-proof",
      scenarioId: "operator-proof.install.verify-install",
      text: "code SECRET_STORE_UNAVAILABLE",
    },
    { lane: "architecture-metrics", scenarioId: "architecture.metrics.snapshot", text: "GatewayService line count increased" },
  ];
  const diff = diffSignatures(signatures, LEDGER_ENTRIES);
  assert.equal(diff.chronic.length, 1);
  assert.equal(diff.fresh.length, 1);
  assert.equal(diff.fresh[0].lane, "architecture-metrics");

  const report = formatReport(
    { id: 123, createdAt: "2026-08-17T00:00:00Z", headSha: "abcdef1234", conclusion: "failure" },
    diff,
    [{ lane: "visual-regression", sizeMb: 140 }],
  );
  assert.ok(report.includes("chronic  operator-proof"));
  assert.ok(report.includes("NEW      architecture-metrics"));
  assert.ok(report.includes("1 NEW signature(s)"));
  assert.ok(report.includes("skipped visual-regression"));
});

test("appendFreshToLedger drafts unclassified entries without mutating the input", () => {
  const ledger = { workflow: "W", signatures: [...LEDGER_ENTRIES] };
  const fresh = [{ lane: "architecture-metrics", scenarioId: "architecture.metrics.snapshot", text: "line count increased" }];
  const next = appendFreshToLedger(ledger, fresh, 123);
  assert.equal(next.signatures.length, 3);
  assert.equal(next.signatures[2].classification, "unclassified");
  assert.equal(ledger.signatures.length, 2, "input ledger must not be mutated");
});
