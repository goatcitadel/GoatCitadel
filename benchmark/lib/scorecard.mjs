// Scorecard assembly + serialization (JSON + readable markdown).
//
// A scorecard records, per target, each scenario's status and evidence, plus a
// per-axis tally. The headline claim — "we beat OpenClaw + Hermes" — is rendered
// as a per-axis pass count that is only comparable where a competitor is actually
// configured; unconfigured competitors render "pending build" so the claim is
// honest about what has been measured vs what is wired-but-untested.

import fs from "node:fs";
import path from "node:path";
import { AXES, STATUS } from "./harness.mjs";
import { benchmarkRoot } from "./targets.mjs";

export const OUT_DIR = path.join(benchmarkRoot, "out");
export const SCORECARD_JSON = path.join(OUT_DIR, "scorecard.json");
export const SCORECARD_MD = path.join(OUT_DIR, "scorecard.md");

const STATUS_ICON = {
  [STATUS.PASS]: "PASS",
  [STATUS.FAIL]: "FAIL",
  [STATUS.SKIP]: "skip",
  [STATUS.ERROR]: "ERROR",
};

function emptyAxisTally() {
  const tally = {};
  for (const axis of AXES) {
    tally[axis] = { pass: 0, fail: 0, skip: 0, error: 0, total: 0 };
  }
  return tally;
}

/**
 * Build the in-memory scorecard object from raw results.
 * `results` is an array of { target, scenario, result } records.
 */
export function buildScorecard({ targets, scenarios, results, meta }) {
  const targetIds = [targets.goatcitadel.id, targets.openclaw.id, targets.hermes.id];
  const byTarget = {};

  for (const id of targetIds) {
    byTarget[id] = {
      id,
      kind: id === "goatcitadel" ? "primary" : "competitor",
      configured: targets[id].configured,
      skipReason: targets[id].skipReason ?? null,
      axisTally: emptyAxisTally(),
      scenarios: [],
    };
  }

  for (const { target, scenario, result } of results) {
    const bucket = byTarget[target.id];
    const axis = scenario.axis;
    bucket.axisTally[axis][result.status] += 1;
    bucket.axisTally[axis].total += 1;
    bucket.scenarios.push({
      id: scenario.id,
      axis,
      title: scenario.title,
      mode: scenario.mode,
      requiresEdges: scenario.requiresEdges,
      status: result.status,
      evidence: result.evidence,
      detail: result.detail ?? null,
    });
  }

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    meta,
    targetSource: targets.source,
    usingExampleDefaults: targets.usingExampleDefaults,
    scenarioCount: scenarios.length,
    targets: byTarget,
  };
}

function axisLine(tally) {
  return `${tally.pass} pass / ${tally.fail} fail / ${tally.skip} skip${tally.error ? ` / ${tally.error} error` : ""}`;
}

/** Render a markdown summary string. */
export function renderMarkdown(scorecard) {
  const lines = [];
  lines.push("# GoatCitadel head-to-head scorecard");
  lines.push("");
  lines.push(`- Generated: ${scorecard.generatedAt}`);
  lines.push(`- Targets source: \`${scorecard.targetSource}\``);
  lines.push(`- Scenarios: ${scorecard.scenarioCount}`);
  if (scorecard.meta?.gatewayReachable !== undefined) {
    lines.push(`- Gateway reachable: ${scorecard.meta.gatewayReachable ? "yes" : "no"}`);
  }
  lines.push("");

  // Per-axis headline table.
  lines.push("## Axis summary");
  lines.push("");
  lines.push("| Target | Configured | CAPABILITY | TRUST | RELIABILITY |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const target of Object.values(scorecard.targets)) {
    const t = target.axisTally;
    const configured = target.configured ? "yes" : "pending build";
    lines.push(
      `| ${target.id} | ${configured} | ${axisLine(t.CAPABILITY)} | ${axisLine(t.TRUST)} | ${axisLine(t.RELIABILITY)} |`,
    );
  }
  lines.push("");

  // Verdict line: only compare where competitors are configured.
  const gc = scorecard.targets.goatcitadel;
  const gcPass = AXES.reduce((sum, axis) => sum + gc.axisTally[axis].pass, 0);
  const competitors = [scorecard.targets.openclaw, scorecard.targets.hermes];
  const configuredCompetitors = competitors.filter((c) => c.configured);
  lines.push("## Verdict");
  lines.push("");
  lines.push(`- GoatCitadel passed **${gcPass}** scenario assertion(s).`);
  if (configuredCompetitors.length === 0) {
    lines.push(
      "- No competitor builds are configured yet, so the head-to-head delta is **pending**. " +
        "GoatCitadel's own TRUST/RELIABILITY proofs above stand on their own; drop OpenClaw/Hermes into " +
        "`benchmark/targets.json` to fill the comparison.",
    );
  } else {
    for (const competitor of configuredCompetitors) {
      const cPass = AXES.reduce((sum, axis) => sum + competitor.axisTally[axis].pass, 0);
      const delta = gcPass - cPass;
      const verb = delta > 0 ? "ahead of" : delta === 0 ? "tied with" : "behind";
      lines.push(`- GoatCitadel is **${verb}** ${competitor.id} (${gcPass} vs ${cPass}; Δ ${delta >= 0 ? "+" : ""}${delta}).`);
    }
  }
  lines.push("");

  // Per-target scenario detail.
  for (const target of Object.values(scorecard.targets)) {
    lines.push(`## ${target.id}`);
    if (!target.configured && target.skipReason) {
      lines.push("");
      lines.push(`> ${target.skipReason}`);
    }
    lines.push("");
    lines.push("| Scenario | Axis | Mode | Status | Evidence |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const s of target.scenarios) {
      const evidence = String(s.evidence ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${s.id} | ${s.axis} | ${s.mode} | ${STATUS_ICON[s.status] ?? s.status} | ${evidence} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Write both scorecard files, creating the out directory. Returns the paths. */
export function writeScorecard(scorecard) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SCORECARD_JSON, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  fs.writeFileSync(SCORECARD_MD, `${renderMarkdown(scorecard)}\n`, "utf8");
  return { json: SCORECARD_JSON, markdown: SCORECARD_MD };
}
