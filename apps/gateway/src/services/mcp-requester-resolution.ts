import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import {
  assertMcpRequesterResolutionBinding,
  assertMcpRequesterResolutionConfig,
  canonicalJsonString,
  mcpRequesterResolutionBindingHashMaterial,
  mcpRequesterScopeHashMaterial,
  type McpRequesterResolutionBinding,
  type McpRequesterResolutionConfig,
  type McpRequesterResolutionTransportPolicy,
  type McpRequesterScopeAuthActorSource,
} from "@goatcitadel/contracts";

export const MCP_REQUESTER_RESOLUTION_TIMEOUT_MS = 2_000;
export const MCP_REQUESTER_CONNECTION_MAX_AGE_MS = 5 * 60_000;
export const MCP_REQUESTER_CONNECTION_URL_MAX_BYTES = 2_048;
export const MCP_REQUESTER_CONNECTION_HEADER_LIMIT = 16;
export const MCP_REQUESTER_CONNECTION_HEADER_NAME_MAX_BYTES = 64;
export const MCP_REQUESTER_CONNECTION_HEADER_VALUE_MAX_BYTES = 8_192;
export const MCP_REQUESTER_CONNECTION_HEADER_AGGREGATE_MAX_BYTES = 32_768;

export type McpRequesterResolutionReasonCode =
  | "requester_context_missing"
  | "requester_context_ambiguous"
  | "requester_scope_mismatch"
  | "capability_profile_missing"
  | "capability_profile_invalid"
  | "capability_profile_drift"
  | "server_not_callable"
  | "resolver_missing"
  | "resolver_binding_drift"
  | "resolver_timeout"
  | "resolver_cancelled"
  | "resolver_failed"
  | "resolved_connection_invalid"
  | "resolved_destination_denied"
  | "resolved_header_denied"
  | "resolved_connection_expired"
  | "connection_generation_revoked"
  | "secret_guard_failed"
  | "transport_pre_dispatch_failed"
  | "transport_outcome_unknown";

const REASON_MESSAGES: Record<McpRequesterResolutionReasonCode, string> = {
  requester_context_missing: "Authenticated requester context is required.",
  requester_context_ambiguous: "Authenticated requester context is invalid.",
  requester_scope_mismatch: "Authenticated requester scope does not match.",
  capability_profile_missing: "The immutable capability profile is required.",
  capability_profile_invalid: "The immutable capability profile is invalid.",
  capability_profile_drift: "The immutable capability profile has drifted.",
  server_not_callable: "The MCP server is not callable.",
  resolver_missing: "The requester connection resolver is unavailable.",
  resolver_binding_drift: "The requester connection resolver binding has drifted.",
  resolver_timeout: "Requester connection resolution timed out.",
  resolver_cancelled: "Requester connection resolution was cancelled.",
  resolver_failed: "Requester connection resolution failed.",
  resolved_connection_invalid: "The resolved MCP connection is invalid.",
  resolved_destination_denied: "The resolved MCP destination is denied.",
  resolved_header_denied: "A resolved MCP header is denied.",
  resolved_connection_expired: "The resolved MCP connection has expired.",
  connection_generation_revoked: "The resolved MCP connection generation is no longer current.",
  secret_guard_failed: "The requester connection secret guard failed.",
  transport_pre_dispatch_failed: "The MCP transport failed before dispatch.",
  transport_outcome_unknown: "The MCP transport outcome is unknown.",
};

export class McpRequesterResolutionError extends Error {
  public readonly code: McpRequesterResolutionReasonCode;

  public constructor(code: McpRequesterResolutionReasonCode) {
    super(REASON_MESSAGES[code]);
    this.name = "McpRequesterResolutionError";
    this.code = code;
  }
}

const requesterAuthorityBrand: unique symbol = Symbol("goatcitadel.mcp.requester-authority");
const requesterAuthorities = new WeakSet<object>();

export interface McpRequesterAuthorityInput {
  actorId: string;
  actorSource: McpRequesterScopeAuthActorSource;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  capabilityProfileId: string;
  capabilityProfileSha256: string;
  requesterScopeSha256: string;
  invocationAttemptId: string;
  attemptGeneration: number;
  authConnectionGeneration?: number;
}

export interface McpRequesterAuthority extends Readonly<McpRequesterAuthorityInput> {
  readonly [requesterAuthorityBrand]: true;
  toJSON(): never;
}

class McpRequesterAuthorityValue implements McpRequesterAuthority {
  declare public readonly [requesterAuthorityBrand]: true;
  readonly #value: Readonly<McpRequesterAuthorityInput>;

  public constructor(value: McpRequesterAuthorityInput) {
    this.#value = value;
    requesterAuthorities.add(this);
    Object.freeze(this);
  }

  public get actorId(): string {
    return this.#value.actorId;
  }
  public get actorSource(): McpRequesterScopeAuthActorSource {
    return this.#value.actorSource;
  }
  public get workspaceId(): string {
    return this.#value.workspaceId;
  }
  public get sessionId(): string {
    return this.#value.sessionId;
  }
  public get turnId(): string {
    return this.#value.turnId;
  }
  public get capabilityProfileId(): string {
    return this.#value.capabilityProfileId;
  }
  public get capabilityProfileSha256(): string {
    return this.#value.capabilityProfileSha256;
  }
  public get requesterScopeSha256(): string {
    return this.#value.requesterScopeSha256;
  }
  public get invocationAttemptId(): string {
    return this.#value.invocationAttemptId;
  }
  public get attemptGeneration(): number {
    return this.#value.attemptGeneration;
  }
  public get authConnectionGeneration(): number | undefined {
    return this.#value.authConnectionGeneration;
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

export function createMcpRequesterAuthority(input: McpRequesterAuthorityInput): McpRequesterAuthority {
  let value: Readonly<McpRequesterAuthorityInput>;
  try {
    value = snapshotExactOwnDataRecord(
      input,
      [
        "actorId",
        "actorSource",
        "attemptGeneration",
        "authConnectionGeneration",
        "capabilityProfileId",
        "capabilityProfileSha256",
        "invocationAttemptId",
        "requesterScopeSha256",
        "sessionId",
        "turnId",
        "workspaceId",
      ],
      ["authConnectionGeneration"],
    ) as unknown as Readonly<McpRequesterAuthorityInput>;
    assertCanonicalIdentifier(value.invocationAttemptId, 256);
    assertPositiveSafeInteger(value.attemptGeneration);
    if (value.authConnectionGeneration !== undefined) assertPositiveSafeInteger(value.authConnectionGeneration);
    assertLowercaseSha256(value.capabilityProfileSha256);
    assertLowercaseSha256(value.requesterScopeSha256);
    const expectedScopeSha256 = digest(
      mcpRequesterScopeHashMaterial({
        profileId: value.capabilityProfileId,
        turnId: value.turnId,
        sessionId: value.sessionId,
        workspaceId: value.workspaceId,
        authActorId: value.actorId,
        authActorSource: value.actorSource,
      }),
    );
    if (expectedScopeSha256 !== value.requesterScopeSha256) {
      throw new McpRequesterResolutionError("requester_scope_mismatch");
    }
  } catch (error) {
    if (error instanceof McpRequesterResolutionError) throw error;
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
  return new McpRequesterAuthorityValue(value);
}

export function assertMcpRequesterAuthority(input: unknown): asserts input is McpRequesterAuthority {
  if (typeof input !== "object" || input === null || !requesterAuthorities.has(input)) {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

export interface McpRequesterScopedServerSnapshot {
  serverId: string;
  transport: "http" | "sse";
  connectionMode: "requester_scoped";
  configurationRevision: number;
  requesterResolution: McpRequesterResolutionConfig;
}

export interface McpRequesterCapabilityProfileSnapshot {
  profileId: string;
  profileSha256: string;
  callableCatalogSnapshotId: string;
  callableCatalogSha256: string;
  canonicalToolName: string;
}

export interface McpRequesterResolutionCurrentState {
  revoked: boolean;
  capabilityProfileId: string;
  capabilityProfileSha256: string;
  requesterScopeSha256: string;
  serverConfigRevision: number;
  serverConfigSha256: string;
  resolverId: string;
  resolverVersion: string;
  resolverConfigGeneration: number;
  transportPolicySha256: string;
  callableCatalogSnapshotId: string;
  callableCatalogSha256: string;
  attemptGeneration: number;
  authConnectionGeneration?: number;
  meshActivationSha256?: string;
  connectionGenerationCurrent: boolean;
}

export interface McpRequesterConnectionResolverInput {
  serverId: string;
  requester: McpRequesterAuthority;
  binding: McpRequesterResolutionBinding;
  signal: AbortSignal;
}

export interface McpEphemeralResolvedHeaderInput {
  name: string;
  value: string;
}

export interface McpEphemeralResolvedConnectionInput {
  outcomeClass: "resolved";
  url: string;
  headers: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>;
  connectionGeneration: number;
  rotationGeneration?: number;
  expiresAt: string;
}

const resolvedConnectionCandidateBrand: unique symbol = Symbol("goatcitadel.mcp.resolved-connection-candidate");
const readResolvedConnectionCandidate: unique symbol = Symbol("goatcitadel.mcp.read-resolved-connection-candidate");

export interface McpEphemeralResolvedConnectionCandidate {
  readonly [resolvedConnectionCandidateBrand]: true;
  toJSON(): never;
}

class McpEphemeralResolvedConnectionCandidateValue implements McpEphemeralResolvedConnectionCandidate {
  declare public readonly [resolvedConnectionCandidateBrand]: true;
  readonly #value: Readonly<McpEphemeralResolvedConnectionInput>;

  public constructor(value: McpEphemeralResolvedConnectionInput) {
    this.#value = Object.freeze({
      outcomeClass: value.outcomeClass,
      url: value.url,
      headers: value.headers,
      connectionGeneration: value.connectionGeneration,
      ...(value.rotationGeneration === undefined ? {} : { rotationGeneration: value.rotationGeneration }),
      expiresAt: value.expiresAt,
    });
    Object.freeze(this);
  }

  public [readResolvedConnectionCandidate](): McpEphemeralResolvedConnectionInput {
    return {
      ...this.#value,
      headers: this.#value.headers.map((header) => ({ ...header })),
    };
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }
}

export function createMcpEphemeralResolvedConnectionCandidate(
  input: McpEphemeralResolvedConnectionInput,
): McpEphemeralResolvedConnectionCandidate {
  try {
    return new McpEphemeralResolvedConnectionCandidateValue(snapshotResolvedConnectionInput(input));
  } catch {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
}

Object.freeze(McpRequesterAuthorityValue.prototype);
Object.freeze(McpEphemeralResolvedConnectionCandidateValue.prototype);

export function readMcpEphemeralResolvedConnectionCandidate(input: unknown): McpEphemeralResolvedConnectionInput {
  if (!(input instanceof McpEphemeralResolvedConnectionCandidateValue)) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  return input[readResolvedConnectionCandidate]();
}

export interface McpRequesterConnectionResolver {
  readonly resolverId: string;
  readonly resolverVersion: string;
  readonly configGeneration: number;
  resolve(input: McpRequesterConnectionResolverInput): Promise<McpEphemeralResolvedConnectionCandidate>;
}

type StableMcpRequesterConnectionResolver = McpRequesterConnectionResolver;

export class McpRequesterResolverRegistry {
  readonly #byId: ReadonlyMap<string, StableMcpRequesterConnectionResolver>;

  public constructor(resolvers: readonly McpRequesterConnectionResolver[]) {
    let entries: readonly unknown[];
    try {
      entries = snapshotExactArray(resolvers, 64);
    } catch {
      throw new McpRequesterResolutionError("resolver_binding_drift");
    }
    const byId = new Map<string, StableMcpRequesterConnectionResolver>();
    for (const resolver of entries) {
      let snapshot: Readonly<Record<string, unknown>>;
      try {
        snapshot = snapshotExactOwnDataRecord(resolver, [
          "configGeneration",
          "resolve",
          "resolverId",
          "resolverVersion",
        ]);
        assertCanonicalIdentifier(snapshot.resolverId, 128);
        assertCanonicalSemVer(snapshot.resolverVersion);
        assertPositiveSafeInteger(snapshot.configGeneration);
        if (
          typeof snapshot.resolve !== "function" ||
          nodeTypes.isProxy(snapshot.resolve) ||
          byId.has(snapshot.resolverId)
        ) {
          throw new TypeError();
        }
      } catch {
        throw new McpRequesterResolutionError("resolver_binding_drift");
      }
      const receiver = Object.freeze({
        resolverId: snapshot.resolverId,
        resolverVersion: snapshot.resolverVersion,
        configGeneration: snapshot.configGeneration,
        resolve: snapshot.resolve,
      });
      const stable = Object.freeze({
        resolverId: snapshot.resolverId,
        resolverVersion: snapshot.resolverVersion,
        configGeneration: snapshot.configGeneration,
        resolve: snapshot.resolve.bind(receiver),
      });
      byId.set(stable.resolverId, stable);
    }
    this.#byId = byId;
  }

  public resolveExact(resolverId: string, resolverVersion: string, configGeneration: number) {
    const resolver = this.#byId.get(resolverId);
    if (!resolver) throw new McpRequesterResolutionError("resolver_missing");
    if (resolver.resolverVersion !== resolverVersion || resolver.configGeneration !== configGeneration) {
      throw new McpRequesterResolutionError("resolver_binding_drift");
    }
    return resolver;
  }

  public listMetadata(): Array<{ resolverId: string; resolverVersion: string; configGeneration: number }> {
    return [...this.#byId.values()]
      .map(({ resolverId, resolverVersion, configGeneration }) => ({
        resolverId,
        resolverVersion,
        configGeneration,
      }))
      .sort((left, right) => left.resolverId.localeCompare(right.resolverId));
  }
}

export interface ValidatedMcpEphemeralResolvedConnection {
  outcomeClass: "resolved";
  url: string;
  headers: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>;
  connectionGeneration: number;
  rotationGeneration?: number;
  expiresAt: string;
  expiresAtMs: number;
}

export function assertMcpRequesterScopedServerSnapshot(
  input: unknown,
): asserts input is McpRequesterScopedServerSnapshot {
  try {
    assertExactKeys(input, ["configurationRevision", "connectionMode", "requesterResolution", "serverId", "transport"]);
    const value = input as Record<string, unknown>;
    assertCanonicalIdentifier(value.serverId, 256);
    if (value.transport !== "http" && value.transport !== "sse") throw new TypeError();
    if (value.connectionMode !== "requester_scoped") throw new TypeError();
    assertPositiveSafeInteger(value.configurationRevision);
    assertMcpRequesterResolutionConfig(value.requesterResolution);
  } catch {
    throw new McpRequesterResolutionError("server_not_callable");
  }
}

export function assertMcpRequesterCapabilityProfileSnapshot(
  input: unknown,
): asserts input is McpRequesterCapabilityProfileSnapshot {
  try {
    assertExactKeys(input, [
      "callableCatalogSha256",
      "callableCatalogSnapshotId",
      "canonicalToolName",
      "profileId",
      "profileSha256",
    ]);
    const value = input as Record<string, unknown>;
    assertCanonicalIdentifier(value.profileId, 256);
    assertCanonicalIdentifier(value.callableCatalogSnapshotId, 256);
    assertCanonicalIdentifier(value.canonicalToolName, 256);
    assertLowercaseSha256(value.profileSha256);
    assertLowercaseSha256(value.callableCatalogSha256);
  } catch {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
}

export function mcpRequesterScopedServerConfigHash(input: McpRequesterScopedServerSnapshot): string {
  assertMcpRequesterScopedServerSnapshot(input);
  return digest(input);
}

export function mcpRequesterTransportPolicyHash(input: McpRequesterResolutionTransportPolicy): string {
  assertMcpRequesterResolutionConfig({
    resolverId: "goatcitadel.policy-hash",
    resolverVersion: "1.0.0",
    configGeneration: 1,
    transportPolicy: input,
  });
  return digest(input);
}

export function mcpRequesterMeshActivationHash(binding: McpRequesterResolutionBinding): string | undefined {
  assertMcpRequesterResolutionBinding(binding);
  return binding.meshActivation ? digest(binding.meshActivation) : undefined;
}

export function assertMcpRequesterResolutionBindingIntegrity(binding: McpRequesterResolutionBinding): void {
  try {
    assertMcpRequesterResolutionBinding(binding);
    if (digest(mcpRequesterResolutionBindingHashMaterial(binding)) !== binding.bindingSha256) throw new TypeError();
  } catch {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
}

export function validateMcpEphemeralResolvedConnection(
  input: unknown,
  transportPolicy: McpRequesterResolutionTransportPolicy,
  nowMs: number,
): ValidatedMcpEphemeralResolvedConnection {
  let value: McpEphemeralResolvedConnectionInput;
  try {
    value = snapshotResolvedConnectionInput(input);
  } catch (error) {
    if (error instanceof McpRequesterResolutionError && error.code === "resolved_header_denied") throw error;
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  if (value.outcomeClass !== "resolved") {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  assertPositiveConnectionGeneration(value.connectionGeneration);
  if (value.rotationGeneration !== undefined) assertPositiveConnectionGeneration(value.rotationGeneration);
  const validatedUrl = validateResolvedUrl(value.url, transportPolicy);
  const headers = validateResolvedHeaders(value.headers, transportPolicy);
  const expiresAt = validateResolvedExpiry(value.expiresAt, nowMs);
  return Object.freeze({
    outcomeClass: "resolved",
    url: validatedUrl,
    headers,
    connectionGeneration: value.connectionGeneration,
    ...(value.rotationGeneration === undefined ? {} : { rotationGeneration: value.rotationGeneration }),
    expiresAt: expiresAt.canonical,
    expiresAtMs: expiresAt.epochMs,
  });
}

function validateResolvedUrl(input: unknown, policy: McpRequesterResolutionTransportPolicy): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input !== input.trim() ||
    Buffer.byteLength(input, "utf8") > MCP_REQUESTER_CONNECTION_URL_MAX_BYTES ||
    containsAsciiControlCharacter(input) ||
    input.includes("\\") ||
    input.includes("#")
  ) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  const scheme = parsed.protocol.slice(0, -1);
  if ((scheme !== "http" && scheme !== "https") || parsed.username || parsed.password || parsed.hash) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  if (
    !policy.allowedSchemes.includes(scheme) ||
    !policy.allowedHosts.includes(host) ||
    !policy.allowedPorts.includes(port)
  ) {
    throw new McpRequesterResolutionError("resolved_destination_denied");
  }
  if (scheme === "http" && !isExactLoopbackHost(host)) {
    throw new McpRequesterResolutionError("resolved_destination_denied");
  }
  return input;
}

function validateResolvedHeaders(
  input: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>,
  policy: McpRequesterResolutionTransportPolicy,
): ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>> {
  if (input.length > MCP_REQUESTER_CONNECTION_HEADER_LIMIT) {
    throw new McpRequesterResolutionError("resolved_header_denied");
  }
  const forbidden = new Set([
    "connection",
    "content-length",
    "cookie",
    "forwarded",
    "host",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
    "proxy-authorization",
    "proxy-connection",
    "set-cookie",
    "transfer-encoding",
    "upgrade",
  ]);
  const seen = new Set<string>();
  const validated: Array<Readonly<McpEphemeralResolvedHeaderInput>> = [];
  let aggregateBytes = 0;
  for (const entry of input) {
    const { name, value } = entry;
    if (
      typeof name !== "string" ||
      name !== name.normalize("NFKC") ||
      Buffer.byteLength(name, "utf8") > MCP_REQUESTER_CONNECTION_HEADER_NAME_MAX_BYTES ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)
    ) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    const canonicalName = name.toLowerCase();
    if (
      seen.has(canonicalName) ||
      forbidden.has(canonicalName) ||
      canonicalName.startsWith("proxy-") ||
      canonicalName.startsWith("x-forwarded-") ||
      !policy.allowedHeaderNames.includes(canonicalName)
    ) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      containsAsciiControlCharacter(value) ||
      Buffer.byteLength(value, "utf8") > MCP_REQUESTER_CONNECTION_HEADER_VALUE_MAX_BYTES
    ) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    aggregateBytes += Buffer.byteLength(canonicalName, "utf8") + Buffer.byteLength(value, "utf8") + 4;
    if (aggregateBytes > MCP_REQUESTER_CONNECTION_HEADER_AGGREGATE_MAX_BYTES) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    seen.add(canonicalName);
    validated.push(Object.freeze({ name: canonicalName, value }));
  }
  return Object.freeze(validated);
}

function validateResolvedExpiry(input: unknown, nowMs: number): { canonical: string; epochMs: number } {
  if (typeof input !== "string" || !Number.isFinite(nowMs)) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  const epochMs = Date.parse(input);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== input) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  if (epochMs <= nowMs) throw new McpRequesterResolutionError("resolved_connection_expired");
  if (epochMs > nowMs + MCP_REQUESTER_CONNECTION_MAX_AGE_MS) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  return { canonical: input, epochMs };
}

function assertPositiveConnectionGeneration(input: unknown): asserts input is number {
  try {
    assertPositiveSafeInteger(input);
  } catch {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
}

function isExactLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function assertExactKeys(input: unknown, keys: readonly string[], optional: readonly string[] = []): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError();
  const actual = Object.keys(input).sort(compareExact);
  const allowed = new Set(keys);
  const optionalSet = new Set(optional);
  if (actual.some((key) => !allowed.has(key))) throw new TypeError();
  if (keys.some((key) => !optionalSet.has(key) && !actual.includes(key))) throw new TypeError();
}

function snapshotResolvedConnectionInput(input: unknown): McpEphemeralResolvedConnectionInput {
  const value = snapshotExactOwnDataRecord(
    input,
    ["connectionGeneration", "expiresAt", "headers", "outcomeClass", "rotationGeneration", "url"],
    ["rotationGeneration"],
  );
  const headerEntries = snapshotExactArray(
    value.headers,
    MCP_REQUESTER_CONNECTION_HEADER_LIMIT,
    () => new McpRequesterResolutionError("resolved_header_denied"),
  );
  const headers = Object.freeze(
    headerEntries.map((header) => {
      const snapshot = snapshotExactOwnDataRecord(header, ["name", "value"]);
      return Object.freeze({ name: snapshot.name, value: snapshot.value }) as Readonly<McpEphemeralResolvedHeaderInput>;
    }),
  );
  return Object.freeze({
    outcomeClass: value.outcomeClass,
    url: value.url,
    headers,
    connectionGeneration: value.connectionGeneration,
    ...(value.rotationGeneration === undefined ? {} : { rotationGeneration: value.rotationGeneration }),
    expiresAt: value.expiresAt,
  }) as McpEphemeralResolvedConnectionInput;
}

function snapshotExactOwnDataRecord(
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

function snapshotExactArray(input: unknown, maxLength: number, onLimit?: () => Error): readonly unknown[] {
  if (!Array.isArray(input) || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor)) throw new TypeError();
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError();
  if (length > maxLength) throw onLimit?.() ?? new TypeError();
  const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) throw new TypeError();
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new TypeError();
    values.push(descriptor.value);
  }
  return Object.freeze(values);
}

function assertCanonicalIdentifier(input: unknown, maxLength: number): asserts input is string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > maxLength ||
    input !== input.normalize("NFKC").trim() ||
    containsAsciiControlCharacter(input) ||
    /[\s\\]/u.test(input) ||
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(input)
  ) {
    throw new TypeError();
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function assertCanonicalSemVer(input: unknown): asserts input is string {
  if (
    typeof input !== "string" ||
    input.length > 128 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      input,
    )
  ) {
    throw new TypeError();
  }
}

function assertPositiveSafeInteger(input: unknown): asserts input is number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) throw new TypeError();
}

function assertLowercaseSha256(input: unknown): asserts input is string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) throw new TypeError();
}

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
