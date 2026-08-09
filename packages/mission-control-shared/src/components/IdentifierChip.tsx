import { Check, Copy } from "lucide-react";
import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

const IDENTIFIER_PREFIX_LENGTH = 8;
const IDENTIFIER_SUFFIX_LENGTH = 6;

export function formatIdentifierMiddle(value: string): string {
  const visibleLength = IDENTIFIER_PREFIX_LENGTH + IDENTIFIER_SUFFIX_LENGTH;
  if (value.length <= visibleLength + 1) {
    return value;
  }
  return `${value.slice(0, IDENTIFIER_PREFIX_LENGTH)}…${value.slice(-IDENTIFIER_SUFFIX_LENGTH)}`;
}

export function IdentifierChip({
  value,
  label,
  copyable = true,
  className,
}: {
  value: string;
  label?: string;
  copyable?: boolean;
  className?: string;
}) {
  const [copyFeedback, setCopyFeedback] = useState<{ value: string; state: CopyState }>({
    value,
    state: "idle",
  });
  const copyState = copyFeedback.value === value ? copyFeedback.state : "idle";
  const normalizedLabel = label?.trim();
  const identifierName = normalizedLabel ? `${normalizedLabel} identifier` : "Identifier";
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Retry" : "Copy";

  async function copyIdentifier(): Promise<void> {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopyFeedback({ value, state: "copied" });
    } catch {
      setCopyFeedback({ value, state: "failed" });
    }
  }

  return (
    <span className={`gc-identifier-chip${className ? ` ${className}` : ""}`}>
      {normalizedLabel ? <span className="gc-identifier-chip-label">{normalizedLabel}</span> : null}
      <code className="gc-identifier-chip-value" aria-label={`${identifierName}: ${value}`} title={value}>
        {formatIdentifierMiddle(value)}
      </code>
      {copyable ? (
        <button
          type="button"
          className="gc-identifier-chip-copy"
          aria-label={`${copyState === "copied" ? "Copied" : "Copy full"} ${identifierName.toLowerCase()}`}
          title={copyState === "failed" ? `Copy failed. Retry copying ${value}` : `Copy ${value}`}
          onClick={() => void copyIdentifier()}
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" size={12} strokeWidth={2.4} />
          ) : (
            <Copy aria-hidden="true" size={12} strokeWidth={2.2} />
          )}
          <span aria-live="polite">{copyLabel}</span>
        </button>
      ) : null}
    </span>
  );
}
