import { describe, expect, it } from "vitest";
import { McpElicitationService, McpElicitationServiceError } from "./mcp-elicitation-service.js";

describe("McpElicitationService", () => {
  function createService() {
    return new McpElicitationService();
  }

  function createPending(service: McpElicitationService, overrides: Record<string, unknown> = {}) {
    return service.createRequest({
      prompt: "Which environment should I deploy to?",
      requestedSchema: { type: "object", properties: { env: { type: "string" } } },
      serverId: "srv-1",
      ...overrides,
    });
  }

  describe("createRequest", () => {
    it("records a pending request that is immediately listable", () => {
      const service = createService();
      const request = createPending(service);

      expect(request.elicitationId).toMatch(/^mcp-elicit-/);
      expect(request.status).toBe("pending");
      expect(request.method).toBe("elicitation/create");
      expect(request.source.serverId).toBe("srv-1");
      expect(service.listRequests()).toHaveLength(1);
      expect(service.listRequests()[0]?.elicitationId).toBe(request.elicitationId);
    });

    it("redacts secrets in the prompt and reports the redaction count", () => {
      const service = createService();
      const request = service.createRequest({
        prompt: "Use Bearer abcdef1234567890 to authenticate",
        requestedSchema: { type: "object" },
      });

      expect(request.prompt.text).not.toContain("abcdef1234567890");
      expect(request.prompt.text).toContain("[REDACTED]");
      expect(request.prompt.redactedSecretCount).toBeGreaterThan(0);
    });

    it("truncates prompts longer than the bounded limit", () => {
      const service = createService();
      const request = service.createRequest({
        prompt: "x".repeat(5000),
        requestedSchema: { type: "object" },
      });

      expect(request.prompt.truncated).toBe(true);
      expect(request.prompt.charLength).toBeLessThanOrEqual(request.prompt.maxChars);
    });

    it("rejects a requested schema that exceeds the byte limit", () => {
      const service = createService();
      expect(() =>
        service.createRequest({
          prompt: "Need input",
          requestedSchema: { blob: "y".repeat(20 * 1024) },
        }),
      ).toThrow(/exceeded/i);
    });
  });

  describe("listRequests", () => {
    it("filters by status, serverId, and sessionId", () => {
      const service = createService();
      const a = service.createRequest({
        prompt: "A",
        requestedSchema: { type: "object" },
        serverId: "srv-a",
        owner: { sessionId: "sess-1" },
      });
      service.createRequest({
        prompt: "B",
        requestedSchema: { type: "object" },
        serverId: "srv-b",
        owner: { sessionId: "sess-2" },
      });
      service.respondToRequest(a.elicitationId, { action: "accept", content: { ok: true } });

      expect(service.listRequests({ serverId: "srv-a" }).map((r) => r.elicitationId)).toEqual([a.elicitationId]);
      expect(service.listRequests({ sessionId: "sess-2" })).toHaveLength(1);
      expect(service.listRequests({ status: "accepted" }).map((r) => r.elicitationId)).toEqual([a.elicitationId]);
      expect(service.listRequests({ status: "pending" })).toHaveLength(1);
    });
  });

  describe("respondToRequest", () => {
    it("accepts a pending request with bounded content", () => {
      const service = createService();
      const request = createPending(service);

      const updated = service.respondToRequest(request.elicitationId, {
        action: "accept",
        content: { env: "prod" },
      });

      expect(updated.status).toBe("accepted");
      expect(updated.response?.action).toBe("accept");
      expect(updated.response?.content?.value).toEqual({ env: "prod" });
      expect(updated.evidence.responseContent).toBeDefined();
    });

    it("declines and cancels without content", () => {
      const service = createService();
      const declined = service.respondToRequest(createPending(service).elicitationId, { action: "decline" });
      const cancelled = service.respondToRequest(createPending(service).elicitationId, { action: "cancel" });

      expect(declined.status).toBe("declined");
      expect(declined.response?.content).toBeUndefined();
      expect(cancelled.status).toBe("cancelled");
    });

    it("requires content for accept responses", () => {
      const service = createService();
      const request = createPending(service);
      expect(() => service.respondToRequest(request.elicitationId, { action: "accept" })).toThrow(
        McpElicitationServiceError,
      );
    });

    it("accepts an empty content object without throwing", () => {
      const service = createService();
      const request = createPending(service);
      const updated = service.respondToRequest(request.elicitationId, { action: "accept", content: {} });
      expect(updated.status).toBe("accepted");
      expect(updated.response?.content?.value).toEqual({});
    });

    it("forbids content on decline and cancel responses", () => {
      const service = createService();
      const request = createPending(service);
      expect(() =>
        service.respondToRequest(request.elicitationId, {
          action: "decline",
          content: { nope: true },
        }),
      ).toThrow(/must not include content/i);
    });

    it("throws 404 for an unknown elicitation id", () => {
      const service = createService();
      try {
        service.respondToRequest("mcp-elicit-missing", { action: "cancel" });
        expect.unreachable("expected respondToRequest to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(McpElicitationServiceError);
        expect((error as McpElicitationServiceError).statusCode).toBe(404);
      }
    });

    it("throws 409 when the request has already been resolved", () => {
      const service = createService();
      const request = createPending(service);
      service.respondToRequest(request.elicitationId, { action: "cancel" });

      try {
        service.respondToRequest(request.elicitationId, { action: "cancel" });
        expect.unreachable("expected respondToRequest to throw");
      } catch (error) {
        expect((error as McpElicitationServiceError).statusCode).toBe(409);
        expect((error as Error).message).toMatch(/already been resolved/i);
      }
    });

    it("rejects a response whose owner scope differs from the original request", () => {
      const service = createService();
      const request = createPending(service, { owner: { operatorId: "op-1" } });

      try {
        service.respondToRequest(request.elicitationId, {
          action: "cancel",
          owner: { operatorId: "op-2" },
        });
        expect.unreachable("expected respondToRequest to throw");
      } catch (error) {
        expect((error as McpElicitationServiceError).statusCode).toBe(403);
      }
    });
  });
});
