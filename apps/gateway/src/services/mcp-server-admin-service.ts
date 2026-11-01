import {
  prepareReviewedMcpOAuthDiscovery,
  startMcpOAuth as startMcpOAuthHandshake,
} from "./mcp-oauth-handshake-service.js";
import { randomUUID } from "node:crypto";
import type {
  McpApprovalPosture,
  McpToolRecord,
  McpOAuthConfig,
  McpServerCreateInput,
  McpServerPolicy,
  McpServerRecord,
  McpServerUpdateInput,
} from "@goatcitadel/contracts";
import { redactSecretText, resolveMcpServerConnectionMode } from "@goatcitadel/contracts";
import { ValidationError, NotFoundError } from "@goatcitadel/contracts";
import { assertMcpServerReview, mcpServerRevision, type McpServerWriteReview } from "./mcp-server-revision.js";
import {
  assertReviewedStaticServer,
  assertReviewedMcpOAuth,
  type McpConnectionActionReview,
  type McpOAuthExchangeReview,
} from "./mcp-reviewed-connection.js";
import { assertMcpConnectionReview } from "./mcp-server-revision.js";
import { sameConfiguration } from "./mcp-server-state-helpers.js";
import { buildPublicMcpAuthState } from "./mcp-oauth-token-service.js";
import { isDeepStrictEqual } from "node:util";
import type { McpConnectionFence } from "./mcp-static-environment-service.js";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { ToolPolicyActorContext } from "@goatcitadel/contracts";
import { inferMcpCategory, normalizeMcpPolicy } from "./mcp-server-policy.js";
import { isMoneyMovingCatalogServer } from "./mcp-money-moving.js";
import { assertMcpServerEditAllowed, assertMcpServerRemovalAllowed, type PluginPass } from "./plugin-owned-refusal.js";
import { discoverMcpTools } from "./mcp-runtime.js";
import {
  mcpOAuthPkceStore,
  type DiscoveredMcpAuthorization,
  type McpAuthorizationServerRecord,
} from "./mcp-oauth-discovery.js";
import { createInternalMcpApprovalInboxTools, isInternalMcpApprovalInboxServer } from "./mcp-approval-inbox.js";
import { createInternalMcpDurableTasksTools, isInternalMcpDurableTasksServer } from "./mcp-durable-tasks.js";
import {
  buildInternalMcpServerCreateBlockedMessage,
  buildUnsupportedMcpTransportMessage,
  isAllowedMcpDefinitionForCallerCreate,
  isInternalMcpServerUrl,
  isRuntimeSupportedMcpDefinition,
} from "./mcp-template-visibility.js";

export interface McpAuthStateRecord {
  accessTokenRef?: string;
  refreshTokenRef?: string;
  tokenExpiresAt?: string;
  oauthState?: string;
  scopes?: string[];
  /**
   * MCP v2 resource indicator: the resource server this token is scoped to. Makes
   * the per-server token scoping explicit/auditable so a token minted for one MCP
   * server is not reused against another (resource-indicator semantics).
   */
  resourceIndicator?: string;
  /** Endpoints and public client id found by metadata discovery; never a secret. */
  authorizationServer?: McpAuthorizationServerRecord;
  updatedAt: string;
  lastRefreshedAt?: string;
  error?: string;
  lastCodePreview?: string;
  tokenRequest?: McpOAuthTokenRequest;
}

export interface McpOAuthTokenRequest {
  requestId: string;
  kind: "authorization_code" | "refresh_token";
  configurationBindingId: string;
  reservedAt: string;
}

export interface McpOAuthRequestReservation {
  server: McpServerRecord;
  auth: McpAuthStateRecord & { tokenRequest: McpOAuthTokenRequest };
}

/** One server's auth publication, bound to the configuration and auth state that produced it. */
export interface McpAuthStateUpdate {
  server: McpServerRecord;
  expected: McpAuthStateRecord | undefined;
  next: McpAuthStateRecord | undefined;
  fence?: McpConnectionFence;
}

export interface McpServerAdminHost {
  readonly storage: {
    approvalInbox: Pick<Storage["approvalInbox"], "deleteByReceiver">;
  };
  readMcpServers(): Promise<McpServerRecord[]>;
  writeMcpServers(
    servers: McpServerRecord[],
    expectedServers: McpServerRecord[],
    review?: McpServerWriteReview,
  ): Promise<McpServerRecord[]>;
  captureMcpServerSessionCloser?(serverId: string): () => void;
  prepareMcpStaticEnvironment?(server: McpServerRecord, fence?: McpConnectionFence): Promise<McpServerRecord>;
  resolveMcpOAuthClientId?(server: McpServerRecord, fence?: McpConnectionFence): Promise<string | undefined>;
  discoverMcpOAuthAuthorization?(
    server: McpServerRecord,
    input: { redirectUri: string; scopes?: string[]; configuredClientId?: string },
  ): Promise<DiscoveredMcpAuthorization>;
  patchMcpServerState(
    serverId: string,
    patch: Partial<McpServerRecord>,
    expected: McpServerRecord,
  ): Promise<McpServerRecord>;
  completeMcpServerConnection(expected: McpServerRecord, tools: McpToolRecord[]): Promise<McpServerRecord>;
  readMcpTools(): Promise<McpToolRecord[]>;
  writeMcpTools(tools: McpToolRecord[]): Promise<void>;
  resolveConnectedMcpTools(
    server: McpServerRecord,
    existing: McpToolRecord[],
    fence?: McpConnectionFence,
  ): Promise<McpToolRecord[]>;
  exchangeMcpOAuthCode?(
    server: McpServerRecord,
    code: string,
    stateRecord: McpAuthStateRecord,
    review?: McpOAuthExchangeReview,
  ): Promise<McpAuthStateRecord>;
  requireMcpServer(serverId: string): Promise<McpServerRecord>;
  readMcpAuthState(): Promise<Record<string, McpAuthStateRecord>>;
  writeMcpAuthState(update: McpAuthStateUpdate): Promise<void>;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Appends one operator record to the approvals audit stream. */
  appendApprovalsAudit(event: Record<string, unknown>): Promise<void>;
}

/** A write bound to the revision the operator reviewed. `actorId` names who made it, for the audit record. */
export interface McpServerEditReview {
  expectedRevision: string;
  onCommitted?: () => void | Promise<void>;
  actorId?: string;
}

/**
 * `pluginOwner` is set only by the plugin service's install, which is its only caller with it: a plain create never
 * marks a server. A marked server is read-only to every other editor (`assertMcpServerEditAllowed`).
 */
export async function createMcpServer(
  host: McpServerAdminHost,
  input: McpServerCreateInput,
  ownerServerId?: string,
  ownerPlanId?: string,
  onCommitted?: () => void | Promise<void>,
  pluginOwner?: McpServerRecord["pluginOwner"],
): Promise<McpServerRecord> {
  if (isInternalMcpServerUrl(input.url)) {
    throw new ValidationError({ message: buildInternalMcpServerCreateBlockedMessage() });
  }
  if (!isAllowedMcpDefinitionForCallerCreate(input)) {
    throw new ValidationError({ message: buildUnsupportedMcpTransportMessage(input.transport) });
  }
  const now = new Date().toISOString();
  if (
    ownerServerId &&
    (!/^pack-[a-f0-9]{40}$/u.test(ownerServerId) ||
      (await host.readMcpServers()).some((server) => server.serverId === ownerServerId))
  ) {
    throw new Error("Pack MCP identity is invalid or already registered.");
  }
  const created: McpServerRecord = {
    serverId: ownerServerId ?? randomUUID(),
    ...(ownerServerId && ownerPlanId
      ? {
          packChange: { planId: ownerPlanId, revision: 1, phase: "apply" as const, created: true },
        }
      : {}),
    ...(pluginOwner ? { pluginOwner: { ...pluginOwner } } : {}),
    label: input.label.trim(),
    transport: input.transport,
    command: input.command?.trim() || undefined,
    args: input.args?.map((item) => item.trim()).filter(Boolean),
    url: input.url?.trim() || undefined,
    authType: input.authType ?? "none",
    oauth: normalizeMcpOAuthConfig(input.oauth),
    enabled: input.enabled ?? true,
    category: input.category ?? inferMcpCategory(input.transport),
    trustTier: input.trustTier ?? "restricted",
    costTier: input.costTier ?? "unknown",
    policy: normalizeMcpPolicy(input.policy),
    verifiedAt: input.verifiedAt,
    status: "disconnected",
    createdAt: now,
    updatedAt: now,
  };
  assertMcpApprovalPostureAllowed(created, created.policy.approvalPosture, undefined);
  const previous = await host.readMcpServers();
  const servers = [created, ...previous];
  const committed = await host.writeMcpServers(servers, previous);
  const acknowledgement = committed.find((server) => server.serverId === created.serverId)!;
  await afterMcpCommit(onCommitted, async () => {
    await host.publishRealtime("system", "mcp", {
      type: "mcp_server_created",
      serverId: created.serverId,
      transport: created.transport,
    });
  });
  return acknowledgement;
}

/**
 * A server a plugin added only switches on or off here, unless the plugin service passes its own `pluginPass`. Every
 * other edit, its approval setting included, is refused with `PluginOwnedError`, decided from the record it loads.
 * `releasePluginOwner`, with that same pass, also clears the plugin's mark, so the server becomes the operator's own.
 */
export async function updateMcpServer(
  host: McpServerAdminHost,
  serverId: string,
  input: McpServerUpdateInput,
  packOwner?: { planId: string; phase: "apply" | "compensate" },
  review?: McpServerEditReview,
  pluginPass?: PluginPass,
  releasePluginOwner = false,
): Promise<McpServerRecord> {
  if (isInternalMcpServerUrl(input.url)) {
    throw new ValidationError({ message: buildInternalMcpServerCreateBlockedMessage() });
  }
  const now = new Date().toISOString();
  let updated: McpServerRecord | undefined;
  const previous = await host.readMcpServers();
  const original = previous.find((server) => server.serverId === serverId);
  if (!original) throw new NotFoundError(`Unknown MCP server: ${serverId}`);
  assertMcpServerEditAllowed(original, input, pluginPass);
  // Releasing a plugin's mark takes that plugin's own pass, whatever else the edit changes.
  if (releasePluginOwner) assertMcpServerRemovalAllowed(original, pluginPass);
  if (review) assertMcpServerReview(original, review.expectedRevision);
  const closeOwnedSessions = host.captureMcpServerSessionCloser?.(serverId);
  const servers = previous.map((item) => {
    if (item.serverId !== serverId) {
      return item;
    }
    const { pluginOwner: _released, ...unmarked } = item;
    updated = {
      ...(releasePluginOwner ? unmarked : item),
      packChange: packOwner
        ? {
            planId: packOwner.planId,
            revision: item.packChange?.planId === packOwner.planId ? item.packChange.revision + 1 : 1,
            phase: packOwner.phase,
            created: item.packChange?.planId === packOwner.planId && item.packChange.created,
          }
        : undefined,
      label: input.label?.trim() || item.label,
      command: input.command === undefined ? item.command : input.command.trim() || undefined,
      args: input.args === undefined ? item.args : input.args.map((entry) => entry.trim()).filter(Boolean),
      url: input.url === undefined ? item.url : input.url.trim() || undefined,
      authType: input.authType ?? item.authType,
      oauth: input.oauth === undefined ? item.oauth : normalizeMcpOAuthConfig(input.oauth),
      enabled: input.enabled ?? item.enabled,
      category: input.category ?? item.category,
      trustTier: input.trustTier ?? item.trustTier,
      costTier: input.costTier ?? item.costTier,
      policy: input.policy ? normalizeMcpPolicy({ ...item.policy, ...input.policy }) : item.policy,
      verifiedAt: input.verifiedAt ?? item.verifiedAt,
      updatedAt: now,
    };
    // Checked against the record as it would be saved, so a rename or new endpoint in the same edit counts too.
    assertMcpApprovalPostureAllowed(updated, input.policy?.approvalPosture, item);
    return updated;
  });
  if (!updated) {
    throw new Error(`Unknown MCP server: ${serverId}`);
  }
  const committed = await host.writeMcpServers(servers, previous, {
    serverId,
    expectedRevision: review?.expectedRevision ?? mcpServerRevision(original),
  });
  const acknowledgement = committed.find((server) => server.serverId === serverId)!;
  await afterMcpCommit(review?.onCommitted, async () => {
    // A change to what asks first is audited once the write has committed, before any follow-up work that could fail.
    // A refused or conflicting write never gets here, so it records nothing. The edit has committed either way, so
    // sessions on a replaced connection still close if the audit write fails. The write rotates the connection
    // version exactly when it disconnects the server; an edit that only changed what asks first keeps the
    // connection, so its live sessions stay open.
    try {
      await auditApprovalPostureChange(host, original, acknowledgement, input.policy?.approvalPosture, review?.actorId);
    } finally {
      if (acknowledgement.connectionRevision !== original.connectionRevision) closeOwnedSessions?.();
    }
  });
  return acknowledgement;
}

/**
 * Hands a plugin's server to the operator: its plugin mark is cleared and nothing else changes, so a later edit or
 * removal is the operator's own. Only that plugin's own pass may (an uninstall that leaves the server to another plugin
 * that kept it).
 */
export async function releaseMcpServerFromPlugin(
  host: McpServerAdminHost,
  serverId: string,
  pluginPass: PluginPass,
): Promise<McpServerRecord> {
  return await updateMcpServer(host, serverId, {}, undefined, undefined, pluginPass, true);
}

export async function updateMcpServerPolicy(
  host: McpServerAdminHost,
  serverId: string,
  policy: Partial<McpServerPolicy>,
  review?: McpServerEditReview,
  pluginPass?: PluginPass,
): Promise<McpServerRecord> {
  return await updateMcpServer(host, serverId, { policy }, undefined, review, pluginPass);
}

export async function connectMcpServer(
  host: McpServerAdminHost,
  serverId: string,
  review?: McpConnectionActionReview,
): Promise<McpServerRecord> {
  const expected = review
    ? { expectedRevision: review.expectedRevision, expectedConnectionRevision: review.expectedConnectionRevision }
    : undefined;
  let server = await host.requireMcpServer(serverId);
  if (expected) assertReviewedStaticServer(server, expected);
  // Requester-scoped transports never mutate global connection state or inventory.
  if (resolveMcpServerConnectionMode(server) === "requester_scoped")
    throw new Error(
      "Requester-scoped MCP servers require an authenticated requester context and cannot be connected or discovered globally.",
    );
  if (!isRuntimeSupportedMcpDefinition(server)) throw new Error(buildUnsupportedMcpTransportMessage(server.transport));
  const claim = (observed: McpServerRecord) =>
    host.patchMcpServerState(serverId, { status: "connecting", lastError: undefined }, observed);
  // The guarded path consumes review before environment work. Legacy enrollment order is retained.
  let connecting = expected ? await claim(server) : undefined;
  const fence = connecting?.connectionRevision
    ? Object.freeze({ expectedConnectionRevision: connecting.connectionRevision })
    : undefined;
  try {
    if (expected) {
      await review?.onCommitted?.();
      if (!fence) throw new Error("MCP connection admission did not return its generation.");
      server = connecting!;
    }
    if (host.prepareMcpStaticEnvironment)
      server = fence
        ? await host.prepareMcpStaticEnvironment(server, fence)
        : await host.prepareMcpStaticEnvironment(server);
    // Enrollment may rotate configuration authority; it must never adopt a replacement connection attempt.
    if (fence && server.connectionRevision !== fence.expectedConnectionRevision)
      throw new Error("MCP connection admission was superseded.");
    connecting = connecting ? server : await claim(server);
    const existing = (await host.readMcpTools()).filter((item) => item.serverId === serverId);
    const tools = fence
      ? await host.resolveConnectedMcpTools(connecting, existing, fence)
      : await host.resolveConnectedMcpTools(connecting, existing);
    return await host.completeMcpServerConnection(connecting, tools);
  } catch (cause) {
    if (!connecting) throw cause;
    const patchFailure = () =>
      host.patchMcpServerState(
        serverId,
        {
          status: "error",
          lastError: expected ? reviewedConnectFailure(cause) : (cause as Error).message,
        },
        connecting!,
      );
    if (!expected) {
      await patchFailure();
      throw cause;
    }
    // Own admission is canonical. A replacement generation must never receive this late result.
    try {
      await patchFailure();
    } catch {
      /* Preserve the committed failure; the replacement owns its state. */
    }
    const error = cause instanceof Error ? cause : new Error("MCP connection outcome requires inspection.");
    Object.assign(error, { mutationCommitted: true });
    throw error;
  }
}

/** Code points of a reviewed connect's own cause kept in the server's last error. */
const REVIEWED_FAILURE_MAX = 500;

/**
 * Why a reviewed connect stopped, as the server's last error: the cause's own words (with the start of a local
 * server's stderr, when it exited) on one line, secret-redacted and bounded, so the operator can see what to fix.
 */
function reviewedConnectFailure(cause: unknown): string {
  // Redacted line by line first, so a secret's header can't take the rest of the stderr with it.
  const redacted = cause instanceof Error ? redactSecretText(cause.message).value : "";
  const reason = redacted.replace(/[\s\p{Cc}]+/gu, " ").trim();
  const kept = Array.from(reason).slice(0, REVIEWED_FAILURE_MAX).join("").trim();
  return kept
    ? `Reviewed MCP connection did not complete: ${kept}`
    : "Reviewed MCP connection did not complete. Inspect the current server before retrying.";
}

export async function disconnectMcpServer(
  host: McpServerAdminHost,
  serverId: string,
  review?: McpConnectionActionReview,
  validateBeforeAdmission?: (server: McpServerRecord) => void,
): Promise<McpServerRecord> {
  const expected = review
    ? { expectedRevision: review.expectedRevision, expectedConnectionRevision: review.expectedConnectionRevision }
    : undefined;
  const previous = await host.requireMcpServer(serverId);
  if (expected) assertReviewedStaticServer(previous, expected);
  validateBeforeAdmission?.(previous);
  // Capture before publication; a replacement session must never be looked up after await.
  const closeOwnedSessions = host.captureMcpServerSessionCloser?.(serverId);
  const server = await host.patchMcpServerState(serverId, { status: "disconnected" }, previous);
  if (expected)
    await afterMcpCommit(review?.onCommitted, () => {
      closeOwnedSessions?.();
    });
  else closeOwnedSessions?.();
  return server;
}

export async function startMcpOAuth(host: McpServerAdminHost, serverId: string, review?: McpConnectionActionReview) {
  if (!review) return startMcpOAuthHandshake(host, serverId);
  const expected = {
    expectedRevision: review.expectedRevision,
    expectedConnectionRevision: review.expectedConnectionRevision,
  };
  // Metadata discovery reads only, so it runs before the review commits; a blocked host changes nothing.
  const prepared = await prepareReviewedMcpOAuthDiscovery(host, serverId, expected);
  // Explicit OAuth review closes the captured old connection before replacing its grant.
  const admitted = await disconnectMcpServer(host, serverId, review, assertReviewedMcpOAuth);
  try {
    return await startMcpOAuthHandshake(host, serverId, { server: admitted, reviewed: expected, prepared });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Reviewed OAuth initialization requires inspection.");
    Object.assign(error, { mutationCommitted: true });
    throw error;
  }
}

export async function completeMcpOAuth(
  host: McpServerAdminHost,
  serverId: string,
  code: string,
  state?: string,
  review?: McpConnectionActionReview,
): Promise<McpServerRecord> {
  review = review ? { ...review } : undefined;
  const authRows = await host.readMcpAuthState();
  const authRow = authRows[serverId];
  if (!authRow?.oauthState) {
    throw new Error("No OAuth handshake in progress for this server.");
  }
  if (!state) {
    throw new Error("OAuth state is required to complete this handshake.");
  }
  if (authRow.oauthState !== state) {
    throw new Error("OAuth state mismatch.");
  }
  // Without this flow's PKCE verifier the provider rejects the code; fail before any reservation.
  if (!mcpOAuthPkceStore.read(serverId, state)) {
    throw new ValidationError({
      field: "oauth",
      message: "This sign-in expired or the Gateway restarted since it began. Start authorization again.",
    });
  }
  const server = await host.requireMcpServer(serverId);
  if (review) {
    assertReviewedStaticServer(server, review);
    assertReviewedMcpOAuth(server);
  }
  const exchange = host.exchangeMcpOAuthCode;
  if (!exchange) {
    throw new Error("MCP OAuth token exchange is not available in this Gateway runtime.");
  }
  // The OAuth owner publishes the returned credential refs before acknowledging success.
  if (review) {
    if (!server.connectionRevision) throw new Error("Reviewed OAuth requires its original connection generation.");
    const published = await exchange.call(host, server, code, authRow, {
      fence: { expectedConnectionRevision: server.connectionRevision },
      onCommitted: review.onCommitted,
    });
    try {
      const current = await host.requireMcpServer(serverId);
      assertMcpConnectionReview(current, {
        expectedRevision: mcpServerRevision(current),
        expectedConnectionRevision: server.connectionRevision,
      });
      if (
        !sameConfiguration(current, server) ||
        !isDeepStrictEqual(current.authState, buildPublicMcpAuthState(current, published))
      )
        throw new Error("OAuth publication changed before acknowledgement.");
      return current; // Guarded completion never starts a process or discovers tools.
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("OAuth readback requires inspection.");
      Object.assign(error, { mutationCommitted: true });
      throw error;
    }
  }
  await exchange.call(host, server, code, authRow);
  return await connectMcpServer(host, serverId);
}

/** A server a plugin added is removed only with the plugin service's own `pluginPass`. */
export async function deleteMcpServer(
  host: McpServerAdminHost,
  serverId: string,
  review?: { expectedRevision: string; onCommitted?: () => void | Promise<void> },
  pluginPass?: PluginPass,
): Promise<{ deleted: boolean }> {
  const previous = await host.readMcpServers();
  const original = previous.find((server) => server.serverId === serverId);
  if (review && !original) throw new NotFoundError(`Unknown MCP server: ${serverId}`);
  assertMcpServerRemovalAllowed(original, pluginPass);
  if (original && review) assertMcpServerReview(original, review.expectedRevision);
  const closeOwnedSessions = host.captureMcpServerSessionCloser?.(serverId);
  const next = previous.filter((item) => item.serverId !== serverId);
  const deleted = next.length !== previous.length;
  if (deleted) {
    await host.writeMcpServers(next, previous, {
      serverId,
      expectedRevision: review?.expectedRevision ?? mcpServerRevision(original!),
    });
    await afterMcpCommit(review?.onCommitted, async () => {
      closeOwnedSessions?.();
      // The registry removes credentials, tool inventory and approvals in the delete transaction.
      await host.publishRealtime("system", "mcp", {
        type: "mcp_server_deleted",
        serverId,
      });
    });
  }
  return { deleted };
}

/**
 * A server that can move money can't be set to let changes run on their own. Every create and policy write checks it
 * before saving, whichever caller asked. The relief helper also caps a saved value, in case one slipped past.
 *
 * `server` is the record as it would be saved, so a rename or new endpoint in the same edit counts. An edit that asks
 * for the setting is refused on a money server. An edit that doesn't is refused only when it is the edit that turns the
 * record into a money server while it keeps the setting (a label or address change pointing a non-money server at
 * PayPal). A record that already held both, saved earlier or re-marked by a later catalog, can still be switched off or
 * edited otherwise.
 */
function assertMcpApprovalPostureAllowed(
  server: McpServerRecord,
  requested: McpApprovalPosture | undefined,
  before: McpServerRecord | undefined,
): void {
  const asksForIt = requested === "nothing_asks";
  const keepsItOnNewMoneyServer =
    before !== undefined && server.policy.approvalPosture === "nothing_asks" && !isMoneyMovingCatalogServer(before);
  if ((asksForIt || keepsItOnNewMoneyServer) && isMoneyMovingCatalogServer(server)) {
    throw new ValidationError({
      message: "This connector can move money, so changes can't be set to run on their own.",
    });
  }
}

/**
 * Records a change to what a connector asks first, as the write owner: the edit set the value, and it differs from the
 * saved value it replaced (`from` is null when none was saved). The same value, or an edit that doesn't mention it,
 * records nothing.
 */
async function auditApprovalPostureChange(
  host: McpServerAdminHost,
  replaced: McpServerRecord,
  saved: McpServerRecord,
  requested: McpApprovalPosture | undefined,
  actorId: string | undefined,
): Promise<void> {
  const to = saved.policy.approvalPosture;
  const from = replaced.policy.approvalPosture ?? null;
  if (requested === undefined || to === undefined || to === from) return;
  await host.appendApprovalsAudit({
    event: "mcp_server_approval_posture_changed",
    serverId: saved.serverId,
    from,
    to,
    actorId: actorId ?? "operator",
  });
}

async function afterMcpCommit(
  onCommitted: (() => void | Promise<void>) | undefined,
  followUp: () => void | Promise<void>,
): Promise<void> {
  try {
    await onCommitted?.();
    await followUp();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("MCP configuration committed but follow-up work failed.");
    Object.assign(error, { mutationCommitted: true });
    throw error;
  }
}

function normalizeMcpOAuthConfig(input?: McpOAuthConfig): McpOAuthConfig | undefined {
  if (!input) {
    return undefined;
  }
  const normalized: McpOAuthConfig = {
    authorizationUrl: input.authorizationUrl?.trim() || undefined,
    tokenUrl: input.tokenUrl?.trim() || undefined,
    metadataDiscovery: input.metadataDiscovery === true ? true : undefined,
    clientIdEnv: input.clientIdEnv?.trim() || undefined,
    clientSecretEnv: input.clientSecretEnv?.trim() || undefined,
    scopes: input.scopes?.map((item) => item.trim()).filter(Boolean),
    redirectUri: input.redirectUri?.trim() || undefined,
    tokenRefreshSkewSeconds: input.tokenRefreshSkewSeconds,
  };
  return Object.values(normalized).some((value) => (Array.isArray(value) ? value.length > 0 : value !== undefined))
    ? normalized
    : undefined;
}

/** Deps for connected-tool discovery (B5b): sandbox network policy + per-server OAuth token minting. */
export interface ResolveConnectedMcpToolsDeps {
  packageRoot?: string;
  networkAllowlist: NonNullable<Parameters<typeof discoverMcpTools>[2]>["networkAllowlist"];
  resolveOAuthAccessToken: NonNullable<NonNullable<Parameters<typeof discoverMcpTools>[2]>["oauthAccessTokenResolver"]>;
  staticEnvironmentResolver?: NonNullable<Parameters<typeof discoverMcpTools>[2]>["staticEnvironmentResolver"];
}

/**
 * Resolve the live tool list for a connecting MCP server: internal servers get
 * their synthesized tools, while stdio/http/sse servers get exact live
 * discovery (with the sandbox network allowlist + OAuth token resolver applied
 * to remote transports). A valid empty catalog stays empty; guessed or stale
 * tools are never substituted for authoritative discovery.
 */
export async function resolveConnectedMcpTools(
  deps: ResolveConnectedMcpToolsDeps,
  server: McpServerRecord,
  _existingTools: McpToolRecord[],
  actorContext?: ToolPolicyActorContext,
): Promise<McpToolRecord[]> {
  // HX-415 defense in depth: requester-scoped discovery is ephemeral and
  // profile-bound. The global tool-resolution path never discovers or infers
  // tools for a requester-scoped server, and never writes them to shared state.
  if (resolveMcpServerConnectionMode(server) === "requester_scoped") {
    return [];
  }
  if (isInternalMcpApprovalInboxServer(server)) {
    return createInternalMcpApprovalInboxTools(server.serverId);
  }
  if (isInternalMcpDurableTasksServer(server)) {
    return createInternalMcpDurableTasksTools(server.serverId);
  }
  if (server.transport === "stdio") {
    return discoverMcpTools(server, undefined, {
      actorContext,
      packageRoot: deps.packageRoot,
      networkAllowlist: deps.networkAllowlist,
      staticEnvironmentResolver: deps.staticEnvironmentResolver,
    });
  }
  if (server.transport === "http" || server.transport === "sse") {
    return discoverMcpTools(server, undefined, {
      networkAllowlist: deps.networkAllowlist,
      oauthAccessTokenResolver: deps.resolveOAuthAccessToken,
      staticEnvironmentResolver: deps.staticEnvironmentResolver,
      actorContext,
    });
  }
  return [];
}
