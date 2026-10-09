import { describe, expect, it, vi } from "vitest";
import { CHANNEL_INGRESS_ACCEPTED_REVISION_KEY } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { getChannelSetupJourney } from "./channel-setup-journey-service.js";
const revision = "a".repeat(64);
function fixture(key = "telegram", events: unknown[] = [], evidence: unknown[] = [], deliveries: unknown[] = []) { return { getIntegrationConnection: vi.fn(async () => ({ connectionId: "connection", revision, catalogId: "channel." + key, kind: "channel", key, status: "connected", enabled: true, config: key === "telegram" ? { botTokenEnv: "TELEGRAM_BOT_TOKEN", webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET", defaultChatId: "123", inboundAccessMode: "allowlist", allowedSenders: ["777"] } : { baseUrl: "https://ntfy.example", topic: "test" } })), storage: { inboundChannelEvents: { listByConnection: vi.fn(async () => events) }, channelSetupEvidence: { list: vi.fn(async () => evidence), get: vi.fn() } }, listChannelDeliveries: vi.fn(async () => deliveries) } as unknown as ChannelSetupHost; }
function event(overrides: Record<string, unknown> = {}) { return { eventId: "event", status: "completed", payload: { [CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]: revision, message: { content: "private message never projected" } }, dispatchKind: "agent_turn", acceptedAt: new Date().toISOString(), sessionId: "session", turnId: "turn", durableRunId: "run", deliveryId: "delivery", ...overrides }; }
describe("revision-bound channel journey", () => {
  it("requires an admitted authorized event and its exact linked sent reply", async () => { const journey = await getChannelSetupJourney(fixture("telegram", [event()], [], [{ deliveryId: "delivery", status: "sent", providerMessageId: "receipt", updatedAt: new Date().toISOString() }]), "connection"); expect(journey.states).toMatchObject({ inbound: "verified", reply: "verified", outbound: "verified", access: "verified", credentials: "verified", destination: "verified" }); expect(journey.latestReply?.providerMessageId).toBe("receipt"); expect(JSON.stringify(journey)).not.toContain("private message"); });
  it.each([event({ payload: { [CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]: "b".repeat(64) } }), event({ status: "suppressed" }), event({ status: "accepted", turnId: undefined, durableRunId: undefined })])("does not complete a setup from stale, suppressed or not-yet-admitted ingress", async (input) => { const journey = await getChannelSetupJourney(fixture("telegram", [input], [], [{ deliveryId: "delivery", status: "sent", updatedAt: new Date().toISOString() }]), "connection"); expect(journey.states.inbound).toBe("pending"); expect(journey.states.reply).toBe("pending"); });
  it("retains an uncertain reply as unknown", async () => { const journey = await getChannelSetupJourney(fixture("telegram", [event({ status: "manual_reconciliation_required" })], [], [{ deliveryId: "delivery", status: "manual_reconciliation_required", updatedAt: new Date().toISOString() }]), "connection"); expect(journey.states.reply).toBe("unknown"); });
  it.each(["failed", "unknown_after_send", "queued"])("retains first-conversation completion while showing the actual newest %s reply", async (status) => {
    const journey = await getChannelSetupJourney(fixture("telegram", [event({ eventId: "newest", deliveryId: "newest-delivery" }), event()], [], [
      { deliveryId: "delivery", status: "sent", providerMessageId: "older-receipt", updatedAt: "2026-10-09T03:00:00.000Z" },
      { deliveryId: "newest-delivery", status, updatedAt: "2026-10-09T03:01:00.000Z" },
    ]), "connection");
    expect(journey.states.reply).toBe("verified");
    expect(journey.latestReply?.deliveryId).toBe("newest-delivery");
    expect(journey.latestReply?.providerMessageId).toBeUndefined();
    expect(journey.latestReplyState).toBe(status === "failed" ? "failed" : status === "unknown_after_send" ? "unknown" : "pending");
  });
  it("does not present an older receipt as the reply to new pending ingress", async () => {
    const journey = await getChannelSetupJourney(fixture("telegram", [event({ eventId: "newest", turnId: undefined, durableRunId: undefined, deliveryId: undefined }), event()], [], [
      { deliveryId: "delivery", status: "sent", providerMessageId: "older-receipt", updatedAt: new Date().toISOString() },
    ]), "connection");
    expect(journey.states.reply).toBe("verified");
    expect(journey.latestReplyState).toBe("pending");
    expect(journey.latestReply).toBeUndefined();
  });
  it("never promotes ntfy dry-run to published or inbound proof", async () => { const journey = await getChannelSetupJourney(fixture("ntfy", [], [{ evidenceId: "proof", phase: "activation", connectionRevision: revision, probe: { mode: "dry_run", steps: [{ key: "ntfy_sandbox_send", status: "skipped", disposition: "deferred" }] } }]), "connection"); expect(journey.states).toMatchObject({ inbound: "unsupported", reply: "unsupported", outbound: "pending" }); });
});
