import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import {
  captureLocalEnvFileSnapshot,
  deleteLocalEnvVar,
  readLocalEnvVar,
  restoreLocalEnvFileSnapshot,
  upsertLocalEnvVar,
  type LocalEnvFileSnapshot,
} from "../env-file.js";
import type { ConfigGenerationProviderSecretEffect } from "./config-generation-service.js";
import { isSecretStoreUnavailableLikeError } from "./secret-store-service.js";

type ProviderSecretSource = "none" | "keychain" | "env" | "inline";

interface ProviderSecretEnvOwnerSummary {
  providerId: string;
  apiKeyEnv?: string;
}

interface ProviderSecretStatus {
  providerId: string;
  hasApiKey: boolean;
  apiKeySource: ProviderSecretSource;
}

interface ProviderSecretPersistenceService {
  setProviderApiKey(providerId: string, apiKey: string): void;
  deleteProviderApiKey(providerId: string): void;
  getProviderSecretStatus(providerId: string): ProviderSecretStatus;
  snapshotRuntimeConfigForPersistence(): { providers: ProviderSecretEnvOwnerSummary[] };
}

interface TransactionalProviderSecretPersistenceService extends ProviderSecretPersistenceService {
  isProviderKeychainAvailable(): boolean;
  readProviderKeychainApiKeyForPersistence(providerId: string): string | undefined;
  readInlineProviderApiKeyForPersistence(providerId: string): string | undefined;
  restoreInlineProviderApiKeyForPersistence(providerId: string, apiKey: string | undefined): void;
  clearInlineProviderApiKey(providerId: string): void;
  invalidateProviderSecretStatus(providerId: string): void;
}

export type ProviderSecretStorageTarget = "keychain" | "env";
export type ProviderSecretDeleteScope = ProviderSecretStorageTarget | "inline" | "all";

export interface PrepareProviderSecretMutationInput {
  operation: "set" | "delete";
  providerId: string;
  apiKey?: string;
  storage?: ProviderSecretStorageTarget | ProviderSecretDeleteScope;
  envVar?: string;
  rootDir: string;
  llmService: TransactionalProviderSecretPersistenceService;
  env?: NodeJS.ProcessEnv;
  allowEnvFallback?: boolean;
}

export interface ProviderSecretMutationStatus {
  providerId: string;
  hasSecret: boolean;
  source: ProviderSecretSource;
}

export interface SaveProviderSecretInput {
  providerId: string;
  apiKey: string;
  expectedRevision: number;
  storage?: ProviderSecretStorageTarget;
  envVar?: string;
}

export interface DeleteProviderSecretInput {
  providerId: string;
  expectedRevision: number;
  storage?: ProviderSecretDeleteScope;
}

export interface ProviderSecretMutationResponse extends ProviderSecretMutationStatus {
  revision: number;
}

export interface PreparedProviderSecretMutation {
  providerId: string;
  operation: "set" | "delete";
  effects: ConfigGenerationProviderSecretEffect[];
  apiKeyEnv?: string;
  apply(): ProviderSecretMutationStatus;
  restore(): void;
}

interface EnvOwnerSnapshot {
  envVar: string;
  processHadValue: boolean;
  processValue?: string;
  fileHadValue: boolean;
  fileValue?: string;
  file: LocalEnvFileSnapshot;
}

interface ProviderEnvOwnerBinding {
  providerId: string;
  envVar: string;
  registrySha256: string;
}

const RESERVED_PROVIDER_SECRET_ENV_KEYS = new Set([
  "COMSPEC",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "HOME",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

/**
 * Builds a reversible provider-secret owner transition without mutating any
 * secret or config owner. Callers place `effects` in the durable generation
 * marker before invoking `apply`.
 */
export function prepareProviderSecretMutation(
  input: PrepareProviderSecretMutationInput,
): PreparedProviderSecretMutation {
  const providerId = input.providerId.trim();
  if (!providerId) {
    throw new Error("providerId is required");
  }
  // Validate the provider and capture the only inline field this transaction
  // is allowed to clear. The value stays in process memory for compensation.
  input.llmService.getProviderSecretStatus(providerId);
  const previousInline = input.llmService.readInlineProviderApiKeyForPersistence(providerId);
  const env = input.env ?? process.env;

  if (input.operation === "set") {
    const apiKey = input.apiKey?.trim();
    if (!apiKey) {
      throw new Error("apiKey must not be empty");
    }
    const target = resolveSetTarget(input);
    if (target === "keychain") {
      const previousKeychain = input.llmService.readProviderKeychainApiKeyForPersistence(providerId);
      const effect: ConfigGenerationProviderSecretEffect = {
        providerId,
        operation: "set",
        target,
        verification: createProviderSecretVerification(apiKey),
        previousState: createPreviousState(previousKeychain),
      };
      return {
        providerId,
        operation: "set",
        effects: [effect],
        apply: () => {
          input.llmService.setProviderApiKey(providerId, apiKey);
          assertEffectSatisfied(effect, input.llmService, input.rootDir, env);
          input.llmService.clearInlineProviderApiKey(providerId);
          return readMutationStatus(input.llmService, providerId);
        },
        restore: () => {
          restoreKeychainValue(input.llmService, providerId, previousKeychain);
          input.llmService.restoreInlineProviderApiKeyForPersistence(providerId, previousInline);
        },
      };
    }

    const envOwner = resolveTransactionalEnvOwner(input);
    const envVar = envOwner.envVar;
    const previousEnv = captureEnvOwnerSnapshot(envVar, input.rootDir, env);
    const effect: ConfigGenerationProviderSecretEffect = {
      providerId,
      operation: "set",
      target,
      envVar,
      verification: createProviderSecretVerification(apiKey),
      previousState: createPreviousState(previousEnv.processHadValue ? previousEnv.processValue : undefined),
      previousEnvFileState: createPreviousState(previousEnv.fileHadValue ? previousEnv.fileValue : undefined),
    };
    return {
      providerId,
      operation: "set",
      effects: [effect],
      apiKeyEnv: envVar,
      apply: () => {
        assertProviderEnvOwnerBindingCurrent(input.llmService, envOwner);
        persistProviderApiKeyToEnv(providerId, envVar, apiKey, input.rootDir, env);
        input.llmService.invalidateProviderSecretStatus(providerId);
        assertEffectSatisfied(effect, input.llmService, input.rootDir, env);
        input.llmService.clearInlineProviderApiKey(providerId);
        return readMutationStatus(input.llmService, providerId);
      },
      restore: () => {
        restoreEnvOwnerSnapshot(previousEnv, env);
        input.llmService.invalidateProviderSecretStatus(providerId);
        input.llmService.restoreInlineProviderApiKeyForPersistence(providerId, previousInline);
      },
    };
  }

  const scope = (input.storage ?? "all") as ProviderSecretDeleteScope;
  if (!(["all", "keychain", "env", "inline"] as const).includes(scope)) {
    throw new Error(`Invalid provider secret delete scope: ${scope}`);
  }
  const effects: ConfigGenerationProviderSecretEffect[] = [];
  let previousKeychain: string | undefined;
  let previousEnv: EnvOwnerSnapshot | undefined;
  let envOwner: ProviderEnvOwnerBinding | undefined;
  if (scope === "all" || scope === "keychain") {
    if (input.llmService.isProviderKeychainAvailable()) {
      previousKeychain = input.llmService.readProviderKeychainApiKeyForPersistence(providerId);
      effects.push({
        providerId,
        operation: "delete",
        target: "keychain",
        previousState: createPreviousState(previousKeychain),
      });
    } else if (scope === "keychain") {
      throw new Error("Secure keychain is unavailable on this host.");
    }
  }
  if (scope === "all" || scope === "env") {
    envOwner = resolveTransactionalEnvOwner(input, scope === "env");
    if (envOwner) {
      previousEnv = captureEnvOwnerSnapshot(envOwner.envVar, input.rootDir, env);
      effects.push({
        providerId,
        operation: "delete",
        target: "env",
        envVar: envOwner.envVar,
        previousState: createPreviousState(previousEnv.processHadValue ? previousEnv.processValue : undefined),
        previousEnvFileState: createPreviousState(previousEnv.fileHadValue ? previousEnv.fileValue : undefined),
      });
    }
  }

  return {
    providerId,
    operation: "delete",
    effects,
    apply: () => {
      if (envOwner) {
        assertProviderEnvOwnerBindingCurrent(input.llmService, envOwner);
      }
      for (const effect of effects) {
        applyDeleteEffect(effect, input.llmService, input.rootDir, env);
      }
      // Inline API keys are never a durable target. Any explicit delete
      // removes that legacy fallback as part of publishing a secret-free
      // provider generation; saves clear it only after external verification.
      input.llmService.clearInlineProviderApiKey(providerId);
      input.llmService.invalidateProviderSecretStatus(providerId);
      return readMutationStatus(input.llmService, providerId);
    },
    restore: () => {
      if (previousEnv) {
        restoreEnvOwnerSnapshot(previousEnv, env);
      }
      if (effects.some((effect) => effect.target === "keychain")) {
        restoreKeychainValue(input.llmService, providerId, previousKeychain);
      }
      input.llmService.restoreInlineProviderApiKeyForPersistence(providerId, previousInline);
      input.llmService.invalidateProviderSecretStatus(providerId);
    },
  };
}

/** Replays/verifies a marker receipt without ever reading secret bytes into config or logs. */
export function reconcileProviderSecretEffects(
  effects: readonly ConfigGenerationProviderSecretEffect[],
  input: {
    rootDir: string;
    llmService: TransactionalProviderSecretPersistenceService;
    env?: NodeJS.ProcessEnv;
  },
): void {
  const env = input.env ?? process.env;
  for (const effect of effects) {
    if (effect.operation === "delete") {
      applyDeleteEffect(effect, input.llmService, input.rootDir, env);
      continue;
    }
    assertEffectSatisfied(effect, input.llmService, input.rootDir, env);
  }
}

/** Proves that reverse compensation restored the exact pre-effect owner state. */
export function assertProviderSecretEffectsRestored(
  effects: readonly ConfigGenerationProviderSecretEffect[],
  input: {
    rootDir: string;
    llmService: TransactionalProviderSecretPersistenceService;
    env?: NodeJS.ProcessEnv;
  },
): void {
  const env = input.env ?? process.env;
  for (const effect of effects) {
    const processOrKeychainValue =
      effect.target === "keychain"
        ? input.llmService.readProviderKeychainApiKeyForPersistence(effect.providerId)
        : effect.envVar
          ? env[effect.envVar]
          : undefined;
    const processOrKeychainRestored = matchesPreviousState(processOrKeychainValue, effect.previousState);
    const envFileRestored =
      effect.target !== "env" ||
      (effect.envVar !== undefined &&
        effect.previousEnvFileState !== undefined &&
        matchesPreviousState(
          readLocalEnvVar(effect.envVar, { rootDir: input.rootDir }).value,
          effect.previousEnvFileState,
        ));
    if (!processOrKeychainRestored || !envFileRestored) {
      throw new Error(
        `Provider secret rollback could not verify the prior ${effect.target} owner for ${effect.providerId}; ` +
          "manual reconciliation is required.",
      );
    }
  }
}

function resolveSetTarget(input: PrepareProviderSecretMutationInput): ProviderSecretStorageTarget {
  if (input.storage === "keychain" || input.storage === "env") {
    return input.storage;
  }
  if (input.storage !== undefined) {
    throw new Error(`Invalid storage target for provider secret save: ${input.storage}`);
  }
  if (input.llmService.isProviderKeychainAvailable()) {
    return "keychain";
  }
  if (input.allowEnvFallback ?? readEnvFallbackFlag(input.env ?? process.env)) {
    return "env";
  }
  throw new Error(
    `Secure keychain is unavailable on this host and writing the secret for provider ${input.providerId} ` +
      "to a plaintext .env file is disabled. Explicitly select env storage or set " +
      "GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK=1 to opt in.",
  );
}

function resolveTransactionalEnvOwner(input: PrepareProviderSecretMutationInput): ProviderEnvOwnerBinding;
function resolveTransactionalEnvOwner(
  input: PrepareProviderSecretMutationInput,
  required: boolean,
): ProviderEnvOwnerBinding | undefined;
function resolveTransactionalEnvOwner(
  input: PrepareProviderSecretMutationInput,
  required = true,
): ProviderEnvOwnerBinding | undefined {
  const binding = resolveProviderEnvOwnerBinding(input.llmService, input.providerId, input.envVar);
  if (binding) {
    return binding;
  }
  if (!required) {
    return undefined;
  }
  throw new ValidationError({
    field: "envVar",
    message: `No server-owned API-key env var is configured for provider ${input.providerId}.`,
  });
}

function captureEnvOwnerSnapshot(envVar: string, rootDir: string, env: NodeJS.ProcessEnv): EnvOwnerSnapshot {
  const fileValue = readLocalEnvVar(envVar, { rootDir });
  return {
    envVar,
    processHadValue: Object.prototype.hasOwnProperty.call(env, envVar),
    processValue: env[envVar],
    fileHadValue: fileValue.present,
    fileValue: fileValue.value,
    file: captureLocalEnvFileSnapshot({ rootDir }),
  };
}

function restoreEnvOwnerSnapshot(snapshot: EnvOwnerSnapshot, env: NodeJS.ProcessEnv): void {
  restoreLocalEnvFileSnapshot(snapshot.file);
  if (snapshot.processHadValue) {
    env[snapshot.envVar] = snapshot.processValue;
  } else {
    delete env[snapshot.envVar];
  }
}

function restoreKeychainValue(
  llmService: TransactionalProviderSecretPersistenceService,
  providerId: string,
  previous: string | undefined,
): void {
  if (previous === undefined) {
    llmService.deleteProviderApiKey(providerId);
  } else {
    llmService.setProviderApiKey(providerId, previous);
  }
}

function applyDeleteEffect(
  effect: ConfigGenerationProviderSecretEffect,
  llmService: TransactionalProviderSecretPersistenceService,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): void {
  if (effect.target === "keychain") {
    llmService.deleteProviderApiKey(effect.providerId);
    return;
  }
  const envVar = effect.envVar;
  if (!envVar) {
    throw new Error(`Provider secret env deletion is missing its env-var owner for ${effect.providerId}.`);
  }
  requireCurrentProviderEnvOwner(llmService, effect.providerId, envVar);
  delete env[envVar];
  deleteLocalEnvVar(envVar, { rootDir });
  llmService.invalidateProviderSecretStatus(effect.providerId);
}

function assertEffectSatisfied(
  effect: ConfigGenerationProviderSecretEffect,
  llmService: TransactionalProviderSecretPersistenceService,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): void {
  if (effect.operation !== "set" || !effect.verification) {
    throw new Error(`Provider secret effect receipt is incomplete for ${effect.providerId}.`);
  }
  const processOrKeychainValue =
    effect.target === "keychain"
      ? llmService.readProviderKeychainApiKeyForPersistence(effect.providerId)
      : effect.envVar
        ? env[requireCurrentProviderEnvOwner(llmService, effect.providerId, effect.envVar)]
        : undefined;
  const processOrKeychainVerified = Boolean(
    processOrKeychainValue && verifyProviderSecret(processOrKeychainValue, effect.verification),
  );
  const envFileValue =
    effect.target === "env" && effect.envVar ? readLocalEnvVar(effect.envVar, { rootDir }).value : undefined;
  const envFileVerified =
    effect.target !== "env" ||
    (effect.envVar !== undefined && Boolean(envFileValue && verifyProviderSecret(envFileValue, effect.verification)));
  if (!processOrKeychainVerified || !envFileVerified) {
    throw new Error(
      `Provider secret recovery could not verify the ${effect.target} owner for ${effect.providerId}; ` +
        "operator re-entry is required.",
    );
  }
}

function createProviderSecretVerification(
  secret: string,
): NonNullable<ConfigGenerationProviderSecretEffect["verification"]> {
  const salt = randomBytes(16);
  return {
    algorithm: "scrypt-v1",
    saltBase64: salt.toString("base64"),
    digestBase64: scryptSync(secret, salt, 32).toString("base64"),
  };
}

function createPreviousState(value: string | undefined): ConfigGenerationProviderSecretEffect["previousState"] {
  return value ? { present: true, verification: createProviderSecretVerification(value) } : { present: false };
}

function matchesPreviousState(
  current: string | undefined,
  previous: ConfigGenerationProviderSecretEffect["previousState"],
): boolean {
  return previous.present
    ? Boolean(current && previous.verification && verifyProviderSecret(current, previous.verification))
    : current === undefined || current === "";
}

function verifyProviderSecret(
  secret: string,
  verification: NonNullable<ConfigGenerationProviderSecretEffect["verification"]>,
): boolean {
  const expected = Buffer.from(verification.digestBase64, "base64");
  const actual = scryptSync(secret, Buffer.from(verification.saltBase64, "base64"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readMutationStatus(
  llmService: ProviderSecretPersistenceService,
  providerId: string,
): ProviderSecretMutationStatus {
  const status = llmService.getProviderSecretStatus(providerId);
  return {
    providerId: status.providerId,
    hasSecret: status.hasApiKey,
    source: status.apiKeySource,
  };
}

function readEnvFallbackFlag(env: NodeJS.ProcessEnv): boolean {
  const flag = env.GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

interface PersistProviderApiKeyInput {
  providerId: string;
  apiKey: string;
  rootDir: string;
  llmService: ProviderSecretPersistenceService;
  env?: NodeJS.ProcessEnv;
  preferredEnvVar?: string;
  persistToEnv?: boolean;
  allowEnvFallback?: boolean;
}

interface DeleteProviderApiKeyInput {
  providerId: string;
  rootDir: string;
  llmService: ProviderSecretPersistenceService;
  env?: NodeJS.ProcessEnv;
}

export function persistProviderApiKeyWithFallback(input: PersistProviderApiKeyInput): {
  providerId: string;
  hasSecret: boolean;
  source: ProviderSecretSource;
} {
  if (!input.persistToEnv) {
    try {
      input.llmService.setProviderApiKey(input.providerId, input.apiKey);
      const status = input.llmService.getProviderSecretStatus(input.providerId);
      return {
        providerId: status.providerId,
        hasSecret: status.hasApiKey,
        source: status.apiKeySource,
      };
    } catch (error) {
      if (!isKeychainUnavailableError(error)) {
        throw error;
      }
      // The keychain is unavailable. Only downgrade to a plaintext .env file when the
      // operator has explicitly opted in — never silently write secrets to disk.
      if (!isEnvFallbackAllowed(input)) {
        throw new Error(
          `Secure keychain is unavailable on this host and writing the secret for provider ${input.providerId} ` +
            "to a plaintext .env file is disabled. Set GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK=1 " +
            "(or pass allowEnvFallback) to opt in to env-backed secrets.",
          { cause: error },
        );
      }
    }
  }

  const envVar = resolveProviderEnvVar(input.llmService, input.providerId, input.preferredEnvVar);
  if (!envVar) {
    throw new Error(
      `Secure keychain is unavailable on this host, and no env var is configured for provider ${input.providerId}.`,
    );
  }

  return persistProviderApiKeyToEnv(input.providerId, envVar, input.apiKey, input.rootDir, input.env);
}

export function deleteProviderApiKeyWithFallback(input: DeleteProviderApiKeyInput): {
  providerId: string;
  hasSecret: boolean;
  source: ProviderSecretSource;
} {
  const status = input.llmService.getProviderSecretStatus(input.providerId);
  if (status.apiKeySource === "env") {
    const envVar = resolveProviderEnvVar(input.llmService, input.providerId);
    if (envVar) {
      delete (input.env ?? process.env)[envVar];
      deleteLocalEnvVar(envVar, { rootDir: input.rootDir });
    }
    return {
      providerId: input.providerId,
      hasSecret: false,
      source: "none",
    };
  }

  input.llmService.deleteProviderApiKey(input.providerId);
  const nextStatus = input.llmService.getProviderSecretStatus(input.providerId);
  return {
    providerId: nextStatus.providerId,
    hasSecret: nextStatus.hasApiKey,
    source: nextStatus.apiKeySource,
  };
}

function resolveProviderEnvVar(
  llmService: ProviderSecretPersistenceService,
  providerId: string,
  preferredEnvVar?: string,
): string | undefined {
  return resolveProviderEnvOwnerBinding(llmService, providerId, preferredEnvVar)?.envVar;
}

function resolveProviderEnvOwnerBinding(
  llmService: ProviderSecretPersistenceService,
  providerId: string,
  preferredEnvVar?: string,
): ProviderEnvOwnerBinding | undefined {
  const providers = readProviderEnvOwnerRegistry(llmService);
  const provider = providers.find((entry) => entry.providerId === providerId);
  const registered = provider?.apiKeyEnv;
  const preferred = preferredEnvVar?.trim();
  if (preferred && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(preferred)) {
    throw new ValidationError({ field: "envVar", message: `Invalid env var key: ${preferredEnvVar}` });
  }
  if (!registered) {
    if (preferred) {
      throw new ValidationError({
        field: "envVar",
        message: `Provider ${providerId} does not have a server-owned API-key env var.`,
      });
    }
    return undefined;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(registered)) {
    throw new ValidationError({
      field: "envVar",
      message: `Provider ${providerId} has an invalid registered API-key env owner.`,
    });
  }
  if (preferred && preferred !== registered) {
    throw new ValidationError({
      field: "envVar",
      message: `Provider ${providerId} secret env owner is server-managed and does not match ${preferred}.`,
    });
  }
  assertProviderEnvOwnerIsNotReserved(providerId, registered);
  const normalizedOwner = normalizeEnvOwnerKey(registered);
  if (
    providers.some(
      (entry) =>
        entry.providerId !== providerId &&
        entry.apiKeyEnv !== undefined &&
        normalizeEnvOwnerKey(entry.apiKeyEnv) === normalizedOwner,
    )
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Provider ${providerId} API-key env owner ${registered} is already registered to another provider.`,
    });
  }
  return {
    providerId,
    envVar: registered,
    registrySha256: fingerprintProviderEnvOwnerRegistry(providers),
  };
}

function readProviderEnvOwnerRegistry(
  llmService: ProviderSecretPersistenceService,
): Array<{ providerId: string; apiKeyEnv?: string }> {
  return llmService.snapshotRuntimeConfigForPersistence().providers.map((provider) => ({
    providerId: provider.providerId.trim(),
    apiKeyEnv: provider.apiKeyEnv?.trim() || undefined,
  }));
}

function fingerprintProviderEnvOwnerRegistry(providers: readonly { providerId: string; apiKeyEnv?: string }[]): string {
  const registry = providers
    .map((provider) => ({ providerId: provider.providerId, apiKeyEnv: provider.apiKeyEnv }))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  return createHash("sha256").update(JSON.stringify(registry)).digest("hex");
}

function assertProviderEnvOwnerBindingCurrent(
  llmService: ProviderSecretPersistenceService,
  binding: ProviderEnvOwnerBinding,
): void {
  let current: ProviderEnvOwnerBinding | undefined;
  try {
    current = resolveProviderEnvOwnerBinding(llmService, binding.providerId, binding.envVar);
  } catch {
    throwProviderEnvOwnerDrift(binding.providerId);
  }
  if (!current || current.registrySha256 !== binding.registrySha256) {
    throwProviderEnvOwnerDrift(binding.providerId);
  }
}

function requireCurrentProviderEnvOwner(
  llmService: ProviderSecretPersistenceService,
  providerId: string,
  expectedEnvVar: string,
): string {
  const current = resolveProviderEnvOwnerBinding(llmService, providerId, expectedEnvVar);
  if (!current) {
    throwProviderEnvOwnerDrift(providerId);
  }
  return current.envVar;
}

function throwProviderEnvOwnerDrift(providerId: string): never {
  throw new ConflictError({
    code: "STATE_CONFLICT",
    message: `Provider ${providerId} environment ownership changed after validation. Refresh settings and retry.`,
  });
}

function assertProviderEnvOwnerIsNotReserved(providerId: string, envVar: string): void {
  const normalized = normalizeEnvOwnerKey(envVar);
  if (normalized.startsWith("GOATCITADEL_") || RESERVED_PROVIDER_SECRET_ENV_KEYS.has(normalized)) {
    throw new ValidationError({
      field: "envVar",
      message: `Provider ${providerId} API-key env owner ${envVar} is reserved for Gateway or host runtime configuration.`,
    });
  }
}

function normalizeEnvOwnerKey(envVar: string): string {
  return envVar.trim().toUpperCase();
}

function isKeychainUnavailableError(error: unknown): boolean {
  return isSecretStoreUnavailableLikeError(error);
}

function isEnvFallbackAllowed(input: PersistProviderApiKeyInput): boolean {
  if (typeof input.allowEnvFallback === "boolean") {
    return input.allowEnvFallback;
  }
  const flag = (input.env ?? process.env).GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function persistProviderApiKeyToEnv(
  providerId: string,
  envVar: string,
  apiKey: string,
  rootDir: string,
  env?: NodeJS.ProcessEnv,
): {
  providerId: string;
  hasSecret: boolean;
  source: ProviderSecretSource;
} {
  const writeResult = upsertLocalEnvVar(envVar, apiKey, { rootDir });
  if (!writeResult.updated) {
    throw new Error(
      `Secure keychain is unavailable on this host, and GoatCitadel could not persist ${envVar} to the local .env file.`,
    );
  }

  (env ?? process.env)[envVar] = apiKey;
  return {
    providerId,
    hasSecret: true,
    source: "env",
  };
}
