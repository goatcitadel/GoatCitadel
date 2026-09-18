import { redactSecretText, type McpServerRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { cleanupPublishedMcpOAuthCredentials } from "./mcp-oauth-publication-cleanup.js";
import type { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import type { McpAuthStateRecord, McpOAuthTokenRequest } from "./mcp-server-admin-service.js";
import type { McpServerStore } from "./mcp-server-store.js";
import {
  markIdempotentExternalSideEffectCompleted,
  runIdempotentExternalSideEffect,
} from "./external-side-effect-runner-service.js";

export interface GatewayMcpOAuthServiceOptions {
  tokenService: McpOAuthTokenService;
  registry: Pick<McpServerStore, "readAuthState" | "writeAuthState" | "reserveAuthRequest">;
  storage: Pick<AsyncStorage, "runImmediateTransaction" | "mutationIdempotency" | "externalSideEffectRuns">;
  reconcileRetiredCredentials?: () => Promise<void>;
}

/**
 * Governance wrapper around {@link McpOAuthTokenService} that persists the per-server
 * auth-state record and sanitizes provider error text before it is surfaced to operators.
 *
 * Extracted from `GatewayService` so the gateway monolith stays within its architecture
 * baseline; the persistence/sanitization concern lives here rather than on the gateway.
 */
export class GatewayMcpOAuthService {
  public constructor(private readonly options: GatewayMcpOAuthServiceOptions) {}

  public async exchangeAuthorizationCode(
    server: McpServerRecord,
    code: string,
    stateRecord: McpAuthStateRecord,
  ): Promise<McpAuthStateRecord> {
    return this.runTokenRequest(server, stateRecord, "authorization_code", (configuration, expected, beforeRequest) =>
      this.options.tokenService.exchangeAuthorizationCode(configuration, code, expected, beforeRequest),
    );
  }

  public async resolveAccessToken(server: McpServerRecord): Promise<string | undefined> {
    if (server.authType !== "oauth2") {
      return undefined;
    }
    const configuration = structuredClone(server);
    const expected = structuredClone((await this.options.registry.readAuthState())[server.serverId]);
    if (!expected?.tokenRequest) {
      const current = this.options.tokenService.readCurrentAccessToken(configuration, expected);
      if (current) {
        // Fence even a read against configuration/auth changes before returning the credential.
        await this.options.registry.writeAuthState({ server: configuration, expected, next: current.state });
        return current.accessToken;
      }
    }
    let accessToken: string | undefined;
    await this.runTokenRequest(configuration, expected, "refresh_token", async (current, auth, beforeRequest) => {
      const resolved = await this.options.tokenService.resolveAccessToken(current, auth, beforeRequest);
      accessToken = resolved.accessToken;
      return resolved.state;
    });
    return accessToken;
  }

  private async runTokenRequest(
    server: McpServerRecord,
    expected: McpAuthStateRecord | undefined,
    kind: McpOAuthTokenRequest["kind"],
    execute: (
      server: McpServerRecord,
      auth: McpAuthStateRecord,
      beforeRequest: () => Promise<void>,
    ) => Promise<McpAuthStateRecord>,
  ): Promise<McpAuthStateRecord> {
    const { registry, storage } = this.options;
    const reservation = await registry.reserveAuthRequest(server, expected, kind);
    const request = reservation.auth.tokenRequest;
    let published: McpAuthStateRecord | undefined;
    const run = await runIdempotentExternalSideEffect({
      mutationStore: storage.mutationIdempotency,
      sideEffectRunStore: storage.externalSideEffectRuns,
      runClaimTransaction: (callback) => storage.runImmediateTransaction(callback),
      requireDurableBoundaryRecord: true,
      requireMutationClaimOwnership: true,
      boundary: "mcp_oauth_token",
      catalogId: "mcp",
      connectionId: reservation.server.serverId,
      actionId: kind,
      actorScope: reservation.server.serverId,
      idempotencyKey: request.requestId,
      checkedAt: new Date().toISOString(),
      // Never hash or mirror authorization codes, tokens, credential refs or URLs in the generic ledger.
      payload: { requestId: request.requestId, kind, configurationBindingId: request.configurationBindingId },
      label: "MCP OAuth token request",
      execute: async (claim) => {
        try {
          return await execute(reservation.server, reservation.auth, () =>
            storage.runImmediateTransaction(async () => {
              await registry.writeAuthState({
                server: reservation.server,
                expected: reservation.auth,
                next: reservation.auth,
              });
              await claim.markExternalCallStarted();
            }),
          );
        } catch (error) {
          // eslint-disable-next-line preserve-caught-error -- Raw transport causes can contain credentials; only the redacted diagnostic may reach the ledger.
          throw new Error(
            sanitizeMcpAuthError(error instanceof Error ? error.message : "MCP OAuth token request failed."),
          );
        }
      },
      commitCompleted: async (claim, state) => {
        const next = { ...state, tokenRequest: undefined };
        await storage.runImmediateTransaction(async () => {
          await registry.writeAuthState({ server: reservation.server, expected: reservation.auth, next });
          await markIdempotentExternalSideEffectCompleted(storage.mutationIdempotency, claim, new Date().toISOString());
          if (!claim.sideEffectRunId) throw new Error("MCP OAuth completion requires its durable request ledger.");
          await storage.externalSideEffectRuns.markCompleted(claim.sideEffectRunId, {
            responsePayload: { requestId: request.requestId, kind, published: true },
          });
        });
        published = next;
      },
    });
    if (run.status !== "executed" || !published) {
      // Keep the reservation. The shared ledger alone decides whether a retry is safe.
      // A duplicate/uncertain request must not invalidate the winning publication with a diagnostic write.
      const detail =
        run.status === "failed"
          ? sanitizeMcpAuthError(run.error.message)
          : run.status === "blocked"
            ? run.message
            : "Canonical publication was not acknowledged.";
      throw new Error(
        `MCP OAuth token request did not finish: ${detail} Reconnect this server from Settings if recovery is required.`,
      );
    }
    await cleanupPublishedMcpOAuthCredentials(this.options, reservation.server.serverId, expected, published);
    return published;
  }
}

export function sanitizeMcpAuthError(message: string): string {
  return redactSecretText(message).value.slice(0, 1024);
}
