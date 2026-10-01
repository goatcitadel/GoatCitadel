import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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
