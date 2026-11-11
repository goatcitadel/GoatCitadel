import { randomUUID } from "node:crypto";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";

const INVALID_TOKEN_EXPIRY = "MCP OAuth token endpoint returned an invalid expiry.";

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
  const nowMs = Date.now();
  const tokenExpiresAt = resolveTokenExpiresAt(response, nowMs);
  const now = new Date(nowMs).toISOString();
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
    tokenExpiresAt,
    scopes: normalizeScopes(response.scope) ?? previous.scopes,
    resourceIndicator: `mcp://${serverId}`,
    updatedAt: now,
    lastRefreshedAt: now,
    error: undefined,
  };
}

function resolveTokenExpiresAt(response: TokenResponse, nowMs: number): string | undefined {
  const expiresAt = response.expires_at ?? "";
  if (typeof expiresAt !== "string") throw new Error(INVALID_TOKEN_EXPIRY);
  const timestamp = expiresAt.trim();
  if (timestamp) {
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error(INVALID_TOKEN_EXPIRY);
    return timestamp;
  }
  const expiresIn = response.expires_in;
  if (expiresIn === undefined || expiresIn === null) return undefined;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) throw new Error(INVALID_TOKEN_EXPIRY);
  const expiry = new Date(nowMs + expiresIn * 1000);
  if (!Number.isFinite(expiry.getTime())) throw new Error(INVALID_TOKEN_EXPIRY);
  return expiry.toISOString();
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
