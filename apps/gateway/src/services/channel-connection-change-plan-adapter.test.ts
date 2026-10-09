import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import type {
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupValidationResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import type { ChangePlanRepositoryCreateInput } from "@goatcitadel/storage";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService } from "./evolution-control-plane-service.js";
import { CHANNEL_SLACK_OAUTH_METADATA_KEYS } from "./channel-oauth-draft-metadata.js";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
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


function reviewedSettingsFixture(overrides: Partial<ChannelSetupDraft> = {}) {
  const draft: ChannelSetupDraft = {
    draftId: "draft-1", revision: 9, catalogId: "channel.slack", lifecycleMode: "create", enabled: true,
    draft: {
      targets: [
        { label: "Primary", channel: "C123", threadTs: "1700.1", default: true },
        { label: "Secondary", channel: "C456", threadTs: "1700.2", default: false },
      ],
      defaultChannel: "C123", defaultThreadTs: "1700.1", inboundAccessMode: "allowlist",
      allowedSenders: ["U123", "U456"], authMode: "oauth", slackInstallId: "slack:T1:A1",
      slackTeamId: "T1", slackScopes: ["chat:write", "channels:read"],
    },
    secretState: { botToken: { configured: true, custody: "temporary" } },
    contentVersion: "1", adapterVersion: "1", validationVersion: "1", testVersion: "1",
    createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
    lastValidatedAt: "2026-10-08T00:01:00.000Z", lastTestedAt: "2026-10-08T00:02:00.000Z",
    ...overrides,
  };
  const deps = {
    getDefinition: vi.fn((id: string) => requireChannelSetupDefinition(id).definition),
    createDraft: vi.fn(async () => draft),
    getDraft: vi.fn(async () => draft),
    updateDraft: vi.fn(async () => draft),
    validateDraft: vi.fn(async (): Promise<ChannelSetupValidationResult> => ({ draftId: draft.draftId, draftRevision: draft.revision,
      status: "ok" as const, levels: [], issues: [], checkedAt: new Date().toISOString() })),
    finalizeDraft: vi.fn(), discardDraft: vi.fn(async () => true), getConnection: vi.fn(),
  };
  const ctx: EvolutionControlPlaneAdapterContext = { ...context(), origin: { surface: "settings", workspaceId: "workspace-channels" } };
  const adapter = new ChannelConnectionChangePlanAdapter(deps);
  return { draft, deps, ctx, adapter };
}
function slackRecord(revision = 9): ChangePlanRecord {
  return { ...record("awaiting_input", revision), request: { kind: "channel_connection", channelKind: "slack", draftId: "draft-1" } };
}

describe("Settings-origin exact channel review", () => {
  it("prepares a reviewed draft without re-entry, validation or mutation of structured routing and access", async () => {
    const { draft, deps, ctx, adapter } = reviewedSettingsFixture();
    const snapshot = structuredClone(draft);
    const prepared = await adapter.prepare(ctx, { kind: "channel_connection", channelKind: "slack", draftId: draft.draftId });
    expect(prepared).toMatchObject({ status: "awaiting_confirmation", target: { resourceId: draft.draftId, expectedRevision: 9 }, requiredAction: { kind: "confirmation" } });
    expect(prepared.requiredAction).not.toHaveProperty("fields");
    expect(draft).toEqual(snapshot);
    expect(deps.createDraft).not.toHaveBeenCalled();
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.validateDraft).not.toHaveBeenCalled();
    expect(deps.finalizeDraft).not.toHaveBeenCalled();
  });

  it.each([
    { lastValidatedAt: undefined, lastTestedAt: undefined },
    { lastValidatedAt: "2026-10-08T00:01:00.000Z", lastTestedAt: undefined },
    { lastValidatedAt: undefined, lastTestedAt: "2026-10-08T00:02:00.000Z" },
  ])("blocks an untested or unvalidated Settings draft without writing owner state", async (timestamps) => {
    const { draft, deps, ctx, adapter } = reviewedSettingsFixture(timestamps);
    const snapshot = structuredClone(draft);
    const prepared = await adapter.prepare(ctx, { kind: "channel_connection", channelKind: "slack", draftId: draft.draftId });
    expect(prepared.status).toBe("manual_required");
    expect(prepared.requiredAction).toBeUndefined();
    expect(prepared.result?.summary).toContain("checks in Channels");
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.validateDraft).not.toHaveBeenCalled();
    expect(deps.finalizeDraft).not.toHaveBeenCalled();
    expect(draft).toEqual(snapshot);
  });

  it("keeps the compatibility expected revision exact through pure plan preparation", async () => {
    const { draft, deps, adapter } = reviewedSettingsFixture();
    const adapters = new EvolutionControlPlaneAdapterRegistry();
    adapters.register(adapter);
    const create = vi.fn(async (input: ChangePlanRepositoryCreateInput) => ({ ...slackRecord(), ...input, revision: 1, planId: "plan-channel", evidenceRefs: [] }));
    const service = new EvolutionControlPlaneService({ adapters, repository: { create } as never });
    const input = { actor: { surface: "settings" as const, workspaceId: "workspace-channels", actorId: "operator" }, request: { kind: "channel_connection" as const, channelKind: "slack", draftId: draft.draftId } };
    await expect(service.create({ ...input, expectedTargetRevision: 8 })).rejects.toThrow("target changed");
    expect(create).not.toHaveBeenCalled();
    const prepared = await service.create({ ...input, expectedTargetRevision: 9 });
    expect(prepared.target.expectedRevision).toBe(9);
    expect(prepared.requiredAction?.kind).toBe("confirmation");
    expect(create).toHaveBeenCalledOnce();
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.validateDraft).not.toHaveBeenCalled();
    expect(draft.revision).toBe(9);
  });

  it("omits target cards, sender lists, arbitrary arrays and OAuth receipt fields from Chat scalar forms", async () => {
    const { draft, deps, adapter } = reviewedSettingsFixture();
    const baseDefinition = deps.getDefinition("channel.slack");
    deps.getDefinition.mockReturnValue({ ...baseDefinition, wizard: { ...baseDefinition.wizard, steps: [{ id: "fields", kind: "field-collection", title: "Values", fields: [
      { key: "defaultChannel", label: "Default", type: "text" },
      { key: "targets", label: "Targets", type: "target-list" },
      { key: "allowedSenders", label: "Senders", type: "sender-list" },
      { key: "legacyMembers", label: "Legacy members", type: "textarea" },
      ...CHANNEL_SLACK_OAUTH_METADATA_KEYS.map((key) => ({ key, label: key, type: "text" as const })),
    ] }] } });
    draft.draft.legacyMembers = ["U789"];
    const prepared = await adapter.prepare(context(), { kind: "channel_connection", channelKind: "slack", draftId: draft.draftId });
    expect(prepared.requiredAction?.kind).toBe("public_form");
    if (prepared.requiredAction?.kind !== "public_form") throw new Error("Expected public form");
    expect(prepared.requiredAction.fields.map((field) => field.fieldId)).toEqual(["defaultChannel"]);
    expect(JSON.stringify(prepared.requiredAction.fields)).not.toContain("[object Object]");
    expect(JSON.stringify(prepared.requiredAction.fields)).not.toContain("1700.1");
  });

  it.each(CHANNEL_SLACK_OAUTH_METADATA_KEYS)("rejects forged OAuth %s before the draft update owner is called", async (key) => {
    const { deps, ctx, adapter } = reviewedSettingsFixture();
    await expect(adapter.respond(ctx, slackRecord(), { [key]: "forged" })).rejects.toThrow("not registered");
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.validateDraft).not.toHaveBeenCalled();
  });

  it.each(["targets", "allowedSenders"])("rejects raw JSON text for structured %s without modifying its saved rows", async (key) => {
    const { draft, deps, ctx, adapter } = reviewedSettingsFixture();
    const snapshot = structuredClone(draft.draft);
    await expect(adapter.respond(ctx, slackRecord(), { [key]: "[]" })).rejects.toThrow("not registered");
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(draft.draft).toEqual(snapshot);
  });

  it("returns structured validation corrections to Channels instead of a scalar JSON prompt", async () => {
    const { draft, deps, adapter } = reviewedSettingsFixture();
    deps.validateDraft.mockResolvedValue({ draftId: draft.draftId, draftRevision: 9, status: "error", levels: [], issues: [{ key: "targets_required", level: "error", fieldKey: "targets", message: "Choose a destination" }], checkedAt: new Date().toISOString() });
    const result = await adapter.respond(context(), slackRecord(), { defaultChannel: "C789" });
    expect(result).toMatchObject({ status: "manual_required" });
    expect(result.requiredAction).toBeUndefined();
    expect(result.result?.summary).toContain("structured destinations");
  });
});


describe("Settings review summary", () => {
  it("shows exact public routing, defaults, normalized sender count and check times without secrets or endpoints", async () => {
    const f = reviewedSettingsFixture({ label: "Work Slack", enabled: false });
    Object.assign(f.draft.draft, {
      slackTeamName: "Sandbox workspace", slackAppId: "A1", slackBotUserId: "B1",
      allowedSenders: [" U123 ", "u123", "U456"],
      botToken: "private-bot-credential", signingSecret: "private-signing-credential",
      webhookUrl: "https://hooks.slack.com/services/T1/B1/private-webhook-credential",
      baseUrl: "https://private-server.example.test",
    });
    f.draft.secretState.botToken!.secretRef = "keychain:goatcitadel:channel-draft:private-custody-account";
    const snapshot = structuredClone(f.draft);
    const result = await f.adapter.prepare(f.ctx, { kind: "channel_connection", channelKind: "slack", draftId: f.draft.draftId });
    for (const value of ["Work Slack", "saved disabled", "draft revision 9", "Primary (C123), thread 1700.1, default", "Secondary (C456), thread 1700.2", "allowlist, 2 allowed senders", "Sandbox workspace (T1)", "app A1", "bot B1", "chat:write", "Validation recorded: 2026-10-08T00:01:00.000Z", "Live check recorded: 2026-10-08T00:02:00.000Z"]) {
      expect(result.summary).toContain(value);
    }
    for (const value of ["private-bot-credential", "private-signing-credential", "private-webhook-credential", "private-server.example.test", "private-custody-account", "keychain:", "https://"]) expect(result.summary).not.toContain(value);
    expect(f.draft).toEqual(snapshot);
    expect(f.deps.updateDraft).not.toHaveBeenCalled();
    expect(f.deps.validateDraft).not.toHaveBeenCalled();
  });

  it("retains a Telegram forum thread and explicit secondary default in a pure review", async () => {
    const f = reviewedSettingsFixture({ catalogId: "channel.telegram", label: "Forum bot", draft: {
      targets: [{ label: "Forum", chatId: "-100123", threadId: "23", default: false }, { label: "Updates", chatId: "@updates_room", threadId: "47", default: true }],
      inboundAccessMode: "allowlist", allowedSenders: ["777"],
    } });
    const snapshot = structuredClone(f.draft);
    const result = await f.adapter.prepare(f.ctx, { kind: "channel_connection", channelKind: "telegram", draftId: f.draft.draftId });
    expect(result.summary).toContain("Forum (-100123), thread 23");
    expect(result.summary).not.toContain("Forum (-100123), thread 23, default");
    expect(result.summary).toContain("Updates (@updates_room), thread 47, default");
    expect(result.summary).toContain("allowlist, 1 allowed sender");
    expect(f.draft).toEqual(snapshot);
  });

  it("uses actual Discord server/channel and policy fields rather than unrelated legacy flat flags", async () => {
    const f = reviewedSettingsFixture({ catalogId: "channel.discord", draft: {
      defaultGuildId: "987654321098765432", defaultChannelId: "123456789012345678", guildPolicy: "allowlist", inboundDmPolicy: "pairing", dmOnly: true,
    } });
    const result = await f.adapter.prepare(f.ctx, { kind: "channel_connection", channelKind: "discord", draftId: f.draft.draftId });
    expect(result.summary).toContain("987654321098765432");
    expect(result.summary).toContain("123456789012345678");
    expect(result.summary).toContain("pairing");
    expect(result.summary).toContain("allowlist");
    expect(result.summary).not.toContain("DM only");
  });

  it("identifies Discord DM-only from guildPolicy off and retains its pairing requirement", async () => {
    const f = reviewedSettingsFixture({ catalogId: "channel.discord", draft: { guildPolicy: "off", inboundDmPolicy: "pairing" } });
    const result = await f.adapter.prepare(f.ctx, { kind: "channel_connection", channelKind: "discord", draftId: f.draft.draftId });
    expect(result.summary).toContain("DM only");
    expect(result.summary).toContain("pairing");
  });

  it.each([
    ["nextcloud-talk", "defaultRoomId", "room-sandbox"],
    ["whatsapp", "defaultTarget", "+15551234567"],
    ["signal", "defaultRecipient", "+15557654321"],
    ["zalo", "defaultRecipientId", "oa-user-123"],
    ["imessage", "defaultHandle", "chat_guid:iMessage;-;+15551234567"],
  ])("shows the registered %s destination using its actual guided field", async (key, field, value) => {
    const f = reviewedSettingsFixture({ catalogId: "channel." + key, draft: { [field]: value } });
    const result = await f.adapter.prepare(f.ctx, { kind: "channel_connection", channelKind: key, draftId: f.draft.draftId });
    expect(result.summary).toContain(value);
  });

  it("redacts private endpoint and custody text even if pasted into a public target label", async () => {
    const f = reviewedSettingsFixture({ label: "Bot\nhttps://private-label.example.test/capability", draft: {
      targets: [{ label: "Ops keychain:goatcitadel:private-reference", channel: "C123", threadTs: "1700.1", default: true }],
    } });
    const result = await f.adapter.prepare(f.ctx, { kind: "channel_connection", channelKind: "slack", draftId: f.draft.draftId });
    expect(result.summary).toContain("C123");
    expect(result.summary).not.toMatch(/private-label|private-reference|keychain:|https:\/\//);
    expect(result.summary).not.toContain("\n");
  });
});

describe("Channel draft cancellation authority", () => {
  function serviceFixture(adapter: ChannelConnectionChangePlanAdapter, plan: ChangePlanRecord) {
    const adapters = new EvolutionControlPlaneAdapterRegistry();
    adapters.register(adapter);
    const transition = vi.fn(async () => ({ ...plan, status: "cancelled" as const, revision: plan.revision + 1 }));
    const service = new EvolutionControlPlaneService({ adapters, repository: { get: vi.fn(async () => plan), transition } as never });
    const actor = { surface: "chat" as const, workspaceId: "default", sessionId: "session-1", actorId: "operator" };
    return { service, actor, transition };
  }

  it("discards only the exact currently reviewed draft revision", async () => {
    const { draft, deps, ctx, adapter } = reviewedSettingsFixture();
    const plan = slackRecord(draft.revision);

    await adapter.discard(ctx, plan);

    expect(deps.getDraft).toHaveBeenCalledWith(plan.target.resourceId);
    expect(deps.discardDraft).toHaveBeenCalledExactlyOnceWith(draft.draftId, plan.target.expectedRevision);
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.finalizeDraft).not.toHaveBeenCalled();
  });

  it("retains a newer draft and does not record Evolution cancellation", async () => {
    const { draft, deps, ctx, adapter } = reviewedSettingsFixture({ revision: 10 });
    const snapshot = structuredClone(draft);
    const plan = slackRecord(9);
    await expect(adapter.discard(ctx, plan)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    const { service, actor, transition } = serviceFixture(adapter, plan);

    await expect(service.cancel(actor, plan.planId, plan.revision)).rejects.toThrow("newer draft was retained");

    expect(draft).toEqual(snapshot);
    expect(deps.discardDraft).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(plan.status).toBe("awaiting_input");
  });

  it.each([
    { name: "wrong owner", alter: (plan: ChangePlanRecord) => ({ ...plan, target: { ...plan.target, ownerId: "integration_connection" } }) },
    { name: "unreviewed revision", alter: (plan: ChangePlanRecord) => ({ ...plan, target: { ...plan.target, expectedRevision: undefined } }) },
    { name: "different channel kind", alter: (plan: ChangePlanRecord) => ({ ...plan, request: { kind: "channel_connection" as const, channelKind: "discord", draftId: "draft-1" } }) },
    { name: "non-channel request", alter: (plan: ChangePlanRecord) => ({ ...plan, request: { kind: "not_a_channel_plan" } as unknown as ChangePlanRecord["request"] }) },
  ])("does not discard a current draft bound to $name", async ({ alter }) => {
    const { deps, ctx, adapter } = reviewedSettingsFixture();
    await expect(adapter.discard(ctx, alter(slackRecord()))).rejects.toThrow();
    expect(deps.discardDraft).not.toHaveBeenCalled();
  });

  it.each([
    { name: "wrong target owner", alter: (plan: ChangePlanRecord) => ({ ...plan, target: { ...plan.target, ownerId: "integration_connection" } }) },
    { name: "non-channel request", alter: (plan: ChangePlanRecord) => ({ ...plan, request: { kind: "not_a_channel_plan" } as unknown as ChangePlanRecord["request"] }) },
    ...[undefined, 0, -1, 1.5].map((expectedRevision) => ({ name: "invalid reviewed revision " + String(expectedRevision), alter: (plan: ChangePlanRecord) => ({ ...plan, target: { ...plan.target, expectedRevision } }) })),
  ])("validates $name before accepting a missing owner as idempotent", async ({ alter }) => {
    const { deps, ctx, adapter } = reviewedSettingsFixture();
    deps.getDraft.mockRejectedValue(new NotFoundError({ entity: "channel_setup_draft", id: "draft-1" }));

    await expect(adapter.discard(ctx, alter(slackRecord()))).rejects.toThrow();

    expect(deps.getDraft).not.toHaveBeenCalled();
    expect(deps.discardDraft).not.toHaveBeenCalled();
  });

  it("treats a typed missing reviewed draft as idempotent cancellation", async () => {
    const { deps, ctx, adapter } = reviewedSettingsFixture();
    const plan = slackRecord();
    deps.getDraft.mockRejectedValue(new NotFoundError({ entity: "channel_setup_draft", id: plan.target.resourceId }));
    await expect(adapter.discard(ctx, plan)).resolves.toBeUndefined();
    const { service, actor, transition } = serviceFixture(adapter, plan);

    const cancelled = await service.cancel(actor, plan.planId, plan.revision);

    expect(cancelled.status).toBe("cancelled");
    expect(transition).toHaveBeenCalledOnce();
    expect(deps.discardDraft).not.toHaveBeenCalled();
  });

  it.each([
    new Error("Draft store unavailable"),
    Object.assign(new Error("Untyped missing-record response"), { code: "ENTITY_NOT_FOUND" }),
  ])("surfaces arbitrary draft fetch failures without deleting or recording cancellation", async (failure) => {
    const { deps, ctx, adapter } = reviewedSettingsFixture();
    const plan = slackRecord();
    deps.getDraft.mockRejectedValue(failure);
    await expect(adapter.discard(ctx, plan)).rejects.toBe(failure);
    const { service, actor, transition } = serviceFixture(adapter, plan);

    await expect(service.cancel(actor, plan.planId, plan.revision)).rejects.toBe(failure);

    expect(deps.discardDraft).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(plan.status).toBe("awaiting_input");
  });

  it.each([false, true])("propagates discard/custody failures with mutationCommitted=%s", async (mutationCommitted) => {
    const { deps, ctx, adapter } = reviewedSettingsFixture();
    const plan = slackRecord();
    const failure = Object.assign(new Error(mutationCommitted ? "Post-delete credential cleanup unavailable" : "Draft discard unavailable"), { mutationCommitted });
    deps.discardDraft.mockRejectedValue(failure);
    await expect(adapter.discard(ctx, plan)).rejects.toBe(failure);
    const { service, actor, transition } = serviceFixture(adapter, plan);
    const result = await service.cancel(actor, plan.planId, plan.revision).catch((error: unknown) => error);

    expect(result).toBe(failure);
    expect(result).toHaveProperty("mutationCommitted", mutationCommitted);
    expect(deps.discardDraft).toHaveBeenCalledWith("draft-1", 9);
    expect(transition).not.toHaveBeenCalled();
    expect(plan.status).toBe("awaiting_input");
  });
});
