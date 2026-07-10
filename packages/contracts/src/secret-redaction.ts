export const SECRET_REDACTION_MARKER = "[REDACTED]";

export interface SecretTextRedactionOptions {
  marker?: string;
  env?: Record<string, string | undefined>;
  redactEmailAddresses?: boolean;
  redactEnvAssignmentsAsWhole?: boolean;
  envValueReplacement?: (name: string) => string;
}

export interface SecretTextRedactionResult {
  value: string;
  redactionCount: number;
}

export type StructuredSecretRedactionReason = "sensitive_key" | "secret_text" | "circular_reference";

export interface StructuredSecretRedactionOptions extends SecretTextRedactionOptions {
  circularMarker?: string;
}

export interface StructuredSecretRedaction {
  path: string;
  reason: StructuredSecretRedactionReason;
}

export interface StructuredSecretRedactionResult<T> {
  value: T;
  redactionCount: number;
  redactedPaths: string[];
  redactions: StructuredSecretRedaction[];
}

type SecretPattern = {
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
  shouldRedact?: (match: string, ...groups: string[]) => boolean;
};

export function redactSecretText(value: string, options: SecretTextRedactionOptions = {}): SecretTextRedactionResult {
  if (!value) {
    return { value, redactionCount: 0 };
  }

  const marker = options.marker ?? SECRET_REDACTION_MARKER;
  let redactionCount = 0;
  let redacted = value;

  for (const item of buildSecretPatterns(marker, options)) {
    item.pattern.lastIndex = 0;
    redacted = redacted.replace(item.pattern, (match, ...groups: string[]) => {
      if (item.shouldRedact && !item.shouldRedact(match, ...groups)) {
        return match;
      }
      redactionCount += 1;
      return item.replace(match, ...groups);
    });
  }

  if (options.env) {
    const envReplacement =
      options.envValueReplacement ?? ((name: string) => `${marker.replace(/\]$/, "_ENV")}:${name}]`);
    for (const [name, raw] of Object.entries(options.env)) {
      const secret = raw?.trim();
      if (!secret || secret.length < 12 || /\s/.test(secret)) {
        continue;
      }
      while (redacted.includes(secret)) {
        redacted = redacted.replace(secret, envReplacement(name));
        redactionCount += 1;
      }
    }
  }

  return { value: redacted, redactionCount };
}

export function redactStructuredSecrets<T>(
  value: T,
  options: StructuredSecretRedactionOptions = {},
): StructuredSecretRedactionResult<T> {
  const marker = options.marker ?? SECRET_REDACTION_MARKER;
  const circularMarker = options.circularMarker ?? "[Circular]";
  const ancestors = new WeakSet<object>();
  const redactions: StructuredSecretRedaction[] = [];
  const redactedPaths: string[] = [];
  const reportedPaths = new Set<string>();

  const report = (path: string, reason: StructuredSecretRedactionReason): void => {
    if (!reportedPaths.has(path)) {
      reportedPaths.add(path);
      redactedPaths.push(path);
    }
    if (!redactions.some((redaction) => redaction.path === path && redaction.reason === reason)) {
      redactions.push({ path, reason });
    }
  };

  const project = (entry: unknown, path: string, safeKey?: string): unknown => {
    if (typeof entry === "string") {
      if (safeKey && isSafeStructuredStringValue(safeKey, entry)) {
        return entry;
      }
      if (safeKey) {
        report(path, "sensitive_key");
        return marker;
      }
      const redacted = redactSecretText(entry, options);
      if (redacted.redactionCount > 0) {
        report(path, "secret_text");
      }
      return collapseStructuredSecretLeaf(redacted.value, marker);
    }
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    if (ancestors.has(entry)) {
      report(path, "circular_reference");
      return circularMarker;
    }

    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        return entry.map((item, index) => project(item, `${path}[${index}]`, safeKey));
      }

      const projectedEntries: Array<[string, unknown]> = [];
      for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
        const childPath = appendStructuredPath(path, key);
        const safeKey = isSafeStructuredValue(key, child);
        if (isSensitiveStructuredKey(key) && !safeKey && child !== null && child !== undefined) {
          report(childPath, "sensitive_key");
          projectedEntries.push([key, marker]);
          continue;
        }
        projectedEntries.push([key, project(child, childPath, safeKey ? key : undefined)]);
      }
      return Object.fromEntries(projectedEntries);
    } finally {
      ancestors.delete(entry);
    }
  };

  return {
    value: project(value, "$") as T,
    redactionCount: redactedPaths.length,
    redactedPaths,
    redactions,
  };
}

function appendStructuredPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function collapseStructuredSecretLeaf(value: string, marker: string): string {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:Bearer|Basic)\\s+${escapedMarker}$`, "i").test(value.trim()) ? marker : value;
}

function isSensitiveStructuredKey(key: string): boolean {
  const normalized = normalizeStructuredKey(key);
  if (!normalized) {
    return false;
  }
  return (
    /(?:^|_)WEBHOOK_(?:URL|URI|ENDPOINT)$/.test(normalized) ||
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN)(?:_|$)/.test(
      normalized,
    ) ||
    /(?:^|_)(?:API|ACCESS|PRIVATE|SECRET)_KEY(?:_|$)/.test(normalized)
  );
}

function isSafeStructuredKey(key: string): boolean {
  const normalized = normalizeStructuredKey(key);
  return (
    /(?:^|_)WEBHOOK_(?:URL|URI|ENDPOINT)_(?:ENV|ENV_NAME|REF|REFERENCE|ID|NAME|STATUS|PRESENT|CONFIGURED|ENABLED)$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|TOKEN)_(?:URL|URI|ENDPOINT)$/.test(normalized) ||
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|TOKEN)_HEADER_(?:NAME|TYPE|STATUS|PRESENT|CONFIGURED|ENABLED)$/.test(
      normalized,
    ) ||
    /(?:^|_)AUTH_(?:ACTOR|PRINCIPAL|SUBJECT)_(?:ID|SOURCE|TYPE|KIND)$/.test(normalized) ||
    /(?:^|_)(?:[A-Z0-9]+_)*IDS?$/.test(normalized) ||
    /(?:^|_)(?:[A-Z0-9]+_)*(?:REF|REFS|REFERENCE|REFERENCES)$/.test(normalized) ||
    /(?:^|_)(?:NEXT_|PREVIOUS_)?CURSOR$/.test(normalized) ||
    /(?:^|_)(?:[A-Z0-9]+_)*HASH$/.test(normalized) ||
    /(?:^|_)(?:TARGET|WORKFLOW|CATALOG|SETTING|FEATURE|CAPABILITY|ACTION|EVENT|TOOL)_KEY$/.test(normalized) ||
    normalized === "KEY" ||
    /(?:^|_)(?:BLINDED_AUTHOR_TOKEN|BLINDED_REVIEWER_TOKEN)$/.test(normalized) ||
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER|COOKIE|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)_PREVIEW$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:API_KEY_SOURCE|AUTH_READINESS|AUTH_METHODS|AUTH_REQUIREMENTS|AUTH_STATUS_CODES|AUTH_PROFILE|AUTH_STATE|SECRET_READINESS|SECRET_FIELD_KEYS|SECRETS_REQUIRED|CREDENTIAL_STORAGE|CREDENTIAL_FILE_CHECKS|PEER_CREDENTIALS|SIGNATURE_ALGORITHM)$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:TOKEN_ENV|SECRET_REF|TOKEN_BUDGET|TOKEN_ID|TOKEN_IDS|TOKEN_REFRESH_SKEW_SECONDS)$/.test(normalized) ||
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER|COOKIE|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)_(?:ENV|ENVS|ENV_NAME|REF|REFS|REFERENCE|REFERENCES|HANDLE|HANDLES|ID|IDS)$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:TOKEN_(?:INPUT|OUTPUT|TOTAL|CACHED_INPUT|BUDGET|COUNT|COUNTS|USAGE|ESTIMATE|ESTIMATES|LIMIT|LIMITS)|(?:INPUT|OUTPUT|TOTAL|PROMPT|COMPLETION|CACHED|REASONING|MAX|MIN)_TOKENS)$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:TIME_TO_FIRST_TOKEN|TOKEN_(?:HARD_CAP|SOFT_CAP|CAP|HEADROOM|EXPIRES_AT|EXPIRATION|TTL|WINDOW|RATE|LATENCY|DURATION|AVAILABLE|REMAINING|CONSUMED|USED))$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER|COOKIE|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)_(?:BOUNDARY|CONTEXT|MODE|NAME|TYPE|KIND|STATUS|PRESENT|CONFIGURED|ENABLED|SUPPORTED|REQUIRED|METHOD|SCHEME)$/.test(
      normalized,
    )
  );
}

function isSafeStructuredValue(key: string, value: unknown): boolean {
  if (typeof value === "string") {
    if (isStructuredBinaryPayloadKey(key)) {
      return isCanonicalBase64Payload(value);
    }
    return isSafeStructuredKey(key) && isSafeStructuredStringValue(key, value);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return isSafeStructuredMetadataValue(key, value);
  }
  if (Array.isArray(value)) {
    if (isSafeStructuredMetadataValue(key, value)) {
      return true;
    }
    const normalized = normalizeStructuredKey(key);
    const supportsStringCollection =
      /(?:^|_)(?:IDS|REFS|REFERENCES|HANDLES|ENVS)$/.test(normalized) ||
      /(?:^|_)(?:SECRET_FIELD_KEYS|SECRETS_REQUIRED)$/.test(normalized);
    return (
      supportsStringCollection &&
      isSafeStructuredKey(key) &&
      value.every((item) => typeof item === "string" && isSafeStructuredStringValue(key, item))
    );
  }
  return Boolean(value) && typeof value === "object" && isSafeStructuredMetadataValue(key, value);
}

function isSafeStructuredStringValue(key: string, value: string): boolean {
  const normalized = normalizeStructuredKey(key);
  if (isStructuredBinaryPayloadKey(key)) {
    return isCanonicalBase64Payload(value);
  }
  if (looksLikeExplicitCredential(value)) {
    return false;
  }
  if (/(?:^|_)API_KEY_SOURCE$/.test(normalized)) {
    return /^(?:inline|env|keychain|none)$/.test(value);
  }
  if (/(?:^|_)AUTH_READINESS$/.test(normalized)) {
    return /^(?:not_required|needs_auth|ready|expired|missing_oauth_config)$/.test(value);
  }
  if (/(?:^|_)CREDENTIAL_STORAGE$/.test(normalized)) {
    return /^(?:strong|partial|weak|unknown|not_applicable)$/.test(value);
  }
  if (/(?:^|_)SIGNATURE_ALGORITHM$/.test(normalized)) {
    return value === "ed25519";
  }
  if (normalized === "KEY") {
    return /^(?:device_identity|short_lived_access_token|rotating_refresh_token|request_signing|replay_protection)$/.test(
      value,
    );
  }
  if (/(?:^|_)BLINDED_AUTHOR_TOKEN$/.test(normalized)) {
    return /^proposal-\d+$/.test(value);
  }
  if (/(?:^|_)BLINDED_REVIEWER_TOKEN$/.test(normalized)) {
    return /^blind:(?:[A-Za-z0-9._/@+-]+:)+[A-Za-z0-9._/@+-]+$/.test(value);
  }
  if (
    /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER|COOKIE|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)_PREVIEW$/.test(
      normalized,
    )
  ) {
    return value === "***" || /^[^\s]{4}\.\.\.[^\s]{4}$/.test(value);
  }
  if (/(?:^|_)[A-Z0-9]+_HASH$/.test(normalized)) {
    return isSafeCryptographicDigest(value);
  }
  if (/(?:^|_)(?:NEXT_|PREVIOUS_)?CURSOR$/.test(normalized)) {
    return isSafeCursorValue(value);
  }
  if (/(?:^|_)(?:ENV|ENVS|ENV_NAME)$/.test(normalized)) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  }
  if (/(?:^|_)(?:ID|IDS)$/.test(normalized)) {
    return isSafeOpaqueIdentifier(value);
  }
  if (/(?:^|_)(?:HANDLE|HANDLES)$/.test(normalized)) {
    return isSafeOpaqueIdentifier(value);
  }
  if (/(?:^|_)(?:REF|REFS|REFERENCE|REFERENCES)$/.test(normalized)) {
    const credentialReference =
      /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|BEARER|COOKIE|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)(?:_|$)/.test(
        normalized,
      );
    return credentialReference ? isSafeOpaqueIdentifier(value) : isSafeReferenceValue(value);
  }
  if (/(?:^|_)(?:TARGET|WORKFLOW|CATALOG|SETTING|FEATURE|CAPABILITY|ACTION|EVENT|TOOL)_KEY$/.test(normalized)) {
    return isSafeOpaqueIdentifier(value);
  }
  if (/(?:^|_)AUTH_METHODS$/.test(normalized)) {
    return /^[a-z][a-z0-9_.+-]{0,63}$/.test(value);
  }
  if (/(?:^|_)AUTH_REQUIREMENTS$/.test(normalized)) {
    return /^(?:device_identity|short_lived_access_token|rotating_refresh_token|request_signing|replay_protection)$/.test(
      value,
    );
  }
  if (/(?:^|_)(?:SECRET_FIELD_KEYS|SECRETS_REQUIRED)$/.test(normalized)) {
    return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
  }
  if (
    /(?:^|_)(?:TOKEN_(?:INPUT|OUTPUT|TOTAL|CACHED_INPUT|BUDGET|COUNT|COUNTS|USAGE|ESTIMATE|ESTIMATES|LIMIT|LIMITS|REFRESH_SKEW_SECONDS)|(?:INPUT|OUTPUT|TOTAL|PROMPT|COMPLETION|CACHED|REASONING|MAX|MIN)_TOKENS)$/.test(
      normalized,
    )
  ) {
    return /^\d+(?:\.\d+)?$/.test(value);
  }
  return redactSecretText(value).redactionCount === 0;
}

function isStructuredBinaryPayloadKey(key: string): boolean {
  return /^(?:(?:BYTES|DATA)_BASE64|B64_JSON)$/.test(normalizeStructuredKey(key));
}

function isCanonicalBase64Payload(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

function isSafeStructuredMetadataValue(key: string, value: unknown): boolean {
  const normalized = normalizeStructuredKey(key);
  if (typeof value === "boolean") {
    return isSensitiveStructuredKey(key);
  }
  if (typeof value === "number") {
    return (
      Number.isFinite(value) &&
      value >= 0 &&
      (normalized === "FENCING_TOKEN" ||
        /(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)_(?:COUNT|COUNTS|LATENCY|LATENCY_MS|DURATION|DURATION_MS)$/.test(
          normalized,
        ) ||
        isSafeTokenMetricKey(normalized))
    );
  }
  if (Array.isArray(value)) {
    if (normalized === "AUTH_METHODS") {
      return value.every(
        (item) =>
          typeof item === "string" && /^[a-z][a-z0-9_.+-]{0,63}$/.test(item) && !looksLikeExplicitCredential(item),
      );
    }
    if (normalized === "AUTH_REQUIREMENTS") {
      return value.every(
        (item) =>
          typeof item === "string" &&
          /^(?:device_identity|short_lived_access_token|rotating_refresh_token|request_signing|replay_protection)$/.test(
            item,
          ),
      );
    }
    if (normalized === "AUTH_STATUS_CODES") {
      return value.every((item) => Number.isInteger(item) && Number(item) >= 100 && Number(item) <= 599);
    }
    if (normalized === "AUTH_READINESS") {
      return value.every(isFollowOnReadinessRecord);
    }
    if (normalized === "AUTH") {
      return value.every(isExternalConnectorAuthSummary);
    }
    if (normalized === "CREDENTIAL_FILE_CHECKS") {
      return value.every(isCredentialFileCheckSummary);
    }
    if (normalized === "PEER_CREDENTIALS") {
      return value.every(isA2APeerCredentialHealthSummary);
    }
    return false;
  }
  if (!isPlainStructuredRecord(value)) {
    return false;
  }
  if (normalized === "AUTH") {
    return isA2APublicAuthSummary(value) || isAuthRuntimeSettingsSummary(value);
  }
  if (normalized === "AUTH_STATE") {
    return isMcpAuthStateSummary(value);
  }
  if (normalized === "AUTH_PROFILE") {
    return isGoogleMeetAuthProfileSummary(value);
  }
  if (normalized === "AUTH_CONTEXT") {
    return isAuthContextSummary(value);
  }
  if (normalized === "SECRET_READINESS") {
    return isSecretReadinessSummary(value);
  }
  if (normalized === "COOKIES") {
    return isBrowserCookieSummary(value);
  }
  if (normalized === "TOKEN" || normalized === "BASIC_PASSWORD") {
    return isCredentialPlanEntry(value);
  }
  if (/^(?:TOKEN_ESTIMATES|TOKEN_COUNTS|TOKEN_USAGE)$/.test(normalized)) {
    return Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
  }
  return false;
}

function isSafeTokenMetricKey(normalized: string): boolean {
  return (
    /(?:^|_)(?:TOKEN_(?:INPUT|OUTPUT|TOTAL|CACHED_INPUT|BUDGET|COUNT|COUNTS|USAGE|ESTIMATE|ESTIMATES|LIMIT|LIMITS|REFRESH_SKEW_SECONDS)|(?:INPUT|OUTPUT|TOTAL|PROMPT|COMPLETION|CACHED|REASONING|MAX|MIN)_TOKENS)$/.test(
      normalized,
    ) ||
    /(?:^|_)(?:TIME_TO_FIRST_TOKEN|TOKEN_(?:HARD_CAP|SOFT_CAP|CAP|HEADROOM|TTL|WINDOW|RATE|LATENCY|DURATION|AVAILABLE|REMAINING|CONSUMED|USED))$/.test(
      normalized,
    )
  );
}

function isPlainStructuredRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyStructuredKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isOptionalSafeString(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "string" && value.length <= 4_096 && !containsControlCharacter(value))
  );
}

function isSafeStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length <= 1_024 && !containsControlCharacter(item))
  );
}

function isA2APublicAuthSummary(value: Record<string, unknown>): boolean {
  return (
    hasOnlyStructuredKeys(value, ["scheme", "tokenPreview"]) &&
    value.scheme === "bearer" &&
    (value.tokenPreview === undefined ||
      (typeof value.tokenPreview === "string" &&
        (value.tokenPreview === "***" || /^[^\s]{4}\.\.\.[^\s]{4}$/.test(value.tokenPreview))))
  );
}

function isCredentialPlanEntry(value: unknown): value is Record<string, unknown> {
  return (
    isPlainStructuredRecord(value) &&
    hasOnlyStructuredKeys(value, ["configured", "source", "warning"]) &&
    typeof value.configured === "boolean" &&
    /^(?:none|env|inline|runtime)$/.test(String(value.source ?? "")) &&
    isOptionalSafeString(value.warning)
  );
}

function isAuthRuntimeSettingsSummary(value: Record<string, unknown>): boolean {
  if (
    !hasOnlyStructuredKeys(value, ["mode", "allowLoopbackBypass", "tokenConfigured", "basicConfigured", "plan"]) ||
    !/^(?:none|token|basic)$/.test(String(value.mode ?? "")) ||
    typeof value.allowLoopbackBypass !== "boolean" ||
    typeof value.tokenConfigured !== "boolean" ||
    typeof value.basicConfigured !== "boolean" ||
    !isPlainStructuredRecord(value.plan)
  ) {
    return false;
  }
  const plan = value.plan;
  return (
    hasOnlyStructuredKeys(plan, ["mode", "warnings", "token", "basicUsername", "basicPassword"]) &&
    /^(?:none|token|basic)$/.test(String(plan.mode ?? "")) &&
    isSafeStringArray(plan.warnings) &&
    isCredentialPlanEntry(plan.token) &&
    isCredentialPlanEntry(plan.basicUsername) &&
    isCredentialPlanEntry(plan.basicPassword)
  );
}

function isExternalConnectorAuthSummary(value: unknown): boolean {
  return (
    isPlainStructuredRecord(value) &&
    hasOnlyStructuredKeys(value, ["id", "type", "name", "description", "managed"]) &&
    typeof value.id === "string" &&
    isSafeOpaqueIdentifier(value.id) &&
    isOptionalSafeString(value.type) &&
    isOptionalSafeString(value.name) &&
    isOptionalSafeString(value.description) &&
    (value.managed === undefined || typeof value.managed === "boolean")
  );
}

function isCredentialFileCheckSummary(value: unknown): boolean {
  return (
    isPlainStructuredRecord(value) &&
    hasOnlyStructuredKeys(value, ["pathLabel", "exists", "permissionStatus", "note"]) &&
    typeof value.pathLabel === "string" &&
    value.pathLabel.length <= 1_024 &&
    typeof value.exists === "boolean" &&
    /^(?:ok|too_broad|missing|unknown)$/.test(String(value.permissionStatus ?? "")) &&
    typeof value.note === "string" &&
    value.note.length <= 4_096
  );
}

function isA2APeerCredentialHealthSummary(value: unknown): boolean {
  return (
    isPlainStructuredRecord(value) &&
    hasOnlyStructuredKeys(value, ["peerId", "label", "status", "scopes", "expiresAt", "revokedAt", "checkedAt"]) &&
    typeof value.peerId === "string" &&
    isSafeOpaqueIdentifier(value.peerId) &&
    isOptionalSafeString(value.label) &&
    /^(?:configured|missing_secret|expired|revoked)$/.test(String(value.status ?? "")) &&
    isSafeStringArray(value.scopes) &&
    isOptionalSafeString(value.expiresAt) &&
    isOptionalSafeString(value.revokedAt) &&
    typeof value.checkedAt === "string" &&
    isOptionalSafeString(value.checkedAt)
  );
}

function isMcpAuthStateSummary(value: Record<string, unknown>): boolean {
  return (
    hasOnlyStructuredKeys(value, [
      "authType",
      "readiness",
      "accessTokenRef",
      "refreshTokenRef",
      "tokenExpiresAt",
      "scopes",
      "updatedAt",
      "lastRefreshedAt",
      "error",
    ]) &&
    /^(?:none|token|oauth2)$/.test(String(value.authType ?? "")) &&
    /^(?:not_required|needs_auth|ready|expired|missing_oauth_config)$/.test(String(value.readiness ?? "")) &&
    (value.accessTokenRef === undefined ||
      (typeof value.accessTokenRef === "string" && isSafeOpaqueIdentifier(value.accessTokenRef))) &&
    (value.refreshTokenRef === undefined ||
      (typeof value.refreshTokenRef === "string" && isSafeOpaqueIdentifier(value.refreshTokenRef))) &&
    isOptionalSafeString(value.tokenExpiresAt) &&
    (value.scopes === undefined || isSafeStringArray(value.scopes)) &&
    isOptionalSafeString(value.updatedAt) &&
    isOptionalSafeString(value.lastRefreshedAt) &&
    isOptionalSafeString(value.error)
  );
}

function isGoogleMeetAuthProfileSummary(value: Record<string, unknown>): boolean {
  return (
    hasOnlyStructuredKeys(value, ["accountRef", "available", "source"]) &&
    (value.accountRef === undefined ||
      (typeof value.accountRef === "string" && isSafeReferenceValue(value.accountRef))) &&
    typeof value.available === "boolean" &&
    /^(?:oauth_thread|manual_reference|missing)$/.test(String(value.source ?? ""))
  );
}

function isAuthContextSummary(value: Record<string, unknown>): boolean {
  return (
    hasOnlyStructuredKeys(value, ["boundary", "secretRefs"]) &&
    (value.boundary === undefined || typeof value.boundary === "string") &&
    (value.secretRefs === undefined ||
      (Array.isArray(value.secretRefs) &&
        value.secretRefs.every((item) => typeof item === "string" && isSafeOpaqueIdentifier(item))))
  );
}

function isSecretReadinessSummary(value: Record<string, unknown>): boolean {
  return (
    hasOnlyStructuredKeys(value, ["required", "configured", "missing"]) &&
    [value.required, value.configured, value.missing].every(
      (items) =>
        Array.isArray(items) &&
        items.every((item) => typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(item)),
    )
  );
}

function isBrowserCookieSummary(value: Record<string, unknown>): boolean {
  return (
    hasOnlyStructuredKeys(value, ["count", "domains"]) &&
    Number.isInteger(value.count) &&
    Number(value.count) >= 0 &&
    Array.isArray(value.domains) &&
    value.domains.every(
      (domain) =>
        typeof domain === "string" &&
        domain.length > 0 &&
        domain.length <= 253 &&
        /^[A-Za-z0-9.-]+$/.test(domain) &&
        !looksLikeExplicitCredential(domain),
    )
  );
}

function isFollowOnReadinessRecord(value: unknown): boolean {
  return (
    isPlainStructuredRecord(value) &&
    hasOnlyStructuredKeys(value, ["key", "label", "state", "note"]) &&
    typeof value.key === "string" &&
    /^(?:device_identity|short_lived_access_token|rotating_refresh_token|request_signing|replay_protection|device_pairing|gateway_base_url|gateway_auth|background_delivery|durable_refresh)$/.test(
      value.key,
    ) &&
    typeof value.label === "string" &&
    /^(?:have_foundation|partial|missing)$/.test(String(value.state ?? "")) &&
    typeof value.note === "string"
  );
}

function isSafeOpaqueIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_048 &&
    /^[A-Za-z0-9_][A-Za-z0-9._:/@+~=-]*$/.test(value) &&
    !looksLikeExplicitCredential(value)
  );
}

function isSafeReferenceValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    value.trim() === value &&
    !containsControlCharacter(value) &&
    !looksLikeExplicitCredential(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function isSafeCursorValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    /^[A-Za-z0-9][A-Za-z0-9._:|+~=%/-]*$/.test(value) &&
    !looksLikeExplicitCredential(value)
  );
}

function isSafeCryptographicDigest(value: string): boolean {
  return /^(?:(?:sha(?:1|224|256|384|512))[:=-])?(?:[a-f0-9]{40}|[a-f0-9]{56}|[a-f0-9]{64}|[a-f0-9]{96}|[a-f0-9]{128})$/i.test(
    value,
  );
}

function looksLikeExplicitCredential(value: string): boolean {
  return (
    /^(?:Bearer|Basic)\s+\S+/i.test(value.trim()) ||
    /(?:^|\s)(?:Authorization|Proxy-Authorization):\s*(?:Bearer|Basic)\s+\S+/i.test(value) ||
    containsCredentialAssignmentText(value) ||
    containsCredentialChannelUrl(value) ||
    /\bgrat_[A-Za-z0-9_-]{16,}\b/.test(value) ||
    /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/.test(value) ||
    /(?:[?&](?:api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|signature)=)[^&#\s]+/i.test(
      value,
    ) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|key-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/.test(
      value,
    )
  );
}

function containsCredentialAssignmentText(value: string): boolean {
  if (
    /(\\["'])\b([A-Za-z0-9-_]*(?:authorization|api[-_]?key|apikey|token|secret|password|passwd|signature|webhook[-_]?(?:url|uri|endpoint)?)[A-Za-z0-9-_]*)\b\1(\s*)([:=])(\s*)(\\["'])([\s\S]*?)\6/i.test(
      value,
    )
  ) {
    return true;
  }
  const pattern = createCredentialAssignmentPattern();
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const label = match[2] ?? "";
    const assignedValue = match[6] ?? "";
    if (!isNonSecretCredentialAssignment(label, assignedValue)) {
      return true;
    }
  }
  return false;
}

function createCredentialAssignmentPattern(): RegExp {
  return /(["']?)\b([A-Za-z0-9-_]*(?:authorization|api[-_]?key|apikey|token|secret|password|passwd|signature|webhook[-_]?(?:url|uri|endpoint)?)[A-Za-z0-9-_]*)\b\1(\s*)([:=])(\s*)(?!(?:Authorization|Proxy-Authorization)\s*:\s)("(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+'|(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(\s*\)|[^\s,;)"'\]}[]+)(?=$|[\s,;)"'\]}])/gi;
}

function isNonSecretCredentialAssignment(label: string, assignedValue: string): boolean {
  const normalizedValue = assignedValue.trim();
  if (/^(?:true|false|null|undefined)$/i.test(normalizedValue)) {
    return true;
  }
  if (/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?$/i.test(normalizedValue)) {
    const normalizedLabel = normalizeStructuredKey(label);
    return normalizedLabel === "FENCING_TOKEN" || isSafeTokenMetricKey(normalizedLabel);
  }
  return /^(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(\s*\)$/i.test(normalizedValue);
}

function containsCredentialChannelUrl(value: string): boolean {
  return (
    /https?:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/i.test(value) ||
    /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/i.test(
      value,
    ) ||
    /https?:\/\/api\.telegram\.org\/bot[A-Za-z0-9:_-]+/i.test(value)
  );
}

function normalizeStructuredKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function buildSecretPatterns(marker: string, options: SecretTextRedactionOptions): SecretPattern[] {
  const envAssignmentReplacement = options.redactEnvAssignmentsAsWhole ? marker : `$1${marker}`;
  const envAssignmentPattern: SecretPattern = {
    pattern: /\b([A-Z][A-Z0-9_]{2,}=)\S{16,}\b/g,
    replace: () => envAssignmentReplacement,
  };
  const patterns: SecretPattern[] = [
    {
      pattern: /\b(Authorization|Proxy-Authorization):\s*(?:Bearer|Basic)\s+[^\s,;]+/gi,
      replace: (_match, header) => `${header}: ${marker}`,
    },
    ...(options.redactEnvAssignmentsAsWhole ? [envAssignmentPattern] : []),
    {
      pattern: /\bgca:(grat_[A-Za-z0-9_-]{16,}):(a|r)\b/gi,
      replace: (_match, _token, decision) => `gca:${marker}:${decision}`,
    },
    {
      pattern: /\bgrat_[A-Za-z0-9_-]{16,}\b/g,
      replace: () => marker,
    },
    {
      pattern: /(https?:\/\/hooks\.slack(?:-gov)?\.com\/services\/)[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/gi,
      replace: (_match, prefix) => `${prefix}${marker}/${marker}/${marker}`,
    },
    {
      pattern:
        /(https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/gi,
      replace: (_match, prefix) => `${prefix}${marker}/${marker}`,
    },
    {
      pattern: /(https?:\/\/api\.telegram\.org\/bot)[A-Za-z0-9:_-]+/gi,
      replace: (_match, prefix) => `${prefix}${marker}`,
    },
    {
      pattern:
        /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|signature)=)[^&#\s]+/gi,
      replace: (_match, prefix) => `${prefix}${marker}`,
    },
    {
      pattern:
        /(\\["'])\b([A-Za-z0-9-_]*(?:authorization|api[-_]?key|apikey|token|secret|password|passwd|signature|webhook[-_]?(?:url|uri|endpoint)?)[A-Za-z0-9-_]*)\b\1(\s*)([:=])(\s*)(\\["'])([\s\S]*?)\6/gi,
      replace: (_match, keyQuote, label, beforeSeparator, separator, afterSeparator, valueQuote) =>
        `${keyQuote}${label}${keyQuote}${beforeSeparator}${separator}${afterSeparator}${valueQuote}${marker}${valueQuote}`,
    },
    {
      pattern: createCredentialAssignmentPattern(),
      shouldRedact: (_match, _quote, label, _beforeSeparator, _separator, _afterSeparator, assignedValue) =>
        !isNonSecretCredentialAssignment(label, assignedValue),
      replace: (_match, quote, label, beforeSeparator, separator, afterSeparator) =>
        `${quote}${label}${quote}${beforeSeparator}${separator}${afterSeparator}${marker}`,
    },
    {
      pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+={0,}/gi,
      replace: (match) => `${match.split(/\s+/, 1)[0]} ${marker}`,
    },
    {
      pattern: /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]+@/g,
      replace: (_match, prefix) => `${prefix}${marker}@`,
    },
    {
      pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
      replace: () => marker,
    },
    {
      pattern: /\bkey-[A-Za-z0-9]{20,}\b/g,
      replace: () => marker,
    },
    {
      pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
      replace: () => marker,
    },
    {
      pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
      replace: () => marker,
    },
    {
      pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
      replace: () => marker,
    },
    {
      pattern: /\bAKIA[0-9A-Z]{16}\b/g,
      replace: () => marker,
    },
    {
      pattern:
        /\b(?=[A-Za-z0-9_.-]*(?:secret|token|api[-_]?key))(?=[A-Za-z0-9_.-]*[-_])(?=[A-Za-z0-9_.-]{16,}\b)[A-Za-z0-9_.-]+\b/gi,
      replace: () => marker,
    },
    ...(options.redactEnvAssignmentsAsWhole ? [] : [envAssignmentPattern]),
    {
      pattern: /\bkeychain:[^\s"']+\b/g,
      replace: () => marker,
    },
    {
      pattern:
        /\b(?=[A-Za-z0-9+/]{36,}={0,2}(?![A-Za-z0-9+/=]))(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{36,}={0,2}(?![A-Za-z0-9+/=])/g,
      replace: () => marker,
    },
  ];

  if (options.redactEmailAddresses) {
    patterns.push({
      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      replace: () => marker,
    });
  }

  return patterns;
}
