import { createHash, randomBytes, randomUUID } from "node:crypto";
import { discoverOAuthServerInfo, registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { redactSecretText, type McpServerRecord } from "@goatcitadel/contracts";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";

/**
 * Discovered authorization server for one MCP server, persisted in its auth-state record.
 * Holds endpoints and a public client id only; no secret is ever stored here.
 */
export interface McpAuthorizationServerRecord {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** RFC 8707 resource indicator sent on authorization, exchange and refresh. */
  resource: string;
  /** Redirect the client was registered or configured for; a different redirect needs a new registration. */
  redirectUri: string;
  discoveredAt: string;
}

const MCP_AUTHORIZATION_SERVER_KEYS = [
  "issuer",
  "authorizationEndpoint",
  "tokenEndpoint",
  "clientId",
  "resource",
  "redirectUri",
  "discoveredAt",
] as const;

const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_MAX_BYTES = 64 * 1024;
const PKCE_TTL_MS = 10 * 60 * 1000;

/** SDK fetch adapter: allowlisted, redirect-checked, time-bounded and size-bounded. */
export function createAllowlistedOAuthFetch(allowlist: string[]): FetchLike {
  return async (input, init) => {
    const response = await fetchAllowlisted(String(input), {
      allowlist,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      init: init ?? {},
    });
    const body = await readBoundedResponseText(response, {
      maxBytes: DISCOVERY_MAX_BYTES,
      timeoutMs: 5_000,
      label: "MCP OAuth discovery",
    });
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** What a client registration attempt is about; only public identifiers, never a secret. */
export interface McpClientRegistrationRequest {
  serverId: string;
  issuer: string;
  registrationEndpoint: string;
}

/**
 * Runs RFC 7591 registration, a side effect at the vendor, inside a durable boundary. `dispatch`
 * sends the one registration request; the boundary records its completed or unknown outcome.
 */
export type McpClientRegistrationBoundary = (
  request: McpClientRegistrationRequest,
  dispatch: () => Promise<OAuthClientInformationFull>,
) => Promise<OAuthClientInformationFull>;

/** Registration reached the vendor: a client may exist there even though sign-in cannot continue. */
export class McpClientRegistrationOutcomeError extends Error {
  public constructor(
    public readonly outcome: "unknown" | "confidential",
    message: string,
  ) {
    super(message);
    this.name = "McpClientRegistrationOutcomeError";
  }
}

export interface DiscoverMcpAuthorizationServerInput {
  server: Pick<McpServerRecord, "serverId" | "label" | "url">;
  redirectUri: string;
  scopes?: string[];
  /** Operator-configured client id; skips dynamic registration when present. */
  configuredClientId?: string;
  /** The last record for this server; its registered client is reused when issuer, resource and redirect match. */
  previous?: McpAuthorizationServerRecord;
  /** Durable boundary for client registration; production always supplies the side-effect ledger. */
  registrationBoundary?: McpClientRegistrationBoundary;
  fetchFn: FetchLike;
  now?: () => Date;
}

export interface DiscoveredMcpAuthorization {
  record: McpAuthorizationServerRecord;
  scope?: string;
}

/**
 * Finds the authorization server the way the MCP authorization spec describes, using the
 * official SDK helpers: RFC 9728 protected-resource metadata, then RFC 8414 / OIDC metadata,
 * then RFC 7591 registration of a public client when no client id is configured.
 */
export async function discoverMcpAuthorizationServer(
  input: DiscoverMcpAuthorizationServerInput,
): Promise<DiscoveredMcpAuthorization> {
  const label = input.server.label;
  const serverUrl = input.server.url?.trim();
  if (!serverUrl) throw new Error(`MCP server ${label} needs a URL before its sign-in can be discovered.`);
  assertSecureDiscoveryUrl(serverUrl, "server URL", label);
  const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: input.fetchFn });
  const metadata = info.authorizationServerMetadata;
  if (!metadata) {
    throw new Error(`MCP server ${label} does not publish OAuth authorization server metadata.`);
  }
  // Every discovered location must be HTTPS (or loopback), so a plain-HTTP hop cannot swap the sign-in page.
  assertSecureDiscoveryUrl(info.authorizationServerUrl, "authorization server", label);
  assertSecureDiscoveryUrl(metadata.issuer, "issuer", label);
  assertSecureDiscoveryUrl(metadata.authorization_endpoint, "authorization endpoint", label);
  assertSecureDiscoveryUrl(metadata.token_endpoint, "token endpoint", label);
  if (metadata.registration_endpoint)
    assertSecureDiscoveryUrl(metadata.registration_endpoint, "registration endpoint", label);
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error(`The sign-in provider for ${label} does not advertise PKCE S256, which MCP OAuth requires.`);
  }
  const resource = resolveResource(serverUrl, info.resourceMetadata?.resource, label);
  const scope = input.scopes?.length
    ? input.scopes.join(" ")
    : info.resourceMetadata?.scopes_supported?.length
      ? info.resourceMetadata.scopes_supported.join(" ")
      : undefined;
  const previous = input.previous;
  const reusable =
    !input.configuredClientId &&
    previous?.issuer === metadata.issuer &&
    previous.resource === resource &&
    previous.redirectUri === input.redirectUri;
  const clientId =
    input.configuredClientId ??
    (reusable && previous
      ? previous.clientId
      : await registerPublicClient(info.authorizationServerUrl, metadata, input, scope));
  return {
    record: {
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      clientId,
      resource,
      redirectUri: input.redirectUri,
      discoveredAt: (input.now?.() ?? new Date()).toISOString(),
    },
    ...(scope ? { scope } : {}),
  };
}

async function registerPublicClient(
  authorizationServerUrl: string,
  metadata: NonNullable<Awaited<ReturnType<typeof discoverOAuthServerInfo>>["authorizationServerMetadata"]>,
  input: DiscoverMcpAuthorizationServerInput,
  scope: string | undefined,
): Promise<string> {
  const label = input.server.label;
  if (!metadata.registration_endpoint) {
    throw new Error(
      `The sign-in provider for ${label} does not support automatic client registration. ` +
        "Set a client ID environment variable in this server's OAuth settings.",
    );
  }
  const dispatch = () =>
    registerClient(authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: "GoatCitadel",
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      scope,
      fetchFn: input.fetchFn,
    });
  const request = {
    serverId: input.server.serverId,
    issuer: metadata.issuer,
    registrationEndpoint: metadata.registration_endpoint,
  };
  const registered = input.registrationBoundary
    ? await input.registrationBoundary(request, dispatch)
    : await dispatch();
  if (registered.client_secret) {
    // A confidential client would need its secret in the OS keychain; v1 supports public clients only.
    throw new McpClientRegistrationOutcomeError(
      "confidential",
      `The sign-in provider for ${label} issued a confidential client, which the provider now holds. ` +
        "Configure client ID and secret environment variables for this server instead.",
    );
  }
  return registered.client_id;
}

type RegistrationLedgerStorage = Pick<
  AsyncStorage,
  "runImmediateTransaction" | "mutationIdempotency" | "externalSideEffectRuns"
>;

/**
 * The production registration boundary: each attempt is one run in the shared external side-effect
 * ledger, recorded completed, failed before sending, or unknown after sending. The ledger holds the
 * issuer, registration endpoint and the public client id only; a returned client secret never reaches it.
 */
export function createLedgeredMcpClientRegistration(storage: RegistrationLedgerStorage): McpClientRegistrationBoundary {
  return async (request, dispatch) => {
    let registered: OAuthClientInformationFull | undefined;
    const run = await runIdempotentExternalSideEffect({
      mutationStore: storage.mutationIdempotency,
      sideEffectRunStore: storage.externalSideEffectRuns,
      runClaimTransaction: (work) => storage.runImmediateTransaction(work),
      requireDurableBoundaryRecord: true,
      boundary: "mcp_oauth_client_registration",
      catalogId: "mcp",
      connectionId: request.serverId,
      actionId: "register_client",
      actorScope: request.serverId,
      idempotencyKey: `mcp-oauth-registration:${randomUUID()}`,
      checkedAt: new Date().toISOString(),
      payload: { issuer: request.issuer, registrationEndpoint: request.registrationEndpoint },
      label: "MCP OAuth client registration",
      execute: async (claim) => {
        await claim.markExternalCallStarted();
        registered = await dispatch();
        return { id: registered.client_id, confidential: Boolean(registered.client_secret) };
      },
    });
    if (run.status === "executed") {
      if (registered) return registered;
      throw new McpClientRegistrationOutcomeError("unknown", "Client registration finished without a response.");
    }
    const reason = redactSecretText(run.status === "failed" ? run.error.message : run.message).value.slice(0, 512);
    if (run.status === "failed" && run.claim.resumeState === "manual_review_unknown_external_outcome") {
      throw new McpClientRegistrationOutcomeError(
        "unknown",
        `Client registration was sent but its outcome is unknown (${reason}). The provider may now hold an unused client.`,
      );
    }
    throw new Error(`Client registration did not run: ${reason}`);
  };
}

function assertSecureDiscoveryUrl(value: string, what: string, label: string): void {
  if (!isCredentialFreeUrl(value, true)) {
    throw new Error(`The ${what} for ${label} must be a credential-free HTTPS URL (plain HTTP only on loopback).`);
  }
}

function resolveResource(serverUrl: string, advertised: string | undefined, label: string): string {
  const requested = resourceUrlFromServerUrl(serverUrl);
  if (!advertised) return requested.href;
  if (!checkResourceAllowed({ requestedResource: requested, configuredResource: advertised })) {
    throw new Error(`MCP server ${label} advertises protected-resource metadata for a different resource.`);
  }
  return advertised;
}

/** Strict shape check for a persisted record; unknown keys or non-HTTPS endpoints are rejected. */
export function isMcpAuthorizationServerRecord(value: unknown): value is McpAuthorizationServerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== MCP_AUTHORIZATION_SERVER_KEYS.length) return false;
  if (!MCP_AUTHORIZATION_SERVER_KEYS.every((key) => typeof record[key] === "string" && record[key])) return false;
  return (
    [record.authorizationEndpoint, record.tokenEndpoint].every((url) => isCredentialFreeUrl(url as string, true)) &&
    isCredentialFreeUrl(record.resource as string, false) &&
    isCredentialFreeUrl(record.redirectUri as string, false) &&
    Number.isFinite(Date.parse(record.discoveredAt as string))
  );
}

/** HTTPS, or plain HTTP on loopback only (OAuth 2.1 native-app allowance). */
function isCredentialFreeUrl(value: string, requireHttps: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return !requireHttps || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

interface PendingPkceFlow {
  state: string;
  verifier: string;
  expiresAt: number;
}

/**
 * In-memory PKCE verifiers, one pending flow per server. Verifiers never reach storage; a
 * Gateway restart mid-flow means the operator starts Connect again (OpenAI Codex OAuth precedent).
 */
export class McpOAuthPkceStore {
  private readonly flows = new Map<string, PendingPkceFlow>();

  public constructor(private readonly now: () => number = Date.now) {}

  /** A fresh verifier and its S256 challenge; nothing is kept until {@link remember}. */
  public create(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }

  /** Keeps the verifier for this server's flow, replacing any earlier one. Call only after the state is saved. */
  public remember(serverId: string, state: string, verifier: string): void {
    this.flows.set(serverId, { state, verifier, expiresAt: this.now() + PKCE_TTL_MS });
  }

  /** The verifier for this exact server and state, if the flow is still pending. */
  public read(serverId: string, state: string | undefined): string | undefined {
    const flow = this.flows.get(serverId);
    if (!flow) return undefined;
    if (flow.expiresAt <= this.now()) {
      this.flows.delete(serverId);
      return undefined;
    }
    return state && flow.state === state ? flow.verifier : undefined;
  }

  public discard(serverId: string): void {
    this.flows.delete(serverId);
  }
}

export const mcpOAuthPkceStore = new McpOAuthPkceStore();
