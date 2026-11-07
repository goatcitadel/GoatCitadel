import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

const COMPOSER_A11Y_BYTES = 64 * 1024;
const composerA11yCounts = audit => {
  assert.ok(Array.isArray(audit?.violations), "Invalid composer audit");
  return { expectedRules: audit.violations.length, expectedNodes: audit.violations.reduce((sum, rule) => sum + (Array.isArray(rule.nodes) ? rule.nodes.length : 0), 0) };
};
const composerA11yGap = (identity, counts, gapReason) => ({ schemaVersion: 1, ...identity, complete: false, gapReason,
  temporalRelation: "immediately_after_same_audit_before_assert_no_actions",
  counts: { ...counts, writtenRules: 0, writtenNodes: 0, omittedRules: counts.expectedRules, omittedNodes: counts.expectedNodes, unresolvedNodes: 0 }, violations: [] });

/** Closed metadata projection of the caller's exact audit. Never invokes axe or stores HTML/body. */
export async function projectComposerAccessibilityEvidence({ audit, observations = [], variant, phase, observationGap = false }) {
  assert.ok(["desktop", "mobile"].includes(variant) && ["ready-to-send", "completed"].includes(phase));
  const identity = { scenarioId: `ux-budgets.cockpit-chat-composer.${variant}`, variant, phase };
  const expected = composerA11yCounts(audit);
  let gapReason = observationGap ? "observation_failure" : null;
  const gap = reason => { gapReason ??= reason; };
  const safeTarget = (value, depth = 0) => {
    if (depth > 8) { gap("target_projection"); return "[TARGET_OMITTED]"; }
    if (Array.isArray(value)) {
      if (value.length > 8) gap("target_projection");
      return value.slice(0, 8).map(item => safeTarget(item, depth + 1));
    }
    if (typeof value !== "string" || value.length > 512) { gap("target_projection"); return "[TARGET_OMITTED]"; }
    const clean = value.replace(/\[(?:value|href|src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\]/giu, "[ATTRIBUTE_OMITTED]")
      .replace(/https?:\/\/[^\s"'\]]+/giu, "[URL_OMITTED]");
    if (clean !== value) gap("target_projection");
    return clean;
  };
  const measured = new Map();
  for (const row of observations.slice(0, 128)) {
    if (!Number.isInteger(row?.ruleIndex) || !Number.isInteger(row?.nodeIndex)) { gap("observation_failure"); continue; }
    const key = `${row.ruleIndex}:${row.nodeIndex}`;
    if (measured.has(key)) { measured.set(key, null); gap("observation_failure"); } else measured.set(key, row);
  }
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const counts = { ...expected, writtenRules: 0, writtenNodes: 0, omittedRules: 0, omittedNodes: 0, unresolvedNodes: 0 };
  const violations = [];
  for (const [ruleIndex, rule] of audit.violations.slice(0, 32).entries()) {
    const nodes = [];
    const originals = Array.isArray(rule.nodes) ? rule.nodes : [];
    if (!Array.isArray(rule.nodes)) gap("invalid_audit_nodes");
    for (const [nodeIndex, node] of originals.slice(0, Math.max(0, 128 - counts.writtenNodes)).entries()) {
      const row = measured.get(`${ruleIndex}:${nodeIndex}`);
      const resolved = row?.resolved === true && /^[A-Z][A-Z0-9-]{0,63}$/u.test(row.tagName ?? "") &&
        ["x", "y", "width", "height"].every(key => finite(row.rect?.[key])) &&
        ["scrollWidth", "scrollHeight", "clientWidth", "clientHeight"].every(key => finite(row.scroll?.[key]) && row.scroll[key] >= 0) &&
        Number.isInteger(row.tabIndex) && Number.isInteger(row.focusableChildCount) && row.focusableChildCount >= 0 && row.focusableChildCount <= 512;
      const projected = { target: safeTarget(node.target), resolved };
      if (resolved) Object.assign(projected, { tagName: row.tagName, role: typeof row.role === "string" && /^[a-z][a-z-]{0,40}$/u.test(row.role) ? row.role : null,
        rect: Object.fromEntries(["x", "y", "width", "height"].map(key => [key, row.rect[key]])),
        scroll: Object.fromEntries(["scrollWidth", "scrollHeight", "clientWidth", "clientHeight"].map(key => [key, row.scroll[key]])), tabIndex: row.tabIndex, focusableChildCount: row.focusableChildCount });
      else { counts.unresolvedNodes++; gap("unresolved_target"); }
      nodes.push(projected); counts.writtenNodes++;
    }
    const ruleId = typeof rule.id === "string" && /^[a-z0-9-]{1,128}$/u.test(rule.id) ? rule.id : "[INVALID_RULE]";
    if (ruleId === "[INVALID_RULE]") gap("invalid_audit_rule");
    violations.push({ id: ruleId, impact: ["minor", "moderate", "serious", "critical"].includes(rule.impact) ? rule.impact : "unknown", nodes });
    counts.writtenRules++;
  }
  counts.omittedRules = counts.expectedRules - counts.writtenRules;
  counts.omittedNodes = counts.expectedNodes - counts.writtenNodes;
  if (counts.omittedRules || counts.omittedNodes) gap("projection_limit");
  let payload = { schemaVersion: 1, ...identity, complete: !gapReason, gapReason,
    temporalRelation: "immediately_after_same_audit_before_assert_no_actions", counts, violations };
  try {
    const { redactStructuredSecrets } = await import("../../../../packages/contracts/dist/secret-redaction.js");
    const redacted = redactStructuredSecrets(payload, { env: process.env, envValueReplacement: () => "[REDACTED]" });
    payload = redacted.value;
    if (redacted.redactionCount > 0) { payload.complete = false; payload.gapReason ??= "redacted_target"; }
    if (Buffer.byteLength(JSON.stringify(payload, null, 2) + "\n") > COMPOSER_A11Y_BYTES) return composerA11yGap(identity, expected, "byte_limit");
    return payload;
  } catch { return composerA11yGap(identity, expected, "redaction_failure"); }
}

export async function captureComposerAccessibilityEvidence(input, { artifactRoot, writeJson }) {
  const identity = { scenarioId: `ux-budgets.cockpit-chat-composer.${input.variant}`, variant: input.variant, phase: input.phase };
  assert.ok(["desktop", "mobile"].includes(input.variant) && ["ready-to-send", "completed"].includes(input.phase));
  const relativePath = `diagnostics/cockpit-chat-composer-${input.variant}-${input.phase}-axe.json`;
  let payload;
  try { payload = await projectComposerAccessibilityEvidence(input); }
  catch { payload = composerA11yGap(identity, { expectedRules: 0, expectedNodes: 0 }, "projection_failure"); }
  try {
    await writeJson(path.join(artifactRoot, relativePath), payload);
    return { complete: payload.complete, gapReason: payload.gapReason, relativePath, counts: payload.counts };
  } catch { return { complete: false, gapReason: "write_failure", relativePath: null,
    counts: { ...payload.counts, writtenRules: 0, writtenNodes: 0, omittedRules: payload.counts.expectedRules, omittedNodes: payload.counts.expectedNodes } }; }
}

export const COMPOSER_SCHEMA = {
  version: "goatcitadel.run-variables.v1",
  fields: [
    { id: "topic", label: "Proof topic", type: "text", required: true },
    { id: "count", label: "Proof count", type: "number", required: true, minimum: 1, maximum: 3 },
    { id: "concise", label: "Proof concise", type: "boolean", default: false },
    {
      id: "style",
      label: "Proof style",
      type: "select",
      required: true,
      options: [
        { value: "plain", label: "Plain" },
        { value: "formal", label: "Formal" },
      ],
    },
  ],
};
export const COMPOSER_TEMPLATE =
  "Composer proof topic={{topic}}; count={{count}}; concise={{concise}}; style={{style}}.";

export function composerPackMarkdown() {
  return [
    "# Composer variable proof",
    "",
    "```goatcitadel-variables",
    JSON.stringify(COMPOSER_SCHEMA),
    "```",
    "",
    "## TEST-91: Typed composer proof",
    COMPOSER_TEMPLATE,
    "",
  ].join("\n");
}

export function assertComposerSelectedScope({ requestedId, selectedId, threadId, documentBefore, documentAfter }) {
  assert.equal(selectedId, requestedId, "The controlled conversation selector shows a different session");
  assert.equal(threadId, requestedId, "The loaded canonical thread belongs to a different session");
  assert.equal(documentAfter, documentBefore, "Conversation selection unexpectedly replaced the browser document");
}

export function assertUploadedAttachment(record, expected) {
  assert.ok(record?.attachmentId, "Upload has no canonical attachment ID");
  for (const key of ["sessionId", "workspaceId", "fileName", "mimeType"]) {
    assert.equal(record[key], expected[key], `Upload ${key} differs from the requested scope/file`);
  }
  assert.equal(record.sizeBytes, Buffer.byteLength(expected.content));
  assert.equal(record.sha256, createHash("sha256").update(expected.content).digest("hex"));
  assert.equal(record.extractStatus, "ready", "Text attachment was not extracted by the owner");
}

/** PNG extraction is unsupported; OCR may settle only queued -> unsupported without changing receipt identity. */
export function assertUploadedBinaryAttachment(record,expected,canonical,downloadedBytes){
  assert.ok(record?.attachmentId,"Binary upload has no positive receipt");
  for(const field of ["sessionId","workspaceId","fileName","mimeType"])assert.equal(record[field],expected[field],`Binary receipt ${field} differs from admitted owner/file`);
  assert.equal(record.mimeType,"image/png");assert.equal(record.extractStatus,"unsupported");
  assert.equal(record.sizeBytes,expected.bytes.length);assert.equal(record.sha256,createHash("sha256").update(expected.bytes).digest("hex"));
  assert.deepEqual(Buffer.from(downloadedBytes),Buffer.from(expected.bytes),"Binary owner content differs from admitted PNG bytes");
  const {analysisStatus:before,...immutable}=record,{analysisStatus:after,...owner}=canonical;
  assert.deepEqual(owner,immutable,"Canonical binary owner differs from immutable receipt");
  assert.ok((before==="queued"&&["queued","unsupported"].includes(after))||(before==="unsupported"&&after==="unsupported"),"Unsupported binary analysis state or backslide");
}

export function assertComposerTurn({ turn, sessionId, content, attachments, removedId, prefs, invocation }) {
  assert.equal(turn?.userMessage?.sessionId, sessionId);
  assert.equal(turn.userMessage.content, content);
  const sent = turn.userMessage.attachments ?? [];
  assert.deepEqual(sent.map((item) => item.attachmentId).sort(), attachments.map((item) => item.attachmentId).sort());
  assert.ok(!sent.some((item) => item.attachmentId === removedId), "Removed attachment leaked into the turn");
  for (const attachment of attachments) {
    const item = sent.find((entry) => entry.attachmentId === attachment.attachmentId);
    for (const key of ["fileName", "mimeType", "sizeBytes"]) assert.equal(item[key], attachment[key]);
  }
  assert.equal(turn.trace?.sessionId, sessionId);
  assert.equal(turn.trace?.status, "completed", "Turn did not complete on the canonical owner");
  assert.equal(turn.trace.thinkingLevel, prefs.thinkingLevel);
  assert.equal(turn.trace.model, prefs.model);
  assert.equal(turn.trace.routing?.primaryProviderId, prefs.providerId);
  if (invocation) {
    const evidence = turn.trace.routing?.runVariables;
    for (const key of ["ownerKind", "ownerId", "ownerRevision", "templateId", "schemaHash"]) {
      assert.equal(evidence?.[key], invocation[key], `Canonical run variable ${key} mismatch`);
    }
    assert.deepEqual(evidence.bindings, invocation.values);
    assert.equal(evidence.resolvedInputHash, createHash("sha256").update(content).digest("hex"));
    assert.match(evidence.bindingsHash, /^[a-f0-9]{64}$/u);
  }
}

export function assertComposerPlan({ plan, workspaceId, sessionId, before, patch, after }) {
  assert.equal(plan?.kind, "session_model");
  assert.equal(plan.origin?.workspaceId, workspaceId);
  assert.equal(plan.origin?.sessionId, sessionId);
  assert.equal(plan.request?.kind, "session_model");
  for (const [key, value] of Object.entries(patch)) assert.equal(plan.request[key], value);
  if (after) {
    assert.equal(after.sessionId, sessionId);
    assert.ok(after.revision > before.revision, "Confirmed preferences did not advance their owner revision");
    for (const key of ["providerId", "model", "thinkingLevel"]) {
      assert.equal(after[key], patch[key] ?? before[key], `Saved ${key} differs from the exact reviewed change`);
    }
  }
}

export function assertComposerConfirmation({ plan, request, receipt, owner }) {
  assert.equal(plan.status, "awaiting_confirmation");
  assert.equal(plan.requiredAction?.kind, "confirmation");
  assert.ok(plan.requiredAction.actionNonce);
  assert.deepEqual(
    request,
    {
      workspaceId: plan.origin.workspaceId,
      sessionId: plan.origin.sessionId,
      ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}),
      expectedRevision: plan.revision,
      actionNonce: plan.requiredAction.actionNonce,
    },
    "Confirmation must use the exact scoped review revision and server-issued nonce.",
  );
  assert.deepEqual(receipt, owner, "Confirmation receipt differs from an independent canonical plan read.");
  assert.equal(owner.planId, plan.planId);
  assert.equal(owner.status, "completed");
  assert.ok(owner.revision > plan.revision);
  assert.deepEqual(owner.origin, plan.origin);
  assert.deepEqual(owner.request, plan.request);
}
