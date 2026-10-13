import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, type ChatTurnFeatureReferences, type McpServerRecord } from "@goatcitadel/contracts";
import {
  composeMcpRequesterAdmissionRuntime,
  selectRequesterMcpChatAdmission,
  selectSavedMcpChatAdmission,
  type McpRequesterAdmissionRuntimeHost,
} from "./mcp-requester-admission-runtime.js";
import {
  createMcpRequesterAdmissionTurnContext,
  readMcpRequesterAdmissionTurnContext,
} from "./mcp-requester-admission-context.js";
import {
  assertMcpAdmissionAuthority,
  assertMcpRequesterAdmissionConnection,
  issueMcpAdmissionDiscoveryAuthority,
  type McpRequesterAdmissionCurrentState,
} from "./mcp-requester-admission-authority.js";
import {
  createMcpEphemeralResolvedConnectionCandidate,
  McpRequesterResolutionError,
} from "./mcp-requester-resolution.js";
import type { McpRequesterScopedToolCallRuntimeInput } from "./mcp-runtime.js";
import { resolveNativeMcpChatToolBinding } from "./gateway/native-mcp-chat-binding.js";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";

const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const state: McpRequesterAdmissionCurrentState = {
    scope: {
      admissionId: "admission",
      sessionIncarnationId: "incarnation",
      workspaceId: "workspace",
      sessionId: "session",
      turnId: "turn",
      aggregateRevision: 2,
      controllerGeneration: 3,
      materialSha256: "a".repeat(64),
      actorId: "actor",
      actorSource: "token",
    },
    connectionId: "actor-connection",
    generation: 7,
    rotationGeneration: 2,
    revoked: false,
    server: {
      serverId: "tenant.with.dots",
      transport: "http",
      connectionMode: "requester_scoped",
      configurationRevision: 2,
      requesterResolution: {
        resolverId: "gateway.tenant",
        resolverVersion: "1.0.0",
        configGeneration: 1,
        transportPolicy: {
          allowedSchemes: ["https"],
          allowedHosts: ["mcp.example.test"],
          allowedPorts: [443],
          allowedHeaderNames: ["authorization"],
        },
      },
    },
  };
  let binding: { references: ChatTurnFeatureReferences; referenceSha256: string } | undefined;
  const raw = {
    tools: [
      {
        name: "search",
        description: "Find notes",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      { name: "unselected", inputSchema: { type: "object" } },
    ],
  };
  const resolve = vi.fn(async () =>
    createMcpEphemeralResolvedConnectionCandidate({
      outcomeClass: "resolved",
      url: "https://mcp.example.test/tools",
      headers: [{ name: "Authorization", value: "Bearer synthetic-mcp-admission-fixture" }],
      connectionGeneration: state.generation,
      rotationGeneration: state.rotationGeneration,
      expiresAt: new Date(NOW + 60_000).toISOString(),
    }),
  );
  const host: McpRequesterAdmissionRuntimeHost = {
    resolvers: [
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.0.0",
        configGeneration: 1,
        resolveForAdmissionDiscovery: resolve,
        resolveForAdmissionToolCall: resolve,
      },
    ],
    enabled: vi.fn(async () => true),
    assertScopeCurrent: vi.fn(async () => undefined),
    readConnection: vi.fn(async () => structuredClone(state)),
    readAdmission: vi.fn(async () => binding),
    assertToolAllowed: vi.fn(async () => undefined),
    getNetworkAllowlist: () => ["mcp.example.test"],
    recordDiagnostic: vi.fn(),
    now: () => NOW,
  };
  const discover = vi.fn(
    async (input: Parameters<typeof import("./mcp-runtime.js").discoverRequesterScopedMcpTools>[0]) => {
      await input.attempt.consumeOperationPermit(await input.attempt.authorizeToolsList());
      return { ok: true as const, rawToolsListResult: structuredClone(raw) };
    },
  );
  const invoke = vi.fn(async (input: McpRequesterScopedToolCallRuntimeInput) => {
    await input.attempt.consumeToolsListRevalidationPermit(await input.attempt.authorizeToolsListRevalidation());
    await input.attempt.acceptFreshToolsListRevalidation(input.revalidate(structuredClone(raw)));
    const permit = await input.attempt.consumeToolsCallPermit(await input.attempt.authorizeToolsCall());
    await input.effectDispatch();
    return { ok: true, output: { toolName: permit.rawRemoteToolName } };
  });
  const compose = () => composeMcpRequesterAdmissionRuntime(host, { discover, invoke });
  const runtime = compose();
  const assertCurrent = vi.fn(async () => undefined);
  const admit = async () => {
    const receipt = await runtime.discover({
      scope: state.scope,
      connectionId: state.connectionId,
      assertCurrent,
      selectedToolNames: ["mcp.tenant.with.dots.search"],
    });
    const references: ChatTurnFeatureReferences = {
      version: "chat.turn.feature-references.v1",
      requesterConnections: [receipt],
    };
    binding = { references, referenceSha256: hash(references) };
    return {
      receipt,
      handle: createMcpRequesterAdmissionTurnContext(state.scope, binding.referenceSha256, assertCurrent),
    };
  };
  const dispatch = (handle: ReturnType<typeof createMcpRequesterAdmissionTurnContext>, active = runtime) =>
    active.requesterScopedMcpDispatch.invoke(
      {
        server: { serverId: state.server.serverId } as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: handle,
      },
      { effectDispatch: effect },
    );
  const effect = vi.fn(async () => undefined);
  return {
    state,
    host,
    resolve,
    raw,
    runtime,
    compose,
    admit,
    invoke,
    discover,
    dispatch,
    effect,
    assertCurrent,
    setBinding: (value: typeof binding) => {
      binding = value;
    },
  };
}

describe("requester MCP feature admission", () => {
  it("rejects duplicate requester selections before discovery and missing saved-tool actor authority", async () => {
    const f = fixture(),
      choice = { connectionId: f.state.connectionId, selectedToolNames: ["mcp.tenant.with.dots.search"] };
    const admission = {
      identity: f.state.scope,
      requestActor: {
        actorKind: "operator",
        authActorId: f.state.scope.actorId,
        authActorSource: f.state.scope.actorSource,
      },
    } as ActiveTurnAdmission;
    const host = {
      assertTurnAdmissionWrite: f.assertCurrent,
      recordDevDiagnostic: vi.fn(),
      runtime: f.runtime,
      configuration: {
        resolvers: f.host.resolvers!,
        readConnection: f.host.readConnection!,
        selectConnections: async () => [choice, choice],
      },
    };
    await expect(selectRequesterMcpChatAdmission(host, { admission, content: "search" })).rejects.toMatchObject({
      code: "discovery_output_too_large",
    });
    expect(f.discover).not.toHaveBeenCalled();
    const staticChat = { hasAdmissionSelection: async () => true, discoverAdmission: vi.fn() };
    await expect(
      selectSavedMcpChatAdmission(
        { ...host, staticChat },
        {
          admission: { ...admission, requestActor: { ...admission.requestActor, authActorSource: "none" } },
          content: "search",
        },
      ),
    ).rejects.toThrow("authenticated operator");
    expect(staticChat.discoverAdmission).not.toHaveBeenCalled();
  });
  it("persists selected nonsecret receipts and restores exact aliases after restart without a profile", async () => {
    const f = fixture();
    const { receipt, handle } = await f.admit();
    expect(receipt.selectedTools.map((tool) => tool.rawRemoteToolName)).toEqual(["search"]);
    expect(JSON.stringify(receipt)).not.toMatch(/Authorization|synthetic-mcp|https:\/\//u);
    const restarted = f.compose();
    const schemas = await restarted.restoreSchemas(handle);
    expect(schemas[0]?.modelName).toBe(receipt.selectedTools[0]?.modelName);
    expect(await f.dispatch(handle, restarted)).toMatchObject({ ok: true, output: { toolName: "search" } });
    expect(f.effect).toHaveBeenCalledTimes(1);
    expect(f.discover).toHaveBeenCalledTimes(1);
    const binding = await resolveNativeMcpChatToolBinding(
      {} as AsyncStorage,
      {
        toolName: "mcp.tenant.with.dots.search",
        sessionId: "session",
        workspaceId: "workspace",
        turnId: "turn",
        agentId: "agent",
        args: {},
        policyContext: { authActorId: "actor", authActorSource: "token" },
      },
      handle,
      restarted.restoreSchemas,
    );
    expect(binding).toMatchObject({ serverId: "tenant.with.dots", nativeToolName: "search" });
  });

  it.each(["generation", "rotation", "actor", "session", "server", "revoke", "policy", "hash"] as const)(
    "refuses %s drift before an effect",
    async (drift) => {
      const f = fixture();
      const { handle } = await f.admit();
      if (drift === "generation") f.state.generation++;
      if (drift === "rotation") f.state.rotationGeneration!++;
      if (drift === "actor") f.state.scope.actorId = "different-actor";
      if (drift === "session") f.state.scope.sessionIncarnationId = "new-incarnation";
      if (drift === "server") f.state.server.configurationRevision++;
      if (drift === "revoke") f.state.revoked = true;
      if (drift === "policy")
        f.host.assertToolAllowed = async () => {
          throw new Error("denied");
        };
      if (drift === "hash") f.setBinding(undefined);
      expect(await f.dispatch(handle)).toMatchObject({ ok: false, failurePhase: "pre_dispatch" });
      expect(f.effect).not.toHaveBeenCalled();
    },
  );

  it("revalidates the live schema after approval and refuses schema drift", async () => {
    const f = fixture();
    const { handle } = await f.admit();
    f.raw.tools[0]!.description = "Changed tool behavior";
    expect(await f.dispatch(handle)).toMatchObject({
      ok: false,
      failurePhase: "pre_dispatch",
      output: { reasonCode: "schema_revalidation_drift" },
    });
    expect(f.effect).not.toHaveBeenCalled();
  });

  it("preserves unknown-after-send and never retries the effect", async () => {
    const f = fixture();
    const { handle } = await f.admit();
    f.invoke.mockImplementationOnce(async (input) => {
      await input.effectDispatch();
      throw new Error("sensitive transport error");
    });
    const result = await f.dispatch(handle);
    expect(result).toMatchObject({
      ok: false,
      externalOutcome: "unknown_after_send",
      failurePhase: "post_dispatch",
      retrySafe: false,
    });
    expect(JSON.stringify(result)).not.toContain("sensitive transport");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.effect).toHaveBeenCalledTimes(1);
  });

  it("requires the original live claim during restore and rechecks it between schema validation and dispatch", async () => {
    const f = fixture();
    const { handle } = await f.admit();
    f.assertCurrent.mockRejectedValueOnce(new Error("claim lost"));
    await expect(f.runtime.restoreSchemas(handle)).rejects.toThrow("claim lost");
    f.invoke.mockImplementationOnce(async (input) => {
      await input.attempt.consumeToolsListRevalidationPermit(await input.attempt.authorizeToolsListRevalidation());
      await input.attempt.acceptFreshToolsListRevalidation(input.revalidate(f.raw));
      f.assertCurrent.mockRejectedValue(new Error("claim lost"));
      await input.attempt.authorizeToolsCall();
      await input.effectDispatch();
      return { ok: true };
    });
    expect(await f.dispatch(handle)).toMatchObject({ ok: false, failurePhase: "pre_dispatch" });
    expect(f.effect).not.toHaveBeenCalled();
  });

  it("isolates actor connections and cancellation instead of reusing a shared resolved endpoint", async () => {
    const a = fixture();
    const b = fixture();
    b.state.scope.actorId = "second-actor";
    b.state.connectionId = "second-connection";
    const [first, second] = await Promise.all([a.admit(), b.admit()]);
    expect(first.receipt.bindingId).not.toBe(second.receipt.bindingId);
    expect(await a.dispatch(second.handle)).toMatchObject({ ok: false, failurePhase: "pre_dispatch" });
    expect(a.effect).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    const response = await a.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: { serverId: a.state.server.serverId } as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: first.handle,
        signal: controller.signal,
      },
      { effectDispatch: a.effect },
    );
    expect(response).toMatchObject({ ok: false, failurePhase: "pre_dispatch" });
    expect(a.effect).not.toHaveBeenCalled();
    expect(await b.dispatch(second.handle)).toMatchObject({ ok: true });
    expect(b.effect).toHaveBeenCalledTimes(1);
  });

  it("fails closed without configured resolver/connection owner and when disabled", async () => {
    const f = fixture();
    delete f.host.readConnection;
    await expect(
      f.runtime.discover({
        scope: f.state.scope,
        connectionId: f.state.connectionId,
        assertCurrent: async () => undefined,
        selectedToolNames: ["mcp.tenant.with.dots.search"],
      }),
    ).rejects.toMatchObject({ code: "resolver_missing" });
    expect(f.resolve).not.toHaveBeenCalled();
    const f2 = fixture();
    f2.host.resolvers = [];
    await expect(
      f2.compose().discover({
        scope: f2.state.scope,
        connectionId: f2.state.connectionId,
        assertCurrent: async () => undefined,
        selectedToolNames: ["mcp.tenant.with.dots.search"],
      }),
    ).rejects.toMatchObject({ code: "resolver_missing" });
    f2.host.enabled = async () => false;
    await expect(
      f2.runtime.discover({
        scope: f2.state.scope,
        connectionId: f2.state.connectionId,
        assertCurrent: async () => undefined,
        selectedToolNames: [],
      }),
    ).rejects.toMatchObject({ code: "requester_context_missing" });
  });

  it("rejects forged handles, authority copies, changed selected schemas and oversized evidence", async () => {
    const f = fixture();
    const { receipt, handle } = await f.admit();
    expect(readMcpRequesterAdmissionTurnContext({ ...handle })).toBeUndefined();
    expect(() => JSON.stringify(handle)).toThrow();
    const authority = issueMcpAdmissionDiscoveryAuthority(f.state);
    expect(() => assertMcpAdmissionAuthority({ ...authority }, "admission_discovery")).toThrow(
      McpRequesterResolutionError,
    );
    const changed = structuredClone(receipt);
    changed.selectedTools[0]!.inputSchema = { type: "number" };
    expect(() => assertMcpRequesterAdmissionConnection(changed)).toThrow();
    const huge = structuredClone(receipt);
    huge.selectedTools[0]!.inputSchema = { description: "x".repeat(70_000) };
    expect(() => assertMcpRequesterAdmissionConnection(huge)).toThrow();
  });
});
