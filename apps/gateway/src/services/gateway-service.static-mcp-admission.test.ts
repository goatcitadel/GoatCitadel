import { describe, expect, it, vi } from "vitest";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import type { ChatFeatureAdmissionHost } from "./chat-feature-admission-service.js";
import { GatewayService } from "./gateway-service.js";

function fixture(selected = false, authenticated = false) {
  const admission: ActiveTurnAdmission = {
    identity: {
      admissionId: "admission",
      workspaceId: "workspace",
      sessionId: "session",
      sessionIncarnationId: "incarnation",
      turnId: "turn",
      aggregateRevision: 1,
      controllerGeneration: 1,
      materialSha256: "a".repeat(64),
    },
    admittedRequest: { content: "Hello" },
    requestActor: {
      actorKind: "operator",
      actorId: "operator",
      authActorSource: authenticated ? "token" : "none",
      ...(authenticated ? { authActorId: "operator" } : {}),
    },
    requestClaim: { runtimeOwnerId: "runtime", leaseRevision: 1 },
  };
  const stub = {
    storage: {},
    assertTurnAdmissionWrite: vi.fn(async () => undefined),
    recordDevDiagnostic: vi.fn(),
    mcpStaticChat: {
      hasAdmissionSelection: vi.fn(async () => selected),
      discoverAdmission: vi.fn(async () => []),
    },
  };
  const host = (
    GatewayService.prototype as unknown as {
      chatFeatureAdmissionHost(this: unknown): ChatFeatureAdmissionHost;
    }
  ).chatFeatureAdmissionHost.call(stub);
  return { admission, stub, resolve: host.resolveStaticMcpConnections! };
}

describe("saved MCP admission through Gateway composition", () => {
  it.each([true, false])(
    "preserves approval eligibility and reports actual policy denial (allowed=%s)",
    async (allowed) => {
      const scope = { ...fixture(true, true).admission.identity, actorId: "operator", actorSource: "token" as const };
      const stub = {
        readMcpServers: vi.fn(async () => [{ serverId: "selected-server" }]),
        assertMcpServerInCapabilityScope: vi.fn(async () => undefined),
        prepareToolAccessEvaluation: vi.fn(async (input: unknown) => input),
        policyEngine: {
          inspectAccess: vi.fn(async () => ({
            allowed,
            requiresApproval: allowed,
            reasonCodes: allowed ? ["approval_required"] : ["policy_deny"],
            permissionProfileId: "safe",
          })),
        },
        recordDevDiagnostic: vi.fn(),
      };
      const assertAllowed = (
        GatewayService.prototype as unknown as {
          assertRequesterAdmissionToolAllowed(this: unknown, currentScope: typeof scope, name: string): Promise<void>;
        }
      ).assertRequesterAdmissionToolAllowed;
      const result = assertAllowed.call(stub, scope, "mcp.selected-server.read");
      if (allowed) {
        await expect(result).resolves.toBeUndefined();
        expect(stub.recordDevDiagnostic).not.toHaveBeenCalled();
      } else {
        await expect(result).rejects.toThrow(/Inspect current Chat permissions/);
        expect(stub.recordDevDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "mcp.admission.policy_denied",
            context: { reasonCodes: ["policy_deny"], permissionProfileId: "safe" },
          }),
        );
      }
    },
  );

  it("leaves ordinary unauthenticated Chat available without credential or scope resolution", async () => {
    const f = fixture();
    await expect(f.resolve({ admission: f.admission, content: "Hello" })).resolves.toEqual([]);
    expect(f.stub.assertTurnAdmissionWrite).toHaveBeenCalledWith(f.admission);
    expect(f.stub.mcpStaticChat.discoverAdmission).not.toHaveBeenCalled();
    expect(f.stub.recordDevDiagnostic).not.toHaveBeenCalled();
  });

  it("refuses selected saved tools with an actionable authentication error before discovery", async () => {
    const f = fixture(true);
    await expect(f.resolve({ admission: f.admission, content: "Use selected-server" })).rejects.toThrow(
      /authenticated operator session/,
    );
    expect(f.stub.mcpStaticChat.discoverAdmission).not.toHaveBeenCalled();
    expect(f.stub.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { reasonCode: "authenticated_actor_required" },
      }),
    );
  });

  it("passes the exact authenticated admission and a fresh ownership assertion to the static owner", async () => {
    const f = fixture(true, true);
    await expect(f.resolve({ admission: f.admission, content: "Use selected-server" })).resolves.toEqual([]);
    const call = f.stub.mcpStaticChat.discoverAdmission.mock.calls[0] as unknown as [
      { scope: unknown; content: string; assertCurrent(): Promise<void> },
    ];
    expect(call[0].scope).toEqual({ ...f.admission.identity, actorId: "operator", actorSource: "token" });
    expect(call[0].content).toBe("Use selected-server");
    await call[0].assertCurrent();
    expect(f.stub.assertTurnAdmissionWrite).toHaveBeenCalledTimes(2);
    f.stub.assertTurnAdmissionWrite.mockRejectedValueOnce(new Error("ownership changed"));
    await expect(call[0].assertCurrent()).rejects.toThrow("ownership changed");
  });

  it("stops stale turns before reading server metadata", async () => {
    const f = fixture(true, true);
    f.stub.assertTurnAdmissionWrite.mockRejectedValueOnce(new Error("ownership changed"));
    await expect(f.resolve({ admission: f.admission, content: "Use selected-server" })).rejects.toThrow(
      "ownership changed",
    );
    expect(f.stub.mcpStaticChat.hasAdmissionSelection).not.toHaveBeenCalled();
    expect(f.stub.mcpStaticChat.discoverAdmission).not.toHaveBeenCalled();
  });
});
