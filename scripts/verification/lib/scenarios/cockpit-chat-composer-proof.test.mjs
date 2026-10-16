import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { setImmediate } from "node:timers";
import {
  assertComposerConfirmation,
  assertComposerPlan,
  assertComposerSelectedScope,
  assertComposerTurn,
  assertUploadedAttachment,
  COMPOSER_SCHEMA,
  composerPackMarkdown,
} from "./cockpit-chat-composer-evidence.mjs";
import {
  currentConversationId,
  observePendingWait,
  selectComposerConversation,
} from "./cockpit-chat-composer-proof.mjs";

const digest = (content) => createHash("sha256").update(content).digest("hex");
const expected = {
  sessionId: "session-a",
  workspaceId: "workspace-a",
  fileName: "fixture.txt",
  mimeType: "text/plain",
  content: "Synthetic content.",
};
const attachment = {
  ...expected,
  attachmentId: "attachment-retained",
  sizeBytes: Buffer.byteLength(expected.content),
  sha256: digest(expected.content),
  extractStatus: "ready",
};
const prefs = {
  sessionId: "session-a",
  revision: 4,
  providerId: "provider-b",
  model: "model-b",
  thinkingLevel: "deep",
};
const invocation = {
  ownerKind: "prompt_pack",
  ownerId: "pack-a",
  ownerRevision: "2026-09-30T12:00:00Z",
  templateId: "test-a",
  schemaHash: "a".repeat(64),
  values: { count: 2, concise: true },
};
function turnInput() {
  const content = "Typed synthetic request.";
  return {
    sessionId: "session-a",
    content,
    attachments: [attachment],
    removedId: "attachment-removed",
    prefs,
    invocation,
    turn: {
      turnId: "turn-a",
      userMessage: {
        sessionId: "session-a",
        content,
        attachments: [
          {
            attachmentId: attachment.attachmentId,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      },
      trace: {
        sessionId: "session-a",
        status: "completed",
        model: prefs.model,
        thinkingLevel: prefs.thinkingLevel,
        routing: {
          primaryProviderId: prefs.providerId,
          runVariables: {
            ...invocation,
            bindings: invocation.values,
            resolvedInputHash: digest(content),
            bindingsHash: "b".repeat(64),
          },
        },
      },
    },
  };
}
it("checks canonical attachment identity, scope and content hash", () => {
  assert.doesNotThrow(() => assertUploadedAttachment(attachment, expected));
  for (const change of [
    { sessionId: "foreign" },
    { workspaceId: "foreign" },
    { fileName: "foreign.txt" },
    { sha256: "f".repeat(64) },
    { sizeBytes: 0 },
    { extractStatus: "failed" },
    { attachmentId: "" },
  ]) {
    assert.throws(() => assertUploadedAttachment({ ...attachment, ...change }, expected));
  }
});
it("requires persisted turn bindings rather than browser chip text", () => {
  assert.doesNotThrow(() => assertComposerTurn(turnInput()));
  const input = turnInput();
  input.turn.userMessage.attachments[0].attachmentId = input.removedId;
  assert.throws(() => assertComposerTurn(input));
});
it("rejects extra/removed attachments, metadata changes and foreign turn scope", () => {
  for (const mutate of [
    (input) =>
      input.turn.userMessage.attachments.push({
        ...input.turn.userMessage.attachments[0],
        attachmentId: "attachment-removed",
      }),
    (input) => {
      input.turn.userMessage.attachments[0].sizeBytes += 1;
    },
    (input) => {
      input.turn.userMessage.sessionId = "foreign";
    },
    (input) => {
      input.turn.trace.sessionId = "foreign";
    },
  ]) {
    const input = turnInput();
    mutate(input);
    assert.throws(() => assertComposerTurn(input));
  }
});
it("rejects uncompleted turns and mismatched executed provider/model/effort", () => {
  for (const mutate of [
    (input) => {
      input.turn.trace.status = "failed";
    },
    (input) => {
      input.turn.trace.model = "old-model";
    },
    (input) => {
      input.turn.trace.thinkingLevel = "standard";
    },
    (input) => {
      input.turn.trace.routing.primaryProviderId = "foreign";
    },
  ]) {
    const input = turnInput();
    mutate(input);
    assert.throws(() => assertComposerTurn(input));
  }
});
it("rejects stale template evidence, stringified typed values and forged resolved input", () => {
  for (const change of [
    { ownerRevision: "old" },
    { schemaHash: "f".repeat(64) },
    { templateId: "foreign" },
    { bindings: { count: "2", concise: "true" } },
    { resolvedInputHash: "f".repeat(64) },
  ]) {
    const input = turnInput();
    Object.assign(input.turn.trace.routing.runVariables, change);
    assert.throws(() => assertComposerTurn(input));
  }
});
function planInput() {
  const before = { ...prefs, revision: 3, providerId: "provider-a", model: "model-a" };
  const patch = { providerId: prefs.providerId, model: prefs.model };
  return {
    sessionId: "session-a",
    workspaceId: "workspace-a",
    before,
    after: prefs,
    patch,
    plan: {
      kind: "session_model",
      origin: { sessionId: "session-a", workspaceId: "workspace-a" },
      request: { kind: "session_model", ...patch },
    },
  };
}
it("accepts an exact scoped session-model plan and newer matching owner receipt", () => {
  assert.doesNotThrow(() => assertComposerPlan(planInput()));
});
it("rejects cross-session plans, stale receipts and widened preference changes", () => {
  const foreign = planInput();
  foreign.plan.origin.sessionId = "foreign";
  assert.throws(() => assertComposerPlan(foreign));
  const stale = planInput();
  stale.after = { ...stale.after, revision: stale.before.revision };
  assert.throws(() => assertComposerPlan(stale));
  const changed = planInput();
  changed.after = { ...changed.after, thinkingLevel: "ultra" };
  assert.throws(() => assertComposerPlan(changed));
});
it("authors an importable typed schema before the test body, without capability authority", () => {
  const source = composerPackMarkdown();
  const schema = JSON.parse(source.match(/```goatcitadel-variables\n([\s\S]+?)\n```/u)[1]);
  assert.deepEqual(schema, COMPOSER_SCHEMA);
  assert.deepEqual(
    schema.fields.map((field) => field.type),
    ["text", "number", "boolean", "select"],
  );
  assert.ok(source.indexOf("```goatcitadel-variables") < source.indexOf("## TEST-91"));
  assert.doesNotMatch(source, /capabilityProfile|frozenSnapshot|callableCatalog/u);
});
it("switches the real conversation list without replacing the browser document", async () => {
  for (const layout of ["desktop", "phone"]) {
    const clicks = [];
    let sheetOpen = false;
    const locator = (path) => {
      const self = {
        or: () => locator([...path, "or"]),
        filter: () => self,
        first: () => self,
        waitFor: async () => {},
        isVisible: async () =>
          path[0] === "complementary:Conversations"
            ? layout === "desktop"
            : path[0] === "dialog:Conversations"
              ? layout === "phone" && sheetOpen
              : layout === "phone" && !sheetOpen,
        getByRole: (role, options) => locator([...path, [role, options]]),
        click: async () => {
          clicks.push(path);
          if (path[0] === "button:Conversations") sheetOpen = true;
        },
      };
      return self;
    };
    const page = {
      goto() {
        throw new Error("Document navigation bypasses the SPA scope persistence contract");
      },
      getByRole: (role, options) => {
        assert.equal(options.exact, true);
        return locator([`${role}:${options.name}`]);
      },
    };
    const session = { sessionId: "exact-session-id", title: "Composer [literal].title" };
    await selectComposerConversation(page, session);
    if (layout === "phone") assert.deepEqual(clicks.shift(), ["button:Conversations"]);
    assert.equal(clicks.length, 1);
    const [root, [navRole, navOptions], [rowRole, rowOptions]] = clicks[0];
    assert.equal(root, layout === "desktop" ? "complementary:Conversations" : "dialog:Conversations");
    assert.deepEqual([navRole, navOptions], ["navigation", { name: "Conversations", exact: true }]);
    assert.equal(rowRole, "button");
    assert.ok(rowOptions.name.test(`${session.title}2m agoactive`));
    assert.ok(!rowOptions.name.test("Composer ltitle"));
  }
});
it("maps the list's current row back to exactly one fixture conversation", () => {
  const sessions = [
    { sessionId: "a", title: "Composer x1" },
    { sessionId: "b", title: "Other composer x1" },
  ];
  assert.equal(currentConversationId("Composer x12m ago", sessions), "a");
  assert.equal(currentConversationId("Other composer x1just now", sessions), "b");
  assert.match(currentConversationId(null, sessions), /^unresolved:/u);
  assert.match(currentConversationId("Unrelated", sessions), /^unresolved:/u);
});
it("requires controlled session selection and the exact canonical thread in the same browser document", () => {
  const value = {
    requestedId: "session-b",
    selectedId: "session-b",
    threadId: "session-b",
    documentBefore: 123,
    documentAfter: 123,
  };
  assert.doesNotThrow(() => assertComposerSelectedScope(value));
  for (const change of [{ selectedId: "session-a" }, { threadId: "session-a" }, { documentAfter: 456 }]) {
    assert.throws(() => assertComposerSelectedScope({ ...value, ...change }));
  }
});

it("requires exact confirmation nonce/revision and independently read terminal plan", () => {
  const plan = {
    ...planInput().plan,
    planId: "plan-a",
    revision: 2,
    status: "awaiting_confirmation",
    requiredAction: { kind: "confirmation", actionNonce: "exact-owner-issued-nonce" },
  };
  const request = {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    expectedRevision: 2,
    actionNonce: plan.requiredAction.actionNonce,
  };
  const receipt = { ...plan, status: "completed", revision: 3, requiredAction: undefined };
  const value = { plan, request, receipt, owner: structuredClone(receipt) };
  assertComposerConfirmation(value);
  for (const patch of [
    { actionNonce: "foreign" },
    { expectedRevision: 1 },
    { sessionId: "foreign" },
    { workspaceId: "foreign" },
    { model: "unreviewed" },
  ])
    assert.throws(() => assertComposerConfirmation({ ...value, request: { ...request, ...patch } }));
  for (const patch of [
    { status: "awaiting_confirmation" },
    { planId: "foreign" },
    { revision: 2 },
    { request: { ...plan.request, thinkingLevel: "ultra" } },
  ]) {
    const changed = { ...receipt, ...patch };
    assert.throws(() => assertComposerConfirmation({ ...value, receipt: changed, owner: structuredClone(changed) }));
  }
  assert.throws(() => assertComposerConfirmation({ ...value, owner: plan }));
});

it("observes pending wait rejection immediately while preserving its exact awaited error", async () => {
  const error = new Error("Synthetic response wait failed");
  const pending = observePendingWait(Promise.reject(error));
  // node:test fails on an unhandled rejection during this action-sized gap.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(pending, (cause) => cause === error);
  assert.equal(await observePendingWait(Promise.resolve("canonical response")), "canonical response");
});
it("allows an action failure to reach cleanup while its outstanding wait rejects", async () => {
  let reject;
  const actionError = new Error("Synthetic selection failed");
  let cleaned = false;
  await assert.rejects(
    async () => {
      observePendingWait(
        new Promise((_, fail) => {
          reject = fail;
        }),
      );
      try {
        throw actionError;
      } finally {
        cleaned = true;
        reject(new Error("Page closed during cleanup"));
      }
    },
    (cause) => cause === actionError,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, true);
});
