import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  mcpRequesterScopeHashMaterial,
  NotFoundError,
  type ChatTurnCapabilityProfileRecord,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { buildMcpRequesterScopedTurnContextFromCapabilityProfile } from "../mcp-requester-resolution-service.js";
import { resolveNativeMcpChatToolBinding } from "./native-mcp-chat-binding.js";
import { toMcpInvokeRequest } from "./external-runtime-approval-adapter.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");

function fixture() {
  const identity = {
    turnId: "turn",
    sessionId: "session",
    workspaceId: "workspace",
    citadelId: "citadel",
    authActorId: "actor",
    authActorSource: "token" as const,
  };
  const material = {
    schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
    mode: "requester_scoped" as const,
    serverId: "server.with.dots",
    toolName: "mcp.server.with.dots.tool.echo",
    resolverId: "gateway.tenant",
    resolverVersion: "1.0.0",
    resolverConfigGeneration: 1,
    requesterScopeSha256: digest(
      mcpRequesterScopeHashMaterial({
        profileId: "profile",
        turnId: identity.turnId,
        sessionId: identity.sessionId,
        workspaceId: identity.workspaceId,
        authActorId: identity.authActorId,
        authActorSource: identity.authActorSource,
      }),
    ),
    serverConfigRevision: 1,
    serverConfigSha256: "a".repeat(64),
    transportPolicySha256: "b".repeat(64),
    callableCatalogSnapshotId: "catalog",
    callableCatalogSha256: "c".repeat(64),
  };
  const profile = {
    profileId: "profile",
    identity,
    catalog: { snapshotId: material.callableCatalogSnapshotId, callableHash: material.callableCatalogSha256 },
    hashes: { profileHash: "d".repeat(64) },
    selection: {
      tools: [
        { canonicalName: material.toolName, mcpRequesterResolution: { ...material, bindingSha256: digest(material) } },
      ],
    },
  } as ChatTurnCapabilityProfileRecord;
  const request: ToolInvokeRequest = {
    toolName: material.toolName,
    agentId: "assistant",
    ...identity,
    toolRunId: "tool-run",
    args: {
      value: "native argument",
      serverId: "untrusted-argument",
      toolName: "another-tool",
      arguments: { nested: true },
    },
    policyContext: { authActorId: identity.authActorId, authActorSource: identity.authActorSource },
  };
  const handle = buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile)!;
  const get = vi.fn(async () => profile);
  const storage = { chatTurnCapabilityProfiles: { get } } as unknown as Pick<
    AsyncStorage,
    "chatTurnCapabilityProfiles"
  >;
  return {
    profile,
    request,
    handle,
    storage,
    get,
    resolve: () => resolveNativeMcpChatToolBinding(storage, request, handle),
  };
}

describe("native MCP target from a frozen Chat profile", () => {
  it("uses the explicit stored server ID, preserving dotted names and exact native arguments", async () => {
    const f = fixture();
    const binding = await f.resolve();
    expect(binding).toMatchObject({ serverId: "server.with.dots", nativeToolName: "tool.echo" });
    expect(f.get).toHaveBeenCalledExactlyOnceWith("profile");
    const signal = new AbortController().signal;
    const input = toMcpInvokeRequest(f.request, signal, binding);
    expect(input).toMatchObject({
      serverId: "server.with.dots",
      toolName: "tool.echo",
      signal,
      arguments: f.request.args,
      policyContext: f.request.policyContext,
    });
    expect(input.arguments).toBe(f.request.args);
    expect(() => JSON.stringify(binding)).toThrow("cannot be serialized");
    expect(() => toMcpInvokeRequest(f.request)).toThrow("explicit target binding");
    expect(() => toMcpInvokeRequest({ ...f.request, toolName: "mcp.other.tool.echo" }, undefined, binding)).toThrow(
      "explicit target binding",
    );
  });

  it("rejects missing, cloned and body-forged context before any profile read", async () => {
    const f = fixture();
    for (const handle of [undefined, { ...f.handle }, { profileId: "profile", ...f.profile.identity }]) {
      await expect(resolveNativeMcpChatToolBinding(f.storage, f.request, handle as typeof f.handle)).rejects.toThrow(
        "exact frozen",
      );
    }
    expect(f.get).not.toHaveBeenCalled();
  });

  const mismatches: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    [
      "request actor",
      (f) => {
        f.request.policyContext!.authActorId = "other";
      },
    ],
    [
      "request actor source",
      (f) => {
        f.request.policyContext!.authActorSource = "loopback";
      },
    ],
    [
      "request session",
      (f) => {
        f.request.sessionId = "other";
      },
    ],
    [
      "request workspace",
      (f) => {
        f.request.workspaceId = "other";
      },
    ],
    [
      "request turn",
      (f) => {
        f.request.turnId = "other";
      },
    ],
    [
      "request Citadel",
      (f) => {
        f.request.citadelId = "other";
      },
    ],
    [
      "stored actor",
      (f) => {
        f.profile.identity.authActorId = "other";
      },
    ],
    [
      "stored profile identity",
      (f) => {
        f.profile.profileId = "other";
      },
    ],
    [
      "stored profile hash",
      (f) => {
        f.profile.hashes.profileHash = "e".repeat(64);
      },
    ],
    [
      "stored catalog hash",
      (f) => {
        f.profile.catalog.callableHash = "e".repeat(64);
      },
    ],
    [
      "stored catalog identity",
      (f) => {
        f.profile.catalog.snapshotId = "other";
      },
    ],
    [
      "removed tool",
      (f) => {
        f.profile.selection.tools = [];
      },
    ],
    [
      "duplicate selection",
      (f) => {
        f.profile.selection.tools.push(f.profile.selection.tools[0]!);
      },
    ],
    [
      "legacy/static binding",
      (f) => {
        delete f.profile.selection.tools[0]!.mcpRequesterResolution;
      },
    ],
    [
      "changed native binding",
      (f) => {
        f.profile.selection.tools[0]!.mcpRequesterResolution!.serverId = "other";
      },
    ],
    [
      "different requester binding",
      (f) => {
        const binding = f.profile.selection.tools[0]!.mcpRequesterResolution!;
        binding.requesterScopeSha256 = "e".repeat(64);
        const { bindingSha256: _hash, ...material } = binding;
        binding.bindingSha256 = digest(material);
      },
    ],
  ];
  it.each(mismatches)("rejects %s without widening the selected target", async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(f.resolve()).rejects.toThrow("exact frozen");
  });

  it("re-reads storage and distinguishes absent profiles from unavailable storage", async () => {
    const f = fixture();
    await f.resolve();
    f.get.mockRejectedValueOnce(new NotFoundError({ entity: "profile", id: "profile" }));
    await expect(f.resolve()).rejects.toThrow("exact frozen");
    f.get.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(f.resolve()).rejects.toThrow("storage unavailable");
    expect(f.get).toHaveBeenCalledTimes(3);
  });

  it("does not acquire native authority for the generic wrapper or other built-ins", async () => {
    const f = fixture();
    for (const toolName of ["mcp.invoke", "fs.read"]) {
      await expect(
        resolveNativeMcpChatToolBinding(f.storage, { ...f.request, toolName }, undefined),
      ).resolves.toBeUndefined();
    }
    expect(f.get).not.toHaveBeenCalled();
  });
});
