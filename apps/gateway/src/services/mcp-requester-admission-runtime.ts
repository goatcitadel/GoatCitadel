import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  readChatTurnFeatureReferences,
  type ChatTurnFeatureReferences,
  type McpRequesterAdmissionConnection,
  type McpRequesterAdmissionScope,
} from "@goatcitadel/contracts";
import { discoverRequesterScopedMcpTools, invokeRequesterScopedMcpToolCall } from "./mcp-runtime.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import {
  McpRequesterResolutionError,
  McpRequesterResolverRegistry,
  extractMcpRequesterDiscoveryOutputInput,
  normalizeMcpRequesterDiscoveryOutput,
  type McpRequesterResolutionReasonCode,
} from "./mcp-requester-resolution.js";
import {
  McpRequesterResolutionService,
  buildRequesterScopedPreDispatchFailure,
} from "./mcp-requester-resolution-service.js";
import {
  assertMcpAdmissionCurrent,
  assertMcpRequesterAdmissionConnection,
  createMcpRequesterAdmissionConnection,
  issueMcpAdmissionDiscoveryAuthority,
  issueMcpAdmissionToolCallAuthority,
  type McpRequesterAdmissionCurrentState,
} from "./mcp-requester-admission-authority.js";
import {
  readMcpRequesterAdmissionTurnContext,
  type McpRequesterAdmissionTurnContextHandle,
} from "./mcp-requester-admission-context.js";
import type { McpRequesterAdmissionResolver } from "./mcp-requester-admission-resolvers.js";
import {
  collectNativeMcpChatCatalogCandidates,
  bindNativeAdmissionMcpChatToolSchema,
  type NativeMcpChatToolSchema,
} from "./gateway/native-mcp-chat-catalog.js";
import type { RequesterScopedMcpDispatchPort } from "./tool-invocation-coordinator-service.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import type { McpStaticChatService } from "./mcp-static-chat-service.js";
import { requesterScopeFromActiveAdmission } from "./mcp-requester-admission-scope.js";
import type { LlmCompletionHost } from "./llm-completion-host.js";

interface McpAdmissionSelectionHost {
  assertTurnAdmissionWrite(admission: ActiveTurnAdmission): Promise<void>;
  recordDevDiagnostic: LlmCompletionHost["recordDevDiagnostic"];
}

export async function selectSavedMcpChatAdmission(
  host: McpAdmissionSelectionHost & {
    staticChat: Pick<McpStaticChatService, "hasAdmissionSelection" | "discoverAdmission">;
  },
  input: { admission: ActiveTurnAdmission; content: string },
) {
  await host.assertTurnAdmissionWrite(input.admission);
  if (!(await host.staticChat.hasAdmissionSelection(input.content))) return [];
  const actor = input.admission.requestActor;
  if (
    actor.actorKind !== "operator" ||
    !actor.authActorId?.trim() ||
    !actor.authActorSource ||
    !["token", "basic", "loopback", "device", "companion"].includes(actor.authActorSource)
  ) {
    host.recordDevDiagnostic({
      level: "warn",
      category: "mcp",
      event: "mcp.static_admission.unavailable",
      message: "Selected saved MCP tools require an authenticated Chat actor.",
      context: { reasonCode: "authenticated_actor_required" },
    });
    throw new ConflictError({
      message:
        "Saved MCP tools in Chat require an authenticated operator session. Configure supported Gateway authentication and start a new Chat turn.",
    });
  }
  return host.staticChat.discoverAdmission({
    scope: requesterScopeFromActiveAdmission(input.admission),
    content: input.content,
    assertCurrent: () => host.assertTurnAdmissionWrite(input.admission),
  });
}

export async function selectRequesterMcpChatAdmission(
  host: McpAdmissionSelectionHost & {
    configuration?: McpRequesterAdmissionConfiguration;
    runtime: Pick<ReturnType<typeof composeMcpRequesterAdmissionRuntime>, "discover">;
  },
  input: { admission: ActiveTurnAdmission; content: string },
) {
  if (!host.configuration) {
    host.recordDevDiagnostic({
      level: "warn",
      category: "mcp",
      event: "mcp.requester_admission.unavailable",
      message: "Requester MCP has no configured actor-bound connection resolver.",
      context: { reasonCode: "resolver_missing" },
    });
    return [];
  }
  await host.assertTurnAdmissionWrite(input.admission);
  const selected = await host.configuration.selectConnections(input);
  if (selected.length > 4 || new Set(selected.map((item) => item.connectionId)).size !== selected.length)
    throw new McpRequesterResolutionError("discovery_output_too_large");
  if (!selected.length) return [];
  const scope = requesterScopeFromActiveAdmission(input.admission),
    receipts = [];
  for (const connection of selected)
    receipts.push(
      await host.runtime.discover({
        scope,
        ...connection,
        assertCurrent: () => host.assertTurnAdmissionWrite(input.admission),
      }),
    );
  return receipts;
}

/** First-class Gateway constructor registration, intentionally unavailable to request DTOs and plugins. */
export interface McpRequesterAdmissionConfiguration {
  resolvers: readonly McpRequesterAdmissionResolver[];
  readConnection(scope: McpRequesterAdmissionScope, connectionId: string): Promise<McpRequesterAdmissionCurrentState>;
  selectConnections(input: { admission: ActiveTurnAdmission; content: string }): Promise<
    readonly {
      connectionId: string;
      selectedToolNames: readonly string[];
    }[]
  >;
}

export interface McpRequesterAdmissionRuntimeHost {
  /** Fixed server-owned registrations; plugins, requests and discovery cannot install a resolver. */
  resolvers?: readonly McpRequesterAdmissionResolver[];
  enabled(): Promise<boolean>;
  /** Verify exact canonical actor, session incarnation, revision, controller and active request/durable claim. */
  assertScopeCurrent(scope: McpRequesterAdmissionScope): Promise<void>;
  readAdmission(
    scope: McpRequesterAdmissionScope,
  ): Promise<{ references: ChatTurnFeatureReferences; referenceSha256: string } | undefined>;
  /** Configured actor-bound connection owner. No shared credential or endpoint fallback is permitted. */
  readConnection?(scope: McpRequesterAdmissionScope, connectionId: string): Promise<McpRequesterAdmissionCurrentState>;
  /** Fresh deny-wins policy, grants and approval posture remain Gateway-owned. */
  assertToolAllowed(scope: McpRequesterAdmissionScope, canonicalToolName: string): Promise<void>;
  getNetworkAllowlist(): readonly string[];
  recordDiagnostic(reasonCode: McpRequesterResolutionReasonCode): void;
  now?(): number;
}

export function composeMcpRequesterAdmissionRuntime(
  host: McpRequesterAdmissionRuntimeHost,
  drivers: {
    discover?: typeof discoverRequesterScopedMcpTools;
    invoke?: typeof invokeRequesterScopedMcpToolCall;
  } = {},
) {
  const service = new McpRequesterResolutionService(
    new McpRequesterResolverRegistry({ profileDiscovery: [], toolCall: [] }),
    { admissionResolvers: host.resolvers, now: host.now },
  );
  const scanner = createMcpRequesterDiscoverySecretScanner();
  const diagnostic = (error: unknown): McpRequesterResolutionReasonCode => {
    const code = error instanceof McpRequesterResolutionError ? error.code : "requester_scope_mismatch";
    try {
      host.recordDiagnostic(code);
    } catch {
      /* Observability cannot change authority. */
    }
    return code;
  };
  const assertScope = async (scope: McpRequesterAdmissionScope, assertCurrent: () => Promise<void>) => {
    if (!(await host.enabled())) throw new McpRequesterResolutionError("requester_context_missing");
    if (typeof assertCurrent !== "function") throw new McpRequesterResolutionError("requester_context_missing");
    await assertCurrent();
    await host.assertScopeCurrent(scope);
  };
  const readConnection = async (
    scope: McpRequesterAdmissionScope,
    connectionId: string,
    assertCurrent: () => Promise<void>,
  ) => {
    await assertScope(scope, assertCurrent);
    if (!host.readConnection) throw new McpRequesterResolutionError("resolver_missing");
    const state = await host.readConnection(scope, connectionId);
    if (canonicalJsonString(state.scope) !== canonicalJsonString(scope) || state.connectionId !== connectionId) {
      throw new McpRequesterResolutionError("requester_scope_mismatch");
    }
    return state;
  };
  const readReceipts = async (handle: unknown) => {
    const context = readMcpRequesterAdmissionTurnContext(handle);
    if (!context) throw new McpRequesterResolutionError("requester_context_missing");
    await assertScope(context.scope, context.assertCurrent);
    const binding = await host.readAdmission(context.scope);
    if (!binding || binding.referenceSha256 !== context.referenceSha256)
      throw new McpRequesterResolutionError("requester_scope_mismatch");
    const references = readChatTurnFeatureReferences(binding.references);
    const hash = createHash("sha256").update(canonicalJsonString(references)).digest("hex");
    if (hash !== context.referenceSha256) throw new McpRequesterResolutionError("requester_scope_mismatch");
    const receipts = (references.requesterConnections ?? []).map((entry) =>
      assertMcpRequesterAdmissionConnection(entry),
    );
    if (
      receipts.some((receipt) => canonicalJsonString(receipt.scope) !== canonicalJsonString(context.scope)) ||
      new Set(receipts.map((receipt) => receipt.connectionId)).size !== receipts.length ||
      new Set(receipts.flatMap((receipt) => receipt.selectedTools.map((tool) => tool.canonicalToolName))).size !==
        receipts.reduce((count, receipt) => count + receipt.selectedTools.length, 0)
    ) {
      throw new McpRequesterResolutionError("requester_scope_mismatch");
    }
    return { context, receipts };
  };
  const readCallState = async (
    handle: unknown,
    receipt: McpRequesterAdmissionConnection,
    canonicalToolName: string,
  ) => {
    const live = await readReceipts(handle);
    if (!live.receipts.some((entry) => entry.bindingId === receipt.bindingId))
      throw new McpRequesterResolutionError("resolver_binding_drift");
    await host.assertToolAllowed(live.context.scope, canonicalToolName);
    return {
      ...(await readConnection(live.context.scope, receipt.connectionId, live.context.assertCurrent)),
      referenceSha256: live.context.referenceSha256,
    };
  };
  return {
    /** The caller selects names through its normal policy/catalog owner; discovery grants no call permission. */
    async discover(input: {
      scope: McpRequesterAdmissionScope;
      connectionId: string;
      selectedToolNames: readonly string[];
      assertCurrent(): Promise<void>;
      signal?: AbortSignal;
    }): Promise<McpRequesterAdmissionConnection> {
      let attempt;
      try {
        const current = await readConnection(input.scope, input.connectionId, input.assertCurrent);
        const authority = issueMcpAdmissionDiscoveryAuthority(current);
        attempt = await service.resolveForAdmissionDiscovery({
          requester: authority,
          server: current.server,
          readCurrentState: () => readConnection(input.scope, input.connectionId, input.assertCurrent),
          signal: input.signal,
        });
        const result = await (drivers.discover ?? discoverRequesterScopedMcpTools)({
          attempt,
          networkAllowlist: [...host.getNetworkAllowlist()],
          now: host.now,
        });
        if (!result.ok) throw new McpRequesterResolutionError(result.reasonCode);
        const catalog = normalizeMcpRequesterDiscoveryOutput(
          current.server.serverId,
          extractMcpRequesterDiscoveryOutputInput(current.server.serverId, result.rawToolsListResult),
          scanner,
        );
        for (const name of input.selectedToolNames) await host.assertToolAllowed(input.scope, name);
        const fresh = await readConnection(input.scope, input.connectionId, input.assertCurrent);
        // Recheck the discovery authority after transport, before persisting selected evidence.
        assertMcpAdmissionCurrent(authority, fresh);
        return createMcpRequesterAdmissionConnection({
          current: fresh,
          catalog,
          selectedToolNames: input.selectedToolNames,
        });
      } catch (error) {
        diagnostic(error);
        throw error;
      } finally {
        attempt?.dispose();
      }
    },
    /** This is also the restore path after restart/approval; no process-local discovery registry is authoritative. */
    async restoreSchemas(handle: McpRequesterAdmissionTurnContextHandle): Promise<NativeMcpChatToolSchema[]> {
      const { receipts } = await readReceipts(handle);
      const schemas: NativeMcpChatToolSchema[] = [];
      for (const receipt of receipts) {
        const catalog = normalizeMcpRequesterDiscoveryOutput(
          receipt.serverId,
          {
            tools: receipt.selectedTools.map((tool) => ({
              rawRemoteToolName: tool.rawRemoteToolName,
              canonicalToolName: tool.canonicalToolName,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              inputSchema: tool.inputSchema,
            })),
          },
          scanner,
        );
        for (const candidate of collectNativeMcpChatCatalogCandidates([catalog], [])) {
          const current = await readCallState(handle, receipt, candidate.tool.canonicalToolName);
          issueMcpAdmissionToolCallAuthority({
            receipt,
            canonicalToolName: candidate.tool.canonicalToolName,
            referenceSha256: current.referenceSha256,
            current,
          });
          schemas.push(bindNativeAdmissionMcpChatToolSchema(candidate, receipt));
        }
      }
      return schemas;
    },
    requesterScopedMcpDispatch: {
      async invoke(input, options) {
        let attempt;
        let dispatched = false;
        try {
          const { context, receipts } = await readReceipts(input.mcpRequesterTurnContext);
          const canonicalToolName = `mcp.${input.server.serverId}.${input.toolName}`;
          const receipt = receipts.find(
            (entry) =>
              entry.serverId === input.server.serverId &&
              entry.selectedTools.some((tool) => tool.canonicalToolName === canonicalToolName),
          );
          if (!receipt) throw new McpRequesterResolutionError("requester_context_missing");
          const current = await readCallState(input.mcpRequesterTurnContext, receipt, canonicalToolName);
          const authority = issueMcpAdmissionToolCallAuthority({
            receipt,
            canonicalToolName,
            referenceSha256: context.referenceSha256,
            current,
          });
          attempt = await service.resolveForAdmissionToolCall({
            requester: authority,
            server: current.server,
            readCurrentState: () => readCallState(input.mcpRequesterTurnContext, receipt, canonicalToolName),
            signal: input.signal,
          });
          return await (drivers.invoke ?? invokeRequesterScopedMcpToolCall)({
            attempt,
            toolName: input.toolName,
            arguments: input.arguments,
            effectDispatch: async () => {
              await options.effectDispatch();
              dispatched = true;
            },
            networkAllowlist: [...host.getNetworkAllowlist()],
            now: host.now,
            revalidate: (raw) => ({
              revalidationAttemptId: authority.revalidationAttemptId,
              revalidationAttemptGeneration: authority.revalidationAttemptGeneration,
              catalog: normalizeMcpRequesterDiscoveryOutput(
                receipt.serverId,
                extractMcpRequesterDiscoveryOutputInput(receipt.serverId, raw),
                scanner,
              ),
            }),
          });
        } catch (error) {
          const code = diagnostic(error);
          if (dispatched)
            return {
              ok: false,
              error: "Requester MCP outcome is unknown after dispatch; manual reconciliation is required.",
              externalOutcome: "unknown_after_send",
              manualReconciliationRequired: true,
              retrySafe: false,
              failurePhase: "post_dispatch",
              output: { requesterScoped: true, reasonCode: code },
            };
          return buildRequesterScopedPreDispatchFailure(input.toolName, code);
        } finally {
          attempt?.dispose();
        }
      },
    } satisfies RequesterScopedMcpDispatchPort,
  };
}
