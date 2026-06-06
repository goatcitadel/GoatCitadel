const REASONING_BLOCK_TAGS = ["think", "thinking", "reasoning", "internal_reasoning", "analysis"];
const INTERNAL_BLOCK_TAGS = ["tool_call", "tool_result", "tool_use", "internal_trace"];
const FENCED_CODE_PATTERN = /(```[\s\S]*?```)/g;

export interface ChannelOutboundSanitizeOptions {
  neutralizeMentions?: boolean;
  maxLength?: number;
}

export interface ChannelOutboundSanitizeResult {
  message: string;
  removedBlockCount: number;
  redactedSecretCount: number;
  neutralizedMentionCount: number;
  truncated: boolean;
}

export function sanitizeChannelOutboundMessage(
  message: string,
  options: ChannelOutboundSanitizeOptions = {},
): ChannelOutboundSanitizeResult {
  if (!message) {
    return emptySanitizeResult(message);
  }

  let removedBlockCount = 0;
  let redactedSecretCount = 0;
  let neutralizedMentionCount = 0;
  let truncated = false;
  const segments = message.split(FENCED_CODE_PATTERN);
  let sanitized = segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }
      const result = sanitizeNonCodeSegment(segment, options);
      removedBlockCount += result.removedBlockCount;
      redactedSecretCount += result.redactedSecretCount;
      neutralizedMentionCount += result.neutralizedMentionCount;
      return result.message;
    })
    .join("");

  if (typeof options.maxLength === "number" && options.maxLength > 0 && sanitized.length > options.maxLength) {
    sanitized = sanitized.slice(0, Math.max(0, options.maxLength - 24)).trimEnd();
    sanitized = `${sanitized}\n[message truncated]`;
    truncated = true;
  }

  if (removedBlockCount === 0 && redactedSecretCount === 0 && neutralizedMentionCount === 0 && !truncated) {
    return emptySanitizeResult(message);
  }

  return {
    message: normalizeWhitespaceAfterSanitizing(sanitized),
    removedBlockCount,
    redactedSecretCount,
    neutralizedMentionCount,
    truncated,
  };
}

function sanitizeNonCodeSegment(
  segment: string,
  options: ChannelOutboundSanitizeOptions,
): Omit<ChannelOutboundSanitizeResult, "truncated"> {
  let next = segment;
  let removedBlockCount = 0;
  for (const tag of [...REASONING_BLOCK_TAGS, ...INTERNAL_BLOCK_TAGS]) {
    const block = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    next = next.replace(block, () => {
      removedBlockCount += 1;
      return "";
    });
    const bracketBlock = new RegExp(`\\[${tag}\\b[^\\]]*\\][\\s\\S]*?\\[\\/${tag}\\]`, "gi");
    next = next.replace(bracketBlock, () => {
      removedBlockCount += 1;
      return "";
    });
  }

  next = next.replace(/<!--\s*(?:reasoning|thinking|internal)[\s\S]*?-->/gi, () => {
    removedBlockCount += 1;
    return "";
  });

  const secretSanitized = redactOutboundSecrets(next);
  next = secretSanitized.message;
  let neutralizedMentionCount = 0;
  if (options.neutralizeMentions) {
    const mentionSanitized = neutralizeOutboundMentions(next);
    next = mentionSanitized.message;
    neutralizedMentionCount = mentionSanitized.count;
  }

  return {
    message: next,
    removedBlockCount,
    redactedSecretCount: secretSanitized.count,
    neutralizedMentionCount,
  };
}

function redactOutboundSecrets(message: string): { message: string; count: number } {
  let count = 0;
  const redacted = message
    .replace(/\b(authorization|api[-_]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]{8,}/gi, (match, label) => {
      count += 1;
      return `${label}=[REDACTED]`;
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => {
      count += 1;
      return "Bearer [REDACTED]";
    })
    .replace(/\bsk-[A-Za-z0-9]{20,}/g, () => {
      count += 1;
      return "[REDACTED]";
    })
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{8,}@/g, () => {
      count += 1;
      return "[REDACTED]@";
    });
  return { message: redacted, count };
}

function neutralizeOutboundMentions(message: string): { message: string; count: number } {
  let count = 0;
  const neutralized = message
    .replace(/@everyone\b/gi, () => {
      count += 1;
      return "@ everyone";
    })
    .replace(/@here\b/gi, () => {
      count += 1;
      return "@ here";
    })
    .replace(/<@!?[0-9]+>/g, () => {
      count += 1;
      return "[user mention]";
    })
    .replace(/<@&[0-9]+>/g, () => {
      count += 1;
      return "[role mention]";
    });
  return { message: neutralized, count };
}

function normalizeWhitespaceAfterSanitizing(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function emptySanitizeResult(message: string): ChannelOutboundSanitizeResult {
  return {
    message,
    removedBlockCount: 0,
    redactedSecretCount: 0,
    neutralizedMentionCount: 0,
    truncated: false,
  };
}
