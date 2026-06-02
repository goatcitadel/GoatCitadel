import type { McpServerRecord } from "@goatcitadel/contracts";
import type { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";

export interface GatewayMcpOAuthServiceOptions {
  tokenService: McpOAuthTokenService;
  readAuthState: () => Record<string, McpAuthStateRecord>;
  writeAuthState: (state: Record<string, McpAuthStateRecord>) => void;
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
    try {
      return await this.options.tokenService.exchangeAuthorizationCode(server, code, stateRecord);
    } catch (error) {
      const message = sanitizeMcpAuthError((error as Error).message);
      const authRows = this.options.readAuthState();
      authRows[server.serverId] = {
        ...(authRows[server.serverId] ?? stateRecord),
        error: message,
        updatedAt: new Date().toISOString(),
      };
      this.options.writeAuthState(authRows);
      throw new Error(message, { cause: error });
    }
  }

  public async resolveAccessToken(server: McpServerRecord): Promise<string | undefined> {
    if (server.authType !== "oauth2") {
      return undefined;
    }
    const authRows = this.options.readAuthState();
    try {
      const resolved = await this.options.tokenService.resolveAccessToken(server, authRows[server.serverId]);
      authRows[server.serverId] = resolved.state;
      this.options.writeAuthState(authRows);
      return resolved.accessToken;
    } catch (error) {
      authRows[server.serverId] = {
        ...(authRows[server.serverId] ?? { updatedAt: new Date().toISOString() }),
        error: sanitizeMcpAuthError((error as Error).message),
        updatedAt: new Date().toISOString(),
      };
      this.options.writeAuthState(authRows);
      throw error;
    }
  }
}

export function sanitizeMcpAuthError(message: string): string {
  return message
    .replace(
      /\b(Bearer|token|api[-_]?key|authorization|client_secret)\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{12,}@/g, "[REDACTED]@")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .slice(0, 1024);
}
