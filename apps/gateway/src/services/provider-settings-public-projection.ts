import { isDeepStrictEqual } from "node:util";
import { projectCredentialUrlsInText, projectPublicSecretValue } from "./public-secret-projection.js";
import { preserveKnownPublicProjectionSecretsForUpdate } from "./integration-connection-public-projection.js";

const MARKER = "[REDACTED]";
const ARGV_LIKE_KEY_PATTERN = /^(?:argv|args|extraArgs|execArgv|commandArgs|command_argv)$/i;
const COMMAND_TEXT_KEY_PATTERN =
  /^(?:command|commandLine|execCommand|launchCommandPreview|repairCommand|shellCommand)$/i;
const SECRET_ARG_NAME =
  "(?:auth|authentication|authorization|proxy[-_]?authorization|bearer|cookie|cookies|credential|credentials|api[-_]?key|apikey|client[-_]?key|access[-_]?key|private[-_]?key|consumer[-_]?key|signing[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|signature|webhook[-_]?(?:url|uri|endpoint))";
const SECRET_ARG_FLAG_PATTERN = new RegExp(`^--?${SECRET_ARG_NAME}(?:=|$)`, "i");
const SECRET_COMMAND_FLAG_PATTERN = new RegExp(`(^|\\s)(--?${SECRET_ARG_NAME})(=|\\s+)("[^"]*"|'[^']*'|\\S+)`, "gi");
const AUTHORIZATION_ARG_FLAG_PATTERN = /^--?(?:auth|authentication|authorization|proxy[-_]?authorization|bearer)$/i;
const AUTHORIZATION_SCHEME_PATTERN = /^(?:Bearer|Basic)$/i;
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
    const reconciledArray = reconcileProjectedSettingsArray(
      field,
      currentSection[field],
      projectedSection[field],
      incomingSection[field],
    );
    if (reconciledArray !== undefined) {
      incomingSection[field] = reconciledArray;
      continue;
    }
    const reconciledCommand = reconcileProjectedSettingsCommand(
      field,
      currentSection[field],
      projectedSection[field],
      incomingSection[field],
    );
    if (reconciledCommand !== undefined) {
      incomingSection[field] = reconciledCommand;
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

function reconcileProjectedSettingsArray(
  field: string,
  raw: unknown,
  projected: unknown,
  incoming: unknown,
): unknown[] | undefined {
  if (
    !Array.isArray(raw) ||
    !Array.isArray(projected) ||
    !Array.isArray(incoming) ||
    !incoming.some(containsPublicMarkerDeep)
  ) {
    return undefined;
  }

  const projectedMarkerIndices = projected.flatMap((entry, index) => (containsPublicMarkerDeep(entry) ? [index] : []));
  const incomingMarkerIndices = incoming.flatMap((entry, index) => (containsPublicMarkerDeep(entry) ? [index] : []));
  if (
    raw.length !== projected.length ||
    projected.length !== incoming.length ||
    incomingMarkerIndices.some((index) => !projectedMarkerIndices.includes(index))
  ) {
    throw new Error("Projected settings arrays with hidden values cannot be reordered or resized.");
  }

  if (
    field === "extraArgs" &&
    incomingMarkerIndices.some((index) => !hasStableArgvMarkerBinding(projected, incoming, index))
  ) {
    throw new Error("Projected settings arrays with hidden values cannot be reordered or resized.");
  }

  const reconciled = incoming.map((entry, index) => {
    const wrapper = preserveKnownPublicProjectionSecretsForUpdate(
      { value: raw[index] },
      { value: projected[index] },
      { value: entry },
    );
    return wrapper.value;
  });
  const reprojected = projectProviderRuntimePublicValue({ [field]: reconciled }) as Record<string, unknown>;
  const reprojectedArray = reprojected[field];
  if (
    !Array.isArray(reprojectedArray) ||
    incomingMarkerIndices.some((index) => !isDeepStrictEqual(reprojectedArray[index], incoming[index]))
  ) {
    throw new Error("Projected settings arrays with hidden values cannot be reordered or resized.");
  }
  return reconciled;
}

function reconcileProjectedSettingsCommand(
  field: string,
  raw: unknown,
  projected: unknown,
  incoming: unknown,
): string | undefined {
  if (
    !COMMAND_TEXT_KEY_PATTERN.test(field) ||
    typeof raw !== "string" ||
    typeof projected !== "string" ||
    typeof incoming !== "string"
  ) {
    return undefined;
  }

  const projectedMarkerSlots = listCommandSecretSlots(projected).filter((slot) => isRedactionMarkerValue(slot.value));
  if (projectedMarkerSlots.length === 0 || countRedactionMarkers(incoming) === 0) {
    return undefined;
  }

  const incomingMarkerSlots = listCommandSecretSlots(incoming).filter((slot) => isRedactionMarkerValue(slot.value));
  const fail = (): never => {
    throw new Error("Projected settings commands with hidden values cannot move or duplicate credential markers.");
  };
  if (incomingMarkerSlots.length !== countRedactionMarkers(incoming)) {
    fail();
  }

  assertStableDuplicateCommandBindings(
    projected,
    incoming,
    listCommandSecretSlots(projected),
    listCommandSecretSlots(incoming),
    fail,
  );

  const incomingIds = new Set(incomingMarkerSlots.map((slot) => slot.id));
  const expectedOrder = projectedMarkerSlots.filter((slot) => incomingIds.has(slot.id)).map((slot) => slot.id);
  if (
    expectedOrder.length !== incomingMarkerSlots.length ||
    incomingMarkerSlots.some((slot, index) => slot.id !== expectedOrder[index])
  ) {
    fail();
  }

  const rawById = new Map(listCommandSecretSlots(raw).map((slot) => [slot.id, slot]));
  const replacements = new Map<number, string>();
  for (const slot of incomingMarkerSlots) {
    const rawSlot = rawById.get(slot.id);
    if (!rawSlot || isRedactionMarkerValue(rawSlot.value)) {
      throw new Error("Projected settings commands with hidden values cannot move or duplicate credential markers.");
    }
    replacements.set(slot.valueStart, rawSlot.value);
  }
  return replaceCommandSlotValues(incoming, incomingMarkerSlots, replacements);
}

function hasStableArgvMarkerBinding(projected: unknown[], incoming: unknown[], markerIndex: number): boolean {
  const projectedEntry = projected[markerIndex];
  const incomingEntry = incoming[markerIndex];
  if (typeof projectedEntry !== "string" || typeof incomingEntry !== "string") {
    return isDeepStrictEqual(projectedEntry, incomingEntry);
  }
  if (projectedEntry === MARKER) {
    return (
      incomingEntry === MARKER &&
      markerIndex > 0 &&
      isDeepStrictEqual(projected[markerIndex - 1], incoming[markerIndex - 1])
    );
  }
  return projectedEntry === incomingEntry;
}

function containsPublicMarkerDeep(value: unknown): boolean {
  if (typeof value === "string") {
    return value.toUpperCase().includes(MARKER);
  }
  if (Array.isArray(value)) {
    return value.some(containsPublicMarkerDeep);
  }
  return isRecord(value) && Object.values(value).some(containsPublicMarkerDeep);
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
    if (typeof projected === "string" && typeof original === "string" && key && COMMAND_TEXT_KEY_PATTERN.test(key)) {
      return projectCommandText(original);
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
  let authorizationFlagPending = false;
  let redactFollowingAuthorizationCredential = false;
  return projected.map((entry, index) => {
    const originalEntry = original[index];
    if (redactFollowingAuthorizationCredential) {
      redactFollowingAuthorizationCredential = false;
      return typeof originalEntry === "string" && isSafeExecutableSecretReference(originalEntry)
        ? originalEntry
        : MARKER;
    }
    if (redactNext) {
      redactNext = false;
      if (
        authorizationFlagPending &&
        typeof originalEntry === "string" &&
        isAuthorizationScheme(originalEntry) &&
        hasFollowingArgvCredential(original, index)
      ) {
        redactFollowingAuthorizationCredential = true;
      }
      authorizationFlagPending = false;
      return typeof originalEntry === "string" && isSafeExecutableSecretReference(originalEntry)
        ? originalEntry
        : MARKER;
    }
    if (typeof originalEntry !== "string") {
      return entry;
    }
    if (!SECRET_ARG_FLAG_PATTERN.test(originalEntry)) {
      return typeof entry === "string" ? projectCredentialUrlsInText(entry) : entry;
    }
    const equalsIndex = originalEntry.indexOf("=");
    if (equalsIndex >= 0) {
      if (
        isAuthorizationArgFlag(originalEntry.slice(0, equalsIndex)) &&
        isAuthorizationScheme(originalEntry.slice(equalsIndex + 1)) &&
        hasFollowingArgvCredential(original, index)
      ) {
        redactFollowingAuthorizationCredential = true;
      }
      if (isSafeExecutableSecretReference(originalEntry.slice(equalsIndex + 1))) {
        return originalEntry;
      }
      return `${originalEntry.slice(0, equalsIndex + 1)}${MARKER}`;
    }
    redactNext = true;
    authorizationFlagPending = isAuthorizationArgFlag(originalEntry);
    return typeof entry === "string" ? entry : originalEntry;
  });
}

function projectCommandText(value: string): string {
  const slots = listCommandSecretSlots(value);
  let cursor = 0;
  let projected = "";
  for (const slot of slots) {
    projected += projectPublicSecretValue(value.slice(cursor, slot.valueStart));
    projected += isSafeExecutableSecretReference(slot.value) ? slot.value : MARKER;
    cursor = slot.valueEnd;
  }
  projected += projectPublicSecretValue(value.slice(cursor));
  return projectCredentialUrlsInText(projected);
}

type CommandSecretSlot = {
  id: string;
  normalizedFlag: string;
  occurrence: number;
  role: "value" | "authorizationCredential";
  flagStart: number;
  value: string;
  valueStart: number;
  valueEnd: number;
};

function listCommandSecretSlots(value: string): CommandSecretSlot[] {
  const occurrences = new Map<string, number>();
  const slots: CommandSecretSlot[] = [];
  SECRET_COMMAND_FLAG_PATTERN.lastIndex = 0;
  for (let match = SECRET_COMMAND_FLAG_PATTERN.exec(value); match; match = SECRET_COMMAND_FLAG_PATTERN.exec(value)) {
    const leading = match[1] ?? "";
    const flag = match[2] ?? "";
    const separator = match[3] ?? "";
    const secretValue = match[4] ?? "";
    const normalizedFlag = flag.toLowerCase();
    const occurrence = occurrences.get(normalizedFlag) ?? 0;
    occurrences.set(normalizedFlag, occurrence + 1);
    const flagStart = match.index + leading.length;
    const valueStart = match.index + leading.length + flag.length + separator.length;
    slots.push({
      id: JSON.stringify([normalizedFlag, occurrence, "value"]),
      normalizedFlag,
      occurrence,
      role: "value",
      flagStart,
      value: secretValue,
      valueStart,
      valueEnd: valueStart + secretValue.length,
    });

    if (isAuthorizationArgFlag(flag) && (isAuthorizationScheme(secretValue) || isRedactionMarkerValue(secretValue))) {
      const followingCredential = readFollowingCommandToken(value, valueStart + secretValue.length);
      if (followingCredential && !looksLikeCommandFlag(followingCredential.value)) {
        slots.push({
          id: JSON.stringify([normalizedFlag, occurrence, "authorizationCredential"]),
          normalizedFlag,
          occurrence,
          role: "authorizationCredential",
          flagStart,
          value: followingCredential.value,
          valueStart: followingCredential.start,
          valueEnd: followingCredential.end,
        });
      }
    }
  }
  SECRET_COMMAND_FLAG_PATTERN.lastIndex = 0;
  return slots;
}

function assertStableDuplicateCommandBindings(
  projectedValue: string,
  incomingValue: string,
  projectedSlots: CommandSecretSlot[],
  incomingSlots: CommandSecretSlot[],
  fail: () => never,
): void {
  const projectedPrimarySlots = projectedSlots.filter((slot) => slot.role === "value");
  const duplicateFlags = new Set(
    projectedPrimarySlots
      .map((slot) => slot.normalizedFlag)
      .filter(
        (normalizedFlag, index, flags) =>
          flags.indexOf(normalizedFlag) === index &&
          projectedPrimarySlots.filter((slot) => slot.normalizedFlag === normalizedFlag).length > 1,
      ),
  );

  for (const normalizedFlag of duplicateFlags) {
    const projectedFlagSlots = projectedPrimarySlots.filter((slot) => slot.normalizedFlag === normalizedFlag);
    if (!projectedSlots.some((slot) => slot.normalizedFlag === normalizedFlag && isRedactionMarkerValue(slot.value))) {
      continue;
    }
    const incomingFlagSlots = incomingSlots.filter(
      (slot) => slot.role === "value" && slot.normalizedFlag === normalizedFlag,
    );
    if (incomingFlagSlots.length !== projectedFlagSlots.length) {
      fail();
    }

    const projectedRoles = listCommandSlotRoles(projectedSlots, normalizedFlag);
    const incomingRoles = listCommandSlotRoles(incomingSlots, normalizedFlag);
    if (!isDeepStrictEqual(incomingRoles, projectedRoles)) {
      fail();
    }

    const projectedRegion = maskDuplicateCommandBindingRegion(projectedValue, projectedSlots, normalizedFlag);
    const incomingRegion = maskDuplicateCommandBindingRegion(incomingValue, incomingSlots, normalizedFlag);
    if (projectedRegion !== incomingRegion) {
      fail();
    }
  }
}

function listCommandSlotRoles(
  slots: CommandSecretSlot[],
  normalizedFlag: string,
): Array<{ occurrence: number; roles: CommandSecretSlot["role"][] }> {
  const occurrences = new Map<number, CommandSecretSlot["role"][]>();
  for (const slot of slots) {
    if (slot.normalizedFlag !== normalizedFlag) {
      continue;
    }
    const roles = occurrences.get(slot.occurrence) ?? [];
    roles.push(slot.role);
    occurrences.set(slot.occurrence, roles);
  }
  return [...occurrences.entries()].map(([occurrence, roles]) => ({ occurrence, roles }));
}

function maskDuplicateCommandBindingRegion(value: string, slots: CommandSecretSlot[], normalizedFlag: string): string {
  const flagSlots = slots.filter((slot) => slot.role === "value" && slot.normalizedFlag === normalizedFlag);
  const first = flagSlots[0];
  const last = flagSlots.at(-1);
  if (!first || !last) {
    return "";
  }
  const lastOccurrenceSlots = slots.filter(
    (slot) => slot.normalizedFlag === normalizedFlag && slot.occurrence === last.occurrence,
  );
  const regionEnd = Math.max(...lastOccurrenceSlots.map((slot) => slot.valueEnd));
  const regionSlots = slots
    .filter((slot) => slot.valueStart >= first.flagStart && slot.valueEnd <= regionEnd)
    .sort((left, right) => left.valueStart - right.valueStart);
  let cursor = first.flagStart;
  let output = "";
  for (const slot of regionSlots) {
    output += value.slice(cursor, slot.valueStart);
    output += MARKER;
    cursor = slot.valueEnd;
  }
  return output + value.slice(cursor, regionEnd);
}

function readFollowingCommandToken(
  value: string,
  offset: number,
): { value: string; start: number; end: number } | undefined {
  const match = /^(\s+)("[^"]*"|'[^']*'|\S+)/.exec(value.slice(offset));
  const token = match?.[2];
  if (!match || !token) {
    return undefined;
  }
  const start = offset + (match[1]?.length ?? 0);
  return { value: token, start, end: start + token.length };
}

function isAuthorizationArgFlag(value: string): boolean {
  return AUTHORIZATION_ARG_FLAG_PATTERN.test(value.trim());
}

function isAuthorizationScheme(value: string): boolean {
  return AUTHORIZATION_SCHEME_PATTERN.test(unquoteCommandToken(value));
}

function hasFollowingArgvCredential(values: unknown[], schemeIndex: number): boolean {
  const following = values[schemeIndex + 1];
  return typeof following === "string" && !looksLikeCommandFlag(following);
}

function looksLikeCommandFlag(value: string): boolean {
  return /^--?[A-Za-z][A-Za-z0-9_-]*(?:=|$)/.test(unquoteCommandToken(value));
}

function unquoteCommandToken(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
}

function replaceCommandSlotValues(
  value: string,
  slots: CommandSecretSlot[],
  replacements: ReadonlyMap<number, string>,
): string {
  let output = value;
  for (const slot of [...slots].sort((left, right) => right.valueStart - left.valueStart)) {
    const replacement = replacements.get(slot.valueStart);
    if (replacement !== undefined) {
      output = `${output.slice(0, slot.valueStart)}${replacement}${output.slice(slot.valueEnd)}`;
    }
  }
  return output;
}

function isSafeExecutableSecretReference(value: string): boolean {
  const trimmed = value.trim();
  const candidate =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  return (
    /^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Z_][A-Z0-9_]*\})$/i.test(candidate) ||
    /^\$env:[A-Z_][A-Z0-9_]*$/i.test(candidate) ||
    /^%[A-Z_][A-Z0-9_]*%$/i.test(candidate) ||
    /^(?:(?:process|Bun)\.env|import\.meta\.env)(?:\.[A-Z_][A-Z0-9_]*|\[(?:"[A-Z_][A-Z0-9_]*"|'[A-Z_][A-Z0-9_]*')\])$/i.test(
      candidate,
    ) ||
    /^Deno\.env\.get\((?:"[A-Z_][A-Z0-9_]*"|'[A-Z_][A-Z0-9_]*')\)$/i.test(candidate) ||
    /^os\.(?:getenv\((?:"[A-Z_][A-Z0-9_]*"|'[A-Z_][A-Z0-9_]*')\)|environ\[(?:"[A-Z_][A-Z0-9_]*"|'[A-Z_][A-Z0-9_]*')\])$/i.test(
      candidate,
    )
  );
}

function isRedactionMarkerValue(value: string): boolean {
  const trimmed = value.trim();
  const candidate =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  return candidate.toUpperCase() === MARKER;
}

function countRedactionMarkers(value: string): number {
  return value.match(/\[REDACTED\]/gi)?.length ?? 0;
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
