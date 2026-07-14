import type { McpRequesterResolutionBinding } from "@goatcitadel/contracts";
import {
  MCP_REQUESTER_RESOLUTION_TIMEOUT_MS,
  McpRequesterResolutionError,
  assertMcpRequesterAuthority,
  assertMcpRequesterCapabilityProfileSnapshot,
  assertMcpRequesterResolutionBindingIntegrity,
  assertMcpRequesterScopedServerSnapshot,
  mcpRequesterMeshActivationHash,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  readMcpEphemeralResolvedConnectionCandidate,
  validateMcpEphemeralResolvedConnection,
  type McpEphemeralResolvedHeaderInput,
  type McpRequesterAuthority,
  type McpRequesterCapabilityProfileSnapshot,
  type McpRequesterResolutionCurrentState,
  type McpRequesterResolutionReasonCode,
  type McpRequesterResolverRegistry,
  type McpRequesterScopedServerSnapshot,
  type ValidatedMcpEphemeralResolvedConnection,
} from "./mcp-requester-resolution.js";
import { createMcpResolutionSecretGuard, type McpResolutionSecretGuard } from "./mcp-resolution-secret-guard.js";

export interface McpRequesterCurrentStateCheck {
  connectionGeneration?: number;
}

export interface McpRequesterResolutionServiceInput {
  requester: McpRequesterAuthority;
  server: McpRequesterScopedServerSnapshot;
  profile: McpRequesterCapabilityProfileSnapshot;
  binding: McpRequesterResolutionBinding;
  readCurrentState(check: McpRequesterCurrentStateCheck): McpRequesterResolutionCurrentState;
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  revocationSignal?: AbortSignal;
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

export interface McpRequesterResolutionAttempt {
  readonly attemptId: string;
  readonly connection: McpEphemeralResolvedConnection;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  scrubText(input: string): string;
  scrubDiagnostic(input: unknown): unknown;
  dispose(): void;
  isDisposed(): boolean;
  toJSON(): never;
}

interface FrozenResolutionExpectation {
  requester: McpRequesterAuthority;
  serverConfigRevision: number;
  serverConfigSha256: string;
  resolverId: string;
  resolverVersion: string;
  resolverConfigGeneration: number;
  transportPolicySha256: string;
  callableCatalogSnapshotId: string;
  callableCatalogSha256: string;
  meshActivationSha256?: string;
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

class McpRequesterResolutionAttemptValue implements McpRequesterResolutionAttempt {
  readonly #attemptId: string;
  readonly #connection: McpEphemeralResolvedConnectionValue;
  readonly #guard: McpResolutionSecretGuard;
  readonly #abort: ResolutionAbortLatch;
  readonly #expectation: FrozenResolutionExpectation;
  readonly #readCurrentState: McpRequesterResolutionServiceInput["readCurrentState"];
  readonly #now: () => number;
  #disposed = false;

  public constructor(input: {
    connection: McpEphemeralResolvedConnectionValue;
    guard: McpResolutionSecretGuard;
    abort: ResolutionAbortLatch;
    expectation: FrozenResolutionExpectation;
    readCurrentState: McpRequesterResolutionServiceInput["readCurrentState"];
    now: () => number;
  }) {
    this.#attemptId = input.expectation.requester.invocationAttemptId;
    this.#connection = input.connection;
    this.#guard = input.guard;
    this.#abort = input.abort;
    this.#expectation = input.expectation;
    this.#readCurrentState = input.readCurrentState;
    this.#now = input.now;
    Object.freeze(this);
  }

  public get attemptId(): string {
    return this.#attemptId;
  }

  public get connection(): McpEphemeralResolvedConnection {
    this.#assertNotDisposed();
    return this.#connection;
  }

  public get signal(): AbortSignal {
    return this.#abort.signal;
  }

  public assertCurrent(): void {
    this.#assertNotDisposed();
    this.#abort.throwIfAborted();
    if (this.#now() >= this.#connection.expiresAtMs) {
      throw new McpRequesterResolutionError("resolved_connection_expired");
    }
    assertCurrentState(this.#expectation, this.#readCurrentState, this.#connection.connectionGeneration);
    this.#abort.throwIfAborted();
  }

  public scrubText(input: string): string {
    this.#assertNotDisposed();
    return this.#guard.scrubText(input);
  }

  public scrubDiagnostic(input: unknown): unknown {
    this.#assertNotDisposed();
    return this.#guard.scrubDiagnostic(input);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.dispose();
    this.#connection.dispose();
    this.#guard.dispose();
  }

  public isDisposed(): boolean {
    return this.#disposed;
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new McpRequesterResolutionError("connection_generation_revoked");
  }
}

class ResolutionAbortLatch {
  readonly #controller = new AbortController();
  readonly #listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  #code: McpRequesterResolutionReasonCode | undefined;

  public constructor(
    input: Pick<McpRequesterResolutionServiceInput, "signal" | "shutdownSignal" | "revocationSignal">,
  ) {
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
    for (const { signal, listener } of this.#listeners.splice(0)) {
      signal.removeEventListener("abort", listener);
    }
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

Object.freeze(McpEphemeralResolvedConnectionValue.prototype);
Object.freeze(McpRequesterResolutionAttemptValue.prototype);

export class McpRequesterResolutionService {
  readonly #registry: McpRequesterResolverRegistry;
  readonly #now: () => number;

  public constructor(registry: McpRequesterResolverRegistry, options?: { now?: () => number }) {
    this.#registry = registry;
    this.#now = options?.now ?? Date.now;
  }

  public async resolve(input: McpRequesterResolutionServiceInput): Promise<McpRequesterResolutionAttempt> {
    input = freezeResolutionInput(input);
    assertMcpRequesterAuthority(input.requester);
    assertMcpRequesterScopedServerSnapshot(input.server);
    assertMcpRequesterCapabilityProfileSnapshot(input.profile);
    assertMcpRequesterResolutionBindingIntegrity(input.binding);
    const expectation = buildExpectation(input);
    assertFrozenBindings(input, expectation);
    const resolver = this.#registry.resolveExact(
      expectation.resolverId,
      expectation.resolverVersion,
      expectation.resolverConfigGeneration,
    );
    assertCurrentState(expectation, input.readCurrentState);

    const abort = new ResolutionAbortLatch(input);
    let guard: McpResolutionSecretGuard | undefined;
    let connection: McpEphemeralResolvedConnectionValue | undefined;
    const timer = setTimeout(() => abort.abort("resolver_timeout"), MCP_REQUESTER_RESOLUTION_TIMEOUT_MS);
    try {
      abort.throwIfAborted();
      const result = await awaitResolverResult(
        Promise.resolve().then(() =>
          resolver.resolve({
            serverId: input.server.serverId,
            requester: input.requester,
            binding: input.binding,
            signal: abort.signal,
          }),
        ),
        abort,
      );
      clearTimeout(timer);
      abort.throwIfAborted();
      assertCurrentState(expectation, input.readCurrentState);
      const candidate = readMcpEphemeralResolvedConnectionCandidate(result);
      const validated = validateMcpEphemeralResolvedConnection(
        candidate,
        input.server.requesterResolution.transportPolicy,
        this.#now(),
      );
      assertCurrentState(expectation, input.readCurrentState, validated.connectionGeneration);
      guard = createMcpResolutionSecretGuard({ url: validated.url, headers: validated.headers });
      connection = new McpEphemeralResolvedConnectionValue(validated);
      const attempt = new McpRequesterResolutionAttemptValue({
        connection,
        guard,
        abort,
        expectation,
        readCurrentState: input.readCurrentState,
        now: this.#now,
      });
      attempt.assertCurrent();
      return attempt;
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

function freezeResolutionInput(input: McpRequesterResolutionServiceInput): McpRequesterResolutionServiceInput {
  let server: McpRequesterScopedServerSnapshot;
  let profile: McpRequesterCapabilityProfileSnapshot;
  let binding: McpRequesterResolutionBinding;
  try {
    const copiedServer = structuredClone(input.server);
    copiedServer.requesterResolution.transportPolicy.allowedSchemes = Object.freeze([
      ...copiedServer.requesterResolution.transportPolicy.allowedSchemes,
    ]) as Array<"http" | "https">;
    copiedServer.requesterResolution.transportPolicy.allowedHosts = Object.freeze([
      ...copiedServer.requesterResolution.transportPolicy.allowedHosts,
    ]) as string[];
    copiedServer.requesterResolution.transportPolicy.allowedPorts = Object.freeze([
      ...copiedServer.requesterResolution.transportPolicy.allowedPorts,
    ]) as number[];
    copiedServer.requesterResolution.transportPolicy.allowedHeaderNames = Object.freeze([
      ...copiedServer.requesterResolution.transportPolicy.allowedHeaderNames,
    ]) as string[];
    Object.freeze(copiedServer.requesterResolution.transportPolicy);
    Object.freeze(copiedServer.requesterResolution);
    server = Object.freeze(copiedServer);
  } catch {
    throw new McpRequesterResolutionError("server_not_callable");
  }
  try {
    profile = Object.freeze(structuredClone(input.profile));
    const copiedBinding = structuredClone(input.binding);
    if (copiedBinding.meshActivation) Object.freeze(copiedBinding.meshActivation);
    binding = Object.freeze(copiedBinding);
  } catch {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
  return Object.freeze({ ...input, server, profile, binding });
}

function buildExpectation(input: McpRequesterResolutionServiceInput): FrozenResolutionExpectation {
  return Object.freeze({
    requester: input.requester,
    serverConfigRevision: input.server.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(input.server),
    resolverId: input.server.requesterResolution.resolverId,
    resolverVersion: input.server.requesterResolution.resolverVersion,
    resolverConfigGeneration: input.server.requesterResolution.configGeneration,
    transportPolicySha256: mcpRequesterTransportPolicyHash(input.server.requesterResolution.transportPolicy),
    callableCatalogSnapshotId: input.profile.callableCatalogSnapshotId,
    callableCatalogSha256: input.profile.callableCatalogSha256,
    meshActivationSha256: mcpRequesterMeshActivationHash(input.binding),
  });
}

function assertFrozenBindings(
  input: McpRequesterResolutionServiceInput,
  expectation: FrozenResolutionExpectation,
): void {
  if (
    input.requester.capabilityProfileId !== input.profile.profileId ||
    input.requester.capabilityProfileSha256 !== input.profile.profileSha256
  ) {
    throw new McpRequesterResolutionError("capability_profile_drift");
  }
  if (
    input.binding.serverId !== input.server.serverId ||
    input.binding.toolName !== input.profile.canonicalToolName ||
    input.binding.requesterScopeSha256 !== input.requester.requesterScopeSha256
  ) {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  if (
    input.binding.serverConfigRevision !== expectation.serverConfigRevision ||
    input.binding.serverConfigSha256 !== expectation.serverConfigSha256 ||
    input.binding.resolverId !== expectation.resolverId ||
    input.binding.resolverVersion !== expectation.resolverVersion ||
    input.binding.resolverConfigGeneration !== expectation.resolverConfigGeneration ||
    input.binding.transportPolicySha256 !== expectation.transportPolicySha256
  ) {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
  if (
    input.binding.callableCatalogSnapshotId !== expectation.callableCatalogSnapshotId ||
    input.binding.callableCatalogSha256 !== expectation.callableCatalogSha256
  ) {
    throw new McpRequesterResolutionError("capability_profile_drift");
  }
}

function assertCurrentState(
  expected: FrozenResolutionExpectation,
  readCurrentState: McpRequesterResolutionServiceInput["readCurrentState"],
  connectionGeneration?: number,
): void {
  let current: McpRequesterResolutionCurrentState;
  try {
    current = readExactCurrentState(
      readCurrentState(connectionGeneration === undefined ? {} : { connectionGeneration }),
    );
  } catch {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
  if (current.revoked || !current.connectionGenerationCurrent) {
    throw new McpRequesterResolutionError("connection_generation_revoked");
  }
  if (
    current.capabilityProfileId !== expected.requester.capabilityProfileId ||
    current.capabilityProfileSha256 !== expected.requester.capabilityProfileSha256 ||
    current.callableCatalogSnapshotId !== expected.callableCatalogSnapshotId ||
    current.callableCatalogSha256 !== expected.callableCatalogSha256
  ) {
    throw new McpRequesterResolutionError("capability_profile_drift");
  }
  if (
    current.requesterScopeSha256 !== expected.requester.requesterScopeSha256 ||
    current.attemptGeneration !== expected.requester.attemptGeneration ||
    current.authConnectionGeneration !== expected.requester.authConnectionGeneration
  ) {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  if (
    current.serverConfigRevision !== expected.serverConfigRevision ||
    current.serverConfigSha256 !== expected.serverConfigSha256 ||
    current.resolverId !== expected.resolverId ||
    current.resolverVersion !== expected.resolverVersion ||
    current.resolverConfigGeneration !== expected.resolverConfigGeneration ||
    current.transportPolicySha256 !== expected.transportPolicySha256 ||
    current.meshActivationSha256 !== expected.meshActivationSha256
  ) {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
}

function readExactCurrentState(input: unknown): McpRequesterResolutionCurrentState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError();
  const keys = (ownKeys as string[]).sort(compareExact);
  const required = [
    "attemptGeneration",
    "callableCatalogSha256",
    "callableCatalogSnapshotId",
    "capabilityProfileId",
    "capabilityProfileSha256",
    "connectionGenerationCurrent",
    "requesterScopeSha256",
    "resolverConfigGeneration",
    "resolverId",
    "resolverVersion",
    "revoked",
    "serverConfigRevision",
    "serverConfigSha256",
    "transportPolicySha256",
  ];
  const optional = ["authConnectionGeneration", "meshActivationSha256"];
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) throw new TypeError();
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) throw new TypeError();
    value[key] = descriptor.value;
  }
  const stringFields = [
    "capabilityProfileId",
    "capabilityProfileSha256",
    "requesterScopeSha256",
    "serverConfigSha256",
    "resolverId",
    "resolverVersion",
    "transportPolicySha256",
    "callableCatalogSnapshotId",
    "callableCatalogSha256",
  ];
  if (stringFields.some((key) => typeof value[key] !== "string" || value[key] === "")) throw new TypeError();
  if (value.meshActivationSha256 !== undefined && typeof value.meshActivationSha256 !== "string") throw new TypeError();
  for (const key of ["serverConfigRevision", "resolverConfigGeneration", "attemptGeneration"]) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0) throw new TypeError();
  }
  if (
    value.authConnectionGeneration !== undefined &&
    (!Number.isSafeInteger(value.authConnectionGeneration) || (value.authConnectionGeneration as number) <= 0)
  ) {
    throw new TypeError();
  }
  if (typeof value.revoked !== "boolean" || typeof value.connectionGenerationCurrent !== "boolean") {
    throw new TypeError();
  }
  return Object.freeze({
    revoked: value.revoked,
    capabilityProfileId: value.capabilityProfileId,
    capabilityProfileSha256: value.capabilityProfileSha256,
    requesterScopeSha256: value.requesterScopeSha256,
    serverConfigRevision: value.serverConfigRevision,
    serverConfigSha256: value.serverConfigSha256,
    resolverId: value.resolverId,
    resolverVersion: value.resolverVersion,
    resolverConfigGeneration: value.resolverConfigGeneration,
    transportPolicySha256: value.transportPolicySha256,
    callableCatalogSnapshotId: value.callableCatalogSnapshotId,
    callableCatalogSha256: value.callableCatalogSha256,
    attemptGeneration: value.attemptGeneration,
    authConnectionGeneration: value.authConnectionGeneration,
    meshActivationSha256: value.meshActivationSha256,
    connectionGenerationCurrent: value.connectionGenerationCurrent,
  } as McpRequesterResolutionCurrentState);
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

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
