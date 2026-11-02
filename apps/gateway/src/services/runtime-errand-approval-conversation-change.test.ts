import { describe, expect, it, vi } from "vitest";
import {
  ERRAND_APPROVAL_CONVERSATION_NOT_OWN,
  ValidationError,
  isChangePlanRequest,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import { createRuntimeConfigurationOwnerChecks } from "./gateway-route-composition-shared.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import { RuntimeConfigurationChangePlanAdapter } from "./runtime-configuration-change-plan-adapter.js";
import {
  applyErrandApprovalConversation,
  projectBrowserErrandSettings,
} from "./runtime-errand-approval-conversation-change.js";

const context = {
  origin: { surface: "settings", workspaceId: "default", actorId: "operator-1" },
  actions: {
    confirmation: (input: Record<string, unknown>) => ({
      kind: "confirmation",
      actionId: "action-1",
      actionNonce: "nonce-1",
      purpose: "apply",
      ...input,
    }),
    secureInput: () => {
      throw new Error("not used");
    },
  },
} as never;

const OWN_SESSION = "session-own-dm";
const GROUP_SESSION = "session-team";

const request = (approvalSessionId: string | null) => ({
  kind: "runtime_configuration" as const,
  change: { operation: "browser_errand_approval_conversation" as const, config: { approvalSessionId } },
});

/** A settings owner holding the pick the way the real one does, behind the one ownership check. */
function errandAdapter(initial?: string, titleOf?: (sessionId: string) => Promise<string | undefined>) {
  const isOwn = async (sessionId: string) => sessionId === OWN_SESSION;
  const assistant: { browserErrands?: { approvalSessionId?: string } } = initial
    ? { browserErrands: { approvalSessionId: initial } }
    : {};
  let revision = 7;
  const current = () => ({ revision, browserErrands: projectBrowserErrandSettings(assistant), features: {} }) as never;
  const updateSettings = vi.fn(async (input: { browserErrandApprovalSessionId?: string | null }) => {
    if (input.browserErrandApprovalSessionId !== undefined) {
      await applyErrandApprovalConversation(assistant, input.browserErrandApprovalSessionId, isOwn);
    }
    revision += 1;
    return current();
  });
  const adapter = new RuntimeConfigurationChangePlanAdapter({
    getSettings: async () => current(),
    updateSettings,
    hasTemporaryAuthCredential: async () => false,
    consumeTemporaryAuthCredential: async () => "",
    discardTemporaryAuthCredential: () => undefined,
    errandApprovalConversationTitle:
      titleOf ?? (async (sessionId) => ((await isOwn(sessionId)) ? "Me on Telegram" : undefined)),
  });
  return { adapter, updateSettings, assistant };
}

async function roundTrip(adapter: RuntimeConfigurationChangePlanAdapter, sessionId: string | null) {
  const prepared = await adapter.prepare(context, request(sessionId));
  const plan = {
    planId: "plan-1",
    request: request(sessionId),
    target: prepared.target,
  } as unknown as ChangePlanRecord;
  const applied = await adapter.apply(context, plan);
  const verified = await adapter.verify(context, plan);
  return { prepared, applied, verified };
}

describe("the browser errand approval conversation setting", () => {
  it("is a registered runtime operation whose shape is only a session id or null", () => {
    expect(isChangePlanRequest(request(OWN_SESSION))).toBe(true);
    expect(isChangePlanRequest(request(null))).toBe(true);
    expect(isChangePlanRequest(request(" padded "))).toBe(false);
    expect(isChangePlanRequest(request("bad\u0007id"))).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: {
          operation: "browser_errand_approval_conversation",
          config: { approvalSessionId: OWN_SESSION, extra: true },
        },
      }),
    ).toBe(false);
  });

  it("round-trips a pick of the operator's own private conversation through its plan", async () => {
    const { adapter, assistant } = errandAdapter();
    const { prepared, applied, verified } = await roundTrip(adapter, OWN_SESSION);

    expect(prepared).toMatchObject({
      target: { ownerId: "runtime_settings", resourceId: "browser_errand_approval_conversation", expectedRevision: 7 },
      summary: "Send waiting browser errand approvals to Me on Telegram",
      risk: "caution",
      status: "awaiting_confirmation",
      requiredAction: {
        kind: "confirmation",
        confirmationText: "Send waiting browser errand approvals to Me on Telegram",
      },
    });
    const completedSummary = "Waiting browser errand approvals now go to Me on Telegram.";
    expect(applied).toMatchObject({ status: "verifying", result: { summary: completedSummary } });
    expect(verified).toMatchObject({ status: "completed" });
    expect(assistant.browserErrands).toEqual({ approvalSessionId: OWN_SESSION });
  });

  it("completes with the plain fallback when the picked conversation's name can't be read after the write", async () => {
    let lookups = 0;
    const { adapter } = errandAdapter(undefined, async () => {
      lookups += 1;
      if (lookups > 1) throw new Error("binding store offline");
      return "Me on Telegram";
    });
    const { applied } = await roundTrip(adapter, OWN_SESSION);

    expect(applied).toMatchObject({
      result: { summary: "Waiting browser errand approvals now go to the conversation you picked." },
    });
  });

  it("refuses to prepare a group conversation with the one sentence, and never writes", async () => {
    const { adapter, updateSettings } = errandAdapter();
    const refusal = adapter.prepare(context, request(GROUP_SESSION));

    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toThrow(ERRAND_APPROVAL_CONVERSATION_NOT_OWN);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("refuses at apply too when the settings owner no longer finds the conversation the operator's own", async () => {
    const { adapter } = errandAdapter();
    const plan = {
      planId: "plan-1",
      request: request(GROUP_SESSION),
      target: { ownerId: "runtime_settings", resourceId: "browser_errand_approval_conversation", expectedRevision: 7 },
    } as unknown as ChangePlanRecord;

    await expect(adapter.apply(context, plan)).rejects.toThrow(ERRAND_APPROVAL_CONVERSATION_NOT_OWN);
  });

  it("clears the pick to empty, which the settings report as no conversation", async () => {
    const { adapter, assistant } = errandAdapter(OWN_SESSION);
    const { prepared, verified } = await roundTrip(adapter, null);

    expect(prepared).toMatchObject({
      summary: "Stop sending browser errand approvals to a channel",
      impact: "Waiting browser errand approvals still go to your phone.",
    });
    expect(verified).toMatchObject({ status: "completed" });
    expect(assistant.browserErrands).toBeUndefined();
    expect(projectBrowserErrandSettings(assistant)).toEqual({});
  });

  it("keeps the written copy free of banned cockpit words", async () => {
    const { adapter } = errandAdapter();
    for (const sessionId of [OWN_SESSION, null]) {
      const prepared = await adapter.prepare(context, request(sessionId));
      const copy = [prepared.title, prepared.summary, prepared.impact].join(" ");
      expect(copy).not.toMatch(/posture|gateway|revision|evidence|owner|snapshot|canonical|durable|projection|replay/i);
    }
  });

  it("the settings owner refuses every pick when it has no ownership check, and an empty pick clears", async () => {
    const assistant: { browserErrands?: { approvalSessionId?: string } } = {
      browserErrands: { approvalSessionId: OWN_SESSION },
    };
    await expect(applyErrandApprovalConversation(assistant, OWN_SESSION, undefined)).rejects.toThrow(
      ERRAND_APPROVAL_CONVERSATION_NOT_OWN,
    );
    await applyErrandApprovalConversation(assistant, "   ", undefined);
    expect(assistant.browserErrands).toBeUndefined();
  });
});

describe("the runtime configuration owner checks", () => {
  function port(conversation: unknown, options: { connectionMissing?: boolean } = {}) {
    return {
      storage: {
        chatSessionBindings: {
          get: async () => ({
            sessionId: OWN_SESSION,
            transport: "integration",
            connectionId: "conn-1",
            target: "chat-1",
            writable: true,
            conversation,
          }),
        },
        chatSessionMeta: { get: async () => undefined },
        sessions: { getBySessionId: async () => ({ channel: "telegram" }) },
        integrationConnections: {
          get: async () => {
            if (options.connectionMissing) {
              const { NotFoundError } = await import("@goatcitadel/contracts");
              throw new NotFoundError({ entity: "Integration connection", id: "conn-1" });
            }
            return {
              connectionId: "conn-1",
              key: "telegram",
              config: { ownerActorIds: ["owner-1"], telegramPairing: { approved: [{ actorId: "owner-1" }] } },
            };
          },
        },
      },
      readDiscordPairings: async () => [],
    } as unknown as GatewayRouteCompositionPort;
  }

  it("names the operator's own direct conversation and nothing else", async () => {
    const own = createRuntimeConfigurationOwnerChecks(() =>
      port({ kind: "direct", counterpartActorId: "owner-1", title: "Me" }),
    );
    const group = createRuntimeConfigurationOwnerChecks(() => port({ kind: "group", title: "Team" }));
    const gone = createRuntimeConfigurationOwnerChecks(() =>
      port({ kind: "direct", counterpartActorId: "owner-1" }, { connectionMissing: true }),
    );

    await expect(own.errandApprovalConversationTitle?.(OWN_SESSION)).resolves.toBe("Me on Telegram");
    await expect(group.errandApprovalConversationTitle?.(OWN_SESSION)).resolves.toBeUndefined();
    await expect(gone.errandApprovalConversationTitle?.(OWN_SESSION)).resolves.toBeUndefined();
  });
});
