/* eslint-disable max-lines -- Stage-specific resolution and attempt lifecycles remain auditable in one seam. */
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  canonicalJsonString,
  mcpRequesterScopeHashMaterial,
  type McpNormalizedRequesterDiscoveryCatalog,
  type McpNormalizedContentItem,
  type McpRequesterResolutionBinding,
  type McpRequesterResolutionMeshBinding,
  type McpRequesterScopeAuthActorSource,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import {
  MCP_REQUESTER_RESOLUTION_TIMEOUT_MS,
  McpRequesterResolutionError,
  assertMcpProfileDiscoveryAuthority,
  assertMcpRequesterResolutionBindingIntegrity,
  assertMcpToolCallAuthority,
  assertNormalizedMcpRequesterDiscoveryCatalog,
  createMcpRequesterProviderAlias,
  extractMcpRequesterDiscoveryOutputInput,
  issueMcpProfileDiscoveryAuthority,
  issueMcpToolCallAuthority,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  normalizeMcpRequesterDiscoveryOutput,
  readMcpEphemeralResolvedConnectionCandidate,
  snapshotMcpRequesterScopedServerSnapshot,
  validateMcpEphemeralResolvedConnection,
  type McpEphemeralResolvedConnectionCandidate,
  type McpEphemeralResolvedHeaderInput,
  type McpProfileDiscoveryAuthority,
  type McpProfileDiscoveryCurrentState,
  type McpRequesterDiscoverySecretScanner,
  type McpRequesterResolutionReasonCode,
  type McpRequesterResolverRegistry,
  type McpRequesterScopedServerSnapshot,
  type McpToolCallAuthority,
  type McpToolCallCurrentState,
  type ValidatedMcpEphemeralResolvedConnection,
} from "./mcp-requester-resolution.js";
import { createMcpResolutionSecretGuard, type McpResolutionSecretGuard } from "./mcp-resolution-secret-guard.js";
// Type-only runtime seam imports: the VALUE drivers are dependency-injected by
// the composition layer, so no runtime import cycle exists with mcp-runtime.ts.
import type {
  McpRequesterScopedDiscoveryResult,
  McpRequesterScopedDiscoveryRuntimeInput,
  McpRequesterScopedToolCallRuntimeInput,
  McpRuntimeInvocationResult,
} from "./mcp-runtime.js";

interface ResolutionSignals {
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  revocationSignal?: AbortSignal;
}

export interface McpProfileDiscoveryCurrentStateCheck {
  connectionGeneration?: number;
  rotationGeneration?: number;
}

export interface McpToolCallCurrentStateCheck {
  connectionGeneration?: number;
  rotationGeneration?: number;
}

export interface McpProfileDiscoveryResolutionServiceInput extends ResolutionSignals {
  requester: McpProfileDiscoveryAuthority;
  server: McpRequesterScopedServerSnapshot;
  readCurrentState(check: McpProfileDiscoveryCurrentStateCheck): McpProfileDiscoveryCurrentState;
}

export interface McpToolCallResolutionServiceInput extends ResolutionSignals {
  requester: McpToolCallAuthority;
  server: McpRequesterScopedServerSnapshot;
  binding: McpRequesterResolutionBinding;
  readCurrentState(check: McpToolCallCurrentStateCheck): McpToolCallCurrentState;
}

export interface McpEphemeralResolvedConnection {
  readonly outcomeClass: "resolved";
  readonly url: string;
  readonly headers: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>;
  readonly connectionGeneration: number;
  readonly rotationGeneration?: number;
  readonly expiresAt: string;
  toJSON(): never;
}

const profileDiscoveryOperationPermitBrand: unique symbol = Symbol(
  "goatcitadel.mcp.profile-discovery-operation-permit",
);
const toolCallRevalidationPermitBrand: unique symbol = Symbol("goatcitadel.mcp.tool-call-revalidation-permit");
const toolCallOperationPermitBrand: unique symbol = Symbol("goatcitadel.mcp.tool-call-operation-permit");
const profileDiscoveryOperationPermits = new WeakSet<object>();
const toolCallRevalidationPermits = new WeakSet<object>();
const toolCallOperationPermits = new WeakSet<object>();

export type McpProfileDiscoveryOperation = "initialize" | "notifications/initialized" | "tools/list";

export interface McpProfileDiscoveryOperationPermit {
  readonly stage: "profile_discovery";
  readonly operation: McpProfileDiscoveryOperation;
  readonly authoritySha256: string;
  readonly connectionGeneration: number;
  readonly rotationGeneration?: number;
  readonly [profileDiscoveryOperationPermitBrand]: true;
  toJSON(): never;
}

export interface McpToolCallRevalidationPermit {
  readonly stage: "tool_call_revalidation";
  readonly operation: "tools/list";
  readonly authoritySha256: string;
  readonly revalidationAttemptId: string;
  readonly revalidationAttemptGeneration: number;
  readonly connectionGeneration: number;
  readonly rotationGeneration?: number;
  readonly expectedCatalogSha256: string;
  readonly expectedToolDefinitionSha256: string;
  readonly [toolCallRevalidationPermitBrand]: true;
  toJSON(): never;
}

export interface McpToolCallOperationPermit {
  readonly stage: "tool_call";
  readonly operation: "tools/call";
  readonly authoritySha256: string;
  readonly finalEffectAttemptId: string;
  readonly finalEffectAttemptGeneration: number;
  readonly connectionGeneration: number;
  readonly rotationGeneration?: number;
  readonly serverId: string;
  readonly rawRemoteToolName: string;
  readonly canonicalToolName: string;
  readonly providerAlias: string;
  readonly [toolCallOperationPermitBrand]: true;
  toJSON(): never;
}

class ProfileDiscoveryOperationPermitValue {
  public constructor(
    value: Omit<McpProfileDiscoveryOperationPermit, typeof profileDiscoveryOperationPermitBrand | "toJSON">,
  ) {
    Object.assign(this, value);
    profileDiscoveryOperationPermits.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("operation_denied");
  }
}

class ToolCallRevalidationPermitValue {
  public constructor(value: Omit<McpToolCallRevalidationPermit, typeof toolCallRevalidationPermitBrand | "toJSON">) {
    Object.assign(this, value);
    toolCallRevalidationPermits.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("operation_denied");
  }
}

class ToolCallOperationPermitValue {
  public constructor(value: Omit<McpToolCallOperationPermit, typeof toolCallOperationPermitBrand | "toJSON">) {
    Object.assign(this, value);
    toolCallOperationPermits.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("operation_denied");
  }
}

Object.freeze(ProfileDiscoveryOperationPermitValue.prototype);
Object.freeze(ToolCallRevalidationPermitValue.prototype);
Object.freeze(ToolCallOperationPermitValue.prototype);

function assertLiveMcpProfileDiscoveryOperationPermit(
  input: unknown,
): asserts input is McpProfileDiscoveryOperationPermit {
  if (typeof input !== "object" || input === null || !profileDiscoveryOperationPermits.has(input)) {
    throw new McpRequesterResolutionError("operation_denied");
  }
}

function assertLiveMcpToolCallRevalidationPermit(input: unknown): asserts input is McpToolCallRevalidationPermit {
  if (typeof input !== "object" || input === null || !toolCallRevalidationPermits.has(input)) {
    throw new McpRequesterResolutionError("operation_denied");
  }
}

function assertLiveMcpToolCallOperationPermit(input: unknown): asserts input is McpToolCallOperationPermit {
  if (typeof input !== "object" || input === null || !toolCallOperationPermits.has(input)) {
    throw new McpRequesterResolutionError("operation_denied");
  }
}

export interface McpProfileDiscoveryResolutionAttempt {
  readonly stage: "profile_discovery";
  readonly attemptId: string;
  readonly connection: McpEphemeralResolvedConnection;
  readonly signal: AbortSignal;
  authorizeInitialize(): McpProfileDiscoveryOperationPermit;
  authorizeInitializedNotification(): McpProfileDiscoveryOperationPermit;
  authorizeToolsList(): McpProfileDiscoveryOperationPermit;
  consumeOperationPermit(input: McpProfileDiscoveryOperationPermit): McpProfileDiscoveryOperationPermit;
  assertCurrent(): void;
  scrubText(input: string): string;
  scrubDiagnostic(input: unknown): unknown;
  dispose(): void;
  isDisposed(): boolean;
  toJSON(): never;
}

export interface McpFreshToolsListRevalidationInput {
  revalidationAttemptId: string;
  revalidationAttemptGeneration: number;
  catalog: McpNormalizedRequesterDiscoveryCatalog;
}

export interface McpToolCallResolutionAttempt {
  readonly stage: "tool_call";
  readonly attemptId: string;
  readonly connection: McpEphemeralResolvedConnection;
  readonly signal: AbortSignal;
  authorizeToolsListRevalidation(): McpToolCallRevalidationPermit;
  consumeToolsListRevalidationPermit(input: McpToolCallRevalidationPermit): McpToolCallRevalidationPermit;
  acceptFreshToolsListRevalidation(input: McpFreshToolsListRevalidationInput): void;
  authorizeToolsCall(): McpToolCallOperationPermit;
  consumeToolsCallPermit(input: McpToolCallOperationPermit): McpToolCallOperationPermit;
  assertCurrent(): void;
  scrubText(input: string): string;
  scrubDiagnostic(input: unknown): unknown;
  dispose(): void;
  isDisposed(): boolean;
  toJSON(): never;
}

class McpEphemeralResolvedConnectionValue implements McpEphemeralResolvedConnection {
  #value: ValidatedMcpEphemeralResolvedConnection | undefined;

  public constructor(value: ValidatedMcpEphemeralResolvedConnection) {
    this.#value = value;
    Object.freeze(this);
  }

  public get outcomeClass(): "resolved" {
    return this.#active().outcomeClass;
  }
  public get url(): string {
    return this.#active().url;
  }
  public get headers(): ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>> {
    return this.#active().headers;
  }
  public get connectionGeneration(): number {
    return this.#active().connectionGeneration;
  }
  public get rotationGeneration(): number | undefined {
    return this.#active().rotationGeneration;
  }
  public get expiresAt(): string {
    return this.#active().expiresAt;
  }
  public get expiresAtMs(): number {
    return this.#active().expiresAtMs;
  }

  public dispose(): void {
    this.#value = undefined;
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }

  #active(): ValidatedMcpEphemeralResolvedConnection {
    if (!this.#value) throw new McpRequesterResolutionError("connection_generation_revoked");
    return this.#value;
  }
}

class ResolutionLease {
  readonly #connection: McpEphemeralResolvedConnectionValue;
  readonly #guard: McpResolutionSecretGuard;
  readonly #abort: ResolutionAbortLatch;
  readonly #assertCurrentState: (connectionGeneration?: number, rotationGeneration?: number) => void;
  readonly #now: () => number;
  readonly #onDispose: () => void;
  readonly #expiryTimer: ReturnType<typeof setTimeout>;
  readonly #abortListener: () => void;
  #disposed = false;

  public constructor(input: {
    connection: McpEphemeralResolvedConnectionValue;
    guard: McpResolutionSecretGuard;
    abort: ResolutionAbortLatch;
    assertCurrentState(connectionGeneration?: number, rotationGeneration?: number): void;
    now: () => number;
    onDispose(): void;
  }) {
    this.#connection = input.connection;
    this.#guard = input.guard;
    this.#abort = input.abort;
    this.#assertCurrentState = input.assertCurrentState;
    this.#now = input.now;
    this.#onDispose = input.onDispose;
    this.#abortListener = () => this.#disposeResources();
    this.#abort.signal.addEventListener("abort", this.#abortListener, { once: true });
    this.#expiryTimer = setTimeout(
      () => this.#abort.abort("resolved_connection_expired"),
      Math.max(0, this.#connection.expiresAtMs - this.#now()),
    );
    this.#expiryTimer.unref?.();
    Object.freeze(this);
  }

  public get connection(): McpEphemeralResolvedConnection {
    this.#assertAccessible();
    return this.#connection;
  }

  public get connectionGeneration(): number {
    this.#assertAccessible();
    return this.#connection.connectionGeneration;
  }

  public get signal(): AbortSignal {
    return this.#abort.signal;
  }

  public assertCurrent(): void {
    this.#abort.throwIfAborted();
    this.#assertNotDisposed();
    if (this.#now() >= this.#connection.expiresAtMs) {
      this.#abort.abort("resolved_connection_expired");
      this.#abort.throwIfAborted();
    }
    try {
      this.#assertCurrentState(this.#connection.connectionGeneration, this.#connection.rotationGeneration);
    } catch (error) {
      this.#abort.abort(error instanceof McpRequesterResolutionError ? error.code : "connection_generation_revoked");
      this.#abort.throwIfAborted();
    }
    this.#abort.throwIfAborted();
  }

  public scrubText(input: string): string {
    this.#assertAccessible();
    return this.#guard.scrubText(input);
  }

  public scrubDiagnostic(input: unknown): unknown {
    this.#assertAccessible();
    return this.#guard.scrubDiagnostic(input);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#abort.abort("connection_generation_revoked");
    this.#abort.dispose();
    this.#disposeResources();
  }

  public isDisposed(): boolean {
    return this.#disposed;
  }

  #disposeResources(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#expiryTimer);
    this.#abort.signal.removeEventListener("abort", this.#abortListener);
    this.#abort.dispose();
    this.#connection.dispose();
    this.#guard.dispose();
    this.#onDispose();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new McpRequesterResolutionError("connection_generation_revoked");
  }

  #assertAccessible(): void {
    this.#abort.throwIfAborted();
    this.#assertNotDisposed();
  }
}

class McpProfileDiscoveryResolutionAttemptValue implements McpProfileDiscoveryResolutionAttempt {
  public readonly stage = "profile_discovery" as const;
  readonly #requester: McpProfileDiscoveryAuthority;
  readonly #lease: ResolutionLease;
  readonly #abortListener: () => void;
  readonly #authorizedOperations = new Set<McpProfileDiscoveryOperation>();
  readonly #issuedPermits = new Map<McpProfileDiscoveryOperation, McpProfileDiscoveryOperationPermit>();

  public constructor(requester: McpProfileDiscoveryAuthority, lease: ResolutionLease) {
    this.#requester = requester;
    this.#lease = lease;
    this.#abortListener = () => this.#revokeIssuedPermits();
    this.#lease.signal.addEventListener("abort", this.#abortListener, { once: true });
    Object.seal(this);
  }

  public get attemptId(): string {
    return this.#requester.discoveryAttemptId;
  }
  public get connection(): McpEphemeralResolvedConnection {
    return this.#lease.connection;
  }
  public get signal(): AbortSignal {
    return this.#lease.signal;
  }
  public authorizeInitialize(): McpProfileDiscoveryOperationPermit {
    return this.#permit("initialize");
  }
  public authorizeInitializedNotification(): McpProfileDiscoveryOperationPermit {
    return this.#permit("notifications/initialized");
  }
  public authorizeToolsList(): McpProfileDiscoveryOperationPermit {
    return this.#permit("tools/list");
  }
  public consumeOperationPermit(input: McpProfileDiscoveryOperationPermit): McpProfileDiscoveryOperationPermit {
    try {
      this.#lease.assertCurrent();
    } catch (error) {
      this.#revokeIssuedPermits();
      throw error;
    }
    const issued = [...this.#issuedPermits.entries()].find(([, permit]) => permit === input);
    if (!issued) throw new McpRequesterResolutionError("operation_denied");
    assertLiveMcpProfileDiscoveryOperationPermit(input);
    if (!profileDiscoveryOperationPermits.delete(input)) {
      throw new McpRequesterResolutionError("operation_denied");
    }
    this.#issuedPermits.delete(issued[0]);
    return input;
  }
  public assertCurrent(): void {
    try {
      this.#lease.assertCurrent();
    } catch (error) {
      this.#revokeIssuedPermits();
      throw error;
    }
  }
  public scrubText(input: string): string {
    return this.#lease.scrubText(input);
  }
  public scrubDiagnostic(input: unknown): unknown {
    return this.#lease.scrubDiagnostic(input);
  }
  public dispose(): void {
    this.#revokeIssuedPermits();
    this.#lease.signal.removeEventListener("abort", this.#abortListener);
    this.#lease.dispose();
  }
  public isDisposed(): boolean {
    return this.#lease.isDisposed();
  }
  public toJSON(): never {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }

  #permit(operation: McpProfileDiscoveryOperation): McpProfileDiscoveryOperationPermit {
    try {
      this.#lease.assertCurrent();
    } catch (error) {
      this.#revokeIssuedPermits();
      throw error;
    }
    if (this.#authorizedOperations.has(operation)) throw new McpRequesterResolutionError("operation_denied");
    const permit = new ProfileDiscoveryOperationPermitValue({
      stage: "profile_discovery",
      operation,
      authoritySha256: this.#requester.authoritySha256,
      connectionGeneration: this.#lease.connectionGeneration,
      ...(this.#lease.connection.rotationGeneration === undefined
        ? {}
        : { rotationGeneration: this.#lease.connection.rotationGeneration }),
    }) as unknown as McpProfileDiscoveryOperationPermit;
    this.#authorizedOperations.add(operation);
    this.#issuedPermits.set(operation, permit);
    return permit;
  }

  #revokeIssuedPermits(): void {
    for (const permit of this.#issuedPermits.values()) profileDiscoveryOperationPermits.delete(permit);
    this.#issuedPermits.clear();
  }
}

class McpToolCallResolutionAttemptValue implements McpToolCallResolutionAttempt {
  public readonly stage = "tool_call" as const;
  readonly #requester: McpToolCallAuthority;
  readonly #lease: ResolutionLease;
  readonly #abortListener: () => void;
  #revalidationAuthorized = false;
  #issuedRevalidationPermit: McpToolCallRevalidationPermit | undefined;
  #revalidationDispatched = false;
  #revalidated = false;
  #callAuthorized = false;
  #issuedCallPermit: McpToolCallOperationPermit | undefined;

  public constructor(requester: McpToolCallAuthority, lease: ResolutionLease) {
    this.#requester = requester;
    this.#lease = lease;
    this.#abortListener = () => this.#revokeIssuedPermits();
    this.#lease.signal.addEventListener("abort", this.#abortListener, { once: true });
    Object.seal(this);
  }

  public get attemptId(): string {
    return this.#requester.finalEffectAttemptId;
  }
  public get connection(): McpEphemeralResolvedConnection {
    return this.#lease.connection;
  }
  public get signal(): AbortSignal {
    return this.#lease.signal;
  }
  public authorizeToolsListRevalidation(): McpToolCallRevalidationPermit {
    try {
      this.#lease.assertCurrent();
    } catch (error) {
      this.#revokeIssuedPermits();
      throw error;
    }
    if (this.#revalidationAuthorized) {
      throw new McpRequesterResolutionError("operation_denied");
    }
    const permit = new ToolCallRevalidationPermitValue({
      stage: "tool_call_revalidation",
      operation: "tools/list",
      authoritySha256: this.#requester.authoritySha256,
      revalidationAttemptId: this.#requester.revalidationAttemptId,
      revalidationAttemptGeneration: this.#requester.revalidationAttemptGeneration,
      connectionGeneration: this.#lease.connectionGeneration,
      ...(this.#lease.connection.rotationGeneration === undefined
        ? {}
        : { rotationGeneration: this.#lease.connection.rotationGeneration }),
      expectedCatalogSha256: this.#requester.normalizedDiscoveryCatalogSha256,
      expectedToolDefinitionSha256: this.#requester.normalizedToolDefinitionSha256,
    }) as unknown as McpToolCallRevalidationPermit;
    this.#revalidationAuthorized = true;
    this.#issuedRevalidationPermit = permit;
    return permit;
  }
  public consumeToolsListRevalidationPermit(input: McpToolCallRevalidationPermit): McpToolCallRevalidationPermit {
    try {
      this.#lease.assertCurrent();
    } catch (error) {
      this.#revokeIssuedPermits();
      throw error;
    }
    if (input !== this.#issuedRevalidationPermit) throw new McpRequesterResolutionError("operation_denied");
    assertLiveMcpToolCallRevalidationPermit(input);
    if (!toolCallRevalidationPermits.delete(input)) throw new McpRequesterResolutionError("operation_denied");
    this.#issuedRevalidationPermit = undefined;
    this.#revalidationDispatched = true;
    return input;
  }
  public acceptFreshToolsListRevalidation(input: McpFreshToolsListRevalidationInput): void {
    if (this.#revalidated) throw new McpRequesterResolutionError("schema_revalidation_drift");
    if (!this.#revalidationDispatched) throw new McpRequesterResolutionError("schema_revalidation_required");
    this.#revalidationDispatched = false;
    try {
      this.#assertCurrentAndRevokePermitsOnFailure();
      const value = snapshotExactDataRecord(input, [
        "catalog",
        "revalidationAttemptGeneration",
        "revalidationAttemptId",
      ]);
      assertNormalizedMcpRequesterDiscoveryCatalog(value.catalog);
      if (
        value.revalidationAttemptId !== this.#requester.revalidationAttemptId ||
        value.revalidationAttemptGeneration !== this.#requester.revalidationAttemptGeneration ||
        value.catalog.serverId !== this.#requester.serverId ||
        value.catalog.catalogSha256 !== this.#requester.normalizedDiscoveryCatalogSha256
      ) {
        throw new McpRequesterResolutionError("schema_revalidation_drift");
      }
      const exactTool = value.catalog.tools.find(
        (tool) =>
          tool.rawRemoteToolName === this.#requester.rawRemoteToolName &&
          tool.canonicalToolName === this.#requester.canonicalToolName,
      );
      if (
        !exactTool ||
        exactTool.toolDefinitionSha256 !== this.#requester.normalizedToolDefinitionSha256 ||
        value.catalog.tools.some(
          (tool) =>
            tool !== exactTool &&
            (tool.rawRemoteToolName === this.#requester.rawRemoteToolName ||
              tool.canonicalToolName === this.#requester.canonicalToolName),
        )
      ) {
        throw new McpRequesterResolutionError("schema_revalidation_drift");
      }
      this.#assertCurrentAndRevokePermitsOnFailure();
      this.#revalidated = true;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  public authorizeToolsCall(): McpToolCallOperationPermit {
    this.#assertCurrentAndRevokePermitsOnFailure();
    if (!this.#revalidated) throw new McpRequesterResolutionError("schema_revalidation_required");
    if (this.#callAuthorized) throw new McpRequesterResolutionError("operation_denied");
    const permit = new ToolCallOperationPermitValue({
      stage: "tool_call",
      operation: "tools/call",
      authoritySha256: this.#requester.authoritySha256,
      finalEffectAttemptId: this.#requester.finalEffectAttemptId,
      finalEffectAttemptGeneration: this.#requester.finalEffectAttemptGeneration,
      connectionGeneration: this.#lease.connectionGeneration,
      ...(this.#lease.connection.rotationGeneration === undefined
        ? {}
        : { rotationGeneration: this.#lease.connection.rotationGeneration }),
      serverId: this.#requester.serverId,
      rawRemoteToolName: this.#requester.rawRemoteToolName,
      canonicalToolName: this.#requester.canonicalToolName,
      providerAlias: this.#requester.providerAlias,
    }) as unknown as McpToolCallOperationPermit;
    this.#callAuthorized = true;
    this.#issuedCallPermit = permit;
    return permit;
  }
  public consumeToolsCallPermit(input: McpToolCallOperationPermit): McpToolCallOperationPermit {
    try {
      this.#lease.assertCurrent();
    } catch (error) {
      this.#revokeIssuedPermits();
      throw error;
    }
    if (input !== this.#issuedCallPermit) throw new McpRequesterResolutionError("operation_denied");
    assertLiveMcpToolCallOperationPermit(input);
    if (!toolCallOperationPermits.delete(input)) throw new McpRequesterResolutionError("operation_denied");
    this.#issuedCallPermit = undefined;
    return input;
  }
  public assertCurrent(): void {
    this.#assertCurrentAndRevokePermitsOnFailure();
  }
  public scrubText(input: string): string {
    return this.#lease.scrubText(input);
  }
  public scrubDiagnostic(input: unknown): unknown {
    return this.#lease.scrubDiagnostic(input);
  }
  public dispose(): void {
    this.#revokeIssuedPermits();
    this.#lease.signal.removeEventListener("abort", this.#abortListener);
    this.#lease.dispose();
    this.#revalidationDispatched = false;
    this.#revalidated = false;
    this.#callAuthorized = true;
  }
  public isDisposed(): boolean {
    return this.#lease.isDisposed();
  }
  public toJSON(): never {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }

  #revokeIssuedPermits(): void {
    if (this.#issuedRevalidationPermit) {
      toolCallRevalidationPermits.delete(this.#issuedRevalidationPermit);
      this.#issuedRevalidationPermit = undefined;
    }
    if (this.#issuedCallPermit) {
      toolCallOperationPermits.delete(this.#issuedCallPermit);
      this.#issuedCallPermit = undefined;
    }
  }

  #assertCurrentAndRevokePermitsOnFailure(): void {
    try {
      this.#lease.assertCurrent();
    } catch (error) {
      this.#revokeIssuedPermits();
      throw error;
    }
  }
}

Object.freeze(McpEphemeralResolvedConnectionValue.prototype);
Object.freeze(ResolutionLease.prototype);
Object.freeze(McpProfileDiscoveryResolutionAttemptValue.prototype);
Object.freeze(McpToolCallResolutionAttemptValue.prototype);

class ResolutionAbortLatch {
  readonly #controller = new AbortController();
  readonly #listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  #code: McpRequesterResolutionReasonCode | undefined;

  public constructor(input: ResolutionSignals) {
    this.#link(input.signal, "resolver_cancelled");
    this.#link(input.shutdownSignal, "resolver_cancelled");
    this.#link(input.revocationSignal, "connection_generation_revoked");
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }
  public abort(code: McpRequesterResolutionReasonCode): void {
    if (this.#code) return;
    this.#code = code;
    this.#controller.abort();
  }
  public throwIfAborted(): void {
    if (this.#code || this.#controller.signal.aborted) {
      throw new McpRequesterResolutionError(this.#code ?? "resolver_cancelled");
    }
  }
  public dispose(): void {
    for (const { signal, listener } of this.#listeners.splice(0)) signal.removeEventListener("abort", listener);
    this.abort("resolver_cancelled");
  }
  #link(signal: AbortSignal | undefined, code: McpRequesterResolutionReasonCode): void {
    if (!signal) return;
    if (signal.aborted) {
      this.abort(code);
      return;
    }
    const listener = (): void => this.abort(code);
    signal.addEventListener("abort", listener, { once: true });
    this.#listeners.push({ signal, listener });
  }
}

export class McpRequesterResolutionService {
  readonly #registry: McpRequesterResolverRegistry;
  readonly #now: () => number;
  readonly #activeProfileDiscoveryAuthorities = new Set<string>();
  readonly #activeToolCallAuthorities = new Set<string>();

  public constructor(registry: McpRequesterResolverRegistry, options?: { now?: () => number }) {
    this.#registry = registry;
    this.#now = options?.now ?? Date.now;
  }

  public async resolveForProfileDiscovery(
    rawInput: McpProfileDiscoveryResolutionServiceInput,
  ): Promise<McpProfileDiscoveryResolutionAttempt> {
    const input = freezeProfileDiscoveryInput(rawInput);
    assertMcpProfileDiscoveryAuthority(input.requester);
    assertDiscoveryServerBindings(input.requester, input.server);
    const assertCurrent = (connectionGeneration?: number, rotationGeneration?: number): void =>
      assertProfileDiscoveryCurrentState(
        input.requester,
        input.readCurrentState,
        connectionGeneration,
        rotationGeneration,
      );
    assertCurrent();
    const resolver = this.#registry.resolveProfileDiscoveryExact(
      input.requester.resolverId,
      input.requester.resolverVersion,
      input.requester.resolverConfigGeneration,
    );
    const releaseClaim = this.#claimAuthority(this.#activeProfileDiscoveryAuthorities, input.requester.authoritySha256);
    try {
      const lease = await this.#resolveConnection({
        server: input.server,
        signals: input,
        assertCurrent,
        resolve: (signal) =>
          resolver.resolveForProfileDiscovery({
            serverId: input.server.serverId,
            requester: input.requester,
            signal,
          }),
        onDispose: releaseClaim,
      });
      return new McpProfileDiscoveryResolutionAttemptValue(input.requester, lease);
    } catch (error) {
      releaseClaim();
      throw error;
    }
  }

  public async resolveForToolCall(rawInput: McpToolCallResolutionServiceInput): Promise<McpToolCallResolutionAttempt> {
    const input = freezeToolCallInput(rawInput);
    assertMcpToolCallAuthority(input.requester);
    assertFinalServerAndBinding(input.requester, input.server, input.binding);
    const assertCurrent = (connectionGeneration?: number, rotationGeneration?: number): void =>
      assertToolCallCurrentState(input.requester, input.readCurrentState, connectionGeneration, rotationGeneration);
    assertCurrent();
    const resolver = this.#registry.resolveToolCallExact(
      input.requester.resolverId,
      input.requester.resolverVersion,
      input.requester.resolverConfigGeneration,
    );
    const releaseClaim = this.#claimAuthority(this.#activeToolCallAuthorities, input.requester.authoritySha256);
    try {
      const lease = await this.#resolveConnection({
        server: input.server,
        signals: input,
        assertCurrent,
        resolve: (signal) =>
          resolver.resolveForToolCall({
            serverId: input.server.serverId,
            requester: input.requester,
            binding: input.binding,
            signal,
          }),
        onDispose: releaseClaim,
      });
      return new McpToolCallResolutionAttemptValue(input.requester, lease);
    } catch (error) {
      releaseClaim();
      throw error;
    }
  }

  #claimAuthority(claims: Set<string>, authoritySha256: string): () => void {
    if (claims.has(authoritySha256)) throw new McpRequesterResolutionError("operation_denied");
    claims.add(authoritySha256);
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      claims.delete(authoritySha256);
    };
  }

  async #resolveConnection(input: {
    server: McpRequesterScopedServerSnapshot;
    signals: ResolutionSignals;
    assertCurrent(connectionGeneration?: number, rotationGeneration?: number): void;
    resolve(signal: AbortSignal): Promise<McpEphemeralResolvedConnectionCandidate>;
    onDispose(): void;
  }): Promise<ResolutionLease> {
    const abort = new ResolutionAbortLatch(input.signals);
    let guard: McpResolutionSecretGuard | undefined;
    let connection: McpEphemeralResolvedConnectionValue | undefined;
    const timer = setTimeout(() => abort.abort("resolver_timeout"), MCP_REQUESTER_RESOLUTION_TIMEOUT_MS);
    try {
      abort.throwIfAborted();
      input.assertCurrent();
      const result = await awaitResolverResult(
        Promise.resolve().then(() => input.resolve(abort.signal)),
        abort,
      );
      clearTimeout(timer);
      abort.throwIfAborted();
      input.assertCurrent();
      const candidate = readMcpEphemeralResolvedConnectionCandidate(result);
      const validated = validateMcpEphemeralResolvedConnection(
        candidate,
        input.server.requesterResolution.transportPolicy,
        this.#now(),
      );
      input.assertCurrent(validated.connectionGeneration, validated.rotationGeneration);
      guard = createMcpResolutionSecretGuard({ url: validated.url, headers: validated.headers });
      connection = new McpEphemeralResolvedConnectionValue(validated);
      const lease = new ResolutionLease({
        connection,
        guard,
        abort,
        assertCurrentState: input.assertCurrent,
        now: this.#now,
        onDispose: input.onDispose,
      });
      lease.assertCurrent();
      return lease;
    } catch (error) {
      clearTimeout(timer);
      connection?.dispose();
      guard?.dispose();
      abort.dispose();
      if (error instanceof McpRequesterResolutionError) throw error;
      throw new McpRequesterResolutionError("resolver_failed");
    }
  }
}

function freezeProfileDiscoveryInput(
  input: McpProfileDiscoveryResolutionServiceInput,
): McpProfileDiscoveryResolutionServiceInput {
  try {
    const value = snapshotExactDataRecord(
      input,
      ["readCurrentState", "requester", "revocationSignal", "server", "shutdownSignal", "signal"],
      ["revocationSignal", "shutdownSignal", "signal"],
    );
    assertCallable(value.readCurrentState);
    const signals = freezeResolutionSignals(value);
    return Object.freeze({
      requester: value.requester as McpProfileDiscoveryAuthority,
      server: snapshotMcpRequesterScopedServerSnapshot(value.server),
      readCurrentState: value.readCurrentState as McpProfileDiscoveryResolutionServiceInput["readCurrentState"],
      ...signals,
    });
  } catch (error) {
    if (error instanceof McpRequesterResolutionError) throw error;
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

function freezeToolCallInput(input: McpToolCallResolutionServiceInput): McpToolCallResolutionServiceInput {
  try {
    const value = snapshotExactDataRecord(
      input,
      ["binding", "readCurrentState", "requester", "revocationSignal", "server", "shutdownSignal", "signal"],
      ["revocationSignal", "shutdownSignal", "signal"],
    );
    assertCallable(value.readCurrentState);
    const signals = freezeResolutionSignals(value);
    return Object.freeze({
      requester: value.requester as McpToolCallAuthority,
      server: snapshotMcpRequesterScopedServerSnapshot(value.server),
      binding: snapshotBinding(value.binding),
      readCurrentState: value.readCurrentState as McpToolCallResolutionServiceInput["readCurrentState"],
      ...signals,
    });
  } catch (error) {
    if (error instanceof McpRequesterResolutionError) throw error;
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

function freezeResolutionSignals(input: Readonly<Record<string, unknown>>): ResolutionSignals {
  const signal = assertOptionalGenuineAbortSignal(input.signal);
  const shutdownSignal = assertOptionalGenuineAbortSignal(input.shutdownSignal);
  const revocationSignal = assertOptionalGenuineAbortSignal(input.revocationSignal);
  return Object.freeze({
    ...(signal === undefined ? {} : { signal }),
    ...(shutdownSignal === undefined ? {} : { shutdownSignal }),
    ...(revocationSignal === undefined ? {} : { revocationSignal }),
  });
}

function assertOptionalGenuineAbortSignal(input: unknown): AbortSignal | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "object" ||
    input === null ||
    nodeTypes.isProxy(input) ||
    !(input instanceof AbortSignal) ||
    Object.getPrototypeOf(input) !== AbortSignal.prototype
  ) {
    throw new TypeError();
  }
  return input;
}

function snapshotBinding(input: unknown): McpRequesterResolutionBinding {
  const value = snapshotExactDataRecord(
    input,
    [
      "bindingSha256",
      "callableCatalogSha256",
      "callableCatalogSnapshotId",
      "meshActivation",
      "mode",
      "requesterScopeSha256",
      "resolverConfigGeneration",
      "resolverId",
      "resolverVersion",
      "schemaVersion",
      "serverConfigRevision",
      "serverConfigSha256",
      "serverId",
      "toolName",
      "transportPolicySha256",
    ],
    ["meshActivation"],
  );
  const meshActivation =
    value.meshActivation === undefined
      ? undefined
      : Object.freeze(
          snapshotExactDataRecord(value.meshActivation, [
            "activationId",
            "activationRevision",
            "descriptorSha256",
            "entrySha256",
            "healthGeneration",
            "manifestSha256",
            "publicationLeaseFencingToken",
            "publisherGeneration",
          ]),
        );
  const snapshot = Object.freeze({
    ...value,
    ...(meshActivation === undefined ? {} : { meshActivation }),
  }) as unknown as McpRequesterResolutionBinding;
  assertMcpRequesterResolutionBindingIntegrity(snapshot);
  return snapshot;
}

function assertDiscoveryServerBindings(
  requester: Pick<
    McpProfileDiscoveryAuthority,
    | "serverId"
    | "serverConfigRevision"
    | "serverConfigSha256"
    | "resolverId"
    | "resolverVersion"
    | "resolverConfigGeneration"
    | "transportPolicySha256"
  >,
  server: McpRequesterScopedServerSnapshot,
): void {
  if (
    requester.serverId !== server.serverId ||
    requester.serverConfigRevision !== server.configurationRevision ||
    requester.serverConfigSha256 !== mcpRequesterScopedServerConfigHash(server) ||
    requester.resolverId !== server.requesterResolution.resolverId ||
    requester.resolverVersion !== server.requesterResolution.resolverVersion ||
    requester.resolverConfigGeneration !== server.requesterResolution.configGeneration ||
    requester.transportPolicySha256 !== mcpRequesterTransportPolicyHash(server.requesterResolution.transportPolicy)
  ) {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
}

function assertFinalServerAndBinding(
  requester: McpToolCallAuthority,
  server: McpRequesterScopedServerSnapshot,
  binding: McpRequesterResolutionBinding,
): void {
  assertDiscoveryServerBindings(requester, server);
  const expectedScopeSha256 = digest(
    mcpRequesterScopeHashMaterial({
      profileId: requester.finalProfileId,
      turnId: requester.turnId,
      sessionId: requester.sessionId,
      workspaceId: requester.workspaceId,
      authActorId: requester.actorId,
      authActorSource: requester.actorSource,
    }),
  );
  if (binding.requesterScopeSha256 !== expectedScopeSha256) {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  if (
    binding.bindingSha256 !== requester.bindingSha256 ||
    binding.serverId !== requester.serverId ||
    binding.toolName !== requester.canonicalToolName ||
    binding.serverConfigRevision !== requester.serverConfigRevision ||
    binding.serverConfigSha256 !== requester.serverConfigSha256 ||
    binding.resolverId !== requester.resolverId ||
    binding.resolverVersion !== requester.resolverVersion ||
    binding.resolverConfigGeneration !== requester.resolverConfigGeneration ||
    binding.transportPolicySha256 !== requester.transportPolicySha256 ||
    binding.callableCatalogSha256 !== requester.finalCallableCatalogSha256
  ) {
    throw new McpRequesterResolutionError("capability_profile_drift");
  }
  if (
    binding.meshActivation?.publisherGeneration !== requester.meshPublisherGeneration ||
    binding.meshActivation?.activationRevision !== requester.meshActivationGeneration
  ) {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
}

function assertProfileDiscoveryCurrentState(
  expected: McpProfileDiscoveryAuthority,
  readCurrentState: McpProfileDiscoveryResolutionServiceInput["readCurrentState"],
  connectionGeneration?: number,
  rotationGeneration?: number,
): void {
  const current = readCurrentStateExact(
    readCurrentState,
    connectionGeneration,
    rotationGeneration,
    DISCOVERY_CURRENT_STATE_KEYS,
  );
  assertLiveCurrentState(current);
  if (current.discoveryAttemptOpen !== true) throw new McpRequesterResolutionError("operation_denied");
  assertExactFields(
    current,
    expected,
    ["actorId", "actorSource", "workspaceId", "sessionId", "turnId"],
    "requester_scope_mismatch",
  );
  assertExactFields(current, expected, ["futureProfileId", "baseCallableCatalogSha256"], "capability_profile_drift");
  assertExactFields(
    current,
    expected,
    [
      "serverId",
      "serverConfigRevision",
      "serverConfigSha256",
      "resolverId",
      "resolverVersion",
      "resolverConfigGeneration",
      "transportPolicySha256",
      "globalNetworkPolicyGeneration",
      "authConnectionGeneration",
      "turnGeneration",
      "preparationGeneration",
      "meshPublisherGeneration",
      "meshActivationGeneration",
      "discoveryAttemptId",
      "discoveryAttemptGeneration",
    ],
    "resolver_binding_drift",
  );
}

function assertToolCallCurrentState(
  expected: McpToolCallAuthority,
  readCurrentState: McpToolCallResolutionServiceInput["readCurrentState"],
  connectionGeneration?: number,
  rotationGeneration?: number,
): void {
  const current = readCurrentStateExact(
    readCurrentState,
    connectionGeneration,
    rotationGeneration,
    TOOL_CALL_CURRENT_STATE_KEYS,
  );
  assertLiveCurrentState(current);
  if (current.finalEffectAttemptOpen !== true) throw new McpRequesterResolutionError("operation_denied");
  assertExactFields(
    current,
    expected,
    ["actorId", "actorSource", "workspaceId", "sessionId", "turnId"],
    "requester_scope_mismatch",
  );
  assertExactFields(
    current,
    expected,
    [
      "finalProfileId",
      "finalProfileSha256",
      "baseCallableCatalogSha256",
      "finalCallableCatalogSha256",
      "rawRemoteToolName",
      "canonicalToolName",
      "providerAlias",
      "normalizedDiscoveryCatalogSha256",
      "normalizedToolDefinitionSha256",
      "bindingSha256",
    ],
    "capability_profile_drift",
  );
  assertExactFields(
    current,
    expected,
    [
      "serverId",
      "serverConfigRevision",
      "serverConfigSha256",
      "resolverId",
      "resolverVersion",
      "resolverConfigGeneration",
      "transportPolicySha256",
      "globalNetworkPolicyGeneration",
      "authConnectionGeneration",
      "turnGeneration",
      "preparationGeneration",
      "meshPublisherGeneration",
      "meshActivationGeneration",
      "profileDiscoveryAttemptId",
      "profileDiscoveryAttemptGeneration",
      "revalidationAttemptId",
      "revalidationAttemptGeneration",
      "finalEffectAttemptId",
      "finalEffectAttemptGeneration",
    ],
    "resolver_binding_drift",
  );
}

function readCurrentStateExact<TCheck>(
  reader: (check: TCheck) => unknown,
  connectionGeneration: number | undefined,
  rotationGeneration: number | undefined,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    return snapshotExactDataRecord(
      reader(
        (connectionGeneration === undefined
          ? {}
          : {
              connectionGeneration,
              ...(rotationGeneration === undefined ? {} : { rotationGeneration }),
            }) as TCheck,
      ),
      keys,
      ["meshActivationGeneration", "meshPublisherGeneration"],
    );
  } catch {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
}

function assertLiveCurrentState(current: Readonly<Record<string, unknown>>): void {
  if (
    typeof current.revoked !== "boolean" ||
    typeof current.connectionGenerationCurrent !== "boolean" ||
    typeof current.rotationGenerationCurrent !== "boolean"
  ) {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
  if (current.revoked || !current.connectionGenerationCurrent || !current.rotationGenerationCurrent) {
    throw new McpRequesterResolutionError("connection_generation_revoked");
  }
}

function assertExactFields(
  current: object,
  expected: object,
  fields: readonly string[],
  code: McpRequesterResolutionReasonCode,
): void {
  const currentRecord = current as Readonly<Record<string, unknown>>;
  const expectedRecord = expected as Readonly<Record<string, unknown>>;
  if (fields.some((field) => currentRecord[field] !== expectedRecord[field])) {
    throw new McpRequesterResolutionError(code);
  }
}

const DISCOVERY_CURRENT_STATE_KEYS = [
  "actorId",
  "actorSource",
  "authConnectionGeneration",
  "baseCallableCatalogSha256",
  "connectionGenerationCurrent",
  "rotationGenerationCurrent",
  "discoveryAttemptGeneration",
  "discoveryAttemptId",
  "discoveryAttemptOpen",
  "futureProfileId",
  "globalNetworkPolicyGeneration",
  "meshActivationGeneration",
  "meshPublisherGeneration",
  "preparationGeneration",
  "resolverConfigGeneration",
  "resolverId",
  "resolverVersion",
  "revoked",
  "serverConfigRevision",
  "serverConfigSha256",
  "serverId",
  "sessionId",
  "transportPolicySha256",
  "turnGeneration",
  "turnId",
  "workspaceId",
] as const;

const TOOL_CALL_CURRENT_STATE_KEYS = [
  "actorId",
  "actorSource",
  "authConnectionGeneration",
  "baseCallableCatalogSha256",
  "bindingSha256",
  "canonicalToolName",
  "connectionGenerationCurrent",
  "rotationGenerationCurrent",
  "finalCallableCatalogSha256",
  "finalEffectAttemptGeneration",
  "finalEffectAttemptId",
  "finalEffectAttemptOpen",
  "finalProfileId",
  "finalProfileSha256",
  "globalNetworkPolicyGeneration",
  "meshActivationGeneration",
  "meshPublisherGeneration",
  "normalizedDiscoveryCatalogSha256",
  "normalizedToolDefinitionSha256",
  "preparationGeneration",
  "profileDiscoveryAttemptGeneration",
  "profileDiscoveryAttemptId",
  "providerAlias",
  "rawRemoteToolName",
  "resolverConfigGeneration",
  "resolverId",
  "resolverVersion",
  "revalidationAttemptGeneration",
  "revalidationAttemptId",
  "revoked",
  "serverConfigRevision",
  "serverConfigSha256",
  "serverId",
  "sessionId",
  "transportPolicySha256",
  "turnGeneration",
  "turnId",
  "workspaceId",
] as const;

function snapshotExactDataRecord(
  input: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input) || nodeTypes.isProxy(input))
    throw new TypeError();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) throw new TypeError();
  const actualKeys = (actual as string[]).sort(compareExact);
  const allowed = new Set(keys);
  const optionalSet = new Set(optional);
  if (actualKeys.some((key) => !allowed.has(key))) throw new TypeError();
  if (keys.some((key) => !optionalSet.has(key) && !actualKeys.includes(key))) throw new TypeError();
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of actualKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) throw new TypeError();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function assertCallable(input: unknown): asserts input is (...args: never[]) => unknown {
  if (typeof input !== "function" || nodeTypes.isProxy(input)) throw new TypeError();
}

async function awaitResolverResult(resolverPromise: Promise<unknown>, abort: ResolutionAbortLatch): Promise<unknown> {
  const settledResolver = Promise.resolve(resolverPromise).then(
    (value) => ({ kind: "value" as const, value }),
    () => ({ kind: "error" as const }),
  );
  let listener: (() => void) | undefined;
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    if (abort.signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    listener = (): void => resolve({ kind: "aborted" });
    abort.signal.addEventListener("abort", listener, { once: true });
  });
  const result = await Promise.race([settledResolver, aborted]);
  if (listener) abort.signal.removeEventListener("abort", listener);
  if (result.kind === "aborted") {
    abort.throwIfAborted();
    throw new McpRequesterResolutionError("resolver_cancelled");
  }
  if (result.kind === "error") throw new McpRequesterResolutionError("resolver_failed");
  return result.value;
}

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Maximum retained freeze-time discovery outcomes. The registry is process-
 * local by design (the packet's restart rule: restarting the gateway drops all
 * in-memory attempts and forces fresh resolution), contains ONLY non-secret
 * ids/hashes/names from an already-secret-scanned catalog, and evicts oldest-
 * first at this cap so it can never become an unbounded cache.
 */
export const MCP_PROFILE_DISCOVERY_OUTCOME_REGISTRY_LIMIT = 512;

export interface McpProfileDiscoveryOutcomeKey {
  profileId: string;
  serverId: string;
  canonicalToolName: string;
}

export interface McpProfileDiscoveryOutcomeRecord extends McpProfileDiscoveryOutcomeKey {
  discoveryAttemptId: string;
  discoveryAttemptGeneration: number;
  rawRemoteToolName: string;
  providerAlias: string;
  normalizedDiscoveryCatalogSha256: string;
  normalizedToolDefinitionSha256: string;
  bindingSha256: string;
  requesterScopeSha256: string;
  recordedAtMs: number;
}

const OUTCOME_RECORD_KEYS = [
  "bindingSha256",
  "canonicalToolName",
  "discoveryAttemptGeneration",
  "discoveryAttemptId",
  "normalizedDiscoveryCatalogSha256",
  "normalizedToolDefinitionSha256",
  "profileId",
  "providerAlias",
  "rawRemoteToolName",
  "recordedAtMs",
  "requesterScopeSha256",
  "serverId",
] as const;

/**
 * Process-local home for freeze-time requester discovery outcomes
 * (HX-415 slice 7c). The persisted `McpRequesterResolutionBinding` cannot carry
 * the in-memory discovery attempt artifacts the tool-call authority hash needs
 * (`profileDiscoveryAttemptId/Generation`, raw remote tool name, provider
 * alias, normalized catalog/tool hashes); they live here between profile freeze
 * and dispatch. Values are frozen copies in and out — no live reference
 * escapes — and a load miss simply returns `undefined` so callers fail closed
 * (`requester_context_missing` after a restart or for a never-discovered tool).
 */
export class McpProfileDiscoveryOutcomeRegistry {
  readonly #outcomes = new Map<string, Readonly<McpProfileDiscoveryOutcomeRecord>>();

  public recordProfileDiscoveryOutcome(outcome: McpProfileDiscoveryOutcomeRecord): void {
    const stored = snapshotOutcomeRecord(outcome);
    const key = outcomeMapKey(stored);
    this.#outcomes.delete(key);
    if (this.#outcomes.size >= MCP_PROFILE_DISCOVERY_OUTCOME_REGISTRY_LIMIT) {
      const oldest = this.#outcomes.keys().next();
      if (!oldest.done) this.#outcomes.delete(oldest.value);
    }
    this.#outcomes.set(key, stored);
  }

  public loadProfileDiscoveryOutcome(
    key: McpProfileDiscoveryOutcomeKey,
  ): Readonly<McpProfileDiscoveryOutcomeRecord> | undefined {
    let mapKey: string;
    try {
      const value = snapshotExactDataRecord(key, ["canonicalToolName", "profileId", "serverId"]);
      mapKey = outcomeMapKey(value as unknown as McpProfileDiscoveryOutcomeKey);
    } catch {
      return undefined;
    }
    const stored = this.#outcomes.get(mapKey);
    return stored ? Object.freeze({ ...stored }) : undefined;
  }
}

function outcomeMapKey(key: McpProfileDiscoveryOutcomeKey): string {
  // NUL cannot appear in a canonical identifier, so the separator keeps the
  // profile/server/tool boundary unambiguous.
  const separator = String.fromCharCode(0);
  return `${key.profileId}${separator}${key.serverId}${separator}${key.canonicalToolName}`;
}

function snapshotOutcomeRecord(input: unknown): Readonly<McpProfileDiscoveryOutcomeRecord> {
  try {
    const value = snapshotExactDataRecord(input, OUTCOME_RECORD_KEYS);
    for (const field of [
      "profileId",
      "serverId",
      "canonicalToolName",
      "discoveryAttemptId",
      "rawRemoteToolName",
    ] as const) {
      assertOutcomeCanonicalIdentifier(value[field]);
    }
    if (typeof value.providerAlias !== "string" || !/^mcp__[a-f0-9]{64}$/u.test(value.providerAlias)) {
      throw new TypeError();
    }
    for (const field of [
      "normalizedDiscoveryCatalogSha256",
      "normalizedToolDefinitionSha256",
      "bindingSha256",
      "requesterScopeSha256",
    ] as const) {
      if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/u.test(value[field] as string)) throw new TypeError();
    }
    if (
      typeof value.discoveryAttemptGeneration !== "number" ||
      !Number.isSafeInteger(value.discoveryAttemptGeneration) ||
      value.discoveryAttemptGeneration < 1 ||
      typeof value.recordedAtMs !== "number" ||
      !Number.isSafeInteger(value.recordedAtMs) ||
      value.recordedAtMs < 0
    ) {
      throw new TypeError();
    }
    return value as unknown as Readonly<McpProfileDiscoveryOutcomeRecord>;
  } catch {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
}

function assertOutcomeCanonicalIdentifier(input: unknown): asserts input is string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 256 ||
    input !== input.normalize("NFKC").trim() ||
    /[\s\\]/u.test(input) ||
    containsOutcomeControlCharacter(input)
  ) {
    throw new TypeError();
  }
}

function containsOutcomeControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function isMcpRequesterScopeActorSource(
  value: ToolPolicyActorContext["authActorSource"],
): value is McpRequesterScopeAuthActorSource {
  return value === "token" || value === "basic" || value === "loopback" || value === "device" || value === "companion";
}

/**
 * Mirror of the profile-service `resolveMcpRequesterResolutionBinding` hook
 * input (chat-turn-capability-profile-service.ts). The freeze orchestrator is
 * that hook's future implementation; slice 7d only wires it.
 */
export interface McpRequesterScopedProfileFreezeHookInput {
  profileId: string;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  catalogSnapshotId: string;
  callableCatalogSha256: string;
  requesterScopeSha256?: string;
  canonicalToolName: string;
  modelToolName: string;
}

/**
 * Live server-owned state for one requester-scoped freeze attempt. The
 * composition reads it fresh on every call (drift/revocation detection); the
 * orchestrator owns only the attempt id/generation/open fields it mints itself.
 * `undefined` means "not a requester-scoped server" (static mode or missing
 * resolver configuration) — that server is simply unavailable for requester
 * resolution while static behavior stays untouched.
 */
export interface McpRequesterScopedFreezeCurrentState {
  revoked: boolean;
  actorId: string;
  actorSource: McpRequesterScopeAuthActorSource;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  futureProfileId: string;
  baseCallableCatalogSha256: string;
  server: McpRequesterScopedServerSnapshot;
  globalNetworkPolicyGeneration: number;
  authConnectionGeneration: number;
  turnGeneration: number;
  preparationGeneration: number;
  meshActivation?: McpRequesterResolutionMeshBinding;
  connectionGenerationCurrent: boolean;
  rotationGenerationCurrent: boolean;
}

export interface McpRequesterScopedProfileFreezeInput {
  hook: McpRequesterScopedProfileFreezeHookInput;
  service: Pick<McpRequesterResolutionService, "resolveForProfileDiscovery">;
  outcomes: Pick<McpProfileDiscoveryOutcomeRegistry, "recordProfileDiscoveryOutcome">;
  scanner: McpRequesterDiscoverySecretScanner;
  networkAllowlist: readonly string[];
  readCurrentState(check: McpProfileDiscoveryCurrentStateCheck): McpRequesterScopedFreezeCurrentState | undefined;
  /** Deliverable-4A transport driver (`discoverRequesterScopedMcpTools`), injected so this seam owns no transport. */
  discoverTools(input: McpRequesterScopedDiscoveryRuntimeInput): Promise<McpRequesterScopedDiscoveryResult>;
  /** Crypto-random attempt-id source (composition-owned). */
  createAttemptId(): string;
  /** Content-free taxonomy diagnostics; never receives resolved values or raw causes. */
  onDiagnostic(reasonCode: McpRequesterResolutionReasonCode): void;
  now?(): number;
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  revocationSignal?: AbortSignal;
}

const FREEZE_CURRENT_STATE_KEYS = [
  "actorId",
  "actorSource",
  "authConnectionGeneration",
  "baseCallableCatalogSha256",
  "connectionGenerationCurrent",
  "futureProfileId",
  "globalNetworkPolicyGeneration",
  "meshActivation",
  "preparationGeneration",
  "revoked",
  "rotationGenerationCurrent",
  "server",
  "sessionId",
  "turnGeneration",
  "turnId",
  "workspaceId",
] as const;

interface SnapshotFreezeCurrentState extends Omit<McpRequesterScopedFreezeCurrentState, "server"> {
  server: McpRequesterScopedServerSnapshot;
}

function snapshotFreezeCurrentState(input: unknown): SnapshotFreezeCurrentState | undefined {
  if (input === undefined) return undefined;
  const value = snapshotExactDataRecord(input, FREEZE_CURRENT_STATE_KEYS, ["meshActivation"]);
  const server = snapshotMcpRequesterScopedServerSnapshot(value.server);
  const meshActivation = value.meshActivation === undefined ? undefined : snapshotMeshActivation(value.meshActivation);
  return {
    ...(value as unknown as Omit<SnapshotFreezeCurrentState, "server" | "meshActivation">),
    server,
    ...(meshActivation === undefined ? {} : { meshActivation }),
  };
}

function snapshotMeshActivation(input: unknown): McpRequesterResolutionMeshBinding {
  const value = snapshotExactDataRecord(input, [
    "activationId",
    "activationRevision",
    "descriptorSha256",
    "entrySha256",
    "healthGeneration",
    "manifestSha256",
    "publicationLeaseFencingToken",
    "publisherGeneration",
  ]);
  return Object.freeze({ ...value }) as unknown as McpRequesterResolutionMeshBinding;
}

function meshAuthorityGenerations(meshActivation: McpRequesterResolutionMeshBinding | undefined): {
  meshPublisherGeneration?: number;
  meshActivationGeneration?: number;
} {
  return meshActivation === undefined
    ? {}
    : {
        meshPublisherGeneration: meshActivation.publisherGeneration,
        meshActivationGeneration: meshActivation.activationRevision,
      };
}

function serverBindingFields(server: McpRequesterScopedServerSnapshot): {
  serverId: string;
  serverConfigRevision: number;
  serverConfigSha256: string;
  resolverId: string;
  resolverVersion: string;
  resolverConfigGeneration: number;
  transportPolicySha256: string;
} {
  return {
    serverId: server.serverId,
    serverConfigRevision: server.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(server),
    resolverId: server.requesterResolution.resolverId,
    resolverVersion: server.requesterResolution.resolverVersion,
    resolverConfigGeneration: server.requesterResolution.configGeneration,
    transportPolicySha256: mcpRequesterTransportPolicyHash(server.requesterResolution.transportPolicy),
  };
}

/**
 * Freeze-side orchestrator (HX-415 slice 7c): the future implementation of the
 * profile-service `resolveMcpRequesterResolutionBinding` hook. It derives the
 * private discovery authority strictly from the authenticated hook identity and
 * live server-owned state, resolves + discovers over the injected driver,
 * normalizes and secret-scans the catalog, records the process-local discovery
 * outcome, and returns the non-secret immutable binding. `authActorSource:
 * none`/missing actor NEVER resolves; static servers return `undefined`
 * untouched. EVERY failure disposes the attempt, reports one content-free
 * taxonomy code through `onDiagnostic`, and returns `undefined` — no resolved
 * value, lease, or raw cause ever escapes this function.
 */
export async function resolveRequesterScopedBindingForProfileFreeze(
  input: McpRequesterScopedProfileFreezeInput,
): Promise<McpRequesterResolutionBinding | undefined> {
  const hook = input.hook;
  if (!hook.authActorId || !isMcpRequesterScopeActorSource(hook.authActorSource)) {
    reportDiagnostic(input.onDiagnostic, "requester_context_missing");
    return undefined;
  }
  const actorId = hook.authActorId;
  const actorSource = hook.authActorSource;
  let attempt: McpProfileDiscoveryResolutionAttempt | undefined;
  let attemptOpen = true;
  try {
    const initial = snapshotFreezeCurrentState(input.readCurrentState({}));
    if (!initial) {
      // Static-mode server or missing resolver configuration: not a failure —
      // the hook simply yields no requester binding and static behavior wins.
      return undefined;
    }
    const server = initial.server;
    const discoveryAttemptId = input.createAttemptId();
    const authority = issueMcpProfileDiscoveryAuthority({
      actorId,
      actorSource,
      workspaceId: hook.workspaceId,
      sessionId: hook.sessionId,
      turnId: hook.turnId,
      futureProfileId: hook.profileId,
      baseCallableCatalogSha256: initial.baseCallableCatalogSha256,
      ...serverBindingFields(server),
      globalNetworkPolicyGeneration: initial.globalNetworkPolicyGeneration,
      authConnectionGeneration: initial.authConnectionGeneration,
      turnGeneration: initial.turnGeneration,
      preparationGeneration: initial.preparationGeneration,
      ...meshAuthorityGenerations(initial.meshActivation),
      discoveryAttemptId,
      discoveryAttemptGeneration: 1,
    });
    const readCurrentState = (check: McpProfileDiscoveryCurrentStateCheck): McpProfileDiscoveryCurrentState => {
      const live = snapshotFreezeCurrentState(input.readCurrentState(check));
      if (!live) throw new McpRequesterResolutionError("server_not_callable");
      return {
        revoked: live.revoked,
        actorId: live.actorId,
        actorSource: live.actorSource,
        workspaceId: live.workspaceId,
        sessionId: live.sessionId,
        turnId: live.turnId,
        futureProfileId: live.futureProfileId,
        baseCallableCatalogSha256: live.baseCallableCatalogSha256,
        ...serverBindingFields(live.server),
        globalNetworkPolicyGeneration: live.globalNetworkPolicyGeneration,
        authConnectionGeneration: live.authConnectionGeneration,
        turnGeneration: live.turnGeneration,
        preparationGeneration: live.preparationGeneration,
        ...meshAuthorityGenerations(live.meshActivation),
        discoveryAttemptId,
        discoveryAttemptGeneration: 1,
        discoveryAttemptOpen: attemptOpen,
        connectionGenerationCurrent: live.connectionGenerationCurrent,
        rotationGenerationCurrent: live.rotationGenerationCurrent,
      };
    };
    attempt = await input.service.resolveForProfileDiscovery({
      requester: authority,
      server,
      readCurrentState,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.shutdownSignal === undefined ? {} : { shutdownSignal: input.shutdownSignal }),
      ...(input.revocationSignal === undefined ? {} : { revocationSignal: input.revocationSignal }),
    });
    const discovered = await input.discoverTools({
      attempt,
      networkAllowlist: [...input.networkAllowlist],
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (!discovered.ok) {
      reportDiagnostic(input.onDiagnostic, discovered.reasonCode);
      return undefined;
    }
    const catalog = normalizeMcpRequesterDiscoveryOutput(
      server.serverId,
      extractMcpRequesterDiscoveryOutputInput(server.serverId, discovered.rawToolsListResult),
      input.scanner,
    );
    const tool = catalog.tools.find((candidate) => candidate.canonicalToolName === hook.canonicalToolName);
    if (!tool) throw new McpRequesterResolutionError("server_not_callable");
    const requesterScopeSha256 = digest(
      mcpRequesterScopeHashMaterial({
        profileId: hook.profileId,
        turnId: hook.turnId,
        sessionId: hook.sessionId,
        workspaceId: hook.workspaceId,
        authActorId: actorId,
        authActorSource: actorSource,
      }),
    );
    if (hook.requesterScopeSha256 !== undefined && hook.requesterScopeSha256 !== requesterScopeSha256) {
      throw new McpRequesterResolutionError("requester_scope_mismatch");
    }
    const material = {
      schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
      mode: "requester_scoped" as const,
      serverId: server.serverId,
      toolName: hook.canonicalToolName,
      resolverId: server.requesterResolution.resolverId,
      resolverVersion: server.requesterResolution.resolverVersion,
      resolverConfigGeneration: server.requesterResolution.configGeneration,
      requesterScopeSha256,
      serverConfigRevision: server.configurationRevision,
      serverConfigSha256: mcpRequesterScopedServerConfigHash(server),
      transportPolicySha256: mcpRequesterTransportPolicyHash(server.requesterResolution.transportPolicy),
      callableCatalogSnapshotId: hook.catalogSnapshotId,
      callableCatalogSha256: hook.callableCatalogSha256,
      ...(initial.meshActivation === undefined ? {} : { meshActivation: initial.meshActivation }),
    };
    const binding = Object.freeze({ ...material, bindingSha256: digest(material) }) as McpRequesterResolutionBinding;
    assertMcpRequesterResolutionBindingIntegrity(binding);
    input.outcomes.recordProfileDiscoveryOutcome({
      profileId: hook.profileId,
      serverId: server.serverId,
      canonicalToolName: hook.canonicalToolName,
      discoveryAttemptId,
      discoveryAttemptGeneration: 1,
      rawRemoteToolName: tool.rawRemoteToolName,
      providerAlias: createMcpRequesterProviderAlias({
        serverId: server.serverId,
        rawRemoteToolName: tool.rawRemoteToolName,
        canonicalToolName: tool.canonicalToolName,
        normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
        bindingSha256: binding.bindingSha256,
      }),
      normalizedDiscoveryCatalogSha256: catalog.catalogSha256,
      normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
      bindingSha256: binding.bindingSha256,
      requesterScopeSha256,
      recordedAtMs: (input.now ?? Date.now)(),
    });
    return binding;
  } catch (error) {
    reportDiagnostic(input.onDiagnostic, error instanceof McpRequesterResolutionError ? error.code : "resolver_failed");
    return undefined;
  } finally {
    attemptOpen = false;
    attempt?.dispose();
  }
}

/**
 * Live server-owned state for one requester-scoped dispatch. Same contract as
 * {@link McpRequesterScopedFreezeCurrentState}: read fresh on every call,
 * `undefined` when the server is not requester-scoped anymore.
 */
export interface McpRequesterScopedToolCallCurrentState {
  revoked: boolean;
  actorId: string;
  actorSource: McpRequesterScopeAuthActorSource;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  finalProfileId: string;
  finalProfileSha256: string;
  baseCallableCatalogSha256: string;
  finalCallableCatalogSha256: string;
  server: McpRequesterScopedServerSnapshot;
  globalNetworkPolicyGeneration: number;
  authConnectionGeneration: number;
  turnGeneration: number;
  preparationGeneration: number;
  meshActivation?: McpRequesterResolutionMeshBinding;
  connectionGenerationCurrent: boolean;
  rotationGenerationCurrent: boolean;
}

const TOOL_CALL_LIVE_STATE_KEYS = [
  "actorId",
  "actorSource",
  "authConnectionGeneration",
  "baseCallableCatalogSha256",
  "connectionGenerationCurrent",
  "finalCallableCatalogSha256",
  "finalProfileId",
  "finalProfileSha256",
  "globalNetworkPolicyGeneration",
  "meshActivation",
  "preparationGeneration",
  "revoked",
  "rotationGenerationCurrent",
  "server",
  "sessionId",
  "turnGeneration",
  "turnId",
  "workspaceId",
] as const;

interface SnapshotToolCallCurrentState extends Omit<McpRequesterScopedToolCallCurrentState, "server"> {
  server: McpRequesterScopedServerSnapshot;
}

function snapshotToolCallCurrentState(input: unknown): SnapshotToolCallCurrentState | undefined {
  if (input === undefined) return undefined;
  const value = snapshotExactDataRecord(input, TOOL_CALL_LIVE_STATE_KEYS, ["meshActivation"]);
  const server = snapshotMcpRequesterScopedServerSnapshot(value.server);
  const meshActivation = value.meshActivation === undefined ? undefined : snapshotMeshActivation(value.meshActivation);
  return {
    ...(value as unknown as Omit<SnapshotToolCallCurrentState, "server" | "meshActivation">),
    server,
    ...(meshActivation === undefined ? {} : { meshActivation }),
  };
}

/**
 * Server-built turn context for one requester-scoped dispatch. Slice 7d fills
 * it from server-owned request/turn/profile state — NEVER from
 * `McpInvokeRequest` body fields.
 */
export interface McpRequesterScopedToolCallTurnContext {
  profileId: string;
  finalProfileSha256: string;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  actorId: string;
  actorSource: McpRequesterScopeAuthActorSource;
  baseCallableCatalogSha256: string;
  finalCallableCatalogSha256: string;
  callableCatalogSnapshotId: string;
  globalNetworkPolicyGeneration: number;
  authConnectionGeneration: number;
  turnGeneration: number;
  preparationGeneration: number;
}

export interface McpRequesterScopedToolCallDispatchInput {
  context: McpRequesterScopedToolCallTurnContext;
  serverId: string;
  canonicalToolName: string;
  /** Gateway alias for diagnostics only; the remote name comes from the recorded outcome. */
  toolName: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  revocationSignal?: AbortSignal;
  /** HX-305 effect fence; fired ONLY by the runtime at the tools/call write. */
  effectDispatch(): void;
  service: Pick<McpRequesterResolutionService, "resolveForToolCall">;
  outcomes: Pick<McpProfileDiscoveryOutcomeRegistry, "loadProfileDiscoveryOutcome">;
  scanner: McpRequesterDiscoverySecretScanner;
  networkAllowlist: readonly string[];
  /** Deliverable-4B runtime driver (`invokeRequesterScopedMcpToolCall`), injected so this seam owns no transport. */
  invokeToolCall(input: McpRequesterScopedToolCallRuntimeInput): Promise<McpRuntimeInvocationResult>;
  readCurrentState(check: McpToolCallCurrentStateCheck): McpRequesterScopedToolCallCurrentState | undefined;
  createAttemptId(): string;
  now?(): number;
}

/**
 * Invoke-side orchestrator (HX-415 slice 7c): the future
 * `requesterScopedMcpDispatch.invoke` body. Loads the frozen discovery outcome
 * (miss ⇒ fail closed `requester_context_missing`: restart or never
 * discovered), mints fresh revalidation/effect attempt identity, issues the
 * private tool-call authority, resolves through the exact resolver, and drives
 * the extended runtime with a composition-owned revalidate (normalize + secret
 * scan) callback. Every failure maps onto the packet taxonomy in the same
 * result shape `invokeRequesterScopedMcpToolCall` returns; `effectDispatch`
 * stays un-fired on every pre-dispatch failure.
 */
export async function dispatchRequesterScopedToolCall(
  input: McpRequesterScopedToolCallDispatchInput,
): Promise<McpRuntimeInvocationResult> {
  let attempt: McpToolCallResolutionAttempt | undefined;
  try {
    const outcomeKey: McpProfileDiscoveryOutcomeKey = {
      profileId: input.context.profileId,
      serverId: input.serverId,
      canonicalToolName: input.canonicalToolName,
    };
    const outcome = input.outcomes.loadProfileDiscoveryOutcome(outcomeKey);
    if (!outcome) {
      return buildRequesterScopedPreDispatchFailure(input.toolName, "requester_context_missing");
    }
    const live = snapshotToolCallCurrentState(input.readCurrentState({}));
    if (!live) {
      return buildRequesterScopedPreDispatchFailure(input.toolName, "server_not_callable");
    }
    const context = input.context;
    const revalidationAttemptId = input.createAttemptId();
    const finalEffectAttemptId = input.createAttemptId();
    const bindingMaterial = {
      schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
      mode: "requester_scoped" as const,
      serverId: live.server.serverId,
      toolName: input.canonicalToolName,
      resolverId: live.server.requesterResolution.resolverId,
      resolverVersion: live.server.requesterResolution.resolverVersion,
      resolverConfigGeneration: live.server.requesterResolution.configGeneration,
      requesterScopeSha256: outcome.requesterScopeSha256,
      serverConfigRevision: live.server.configurationRevision,
      serverConfigSha256: mcpRequesterScopedServerConfigHash(live.server),
      transportPolicySha256: mcpRequesterTransportPolicyHash(live.server.requesterResolution.transportPolicy),
      callableCatalogSnapshotId: context.callableCatalogSnapshotId,
      callableCatalogSha256: context.finalCallableCatalogSha256,
      ...(live.meshActivation === undefined ? {} : { meshActivation: live.meshActivation }),
    };
    // The binding is REBUILT from server-owned inputs and pinned to the freeze-
    // time hash from the recorded outcome: any drifted component makes the
    // integrity check fail closed before the resolver is touched.
    const binding = Object.freeze({
      ...bindingMaterial,
      bindingSha256: outcome.bindingSha256,
    }) as McpRequesterResolutionBinding;
    assertMcpRequesterResolutionBindingIntegrity(binding);
    const authority = issueMcpToolCallAuthority({
      actorId: context.actorId,
      actorSource: context.actorSource,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      serverConfigRevision: live.server.configurationRevision,
      serverConfigSha256: mcpRequesterScopedServerConfigHash(live.server),
      resolverId: live.server.requesterResolution.resolverId,
      resolverVersion: live.server.requesterResolution.resolverVersion,
      resolverConfigGeneration: live.server.requesterResolution.configGeneration,
      transportPolicySha256: mcpRequesterTransportPolicyHash(live.server.requesterResolution.transportPolicy),
      globalNetworkPolicyGeneration: context.globalNetworkPolicyGeneration,
      authConnectionGeneration: context.authConnectionGeneration,
      turnGeneration: context.turnGeneration,
      preparationGeneration: context.preparationGeneration,
      ...meshAuthorityGenerations(live.meshActivation),
      profileDiscoveryAttemptId: outcome.discoveryAttemptId,
      profileDiscoveryAttemptGeneration: outcome.discoveryAttemptGeneration,
      revalidationAttemptId,
      revalidationAttemptGeneration: 1,
      finalEffectAttemptId,
      finalEffectAttemptGeneration: 1,
      sealedProfile: {
        finalProfileId: context.profileId,
        finalProfileSha256: context.finalProfileSha256,
        baseCallableCatalogSha256: context.baseCallableCatalogSha256,
        finalCallableCatalogSha256: context.finalCallableCatalogSha256,
        serverId: live.server.serverId,
        rawRemoteToolName: outcome.rawRemoteToolName,
        canonicalToolName: input.canonicalToolName,
        providerAlias: outcome.providerAlias,
        normalizedDiscoveryCatalogSha256: outcome.normalizedDiscoveryCatalogSha256,
        normalizedToolDefinitionSha256: outcome.normalizedToolDefinitionSha256,
        bindingSha256: outcome.bindingSha256,
      },
    });
    let effectAttemptOpen = true;
    const readCurrentState = (check: McpToolCallCurrentStateCheck): McpToolCallCurrentState => {
      const current = snapshotToolCallCurrentState(input.readCurrentState(check));
      if (!current) throw new McpRequesterResolutionError("server_not_callable");
      // The outcome registry IS the process-local current state for the frozen
      // discovery artifacts: re-load on every check so eviction or overwrite by
      // a newer discovery reads as drift, never as silent reuse.
      const currentOutcome = input.outcomes.loadProfileDiscoveryOutcome(outcomeKey);
      if (!currentOutcome) throw new McpRequesterResolutionError("requester_context_missing");
      return {
        revoked: current.revoked,
        actorId: current.actorId,
        actorSource: current.actorSource,
        workspaceId: current.workspaceId,
        sessionId: current.sessionId,
        turnId: current.turnId,
        finalProfileId: current.finalProfileId,
        finalProfileSha256: current.finalProfileSha256,
        baseCallableCatalogSha256: current.baseCallableCatalogSha256,
        finalCallableCatalogSha256: current.finalCallableCatalogSha256,
        ...serverBindingFields(current.server),
        globalNetworkPolicyGeneration: current.globalNetworkPolicyGeneration,
        authConnectionGeneration: current.authConnectionGeneration,
        turnGeneration: current.turnGeneration,
        preparationGeneration: current.preparationGeneration,
        ...meshAuthorityGenerations(current.meshActivation),
        profileDiscoveryAttemptId: currentOutcome.discoveryAttemptId,
        profileDiscoveryAttemptGeneration: currentOutcome.discoveryAttemptGeneration,
        revalidationAttemptId,
        revalidationAttemptGeneration: 1,
        finalEffectAttemptId,
        finalEffectAttemptGeneration: 1,
        finalEffectAttemptOpen: effectAttemptOpen,
        rawRemoteToolName: currentOutcome.rawRemoteToolName,
        canonicalToolName: input.canonicalToolName,
        providerAlias: currentOutcome.providerAlias,
        normalizedDiscoveryCatalogSha256: currentOutcome.normalizedDiscoveryCatalogSha256,
        normalizedToolDefinitionSha256: currentOutcome.normalizedToolDefinitionSha256,
        bindingSha256: currentOutcome.bindingSha256,
        connectionGenerationCurrent: current.connectionGenerationCurrent,
        rotationGenerationCurrent: current.rotationGenerationCurrent,
      };
    };
    attempt = await input.service.resolveForToolCall({
      requester: authority,
      server: live.server,
      binding,
      readCurrentState,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.shutdownSignal === undefined ? {} : { shutdownSignal: input.shutdownSignal }),
      ...(input.revocationSignal === undefined ? {} : { revocationSignal: input.revocationSignal }),
    });
    const resolvedAttempt = attempt;
    try {
      return await input.invokeToolCall({
        attempt: resolvedAttempt,
        toolName: input.toolName,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
        effectDispatch: input.effectDispatch,
        revalidate: (rawToolsListResult) => {
          const catalog = normalizeMcpRequesterDiscoveryOutput(
            input.serverId,
            extractMcpRequesterDiscoveryOutputInput(input.serverId, rawToolsListResult),
            input.scanner,
          );
          return { revalidationAttemptId, revalidationAttemptGeneration: 1, catalog };
        },
        networkAllowlist: [...input.networkAllowlist],
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    } finally {
      effectAttemptOpen = false;
    }
  } catch (error) {
    attempt?.dispose();
    return buildRequesterScopedPreDispatchFailure(
      input.toolName,
      error instanceof McpRequesterResolutionError ? error.code : "transport_pre_dispatch_failed",
    );
  }
}

function reportDiagnostic(
  onDiagnostic: (reasonCode: McpRequesterResolutionReasonCode) => void,
  reasonCode: McpRequesterResolutionReasonCode,
): void {
  try {
    onDiagnostic(reasonCode);
  } catch {
    // Diagnostics are best-effort and must never mask the fail-closed result.
  }
}

/**
 * Pre-dispatch failure in exactly the shape the runtime's own
 * `buildRequesterScopedFailure` produces, so the coordinator's requester branch
 * consumes one consistent result: fixed content-free message, the taxonomy code
 * under `output.requesterScoped`, and `failurePhase: "pre_dispatch"` proving
 * the HX-305 effect fence stayed untouched.
 */
function buildRequesterScopedPreDispatchFailure(
  toolName: string,
  reasonCode: McpRequesterResolutionReasonCode,
): McpRuntimeInvocationResult {
  const message = `Requester-scoped MCP tool ${toolName} failed before dispatch.`;
  const contentItems: McpNormalizedContentItem[] = [{ type: "error", text: message }];
  return {
    ok: false,
    error: message,
    contentItems,
    output: { requesterScoped: true, reasonCode },
    failurePhase: "pre_dispatch",
  };
}
