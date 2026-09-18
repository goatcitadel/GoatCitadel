import { randomUUID } from "node:crypto";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: string;
  scope?: string;
  token_type?: string;
}

interface McpOAuthTokenPersistenceDependencies {
  readonly secretStore: {
    setSecret(account: string, secret: string): void;
    setSecretForCustody?(account: string, secret: string, custodyId: string, writeId?: string): void;
    supportsCredentialWriteReceipts?(): boolean;
  };
  readonly stageCredentials?: (
    serverId: string,
    refs: readonly string[],
    write: (custodyId?: string, writeId?: string) => undefined,
  ) => Promise<void>;
}

/** Stage versioned token slots before publishing references. Lost staging acknowledgement
 * retains the registered slots for durable reconciliation instead of deleting them. */
export async function persistMcpOAuthTokenResponse(
  deps: McpOAuthTokenPersistenceDependencies,
  serverId: string,
  response: TokenResponse,
  previous: McpAuthStateRecord,
  discardUnpublishedAccounts: (accounts: Set<string>) => void,
): Promise<McpAuthStateRecord> {
  const now = new Date().toISOString();
  const version = `${deps.stageCredentials && deps.secretStore.supportsCredentialWriteReceipts?.() ? "receipt-v1:" : ""}${randomUUID()}`;
  const accessAccount = `${accessTokenAccount(serverId)}:${version}`;
  const refreshAccount = `${refreshTokenAccount(serverId)}:${version}`;
  const refreshToken = response.refresh_token?.trim();
  const write = (custodyId?: string, writeId?: string): undefined => {
    const save = (account: string, value: string): void => {
      if (custodyId === undefined) deps.secretStore.setSecret(account, value);
      else {
        if (!deps.secretStore.setSecretForCustody) throw new Error("MCP credential writer requires its OS custody owner.");
        if (writeId === undefined) deps.secretStore.setSecretForCustody(account, value, custodyId);
        else deps.secretStore.setSecretForCustody(account, value, custodyId, writeId);
      }
    };
    save(accessAccount, response.access_token!.trim());
    if (refreshToken) save(refreshAccount, refreshToken);
  };
  try {
    if (deps.stageCredentials) {
      await deps.stageCredentials(serverId,
        [tokenRefFromAccount(accessAccount), ...(refreshToken ? [tokenRefFromAccount(refreshAccount)] : [])], write);
    } else write();
  } catch (error) {
    // Composed writes retain their exact terminal/unknown state for durable cleanup.
    if (!deps.stageCredentials) discardUnpublishedAccounts(new Set([accessAccount, refreshAccount]));
    throw error;
  }
  return {
    ...previous,
    accessTokenRef: tokenRefFromAccount(accessAccount),
    refreshTokenRef: refreshToken ? tokenRefFromAccount(refreshAccount) : previous.refreshTokenRef,
    tokenExpiresAt: resolveTokenExpiresAt(response),
    scopes: normalizeScopes(response.scope) ?? previous.scopes,
    resourceIndicator: `mcp://${serverId}`,
    updatedAt: now,
    lastRefreshedAt: now,
    error: undefined,
  };
}

function resolveTokenExpiresAt(response: TokenResponse): string | undefined {
  if (response.expires_at?.trim()) {
    return response.expires_at.trim();
  }
  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
    return new Date(Date.now() + response.expires_in * 1000).toISOString();
  }
  return undefined;
}

function normalizeScopes(scope?: string): string[] | undefined {
  const scopes = scope
    ?.split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return scopes?.length ? scopes : undefined;
}

export function accessTokenAccount(serverId: string): string {
  return `mcp:${serverId}:access-token`;
}

export function refreshTokenAccount(serverId: string): string {
  return `mcp:${serverId}:refresh-token`;
}

function tokenRefFromAccount(account: string): string {
  return `keychain:goatcitadel:${account}`;
}
