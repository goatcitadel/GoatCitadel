import {
  canonicalJsonString,
  resolveMcpServerConnectionMode,
  readChatTurnFeatureReferences,
  type McpServerRecord,
  type McpRequesterAdmissionScope,
  type McpStaticAdmissionConnection,
} from "@goatcitadel/contracts";
import type { McpStaticChatServiceOptions } from "./mcp-static-chat-service.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS } from "./mcp-server-store.js";
import {
  assertMcpStaticEnvironmentCurrent,
  type McpStaticEnvironmentHandle,
} from "./mcp-static-environment-service.js";
import type { McpResolutionSecretGuard } from "./mcp-resolution-secret-guard.js";
import { discoverStaticMcpToolsList, type McpRuntimeTransportOptions } from "./mcp-runtime.js";
import {
  readMcpRequesterAdmissionTurnContext,
  type McpRequesterAdmissionTurnContextHandle,
} from "./mcp-requester-admission-context.js";
import {
  assertStaticMcpAdmissionReceipt,
  assertStaticMcpAdmissionServer,
  buildStaticMcpAdmissionReceipt,
  staticAdmissionDigest,
} from "./mcp-static-admission.js";
import {
  bindNativeStaticAdmissionMcpChatToolSchema,
  collectNativeMcpChatCatalogCandidates,
  type NativeMcpChatToolSchema,
} from "./gateway/native-mcp-chat-catalog.js";
import { hasExplicitMcpIdentifier, selectExplicitStaticMcpServers } from "./mcp-static-selection.js";
import type { StaticMcpCatalogSnapshot } from "./mcp-static-catalog.js";

export interface StaticMcpAdmissionTransportPort {
  connection(
    server: McpServerRecord,
    allowRefreshedConfiguration: boolean,
  ): Promise<{
    server: McpServerRecord;
    environment: McpStaticEnvironmentHandle;
    guard: McpResolutionSecretGuard;
    transport: McpRuntimeTransportOptions;
  }>;
  normalize(server: McpServerRecord, raw: unknown, guard: McpResolutionSecretGuard): StaticMcpCatalogSnapshot;
}

/** Admission owns retained selections and live checks. The existing transport retains secret custody. */
export class McpStaticChatAdmissionService {
  constructor(
    private readonly options: Pick<
      McpStaticChatServiceOptions,
      "registry" | "admission" | "assertMcpServerInScope" | "readAuthConnectionState"
    >,
    private readonly transport: StaticMcpAdmissionTransportPort,
  ) {}
  /** Metadata only: selection does not discover tools, resolve credentials, or grant authority. */
  public async hasAdmissionSelection(content: string): Promise<boolean> {
    return (await this.selectAdmissionServers(content)).length > 0;
  }

  private async selectAdmissionServers(content: string): Promise<McpServerRecord[]> {
    return selectExplicitStaticMcpServers(
      content,
      (await this.options.registry.readServers()).filter(
        (server) =>
          !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId) && resolveMcpServerConnectionMode(server) === "static",
      ),
    );
  }

  /** Explicit saved server/tool selection only; an upgrade never exposes all configured servers. */
  public async discoverAdmission(input: {
    scope: McpRequesterAdmissionScope;
    content: string;
    assertCurrent(): Promise<void>;
    signal?: AbortSignal;
  }): Promise<McpStaticAdmissionConnection[]> {
    if (!this.options.admission || !(await this.options.admission.enabled())) return [];
    await this.assertAdmissionScope(input.scope, input.assertCurrent);
    const selected = await this.selectAdmissionServers(input.content);
    if (selected.length > 4) throw new Error("Select at most four static MCP servers in one Chat turn.");
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref();
    const receipts: McpStaticAdmissionConnection[] = [];
    try {
      for (const server of selected) {
        await this.options.assertMcpServerInScope({
          serverId: server.serverId,
          toolName: "__admission_discovery__",
          agentId: "assistant",
          workspaceId: input.scope.workspaceId,
          sessionId: input.scope.sessionId,
        });
        const connection = await this.transport.connection(server, false);
        try {
          signal.throwIfAborted();
          const raw = await discoverStaticMcpToolsList(connection.server, 10_000, connection.transport, signal);
          const snapshot = this.transport.normalize(connection.server, raw, connection.guard);
          const explicitlyNamed = snapshot.catalog.tools.filter(
            (tool) =>
              hasExplicitMcpIdentifier(input.content, tool.canonicalToolName) ||
              hasExplicitMcpIdentifier(input.content, tool.rawRemoteToolName),
          );
          const tools = explicitlyNamed.length ? explicitlyNamed : snapshot.catalog.tools;
          if (tools.length > 16) throw new Error("Name up to sixteen exact tools for the selected static MCP server.");
          if (!tools.length) throw new Error("Selected static MCP server has no available tools.");
          for (const tool of tools) await this.options.admission.assertToolAllowed(input.scope, tool.canonicalToolName);
          const receipt = buildStaticMcpAdmissionReceipt(
            input.scope,
            connection.server,
            snapshot,
            tools.map((tool) => tool.canonicalToolName),
          );
          await this.assertAdmissionScope(input.scope, input.assertCurrent);
          assertStaticMcpAdmissionServer(receipt, await this.options.registry.requireServer(server.serverId));
          await assertMcpStaticEnvironmentCurrent(connection.environment, connection.server);
          signal.throwIfAborted();
          receipts.push(receipt);
        } finally {
          connection.guard.dispose();
        }
      }
      return receipts;
    } finally {
      clearTimeout(timer);
    }
  }

  public async restoreAdmissionSchemas(
    handle: McpRequesterAdmissionTurnContextHandle,
  ): Promise<NativeMcpChatToolSchema[]> {
    const { context, receipts } = await this.readAdmissionReceipts(handle);
    const result: NativeMcpChatToolSchema[] = [];
    for (const receipt of receipts) {
      await this.options.assertMcpServerInScope({
        serverId: receipt.serverId,
        toolName: "__admission_restore__",
        agentId: "assistant",
        workspaceId: context.scope.workspaceId,
        sessionId: context.scope.sessionId,
      });
      const server = await this.options.registry.requireServer(receipt.serverId);
      assertStaticMcpAdmissionServer(receipt, server);
      const connection = await this.transport.connection(server, false);
      try {
        const snapshot = this.transport.normalize(
          server,
          {
            tools: receipt.selectedTools.map((tool) => ({
              name: tool.rawRemoteToolName,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              inputSchema: tool.inputSchema,
            })),
          },
          connection.guard,
        );
        for (const candidate of collectNativeMcpChatCatalogCandidates([], [], [snapshot])) {
          await this.options.admission!.assertToolAllowed(context.scope, candidate.tool.canonicalToolName);
          result.push(bindNativeStaticAdmissionMcpChatToolSchema(candidate, receipt));
        }
        await this.assertAdmissionScope(context.scope, context.assertCurrent);
        assertStaticMcpAdmissionServer(receipt, await this.options.registry.requireServer(receipt.serverId));
        await assertMcpStaticEnvironmentCurrent(connection.environment, connection.server);
      } finally {
        connection.guard.dispose();
      }
    }
    return result;
  }

  private async assertAdmissionScope(
    scope: McpRequesterAdmissionScope,
    assertCurrent: () => Promise<void>,
  ): Promise<void> {
    if (!this.options.admission || !(await this.options.admission.enabled())) throw unavailable();
    await assertCurrent();
    await this.options.admission.assertScopeCurrent(scope);
    if (
      (await this.options.readAuthConnectionState({ actorId: scope.actorId, actorSource: scope.actorSource })).revoked
    )
      throw unavailable();
  }

  private async readAdmissionReceipts(handle: unknown) {
    const context = readMcpRequesterAdmissionTurnContext(handle);
    if (!context) throw unavailable();
    await this.assertAdmissionScope(context.scope, context.assertCurrent);
    const binding = await this.options.admission!.readAdmission(context.scope);
    if (!binding || binding.referenceSha256 !== context.referenceSha256) throw unavailable();
    const references = readChatTurnFeatureReferences(binding.references);
    if (staticAdmissionDigest(references) !== context.referenceSha256) throw unavailable();
    const receipts = (references.selectedStaticMcp ?? []).map(assertStaticMcpAdmissionReceipt);
    if (
      new Set(receipts.map((receipt) => receipt.serverId)).size !== receipts.length ||
      receipts.some((receipt) => canonicalJsonString(receipt.scope) !== canonicalJsonString(context.scope))
    )
      throw unavailable();
    return { context, receipts };
  }

  public async admittedCall(handle: unknown, canonicalName: string) {
    const { context, receipts } = await this.readAdmissionReceipts(handle);
    const selected = receipts.filter((receipt) =>
      receipt.selectedTools.some((tool) => tool.canonicalToolName === canonicalName),
    );
    if (selected.length !== 1) throw unavailable();
    const receipt = selected[0]!;
    const tool = receipt.selectedTools.find((entry) => entry.canonicalToolName === canonicalName)!;
    await this.options.admission!.assertToolAllowed(context.scope, canonicalName);
    await this.options.assertMcpServerInScope({
      serverId: receipt.serverId,
      toolName: tool.rawRemoteToolName,
      agentId: "assistant",
      workspaceId: context.scope.workspaceId,
      sessionId: context.scope.sessionId,
    });
    const server = await this.options.registry.requireServer(receipt.serverId);
    assertStaticMcpAdmissionServer(receipt, server);
    return {
      server,
      binding: { configurationBindingId: receipt.configurationBindingId, nativeToolName: tool.rawRemoteToolName },
      tool: {
        providerDefinition: {
          type: "function",
          function: {
            name: tool.modelName,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters: tool.inputSchema,
          },
        },
      },
      scope: {
        workspaceId: context.scope.workspaceId,
        sessionId: context.scope.sessionId,
        authActorId: context.scope.actorId,
        authActorSource: context.scope.actorSource,
      },
    };
  }
}
function unavailable(): Error {
  return new Error("Static MCP authority is no longer current.");
}
