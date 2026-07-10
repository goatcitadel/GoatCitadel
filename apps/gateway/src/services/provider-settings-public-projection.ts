import { projectCredentialUrlsInText, projectPublicSecretValue } from "./public-secret-projection.js";
import { preserveKnownPublicProjectionSecretsForUpdate } from "./integration-connection-public-projection.js";

const MARKER = "[REDACTED]";
const ARGV_LIKE_KEY_PATTERN = /^(?:argv|args|extraArgs|execArgv|commandArgs|command_argv)$/i;
const COMMAND_TEXT_KEY_PATTERN =
  /^(?:command|commandLine|execCommand|launchCommandPreview|repairCommand|shellCommand)$/i;
const SECRET_ARG_NAME =
  "(?:api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|authorization|proxy-authorization|bearer|cookie|credential|credentials)";
const SECRET_ARG_FLAG_PATTERN = new RegExp(`^--?${SECRET_ARG_NAME}(?:=|$)`, "i");
const SECRET_COMMAND_FLAG_PATTERN = new RegExp(`(^|\\s)(--?${SECRET_ARG_NAME})(=|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`, "gi");
const LLAMA_CPP_PROJECTABLE_UPDATE_KEYS = [
  "baseUrl",
  "command",
  "extraArgs",
  "modelsRootPath",
  "modelPath",
  "alias",
] as const;

/**
 * Projects provider/runtime DTOs while also recognizing credentials passed as
 * command-line flag/value pairs. The raw service-owned value is never mutated.
 */
export function projectProviderRuntimePublicValue<T>(value: T): T {
  const projected = projectPublicSecretValue(value);
  return projectExecutableShapes(value, projected) as T;
}

/** Preserves non-secret provider auth metadata while containing inline transport credentials. */
export function projectLlmConfigPublicValue<T>(value: T): T {
  const projected = projectProviderRuntimePublicValue(value);
  if (!isRecord(value) || !isRecord(projected)) {
    return projected;
  }

  const output: Record<string, unknown> = { ...projected };
  for (const collectionKey of ["providerConfigs", "providers"] as const) {
    const originalConfigs = Array.isArray(value[collectionKey]) ? value[collectionKey] : undefined;
    const projectedConfigs = Array.isArray(projected[collectionKey]) ? projected[collectionKey] : undefined;
    if (originalConfigs && projectedConfigs) {
      output[collectionKey] = originalConfigs.map((config, index) =>
        projectProviderConfigMetadata(config, projectedConfigs[index]),
      );
    }
  }
  return output as T;
}

/** Preserves the typed auth-readiness plan while projecting executable settings and status diagnostics. */
export function projectSettingsPublicValue<T>(value: T): T {
  const projected = projectProviderRuntimePublicValue(value);
  if (!isRecord(value) || !isRecord(projected) || !isRecord(value.auth)) {
    return projected;
  }
  return {
    ...projected,
    auth: projectAuthRuntimeMetadata(value.auth),
  } as T;
}

/**
 * Reconciles editable settings DTOs with their raw runtime owner. Public
 * clients commonly PATCH a GET projection; executable placeholders must not
 * replace the command/arguments they represent.
 */
export function preserveSettingsSecretsForPublicUpdate<TCurrent, TInput>(current: TCurrent, input: TInput): TInput {
  if (!isRecord(current) || !isRecord(input)) {
    return structuredClone(input);
  }
  const projected = projectProviderRuntimePublicValue(current);
  if (!isRecord(projected)) {
    return structuredClone(input);
  }

  const reconciled = structuredClone(input) as Record<string, unknown>;
  reconcileNestedProjectedFields(current, projected, reconciled, ["web", "firecrawl"], ["baseUrl"]);
  reconcileNestedProjectedFields(current, projected, reconciled, ["mesh"], ["staticPeers"]);
  reconcileNestedProjectedFields(current, projected, reconciled, ["npu"], ["sidecarUrl"]);
  reconcileNestedProjectedFields(current, projected, reconciled, ["llamaCpp"], LLAMA_CPP_PROJECTABLE_UPDATE_KEYS);
  return reconciled as TInput;
}

export function requiresSettingsPublicProjectionReconciliation(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }
  const web = isRecord(input.web) ? input.web : undefined;
  const firecrawl = web && isRecord(web.firecrawl) ? web.firecrawl : undefined;
  const mesh = isRecord(input.mesh) ? input.mesh : undefined;
  const npu = isRecord(input.npu) ? input.npu : undefined;
  const llamaCpp = isRecord(input.llamaCpp) ? input.llamaCpp : undefined;
  return Boolean(
    (firecrawl && Object.hasOwn(firecrawl, "baseUrl")) ||
    (mesh && Object.hasOwn(mesh, "staticPeers")) ||
    (npu && Object.hasOwn(npu, "sidecarUrl")) ||
    (llamaCpp && LLAMA_CPP_PROJECTABLE_UPDATE_KEYS.some((key) => Object.hasOwn(llamaCpp, key))),
  );
}

function reconcileNestedProjectedFields(
  current: Record<string, unknown>,
  projected: Record<string, unknown>,
  incoming: Record<string, unknown>,
  path: readonly string[],
  fields: readonly string[],
): void {
  const currentSection = readNestedRecord(current, path);
  const projectedSection = readNestedRecord(projected, path);
  const incomingSection = readNestedRecord(incoming, path);
  if (!currentSection || !projectedSection || !incomingSection) {
    return;
  }

  for (const field of fields) {
    if (!Object.hasOwn(incomingSection, field)) {
      continue;
    }
    const reconciledField = preserveKnownPublicProjectionSecretsForUpdate(
      { [field]: currentSection[field] },
      { [field]: projectedSection[field] },
      { [field]: incomingSection[field] },
    );
    if (Object.hasOwn(reconciledField, field)) {
      incomingSection[field] = reconciledField[field];
    }
  }
}

function readNestedRecord(
  value: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return isRecord(current) ? current : undefined;
}

function projectExecutableShapes(original: unknown, projected: unknown, key?: string): unknown {
  if (Array.isArray(projected)) {
    const originalItems = Array.isArray(original) ? original : [];
    if (key && ARGV_LIKE_KEY_PATTERN.test(key)) {
      return projectArgv(originalItems, projected);
    }
    return projected.map((entry, index) => projectExecutableShapes(originalItems[index], entry));
  }
  if (!projected || typeof projected !== "object") {
    if (typeof projected === "string" && key && COMMAND_TEXT_KEY_PATTERN.test(key)) {
      return projectCommandText(projected);
    }
    return projected;
  }

  const originalRecord = isRecord(original) ? original : {};
  return Object.fromEntries(
    Object.entries(projected as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      projectExecutableShapes(originalRecord[childKey], child, childKey),
    ]),
  );
}

function projectArgv(original: unknown[], projected: unknown[]): unknown[] {
  let redactNext = false;
  return projected.map((entry, index) => {
    const originalEntry = original[index];
    if (redactNext) {
      redactNext = false;
      return MARKER;
    }
    if (typeof originalEntry !== "string") {
      return entry;
    }
    if (!SECRET_ARG_FLAG_PATTERN.test(originalEntry)) {
      return typeof entry === "string" ? projectCredentialUrlsInText(entry) : entry;
    }
    const equalsIndex = originalEntry.indexOf("=");
    if (equalsIndex >= 0) {
      return `${originalEntry.slice(0, equalsIndex + 1)}${MARKER}`;
    }
    redactNext = true;
    return typeof entry === "string" ? entry : originalEntry;
  });
}

function projectCommandText(value: string): string {
  return projectCredentialUrlsInText(value).replace(
    SECRET_COMMAND_FLAG_PATTERN,
    (_match, leading: string, flag: string, separator: string) => `${leading}${flag}${separator}${MARKER}`,
  );
}

function projectProviderConfigMetadata(original: unknown, projected: unknown): unknown {
  if (!isRecord(original) || !isRecord(projected) || !isRecord(original.request)) {
    return projected;
  }
  const projectedRequest = isRecord(projected.request) ? projected.request : {};
  const request: Record<string, unknown> = { ...projectedRequest };
  if (isRecord(original.request.auth)) {
    request.auth = projectProviderAuthMetadata(original.request.auth);
  }
  if (isRecord(original.request.proxy)) {
    const projectedProxy = isRecord(projectedRequest.proxy) ? projectedRequest.proxy : {};
    request.proxy = {
      ...projectedProxy,
      ...(isRecord(original.request.proxy.auth)
        ? { auth: projectProviderAuthMetadata(original.request.proxy.auth) }
        : {}),
    };
  }
  return { ...projected, request };
}

function projectProviderAuthMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const projected = projectProviderRuntimePublicValue(value) as Record<string, unknown>;
  if (value.token !== undefined) {
    projected.token = MARKER;
  }
  if (value.value !== undefined) {
    projected.value = MARKER;
  }
  return projected;
}

function projectAuthRuntimeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const projected = projectProviderRuntimePublicValue(value) as Record<string, unknown>;
  if (!isRecord(value.plan)) {
    return projected;
  }
  const plan = projectProviderRuntimePublicValue(value.plan) as Record<string, unknown>;
  for (const key of ["token", "basicUsername", "basicPassword"] as const) {
    if (isRecord(value.plan[key])) {
      plan[key] = projectCredentialPlanEntry(value.plan[key]);
    }
  }
  projected.plan = plan;
  return projected;
}

function projectCredentialPlanEntry(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (typeof value.configured === "boolean") {
    output.configured = value.configured;
  }
  if (typeof value.source === "string") {
    output.source = projectProviderRuntimePublicValue(value.source);
  }
  if (typeof value.warning === "string") {
    output.warning = projectProviderRuntimePublicValue(value.warning);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
