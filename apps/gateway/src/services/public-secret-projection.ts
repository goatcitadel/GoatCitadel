import { redactStructuredSecrets } from "@goatcitadel/contracts";

const CREDENTIAL_PATH_LABEL_PATTERN =
  /^(?:api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|signature|webhooks?)$/i;
const CREDENTIAL_QUERY_LABEL_PATTERN =
  /^(?:api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|signature)$/i;
const MARKER = "[REDACTED]";

/** Creates a detached public projection using the canonical structured redactor plus credential-aware URL paths. */
export function projectPublicSecretValue<T>(value: T): T {
  const projected = redactStructuredSecrets(value, { redactEnvAssignmentsAsWhole: true }).value;
  return projectCredentialUrls(projected) as T;
}

/**
 * Projects an error response while retaining validation-container shape. A
 * wholesale structured projection would replace `fieldErrors.token: string[]`
 * with a scalar marker, which breaks clients even though the array contains
 * validation messages rather than a credential.
 */
export function projectPublicErrorValue<T>(value: T): T {
  return projectPublicErrorShape(value, undefined, new WeakSet<object>()) as T;
}

export function projectCredentialUrlsInText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    const { url, suffix } = splitTrailingUrlPunctuation(candidate);
    return `${redactCredentialUrl(url)}${suffix}`;
  });
}

function projectCredentialUrls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(projectCredentialUrls);
  }
  if (typeof value === "string") {
    return projectCredentialUrlsInText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, projectCredentialUrls(child)]),
  );
}

function projectPublicErrorShape(value: unknown, key: string | undefined, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (!key) {
      return projectPublicSecretValue(value);
    }
    return projectPublicSecretValue({ [key]: value })[key];
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Zod-style `fieldErrors.token: ["Required"]` is metadata, but an
      // arbitrary array under a credential-named key can still echo secret
      // material. Preserve only recognizable validation prose; project every
      // other item with the sensitive parent key intact.
      const sensitiveParent = key ? isSensitivePublicFieldKey(key) : false;
      return value.map((item) =>
        sensitiveParent && !(typeof item === "string" && isValidationMessage(item))
          ? projectPublicErrorShape(item, key, ancestors)
          : projectPublicErrorShape(item, undefined, ancestors),
      );
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        projectPublicErrorShape(child, childKey, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function isSensitivePublicFieldKey(key: string): boolean {
  const probe = "goat-public-projection-non-secret-probe";
  return projectPublicSecretValue({ [key]: probe })[key] === MARKER;
}

function isValidationMessage(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length <= 256 &&
    /^(?:required\b|invalid\b|must\b|expected\b|too\s+(?:small|big|short|long)\b|unrecognized\b|not\s+(?:allowed|supported|valid)\b|should\b|cannot\b|at\s+(?:least|most)\b|minimum\b|maximum\b|value\b)/i.test(
      normalized,
    )
  );
}

function splitTrailingUrlPunctuation(value: string): { url: string; suffix: string } {
  let url = value;
  let suffix = "";
  while (/[.,;:!?)}\]]$/.test(url) && !url.endsWith(MARKER)) {
    suffix = `${url.at(-1) ?? ""}${suffix}`;
    url = url.slice(0, -1);
  }
  return { url, suffix };
}

function redactCredentialUrl(value: string): string {
  const match = value.match(/^(https?:\/\/[^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i);
  if (!match) {
    return value;
  }
  const segments = (match[2] ?? "").split("/");
  const replacements = new Map<number, string>();
  const authority = (match[1] ?? "").toLowerCase();
  for (let index = 0; index < segments.length; index += 1) {
    const decoded = safeDecodeURIComponent(segments[index] ?? "");
    if (CREDENTIAL_PATH_LABEL_PATTERN.test(decoded) && segments[index + 1]) {
      replacements.set(index + 1, MARKER);
      if (/^webhooks?$/i.test(decoded) && segments[index + 2]) {
        replacements.set(index + 2, MARKER);
      }
    }
    if (authority.includes("hooks.slack.com") && /^services$/i.test(decoded)) {
      for (let credentialIndex = index + 1; credentialIndex < segments.length; credentialIndex += 1) {
        if (segments[credentialIndex]) {
          replacements.set(credentialIndex, MARKER);
        }
      }
    }
    if (authority.includes("api.telegram.org") && /^bot.+/i.test(decoded)) {
      replacements.set(index, `bot${MARKER}`);
    }
  }
  const pathname = match[2] ? segments.map((segment, index) => replacements.get(index) ?? segment).join("/") : "";
  return `${match[1]}${pathname}${redactCredentialParameterString(match[3])}${redactCredentialParameterString(match[4])}`;
}

function safeDecodeURIComponent(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function redactCredentialParameterString(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const prefix = value[0] === "?" || value[0] === "#" ? value[0] : "";
  const body = prefix ? value.slice(1) : value;
  return `${prefix}${body
    .split("&")
    .map((part) => {
      const equalsIndex = part.indexOf("=");
      if (equalsIndex < 0) {
        return part;
      }
      const name = part.slice(0, equalsIndex);
      return CREDENTIAL_QUERY_LABEL_PATTERN.test(safeDecodeURIComponent(name.replaceAll("+", " ")))
        ? `${name}=${MARKER}`
        : part;
    })
    .join("&")}`;
}
