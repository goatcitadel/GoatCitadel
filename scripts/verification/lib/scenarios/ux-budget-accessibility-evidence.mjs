import path from "node:path";

export const ACCESSIBILITY_EVIDENCE_BYTE_LIMIT = 8 * 1024 * 1024;
const loadCanonicalRedactor = () => import("../../../../packages/contracts/dist/secret-redaction.js");
const serializeJson = (value) => JSON.stringify(value, null, 2) + "\n";
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

function auditCounts(audit) {
  if (!Array.isArray(audit?.violations)) throw new Error("Invalid audit projection");
  const perRule = audit.violations.map((rule, index) => ({ index, expectedNodes: Array.isArray(rule.nodes) ? rule.nodes.length : 0 }));
  return { expectedViolations: audit.violations.length,
    expectedNodes: perRule.reduce((total, rule) => total + rule.expectedNodes, 0), perRule };
}
function gapEnvelope(identity, counts, reason) {
  return { schemaVersion: 1, ...identity, complete: false, gapReason: reason,
    counts: { expectedViolations: counts.expectedViolations, writtenViolations: 0, expectedNodes: counts.expectedNodes, writtenNodes: 0 },
    omittedRuleCount: counts.perRule.length };
}
function stripUrlDetails(value) {
  if (typeof value !== "string" || !value) return "";
  try { const url = new URL(value); return url.origin + url.pathname; }
  catch { return "[INVALID_URL]"; }
}
function omitInputValues(html) {
  return html.replace(/(\s)value\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '$1value="[OMITTED_INPUT_VALUE]"')
    .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea\s*>)/giu, "$1[OMITTED_INPUT_VALUE]$2");
}

/** Persists only a bounded, canonical-redacted projection of the caller's exact audit; never runs axe. */
export async function captureAccessibilityEvidence(input, { writeJson, loadRedactor = loadCanonicalRedactor, serialize = JSON.stringify }) {
  const { scenarioId, variant, phase, artifactRoot } = input;
  if (!["desktop", "mobile"].includes(variant) || phase !== "document-review" ||
    scenarioId !== "ux-budgets.cockpit-inbox-document-proposal." + variant || typeof artifactRoot !== "string" || !artifactRoot) {
    throw new Error("Invalid accessibility evidence identity");
  }
  const identity = { scenarioId, variant, phase };
  const relativePath = "diagnostics/" + scenarioId + "-document-review-axe.json";
  const file = path.join(artifactRoot, ...relativePath.split("/"));
  let counts = { expectedViolations: null, expectedNodes: null, perRule: [] };
  let payload; let gapReason; let bytes;
  try { counts = auditCounts(input.audit); }
  catch { gapReason = "audit_projection"; }
  let redactSecretText;
  if (!gapReason) {
    try { ({ redactSecretText } = await loadRedactor()); if (typeof redactSecretText !== "function") throw new Error(); }
    catch { gapReason = "redactor_unavailable"; }
  }
  if (!gapReason) {
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /(?:TOKEN|(?:^|_)KEY(?:_|$)|SECRET|PASSWORD|CREDENTIAL)/iu.test(name)));
      const secrets = [...new Set([...Object.values(env), ...(input.sensitiveValues ?? [])].filter((value) => typeof value === "string" && value))]
        .sort((a, b) => b.length - a.length);
      const text = (value) => {
        let protectedText = typeof value === "string" ? value : "";
        if (/<(?:input|textarea)\b/iu.test(protectedText)) protectedText = omitInputValues(protectedText);
        for (const secret of secrets) protectedText = protectedText.split(secret).join("[REDACTED]");
        const result = redactSecretText(protectedText, { env });
        if (typeof result?.value !== "string") throw new Error("Invalid redactor result");
        return result.value;
      };
      const target = (value) => Array.isArray(value) ? value.map(target) : typeof value === "string" ? text(value.replace(/\[value\s*=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\]/giu, '[value="[OMITTED_INPUT_VALUE]"]')) : "[UNSUPPORTED_TARGET]";
      const audit = input.audit;
      payload = { schemaVersion: 1, ...identity, complete: true,
        workspaceId: text(input.workspaceId), proposalId: text(input.proposalId),
        viewport: { width: finiteNumber(input.viewport?.width), height: finiteNumber(input.viewport?.height) },
        overflow: { pass: input.overflow?.pass === true, overflow: finiteNumber(input.overflow?.overflow) },
        testEngine: { name: text(audit.testEngine?.name), version: text(audit.testEngine?.version) },
        testRunner: { name: text(audit.testRunner?.name) },
        testEnvironment: { userAgent: text(audit.testEnvironment?.userAgent), windowWidth: finiteNumber(audit.testEnvironment?.windowWidth), windowHeight: finiteNumber(audit.testEnvironment?.windowHeight) },
        url: text(stripUrlDetails(audit.url)), timestamp: text(audit.timestamp),
        counts: { expectedViolations: counts.expectedViolations, writtenViolations: counts.expectedViolations, expectedNodes: counts.expectedNodes, writtenNodes: counts.expectedNodes },
        violations: audit.violations.map((rule) => ({ id: text(rule.id), impact: text(rule.impact),
          tags: (rule.tags ?? []).map(text), description: text(rule.description), help: text(rule.help), helpUrl: text(stripUrlDetails(rule.helpUrl)),
          expectedNodes: Array.isArray(rule.nodes) ? rule.nodes.length : 0, writtenNodes: Array.isArray(rule.nodes) ? rule.nodes.length : 0,
          nodes: (rule.nodes ?? []).map((node) => ({ impact: text(node.impact), target: target(node.target),
            html: text(omitInputValues(typeof node.html === "string" ? node.html : "")), failureSummary: text(node.failureSummary) })) })) };
    } catch { gapReason = "redaction_failure"; }
  }
  if (!gapReason) {
    try {
      const serialized = serialize(payload, null, 2);
      if (typeof serialized !== "string" || serialized !== JSON.stringify(payload, null, 2)) throw new Error("Invalid serializer result");
      bytes = Buffer.byteLength(serialized + "\n");
      if (bytes > ACCESSIBILITY_EVIDENCE_BYTE_LIMIT) gapReason = "byte_limit";
    } catch { gapReason = "serialization_failure"; }
  }
  if (gapReason) { payload = gapEnvelope(identity, counts, gapReason); bytes = Buffer.byteLength(serializeJson(payload)); }
  try {
    await writeJson(file, payload);
    return { complete: !gapReason, gapReason, relativePath, bytes, counts: payload.counts };
  } catch {
    // Writer errors are never echoed: a fixed safe envelope may still be recorded by a recovering writer.
    const gap = gapEnvelope(identity, counts, "write_failure");
    try {
      await writeJson(file, gap);
      return { complete: false, gapReason: "write_failure", relativePath, bytes: Buffer.byteLength(serializeJson(gap)), counts: gap.counts };
    } catch {
      return { complete: false, gapReason: "write_failure", counts: gap.counts };
    }
  }
}
