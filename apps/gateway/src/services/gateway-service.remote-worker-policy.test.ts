import { describe, expect, it, vi } from "vitest";
import type { ChatTurnCapabilityProfileRecord, ToolPolicyActorContext } from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";
import type { RemoteWorkerChatAuthorityDependencies } from "./remote-worker-chat-authority.js";

function fixture(profileId: string) {
  const resolve = vi.fn<GatewayService["resolveToolPolicyContext"]>();
  const gateway = Object.create(GatewayService.prototype) as {
    resolveToolPolicyContext: GatewayService["resolveToolPolicyContext"];
    remoteWorkerChatAuthorityDependencies(): RemoteWorkerChatAuthorityDependencies;
  };
  gateway.resolveToolPolicyContext = resolve;
  const profile = {
    identity: {
      operatorId: "operator",
      authActorId: "token:actor",
      authActorSource: "token",
      workspaceId: "workspace",
      sessionId: "session",
      turnId: "turn",
      durableRunId: "run",
    },
    governance: { permission: { profileId } },
  } as ChatTurnCapabilityProfileRecord;
  return { resolve, read: () => gateway.remoteWorkerChatAuthorityDependencies().resolvePolicyContext(profile, "task") };
}

describe("remote worker current permission selection", () => {
  it("reuses a currently selected global default without treating it as caller selection", async () => {
    const { resolve, read } = fixture("trusted_local_power");
    const current: ToolPolicyActorContext = { permissionProfileId: "trusted_local_power", authActorId: "token:actor" };
    resolve.mockResolvedValue(current);
    expect(await read()).toBe(current);
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]![0]).toEqual({
      operatorId: "operator",
      authActorId: "token:actor",
      authActorSource: "token",
      workspaceId: "workspace",
      sessionId: "session",
      taskId: "task",
      runId: "run",
      surface: "chat",
      localOperatorOverrideId: undefined,
    });
  });

  it("revalidates an explicitly selected custom profile through the caller-selection owner", async () => {
    const { resolve, read } = fixture("operator-custom");
    const selected: ToolPolicyActorContext = { permissionProfileId: "operator-custom" };
    resolve.mockResolvedValueOnce({ permissionProfileId: "safe" }).mockResolvedValueOnce(selected);
    expect(await read()).toBe(selected);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]![0]).toEqual({ ...resolve.mock.calls[0]![0], permissionProfileId: "operator-custom" });
  });

  it("does not grant a formerly selected global profile after the current default changes", async () => {
    const { resolve, read } = fixture("trusted_local_power");
    resolve
      .mockResolvedValueOnce({ permissionProfileId: "safe" })
      .mockRejectedValueOnce(new Error("Global profile cannot be selected directly"));
    await expect(read()).rejects.toThrow("cannot be selected directly");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("fails closed if the current permission owner cannot resolve authority", async () => {
    const { resolve, read } = fixture("operator-custom");
    resolve.mockRejectedValue(new Error("Permission owner unavailable"));
    await expect(read()).rejects.toThrow("Permission owner unavailable");
    expect(resolve).toHaveBeenCalledOnce();
  });
});
