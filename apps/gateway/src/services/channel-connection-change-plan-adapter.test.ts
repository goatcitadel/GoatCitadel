import { describe, expect, it, vi } from "vitest";
import type {
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { ChannelConnectionChangePlanAdapter } from "./channel-connection-change-plan-adapter.js";
import type { EvolutionControlPlaneAdapterContext } from "./evolution-control-plane-adapter.js";

const definition = {
  catalog: { catalogId: "channel.test", label: "Test Channel" },
  adapter: { adapterVersion: "1", secretFieldKeys: ["botToken"] },
  wizard: {
    steps: [
      {
        fields: [
          { key: "channelId", label: "Channel ID", type: "id", required: true, explanation: "Destination channel." },
          {
            key: "botToken",
            label: "Bot token",
            type: "secret",
            required: true,
            explanation: "Channel credential.",
            sensitive: true,
          },
        ],
      },
    ],
  },
} as ChannelSetupDefinition;

function context(): EvolutionControlPlaneAdapterContext {
  let sequence = 0;
  const base = (kind: ChangePlanRequiredAction["kind"], title: string) => ({
    kind,
    title,
    actionId: `action-${++sequence}`,
    actionNonce: `nonce-${sequence}-1234567890123456`,
  });
  return {
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1" },
    actions: {
      confirmation: (input) => ({
        ...base("confirmation", input.title),
        confirmationText: input.confirmationText,
        purpose: input.purpose ?? "apply",
      }),
      publicForm: (input) => ({
        ...base("public_form", input.title),
        fields: input.fields,
        submitLabel: input.submitLabel,
      }),
      secureInput: (input) => ({
        ...base("secure_input", input.title),
        targetId: input.targetId,
        expiresAt: input.expiresAt,
        fields: input.fields,
      }),
      oauth: (input) => ({ ...base("oauth", input.title), targetId: input.targetId }),
      nativePathPicker: (input) => ({
        ...base("native_path_picker", input.title),
        purpose: "managed_source_registration",
      }),
      approval: (input) => ({ ...base("approval", input.title), risk: input.risk, approvalId: input.approvalId }),
      artifactReview: (input) => ({ ...base("artifact_review", input.title), artifactRefs: input.artifactRefs }),
    },
  } as EvolutionControlPlaneAdapterContext;
}

function record(
  status: ChangePlanRecord["status"],
  targetRevision: number,
  requiredAction?: ChangePlanRequiredAction,
): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1" },
    adapter: { adapterId: "channel-connection", version: 1 },
    kind: "channel_connection",
    scope: "channel",
    status,
    phase: status === "awaiting_input" ? "input" : status === "awaiting_confirmation" ? "confirmation" : "mutation",
    revision: 1,
    request: { kind: "channel_connection", channelKind: "test", draftId: "draft-1" },
    intentHash: "intent-hash",
    target: { ownerId: "channel_setup_draft", resourceId: "draft-1", expectedRevision: targetRevision },
    title: "Connect Test Channel",
    summary: "Configure channel.",
    impact: "Runs a live test.",
    risk: "caution",
    requiredAction,
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("ChannelConnectionChangePlanAdapter", () => {
  it("keeps public details, secure custody, confirmation, and finalization as distinct phases", async () => {
    let draft: ChannelSetupDraft | undefined = {
      draftId: "draft-1",
      revision: 1,
      catalogId: "channel.test",
      lifecycleMode: "create",
      enabled: true,
      draft: {},
      secretState: {},
      contentVersion: "1",
      adapterVersion: "1",
      validationVersion: "1",
      testVersion: "1",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    let connection: IntegrationConnection | undefined;
    const adapter = new ChannelConnectionChangePlanAdapter({
      getDefinition: () => definition,
      createDraft: vi.fn(async () => draft!),
      getDraft: vi.fn(async () => {
        if (!draft) throw new Error("missing draft");
        return draft;
      }),
      updateDraft: vi.fn(async (_draftId, input) => {
        if (!draft || draft.revision !== input.expectedRevision) throw new Error("stale draft");
        draft = { ...draft, revision: draft.revision + 1, draft: input.draft ?? draft.draft };
        return draft;
      }),
      validateDraft: vi.fn(async (_draftId, expectedRevision) => {
        if (!draft || draft.revision !== expectedRevision) throw new Error("stale validation");
        const issues = !draft.draft.channelId
          ? [
              {
                key: "channel_required",
                level: "error" as const,
                message: "Channel ID is required.",
                fieldKey: "channelId",
              },
            ]
          : !draft.secretState.botToken?.configured
            ? [
                {
                  key: "token_required",
                  level: "error" as const,
                  message: "Bot token is required.",
                  fieldKey: "botToken",
                },
              ]
            : [];
        draft = { ...draft, revision: draft.revision + 1 };
        return {
          draftId: draft.draftId,
          draftRevision: draft.revision,
          status: issues.length ? "error" : "ok",
          levels: ["structural"],
          issues,
          checkedAt: "2026-08-13T00:01:00.000Z",
        };
      }),
      finalizeDraft: vi.fn(async (_draftId, expectedRevision) => {
        if (!draft || draft.revision !== expectedRevision) throw new Error("stale finalize");
        connection = {
          connectionId: "connection-1",
          catalogId: "channel.test",
          kind: "channel",
          key: "test",
          label: "Test Channel",
          enabled: true,
          status: "connected",
          config: { channelId: draft.draft.channelId, botToken: "opaque:keychain-ref" },
          createdAt: "2026-08-13T00:02:00.000Z",
          updatedAt: "2026-08-13T00:02:00.000Z",
        };
        const finalRevision = draft.revision;
        draft = undefined;
        return {
          draftRevision: finalRevision,
          connection,
          validation: {
            draftId: "draft-1",
            draftRevision: finalRevision,
            status: "ok",
            levels: ["structural"],
            issues: [],
            checkedAt: "2026-08-13T00:02:00.000Z",
          },
          test: {
            draftId: "draft-1",
            draftRevision: finalRevision,
            status: "ok",
            levels: ["live-auth"],
            issues: [],
            checkedAt: "2026-08-13T00:02:00.000Z",
          },
        };
      }),
      discardDraft: vi.fn(async () => true),
      getConnection: vi.fn(async () => {
        if (!connection) throw new Error("missing connection");
        return connection;
      }),
    });
    const ctx = context();
    const prepared = await adapter.prepare(ctx, {
      kind: "channel_connection",
      channelKind: "test",
      draftId: "draft-1",
    });
    expect(prepared.requiredAction?.kind).toBe("public_form");

    const publicOutcome = await adapter.respond(ctx, record("awaiting_input", 1, prepared.requiredAction), {
      channelId: "room-1",
    });
    expect(publicOutcome.requiredAction?.kind).toBe("secure_input");
    expect(publicOutcome.target?.expectedRevision).toBe(3);
    expect(JSON.stringify(publicOutcome)).not.toContain("bot-token-value");

    draft = {
      ...draft!,
      revision: 4,
      secretState: { botToken: { configured: true, custody: "temporary", secretRef: "keychain:opaque" } },
    };
    const secureOutcome = await adapter.resumeOwnerInput(
      ctx,
      record("awaiting_input", 3, publicOutcome.requiredAction),
      {
        actionId: publicOutcome.requiredAction!.actionId,
        actionKind: "secure_input",
        ownerId: "channel_setup_secret",
        ownerResourceId: "draft-1",
        ownerRevision: 4,
      },
    );
    expect(secureOutcome.requiredAction?.kind).toBe("confirmation");
    expect(secureOutcome.target?.expectedRevision).toBe(5);

    const applyOutcome = await adapter.apply(ctx, record("applying", 5, secureOutcome.requiredAction));
    expect(applyOutcome.status).toBe("verifying");
    expect(applyOutcome.evidenceRefs).toContain("channel-connection:connection-1");
    expect(JSON.stringify(applyOutcome)).not.toContain("bot-token-value");

    const verified = await adapter.verify(ctx, {
      ...record("verifying", 5),
      evidenceRefs: applyOutcome.evidenceRefs ?? [],
      result: applyOutcome.result,
    });
    expect(verified.status).toBe("completed");
  });
});
