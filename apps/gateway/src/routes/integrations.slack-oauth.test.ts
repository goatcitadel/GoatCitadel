import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ValidationError } from "@goatcitadel/contracts";
import { registerSlackOAuthIntegrationRoutes } from "./integrations-slack-oauth-routes.js";

const draftId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const attempt = { attemptId, provider: "slack", workspaceId: "workspace-a", draftId, draftRevision: 7,
  revision: 3, status: "ready", expiresAt: new Date(Date.now() + 600000).toISOString(),
  install: { installId: "slack:T123:A123", teamId: "T123", teamName: "Workspace", appId: "A123", botUserId: "U123", scopes: ["chat:write"] } };
let app: FastifyInstance;
function fixture() {
  app = Fastify();
  app.decorateRequest("authActorId", "operator-a");
  const services = {
    channelSetup: {
      startSlackOAuthAttempt: vi.fn(async () => ({ configured: true, mode: "self_owned", scopes: ["chat:write"], missing: [], authorizationUrl: "https://slack.com/oauth/v2/authorize?state=bound", state: "bound", attempt: { ...attempt, status: "pending", revision: 1 } })),
      getChannelOAuthAttempt: vi.fn(async () => attempt),
      completeSlackOAuthAttempt: vi.fn(async () => attempt),
      adoptSlackOAuthAttempt: vi.fn(async () => ({ draft: { draftId, revision: 8, secretState: { botToken: { configured: true, custody: "temporary" } } }, attempt: { ...attempt, status: "adopted" } })),
      cancelChannelOAuthAttempt: vi.fn(async () => ({ ...attempt, status: "cancelled" })),
      recoverInterruptedChannelOAuthAttempts: vi.fn(async () => {}),
      cleanupChannelOAuthAttempts: vi.fn(async () => {}),
    },
    integrations: { createIntegrationConnection: vi.fn(), updateIntegrationConnection: vi.fn(), listIntegrationConnections: vi.fn() },
  };
  app.decorate("services", services as never);
  registerSlackOAuthIntegrationRoutes(app);
  return services;
}
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });
describe("scoped staged Slack OAuth routes", () => {
  it("rejects the old unbound start and forwards exact actor/workspace/draft bindings", async () => {
    const s = fixture();
    expect((await app.inject({ method: "POST", url: "/api/v1/integrations/slack/oauth/start" })).statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: "/api/v1/integrations/slack/oauth/start",
      payload: { workspaceId: "workspace-a", draftId, expectedRevision: 7 } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(s.channelSetup.startSlackOAuthAttempt).toHaveBeenCalledWith(
      { actorId: "operator-a", workspaceId: "workspace-a" }, { workspaceId: "workspace-a", draftId, expectedRevision: 7 }, expect.any(Object));
    expect(s.channelSetup.recoverInterruptedChannelOAuthAttempts).toHaveBeenCalledOnce();
  });
  it("polls only the exact initiated receipt and lists redacted OAuth installs in readiness", async () => {
    const s = fixture();
    const base = { kind: "channel", key: "slack", enabled: true, status: "connected", createdAt: "2026-05-02T00:00:00.000Z", updatedAt: "2026-05-02T00:00:00.000Z" };
    s.integrations.listIntegrationConnections.mockResolvedValue([
      { ...base, connectionId: "33333333-3333-4333-8333-333333333333", catalogId: "channel.slack", label: "Slack - Citadel",
        config: { authMode: "oauth", botToken: "xoxb-secret", slackInstallId: "slack:T123", slackTeamId: "T123", slackTeamName: "Citadel", slackScopes: "chat:write channels:read" } },
      { ...base, connectionId: "44444444-4444-4444-8444-444444444444", catalogId: "channel.slack", label: "Token Slack", config: { authMode: "bot_token", botToken: "xoxb-other" } },
      { ...base, connectionId: "55555555-5555-4555-8555-555555555555", catalogId: "channel.discord", key: "discord", label: "Discord", config: { authMode: "oauth", botToken: "discord-secret" } },
    ]);
    const response = await app.inject({ method: "GET", url: `/api/v1/integrations/slack/oauth/status?workspaceId=workspace-a&attemptId=${attemptId}` });
    expect(response.json()).toEqual(attempt);
    expect(s.channelSetup.getChannelOAuthAttempt).toHaveBeenCalledWith(
      { actorId: "operator-a", workspaceId: "workspace-a" }, { workspaceId: "workspace-a", attemptId });
    expect((await app.inject({ method: "GET", url: `/api/v1/integrations/slack/oauth/status?attemptId=${attemptId}` })).statusCode).toBe(400);
    expect(s.integrations.listIntegrationConnections).not.toHaveBeenCalled();
    const readiness = await app.inject({ method: "GET", url: "/api/v1/integrations/slack/oauth/status" });
    expect(readiness.statusCode).toBe(200);
    expect(s.integrations.listIntegrationConnections).toHaveBeenCalledExactlyOnceWith("channel", 300);
    expect(readiness.json().connections).toHaveLength(1);
    expect(readiness.json().connections[0]).toMatchObject({
      connection: { connectionId: "33333333-3333-4333-8333-333333333333", config: { authMode: "oauth", botToken: "[REDACTED]" } },
      install: { installId: "slack:T123", teamId: "T123", teamName: "Citadel", scopes: ["chat:write", "channels:read"] },
    });
    expect(readiness.json()).toMatchObject({ scopes: expect.any(Array), missing: expect.any(Array) });
    expect(readiness.json().state).toBeUndefined();
    expect(readiness.body).not.toContain("xoxb-secret");
    expect(readiness.body).not.toContain("xoxb-other");
    expect(readiness.body).not.toContain("discord-secret");
  });
  it("callbacks stage success/denial receipts and never create or replace active connections", async () => {
    const s = fixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/integrations/slack/oauth/callback?state=signed&code=once" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(attempt);
    expect(s.channelSetup.completeSlackOAuthAttempt).toHaveBeenCalledWith("signed", expect.any(Object), "once", false);
    await app.inject({ method: "GET", url: "/api/v1/integrations/slack/oauth/callback?state=signed&error=access_denied" });
    expect(s.channelSetup.completeSlackOAuthAttempt).toHaveBeenLastCalledWith("signed", expect.any(Object), undefined, true);
    expect(s.integrations.createIntegrationConnection).not.toHaveBeenCalled();
    expect(s.integrations.updateIntegrationConnection).not.toHaveBeenCalled();
    expect(response.body).not.toContain("secretRef");
  });
  it("uses explicit adoption and escapes callback HTML without a secret-bearing popup message", async () => {
    const s = fixture();
    const adopted = await app.inject({ method: "POST", url: "/api/v1/integrations/slack/oauth/adopt",
      payload: { workspaceId: "workspace-a", draftId, expectedRevision: 7, attemptId } });
    expect(adopted.statusCode).toBe(200);
    expect(s.channelSetup.adoptSlackOAuthAttempt).toHaveBeenCalledWith(
      { actorId: "operator-a", workspaceId: "workspace-a" }, { workspaceId: "workspace-a", draftId, expectedRevision: 7, attemptId }, expect.any(Function));
    s.channelSetup.completeSlackOAuthAttempt.mockResolvedValueOnce({ ...attempt, install: { ...attempt.install, teamName: "<script>bad</script>" } });
    const html = await app.inject({ method: "GET", url: "/api/v1/integrations/slack/oauth/callback?state=signed&code=code", headers: { accept: "text/html" } });
    expect(html.body).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html.body).not.toContain("<script>bad");
    expect(html.body).toContain("ready for review");
    expect(html.body).not.toContain("postMessage");
  });
  it("returns bounded domain errors for invalid callbacks", async () => {
    const s = fixture();
    s.channelSetup.completeSlackOAuthAttempt.mockRejectedValueOnce(new ValidationError({ message: "Invalid or expired Slack OAuth state." }));
    const response = await app.inject({ method: "GET", url: "/api/v1/integrations/slack/oauth/callback?state=invalid&code=code" });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("client-secret");
  });
});