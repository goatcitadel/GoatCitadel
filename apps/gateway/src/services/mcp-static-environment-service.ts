import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveMcpServerConnectionMode, type McpServerRecord } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import type { SecretStoreService } from "./secret-store-service.js";
import type { McpServerStore } from "./mcp-server-store.js";

/** Private settings contain only this opaque keychain reference, never a credential digest. */
export interface McpEnvironmentBindingRecord {
  credentialRef: string;
}

export const MCP_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "NODE_ENV",
  "NODE_PATH",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const;

export function buildMcpChildEnvironment(server: McpServerRecord, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const captured = pickEnvironment(source, [
    ...MCP_SAFE_ENV_KEYS,
    ...normalizeSafeEnvKeyNames(server.policy.allowedEnvKeys),
  ]);
  return Object.fromEntries(Object.entries(captured).filter((entry) => entry[1] !== undefined));
}

function effectiveEnvironment(server: McpServerRecord, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys: string[] =
    server.transport === "stdio"
      ? [...MCP_SAFE_ENV_KEYS, ...normalizeSafeEnvKeyNames(server.policy.allowedEnvKeys)]
      : server.authType === "token"
        ? normalizeSafeEnvKeyNames(server.policy.allowedEnvKeys).slice(0, 1)
        : [];
  if (server.authType === "oauth2")
    keys.push(
      ...normalizeSafeEnvKeyNames([
        ...(server.oauth?.clientIdEnv ? [server.oauth.clientIdEnv] : []),
        ...(server.oauth?.clientSecretEnv ? [server.oauth.clientSecretEnv] : []),
      ]),
    );
  return pickEnvironment(source, keys);
}

function pickEnvironment(source: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  // Include absent declared variables so adding/removing one changes the material.
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of [...new Set(keys)].sort()) result[key] = source[key];
  if (Buffer.byteLength(material(result), "utf8") > 64 * 1024)
    throw new Error("MCP environment exceeds its capture limit.");
  return Object.freeze(result);
}

interface EnvironmentProof {
  version: 1;
  key: string;
  digest: string;
}
declare const environmentHandleBrand: unique symbol;
/** App-private authority; neither a transport DTO nor a serializable credential container. */
export interface McpStaticEnvironmentHandle {
  readonly [environmentHandleBrand]: true;
}
interface CapturedEnvironment {
  server: McpServerRecord;
  environment: NodeJS.ProcessEnv;
  assertCurrent(): Promise<void>;
}
const captured = new WeakMap<McpStaticEnvironmentHandle, CapturedEnvironment>();

export function readMcpStaticEnvironment(
  handle: McpStaticEnvironmentHandle,
  server: McpServerRecord,
): NodeJS.ProcessEnv {
  return requireCaptured(handle, server).environment;
}

export async function assertMcpStaticEnvironmentCurrent(
  handle: McpStaticEnvironmentHandle,
  server: McpServerRecord,
): Promise<void> {
  await requireCaptured(handle, server).assertCurrent();
}

function requireCaptured(handle: McpStaticEnvironmentHandle, server: McpServerRecord): CapturedEnvironment {
  const entry = captured.get(handle);
  if (!entry || !isDeepStrictEqual(configurationMaterial(entry.server), configurationMaterial(server))) {
    throw new Error("MCP environment requires its original server-owned configuration handle.");
  }
  return entry;
}

export interface McpStaticEnvironmentServiceOptions {
  registry: Pick<McpServerStore, "readEnvironmentBinding" | "writeEnvironmentBinding">;
  secretStore: Pick<SecretStoreService, "getSecret" | "setSecret" | "deleteSecret" | "isWriteCustodySafe"> & Partial<Pick<SecretStoreService, "setSecretForCustody">>;
  env?: NodeJS.ProcessEnv;
  reconcileRetiredCredentials?: () => Promise<void>;
  stageCredentials?: (serverId: string, refs: readonly string[], write: (custodyId?: string) => undefined) => Promise<void>;
}

export class McpStaticEnvironmentService {
  private readonly env: NodeJS.ProcessEnv;
  public constructor(private readonly options: McpStaticEnvironmentServiceOptions) {
    this.env = options.env ?? process.env;
  }

  /** Operator connect/reconnect is the only path that accepts changed ambient credentials. */
  public async enroll(server: McpServerRecord): Promise<McpServerRecord> {
    assertStatic(server);
    const configuration = structuredClone(server);
    const environment = effectiveEnvironment(configuration, this.env);
    const previous = await this.options.registry.readEnvironmentBinding(server.serverId);
    if (Object.keys(environment).length === 0) {
      const current = await this.options.registry.writeEnvironmentBinding(configuration, previous, undefined);
      await this.retirePublished(server.serverId, previous);
      return current;
    }
    if (previous) {
      let proof: EnvironmentProof | undefined;
      try {
        proof = this.readProof(server.serverId, previous);
      } catch (error) {
        // Explicit reconnect may replace a corrupt proof, but keychain failures stay visible.
        if (!(error instanceof McpEnvironmentChangedError)) throw error;
      }
      if (proof && matchesProof(proof, environment)) {
        return this.options.registry.writeEnvironmentBinding(configuration, previous, previous);
      }
    }
    if (!this.options.secretStore.isWriteCustodySafe())
      throw new Error("MCP environment enrollment requires secure keychain write custody.");
    const account = `mcp:${server.serverId}:environment:${randomUUID()}`;
    const key = randomBytes(32).toString("base64url");
    const proof: EnvironmentProof = { version: 1, key, digest: digest(key, environment) };
    const next = { credentialRef: `keychain:goatcitadel:${account}` };
    try {
      const write = (custodyId?: string): undefined => {
        if (custodyId === undefined) this.options.secretStore.setSecret(account, JSON.stringify(proof));
        else {
          if (!this.options.secretStore.setSecretForCustody) throw new Error("MCP environment writer requires its OS custody owner.");
          this.options.secretStore.setSecretForCustody(account, JSON.stringify(proof), custodyId);
        }
      };
      if (this.options.stageCredentials)
        await this.options.stageCredentials(server.serverId, [next.credentialRef], write);
      else write();
    } catch (error) {
      if (!this.options.stageCredentials) this.retire(server.serverId, next);
      throw error;
    }
    // An uncertain database acknowledgment retains both immutable proof versions.
    const current = await this.options.registry.writeEnvironmentBinding(configuration, previous, next);
    await this.retirePublished(server.serverId, previous);
    return current;
  }

  /** Capture only already-enrolled authority; drift never silently enrolls another Gateway's environment. */
  public async capture(server: McpServerRecord): Promise<McpStaticEnvironmentHandle> {
    assertStatic(server);
    const configuration = structuredClone(server);
    if (!configuration.configurationBindingId) throw changedEnvironment();
    const environment = effectiveEnvironment(configuration, this.env);
    const binding = await this.options.registry.readEnvironmentBinding(server.serverId);
    this.assertMatches(configuration, environment, binding);
    // Also fence the canonical configuration and binding; no change is requested here.
    const current = await this.options.registry.writeEnvironmentBinding(configuration, binding, binding);
    const handle = Object.freeze({}) as McpStaticEnvironmentHandle;
    captured.set(handle, {
      server: structuredClone(current),
      environment,
      assertCurrent: async () => {
        const latestEnvironment = effectiveEnvironment(current, this.env);
        if (!isDeepStrictEqual(material(environment), material(latestEnvironment))) throw changedEnvironment();
        this.assertMatches(current, environment, binding);
        await this.options.registry.writeEnvironmentBinding(current, binding, binding);
      },
    });
    return handle;
  }

  private assertMatches(
    server: McpServerRecord,
    environment: NodeJS.ProcessEnv,
    binding: McpEnvironmentBindingRecord | undefined,
  ): void {
    if (Object.keys(environment).length === 0) {
      if (binding) throw changedEnvironment();
      return;
    }
    const proof = binding ? this.readProof(server.serverId, binding) : undefined;
    if (!proof || !matchesProof(proof, environment)) throw changedEnvironment();
  }

  private readProof(serverId: string, binding: McpEnvironmentBindingRecord): EnvironmentProof | undefined {
    if (!isMcpEnvironmentRefForServer(binding.credentialRef, serverId)) throw changedEnvironment();
    const value = this.options.secretStore.getSecret(binding.credentialRef.slice("keychain:goatcitadel:".length));
    if (!value) return undefined;
    if (Buffer.byteLength(value, "utf8") > 512) throw changedEnvironment();
    let proof: EnvironmentProof;
    try {
      proof = JSON.parse(value) as EnvironmentProof;
    } catch {
      throw changedEnvironment();
    }
    if (
      !proof ||
      typeof proof !== "object" ||
      Object.keys(proof).length !== 3 ||
      proof.version !== 1 ||
      typeof proof.key !== "string" ||
      !/^[a-zA-Z0-9_-]{43}$/u.test(proof.key) ||
      typeof proof.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(proof.digest)
    )
      throw changedEnvironment();
    return proof;
  }

  private async retirePublished(serverId: string, binding: McpEnvironmentBindingRecord | undefined): Promise<void> {
    if (this.options.reconcileRetiredCredentials) {
      try { await this.options.reconcileRetiredCredentials(); }
      catch {
        // The new binding already committed; retain cleanup for reconciliation.
        logger.warn("MCP environment retained credential cleanup requires reconciliation.");
      }
    } else this.retire(serverId, binding);
  }

  private retire(serverId: string, binding: McpEnvironmentBindingRecord | undefined): void {
    if (!binding) return;
    if (!isMcpEnvironmentRefForServer(binding.credentialRef, serverId)) {
      logger.warn("MCP environment proof cleanup refused a credential entry outside its server scope.");
      return;
    }
    try {
      this.options.secretStore.deleteSecret(binding.credentialRef.slice("keychain:goatcitadel:".length));
    } catch {
      logger.warn("MCP environment proof cleanup could not remove a retired keychain entry.");
    }
  }
}

export function isMcpEnvironmentRefForServer(value: unknown, serverId: string): value is string {
  const prefix = `keychain:goatcitadel:mcp:${serverId}:environment:`;
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.slice(prefix.length))
  );
}

function assertStatic(server: McpServerRecord): void {
  if (resolveMcpServerConnectionMode(server) !== "static")
    throw new Error("MCP environment capture requires static configuration.");
}

class McpEnvironmentChangedError extends Error {
  public constructor() {
    super("MCP environment credentials are missing or changed; reconnect this server from Settings.");
    this.name = "McpEnvironmentChangedError";
  }
}

function changedEnvironment(): McpEnvironmentChangedError {
  return new McpEnvironmentChangedError();
}

function material(environment: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    Object.keys(environment)
      .sort()
      .map((key) => [key, environment[key] ?? null]),
  );
}

function digest(key: string, environment: NodeJS.ProcessEnv): string {
  return createHmac("sha256", Buffer.from(key, "base64url"))
    .update("goatcitadel:mcp-environment:v1\0")
    .update(material(environment))
    .digest("hex");
}

function matchesProof(proof: EnvironmentProof, environment: NodeJS.ProcessEnv): boolean {
  return timingSafeEqual(Buffer.from(proof.digest, "hex"), Buffer.from(digest(proof.key, environment), "hex"));
}

function configurationMaterial(server: McpServerRecord): unknown {
  const copy = { ...server };
  for (const key of ["authState", "status", "lastConnectedAt", "lastError", "updatedAt"] as const) delete copy[key];
  return JSON.parse(JSON.stringify(copy)) as unknown;
}
