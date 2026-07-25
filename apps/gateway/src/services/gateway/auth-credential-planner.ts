import fsSync from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  AuthMode,
  GatewayAuthCredentialPlan,
  GatewayAuthCredentialSource,
  GatewayInstallTokenResolution,
} from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../../config.js";
import { detectEnvFilePath, upsertLocalEnvVar } from "../../env-file.js";

type AssistantConfigAuthSnapshot = {
  mode?: AuthMode;
  allowLoopbackBypass?: boolean;
  token?: {
    value?: string;
    queryParam?: string;
  };
  basic?: {
    username?: string;
    password?: string;
  };
};

type PlannerParams = {
  runtimeConfig: GatewayRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  configAuth?: AssistantConfigAuthSnapshot;
};

type InstallTokenParams = PlannerParams & {
  explicitToken?: string;
  generateWhenMissing?: boolean;
  persistToEnv?: boolean;
};

const ENV_MODE_KEY = "GOATCITADEL_AUTH_MODE";
const ENV_TOKEN_KEY = "GOATCITADEL_AUTH_TOKEN";
const ENV_BASIC_USERNAME_KEY = "GOATCITADEL_AUTH_BASIC_USERNAME";
const ENV_BASIC_PASSWORD_KEY = "GOATCITADEL_AUTH_BASIC_PASSWORD";

export async function readAssistantAuthConfigSnapshot(rootDir: string): Promise<AssistantConfigAuthSnapshot> {
  return readAssistantAuthConfigSnapshotSync(rootDir);
}

export function readAssistantAuthConfigSnapshotSync(rootDir: string): AssistantConfigAuthSnapshot {
  const filePath = path.join(rootDir, "config", "assistant.config.json");
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { auth?: AssistantConfigAuthSnapshot };
    return parsed.auth ?? {};
  } catch {
    return {};
  }
}

export async function buildGatewayAuthCredentialPlan(params: PlannerParams): Promise<GatewayAuthCredentialPlan> {
  return createGatewayAuthCredentialPlan({
    ...params,
    configAuth: params.configAuth ?? (await readAssistantAuthConfigSnapshot(params.runtimeConfig.rootDir)),
  });
}

export function createGatewayAuthCredentialPlan(params: PlannerParams): GatewayAuthCredentialPlan {
  const env = params.env ?? process.env;
  const configAuth = params.configAuth ?? {};
  const runtimeAuth = params.runtimeConfig.assistant.auth;

  const envMode = normalizeAuthMode(env[ENV_MODE_KEY]);
  const envToken = trimCredentialToUndefined(env[ENV_TOKEN_KEY]);
  const envBasicUsername = trimCredentialToUndefined(env[ENV_BASIC_USERNAME_KEY]);
  const envBasicPassword = trimCredentialToUndefined(env[ENV_BASIC_PASSWORD_KEY]);
  const fileToken = trimCredentialToUndefined(configAuth.token?.value);
  const fileBasicUsername = trimCredentialToUndefined(configAuth.basic?.username);
  const fileBasicPassword = trimCredentialToUndefined(configAuth.basic?.password);
  const runtimeToken = trimCredentialToUndefined(runtimeAuth.token.value);
  const runtimeBasicUsername = trimCredentialToUndefined(runtimeAuth.basic.username);
  const runtimeBasicPassword = trimCredentialToUndefined(runtimeAuth.basic.password);
  const warnings: string[] = [];

  const token = classifyCredentialSource({
    envValue: envToken,
    fileValue: fileToken,
    runtimeValue: runtimeToken,
  });
  const basicUsername = classifyCredentialSource({
    envValue: envBasicUsername,
    fileValue: fileBasicUsername,
    runtimeValue: runtimeBasicUsername,
  });
  const basicPassword = classifyCredentialSource({
    envValue: envBasicPassword,
    fileValue: fileBasicPassword,
    runtimeValue: runtimeBasicPassword,
  });

  if (envMode && configAuth.mode && envMode !== configAuth.mode) {
    warnings.push(`${ENV_MODE_KEY} overrides assistant.config.json auth.mode.`);
  }
  if (envToken && fileToken) {
    warnings.push(`${ENV_TOKEN_KEY} overrides assistant.config.json auth token.`);
  }
  if (envBasicUsername && fileBasicUsername) {
    warnings.push(`${ENV_BASIC_USERNAME_KEY} overrides assistant.config.json basic username.`);
  }
  if (envBasicPassword && fileBasicPassword) {
    warnings.push(`${ENV_BASIC_PASSWORD_KEY} overrides assistant.config.json basic password.`);
  }
  if (token.source === "runtime") {
    warnings.push("Token is configured only in runtime memory and will not survive restart unless persisted to .env.");
  }
  if (basicUsername.source === "runtime" || basicPassword.source === "runtime") {
    warnings.push(
      "Basic auth credentials are configured only in runtime memory and will not survive restart unless persisted to .env.",
    );
  }
  if (runtimeAuth.mode === "token" && !token.configured) {
    warnings.push("Gateway auth mode is token, but no token is configured.");
  }
  if (runtimeAuth.mode === "basic" && !(basicUsername.configured && basicPassword.configured)) {
    warnings.push("Gateway auth mode is basic, but the username/password pair is incomplete.");
  }
  if (runtimeAuth.mode === "none" && (token.configured || basicUsername.configured || basicPassword.configured)) {
    warnings.push("Gateway auth mode is none while credentials are still present and inactive.");
  }

  return {
    mode: runtimeAuth.mode,
    warnings,
    token,
    basicUsername,
    basicPassword,
  };
}

export async function resolveGatewayInstallToken(params: InstallTokenParams): Promise<GatewayInstallTokenResolution> {
  const env = params.env ?? process.env;
  const configAuth = params.configAuth ?? (await readAssistantAuthConfigSnapshot(params.runtimeConfig.rootDir));
  const plan = createGatewayAuthCredentialPlan({
    runtimeConfig: params.runtimeConfig,
    env,
    configAuth,
  });

  if (plan.mode !== "token") {
    return {
      source: "none",
      persistedToEnv: false,
      warnings: plan.warnings,
      unavailableReason: `Gateway auth mode is ${plan.mode}; install tokens are only available in token mode.`,
    };
  }

  const explicitToken = trimCredentialToUndefined(params.explicitToken);
  let token = explicitToken;
  let source: GatewayInstallTokenResolution["source"] = explicitToken ? "explicit" : "none";
  if (!token) {
    const envToken = trimCredentialToUndefined(env[ENV_TOKEN_KEY]);
    if (envToken) {
      token = envToken;
      source = "env";
    }
  }
  if (!token) {
    const fileToken = trimCredentialToUndefined(configAuth.token?.value);
    if (fileToken) {
      token = fileToken;
      source = "inline";
    }
  }
  if (!token) {
    const runtimeToken = trimCredentialToUndefined(params.runtimeConfig.assistant.auth.token.value);
    if (runtimeToken) {
      token = runtimeToken;
      source = "runtime";
    }
  }
  if (!token && params.generateWhenMissing) {
    token = generateGatewayInstallToken();
    source = "generated";
  }
  if (!token) {
    return {
      source: "none",
      persistedToEnv: false,
      warnings: plan.warnings,
      unavailableReason: "No gateway token is configured. Generate one or set GOATCITADEL_AUTH_TOKEN.",
    };
  }

  let persistedToEnv = false;
  let envPath: string | undefined;
  const warnings = [...plan.warnings];
  if (params.persistToEnv) {
    const envFileOptions = { rootDir: params.runtimeConfig.rootDir };
    const writeResult = upsertLocalEnvVar(ENV_TOKEN_KEY, token, envFileOptions);
    if (!writeResult.updated) {
      warnings.push(
        `No local .env file was found (probed: ${writeResult.probedRoots.join(", ")}), so the token could not be persisted.`,
      );
    } else {
      // The token landed but the mode did not: auth would stay off on restart
      // while a live token sits in .env. Surface it rather than assume it stuck.
      const modeResult = upsertLocalEnvVar(ENV_MODE_KEY, "token", envFileOptions);
      if (!modeResult.updated) {
        warnings.push(
          `The token was persisted to ${writeResult.path}, but ${ENV_MODE_KEY} could not be written; set it manually to keep token auth enabled after restart.`,
        );
      }
      envPath = writeResult.path;
      persistedToEnv = true;
    }
  }

  params.runtimeConfig.assistant.auth.mode = "token";
  params.runtimeConfig.assistant.auth.token.value = token;

  return {
    token,
    source,
    persistedToEnv,
    envPath: envPath ?? detectEnvFilePath({ rootDir: params.runtimeConfig.rootDir }),
    warnings,
  };
}

function classifyCredentialSource(params: { envValue?: string; fileValue?: string; runtimeValue?: string }): {
  configured: boolean;
  source: GatewayAuthCredentialSource;
  warning?: string;
} {
  if (params.envValue) {
    return { configured: true, source: "env" };
  }
  if (params.fileValue) {
    return { configured: true, source: "inline" };
  }
  if (params.runtimeValue) {
    return { configured: true, source: "runtime" };
  }
  return { configured: false, source: "none" };
}

function normalizeAuthMode(value: unknown): AuthMode | undefined {
  if (value === "none" || value === "token" || value === "basic") {
    return value;
  }
  return undefined;
}

export function trimCredentialToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/\$\{[A-Z0-9_]+\}/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function generateGatewayInstallToken(): string {
  return randomBytes(36).toString("base64url");
}
