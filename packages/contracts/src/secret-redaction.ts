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

type SecretPattern = {
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
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
      redactionCount += 1;
      return item.replace(match, ...groups);
    });
  }

  if (options.env) {
    const envReplacement = options.envValueReplacement ?? ((name: string) => `${marker.replace(/\]$/, "_ENV")}:${name}]`);
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
      pattern:
        /(["']?)\b([A-Za-z0-9-_]*(?:authorization|api[-_]?key|apikey|token|secret|password|passwd|signature)[A-Za-z0-9-_]*)\b\1(\s*)([:=])(\s*)(?:"[A-Za-z0-9._~+/=-]{8,}"|'[A-Za-z0-9._~+/=-]{8,}'|[A-Za-z0-9._~+/=-]{8,})(?=$|[\s,;)"'\]}])/gi,
      replace: (_match, quote, label, beforeSeparator, separator, afterSeparator) =>
        `${quote}${label}${quote}${beforeSeparator}${separator}${afterSeparator}${marker}`,
    },
    {
      pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+={0,}/gi,
      replace: (match) => `${match.split(/\s+/, 1)[0]} ${marker}`,
    },
    {
      pattern: /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|signature)=)[^&#\s]+/gi,
      replace: (_match, prefix) => `${prefix}${marker}`,
    },
    {
      pattern: /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]+@/g,
      replace: () => `${marker}@`,
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
        /\b(?=[A-Za-z0-9+/]{36,}={0,2}\b)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{36,}={0,2}\b/g,
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
