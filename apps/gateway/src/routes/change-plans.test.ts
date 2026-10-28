import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { SemanticValidationError } from "@goatcitadel/contracts";
import { registerChangePlanRoutes } from "./change-plans.js";

function build(evolution: Record<string, unknown>) {
  const app = Fastify();
  app.decorateRequest("authActorId", "operator-test");
  app.decorate("services", { evolution } as never);
  registerChangePlanRoutes(app);
  return app;
}

describe("Change Plan resource routes", () => {
  it("binds monitoring verification to actor scope and the supplied revision", async () => {
    const verifyMonitoringPlan = vi.fn(async () => ({ planId: "plan-1", status: "completed", revision: 6 }));
    const app = build({ verifyMonitoringPlan });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-1/verifications",
      payload: { workspaceId: "default", expectedRevision: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(verifyMonitoringPlan).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "default", actorId: "operator-test" }),
      "plan-1",
      5,
    );
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-1/verifications",
      payload: { workspaceId: "default", expectedRevision: 5, actorId: "another-operator" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(verifyMonitoringPlan).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it("creates only a bounded typed plan intent", async () => {
    const create = vi.fn(async () => ({ planId: "plan-1", status: "awaiting_confirmation", revision: 1 }));
    const app = build({ create });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans",
      payload: {
        workspaceId: "default",
        sessionId: "session-1",
        request: { kind: "session_model", providerId: "openai", model: "gpt-5", thinkingLevel: "extended" },
        idempotencyKey: "turn-1:tool-1",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ workspaceId: "default", sessionId: "session-1", actorId: "operator-test" }),
        request: { kind: "session_model", providerId: "openai", model: "gpt-5", thinkingLevel: "extended" },
        idempotencyKey: "turn-1:tool-1",
      }),
    );
    await app.close();
  });

  // A Capabilities plan is the operator's own install, so only a server-owned Capabilities route may start one.
  it("refuses a Capabilities origin on the generic create route", async () => {
    const create = vi.fn(async () => ({ planId: "plan-1", status: "awaiting_confirmation", revision: 1 }));
    const app = build({ create });
    const payload = (surface: string) => ({
      workspaceId: "default",
      surface,
      request: { kind: "session_model", providerId: "openai", model: "gpt-5" },
    });

    const refused = await app.inject({ method: "POST", url: "/api/v1/change-plans", payload: payload("capabilities") });
    expect(refused.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const settings = await app.inject({ method: "POST", url: "/api/v1/change-plans", payload: payload("settings") });
    expect(settings.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ surface: "settings" }) }),
    );
    await app.close();
  });

  // Only the operator's Capabilities install route may start one; the adapter also refuses any other origin.
  it("refuses a connector install on the generic create route", async () => {
    const create = vi.fn(async () => ({ planId: "plan-1", status: "awaiting_confirmation", revision: 1 }));
    const app = build({ create });

    for (const surface of ["chat", "settings"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/change-plans",
        payload: {
          workspaceId: "default",
          surface,
          request: { kind: "connector_install", templateId: "linear", enableChatConnectors: true },
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects paths, patches, arbitrary settings, and secret-like extra fields before service entry", async () => {
    const create = vi.fn();
    const app = build({ create });
    for (const request of [
      { kind: "managed_source_registration", path: "F:/code/personal-ai" },
      { kind: "product_source_update", sourceInstallId: "install-1", patch: "diff --git" },
      { kind: "runtime_configuration", key: "anything", value: true },
      { kind: "provider_connection", providerId: "openai", apiKey: "secret" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/change-plans", payload: { request } });
      expect(response.statusCode).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts typed operator write-root and tool-posture intents and rejects extra fields", async () => {
    const create = vi.fn(async () => ({ planId: "plan-1", status: "awaiting_confirmation", revision: 1 }));
    const app = build({ create });
    for (const change of [
      { operation: "operator_write_root", action: "add", path: "/srv/scratch", allowDelete: true, label: "Scratch" },
      { operation: "operator_write_root", action: "remove", preset: "os_temp" },
      { operation: "tool_global_access", toolName: "fs.delete", posture: "available" },
      { operation: "tool_group_access", groupId: "files", enabled: false },
      { operation: "tool_group_access", groupId: "messaging", enabled: true },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/change-plans",
        payload: { request: { kind: "runtime_configuration", change } },
      });
      expect(response.statusCode).toBe(201);
      expect(create).toHaveBeenLastCalledWith(
        expect.objectContaining({ request: { kind: "runtime_configuration", change } }),
      );
    }
    for (const change of [
      { operation: "operator_write_root", action: "add", path: "relative/dir" },
      { operation: "operator_write_root", action: "add", path: "/srv", writeJailRoots: ["/"] },
      { operation: "operator_write_root", action: "add", preset: "home" },
      { operation: "tool_global_access", toolName: "shell.exec", posture: "available" },
      { operation: "tool_global_access", toolName: "fs.write", posture: "available", agentId: "main" },
      { operation: "tool_group_access", groupId: "core", enabled: false },
      { operation: "tool_group_access", groupId: "nope", enabled: false },
      { operation: "tool_group_access", groupId: "files" },
      { operation: "tool_group_access", groupId: "files", enabled: false, agentId: "main" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/change-plans",
        payload: { request: { kind: "runtime_configuration", change } },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(create).toHaveBeenCalledTimes(5);
    await app.close();
  });

  it("binds confirmation to the supplied plan revision and action nonce", async () => {
    const confirm = vi.fn(async () => ({ planId: "plan-1", revision: 4, status: "completed" }));
    const app = build({ confirm });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-1/confirmations",
      payload: { workspaceId: "default", sessionId: "session-1", expectedRevision: 3, actionNonce: "1234567890abcdef" },
    });
    expect(response.statusCode).toBe(200);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "default", sessionId: "session-1" }),
      "plan-1",
      3,
      "1234567890abcdef",
    );
    await app.close();
  });

  it("projects semantic validation as 422", async () => {
    const create = vi.fn(async () => {
      throw new SemanticValidationError("The requested model is unavailable.", { alternatives: ["gpt-5-mini"] });
    });
    const app = build({ create });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans",
      payload: { request: { kind: "installation_default_model", providerId: "openai", model: "missing-model" } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "FIELD_INVALID", details: { alternatives: ["gpt-5-mini"] } });
    await app.close();
  });

  it("keeps dedicated provider credential responses no-store and outside the generic plan service", async () => {
    const submitSecret = vi.fn(async () => ({ planId: "plan-1", status: "awaiting_confirmation", revision: 2 }));
    const app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorate("services", {
      evolution: {},
      evolutionProviderConnection: { submitSecret },
    } as never);
    registerChangePlanRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-1/provider-secret",
      payload: {
        workspaceId: "default",
        sessionId: "session-1",
        expectedRevision: 1,
        actionId: "action-1",
        actionNonce: "1234567890abcdef",
        apiKey: "credential-value-must-not-be-projected",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.body).not.toContain("credential-value-must-not-be-projected");
    expect(submitSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-1",
        expectedRevision: 1,
        actionNonce: "1234567890abcdef",
      }),
    );
    await app.close();
  });

  it("binds OAuth start and poll to the exact no-store Change Plan owner routes", async () => {
    const startOAuth = vi.fn(async () => ({
      flowId: "flow-1",
      providerId: "openai-codex",
      verificationUrl: "https://auth.openai.com/oauth/authorize",
      expiresAt: "2026-08-14T12:00:00.000Z",
      pollAfterMs: 5_000,
    }));
    const pollOAuth = vi.fn(async () => ({
      flowId: "flow-1",
      providerId: "openai-codex",
      status: "connected",
      accountLabel: "operator@example.com",
    }));
    const app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorate("services", {
      evolution: {},
      evolutionProviderConnection: { startOAuth, pollOAuth },
    } as never);
    registerChangePlanRoutes(app);
    const exact = {
      workspaceId: "default",
      sessionId: "session-1",
      expectedRevision: 2,
      actionId: "oauth-action",
      actionNonce: "1234567890abcdef",
    };
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-oauth/provider-oauth-starts",
      payload: exact,
    });
    const polled = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-oauth/provider-oauth-polls",
      payload: { ...exact, flowId: "flow-1" },
    });
    expect(started.statusCode).toBe(200);
    expect(polled.statusCode).toBe(200);
    expect(started.headers["cache-control"]).toBe("no-store");
    expect(polled.headers["cache-control"]).toBe("no-store");
    expect(startOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-oauth",
        expectedRevision: 2,
        actionNonce: "1234567890abcdef",
      }),
    );
    expect(pollOAuth).toHaveBeenCalledWith(expect.objectContaining({ flowId: "flow-1" }));
    expect(started.body).not.toContain("credentialAccount");
    expect(polled.body).not.toContain("accessToken");
    await app.close();
  });

  it("keeps multi-field channel credentials on the dedicated no-store owner route", async () => {
    const submitSecrets = vi.fn(async () => ({ planId: "plan-2", status: "awaiting_confirmation", revision: 3 }));
    const app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorate("services", {
      evolution: {},
      evolutionChannelConnection: { submitSecrets },
    } as never);
    registerChangePlanRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-2/channel-secrets",
      payload: {
        workspaceId: "default",
        sessionId: "session-1",
        expectedRevision: 2,
        actionId: "action-2",
        actionNonce: "1234567890abcdef",
        values: { botToken: "channel-secret", signingSecret: "signing-secret" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("channel-secret");
    expect(response.body).not.toContain("signing-secret");
    expect(submitSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-2",
        values: { botToken: "channel-secret", signingSecret: "signing-secret" },
      }),
    );
    await app.close();
  });

  it("keeps native source paths on the dedicated no-store owner route", async () => {
    const submitSelection = vi.fn(async () => ({
      planId: "plan-source",
      status: "awaiting_confirmation",
      revision: 2,
    }));
    const app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorate("services", { evolution: {}, evolutionManagedSource: { submitSelection } } as never);
    registerChangePlanRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/change-plans/plan-source/managed-source-selections",
      payload: {
        workspaceId: "default",
        sessionId: "session-1",
        expectedRevision: 1,
        actionId: "action-source",
        actionNonce: "1234567890abcdef",
        rootPath: "F:\\code\\private-source-root",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("private-source-root");
    expect(submitSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "F:\\code\\private-source-root",
      }),
    );
    await app.close();
  });
});
