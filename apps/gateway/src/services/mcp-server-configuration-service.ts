import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, resolveMcpServerConnectionMode, type McpServerRecord } from "@goatcitadel/contracts";
import type { McpServerStoreCtx } from "./mcp-server-store.js";
import type { McpAuthStateRecord, McpAuthStateUpdate, McpOAuthRequestReservation, McpOAuthTokenRequest } from "./mcp-server-admin-service.js";
import { callerOwnedServers, assertUniqueServers, sameConfiguration, assertConfigurationSnapshot } from "./mcp-server-state-helpers.js";
import { buildGatewayOwnedInternalMcpServers } from "./mcp-server-read-service.js";
import { buildPublicMcpAuthState } from "./mcp-oauth-token-service.js";
import { assertMcpServerReview, mcpServerRevision, mcpServerReviewConflict, newMcpServerRevision, type McpServerWriteReview } from "./mcp-server-revision.js";
interface McpConfigurationWritePort {
  mutateServers(update: (current: McpServerRecord[]) => McpServerRecord[]): Promise<McpServerRecord[]>;
  removeServerState(ids: string[]): Promise<void>;
  removeFirstApprovals(ids: string[]): Promise<void>;
  removeTools(ids: string[]): Promise<void>;
  readAuthState(): Promise<Record<string, McpAuthStateRecord>>;
}
interface McpOAuthReservationPort {
  requireServer(id: string): Promise<McpServerRecord>;
  ensureStaticConfigurationBinding(id: string): Promise<McpServerRecord>;
  writeAuthState(input: McpAuthStateUpdate): Promise<void>;
}

export async function writeMcpServerConfiguration(ctx: McpServerStoreCtx, port: McpConfigurationWritePort, servers: McpServerRecord[], expectedServers: McpServerRecord[], review?: McpServerWriteReview): Promise<McpServerRecord[]> {
    if (!Array.isArray(expectedServers))
      throw new ConflictError({ message: "MCP configuration snapshot is required." });
    const desired = callerOwnedServers(structuredClone(servers));
    const expected = callerOwnedServers(structuredClone(expectedServers));
    assertUniqueServers(desired);
    assertUniqueServers(expected);
    return await ctx.runImmediateTransaction(async () => {
      let removed: string[] = [];
      let invalidated: string[] = [];
      let disconnected: string[] = [];
      const savedServers = await port.mutateServers((current) => {
        assertConfigurationSnapshot(current, expected);
        if (current.some((server) => mcpServerRevision(server) !== mcpServerRevision(expected.find((item) => item.serverId === server.serverId)!))) throw mcpServerReviewConflict();
        if (review) {
          const target = current.find((server) => server.serverId === review.serverId);
          if (!target) throw new NotFoundError(`Unknown MCP server: ${review.serverId}`);
          assertMcpServerReview(target, review.expectedRevision);
        }
        invalidated = [];
        disconnected = [];
        removed = current
          .filter((server) => !desired.some((item) => item.serverId === server.serverId))
          .map((server) => server.serverId);
        return desired.map((server) => {
          const previous = current.find((item) => item.serverId === server.serverId);
          const saved = { ...server };
          delete saved.authState;
          delete saved.configurationBindingId;
          const changed = !previous || !sameConfiguration(previous, server);
          const edited = changed || review?.serverId === server.serverId;
          saved.revision = edited || !previous?.revision ? newMcpServerRevision() : previous.revision;
          saved.connectionRevision = previous?.connectionRevision;
          if (resolveMcpServerConnectionMode(saved) === "static") {
            saved.configurationBindingId =
              previous && sameConfiguration(previous, server)
                ? (previous.configurationBindingId ?? randomUUID())
                : randomUUID();
          }
          // Untouched servers keep concurrent runtime updates. An edited configuration
          // starts disconnected and fences every outstanding discovery attempt.
          if (previous) {
            saved.status = edited ? "disconnected" : previous.status;
            saved.lastConnectedAt = previous.lastConnectedAt;
            saved.lastError = edited ? undefined : previous.lastError;
            if (edited) {
              saved.connectionRevision = newMcpServerRevision();
              disconnected.push(previous.serverId);
            }
            if (previous.configurationBindingId !== saved.configurationBindingId) invalidated.push(previous.serverId);
          }
          return saved;
        });
      });
      if (removed.length) await port.removeServerState(removed);
      if (invalidated.length) await port.removeFirstApprovals(invalidated);
      if (disconnected.length) await port.removeTools(disconnected);
      const authRows = await port.readAuthState();
      return [...buildGatewayOwnedInternalMcpServers(authRows), ...savedServers.map((server) => ({
        ...server, revision: mcpServerRevision(server), authState: buildPublicMcpAuthState(server, authRows[server.serverId]),
      }))];
    });
  }

export async function reserveMcpOAuthRequest(ctx: McpServerStoreCtx, port: McpOAuthReservationPort, 
    server: McpServerRecord,
    expected: McpAuthStateRecord | undefined,
    kind: McpOAuthTokenRequest["kind"],
  ): Promise<McpOAuthRequestReservation> {
    const input = structuredClone({ server, expected, kind });
    return ctx.runImmediateTransaction(async () => {
      const current = await port.requireServer(input.server.serverId);
      assertConfigurationSnapshot([current], [input.server]);
      const configuration = current.configurationBindingId
        ? current
        : await port.ensureStaticConfigurationBinding(current.serverId);
      if (!sameConfiguration(current, configuration)) {
        throw new ConflictError({ message: "MCP configuration changed before OAuth reservation." });
      }
      const prior = input.expected?.tokenRequest;
      if (prior && (prior.kind !== kind || prior.configurationBindingId !== configuration.configurationBindingId)) {
        throw new ConflictError({
          message: "MCP OAuth has an unresolved request; reconnect this server from Settings.",
        });
      }
      const now = new Date().toISOString();
      const auth = {
        ...input.expected,
        updatedAt: input.expected?.updatedAt ?? now,
        tokenRequest: prior ?? {
          requestId: randomUUID(),
          kind,
          configurationBindingId: configuration.configurationBindingId!,
          reservedAt: now,
        },
      };
      await port.writeAuthState({ server: configuration, expected: input.expected, next: auth });
      return { server: configuration, auth };
    });
  }
