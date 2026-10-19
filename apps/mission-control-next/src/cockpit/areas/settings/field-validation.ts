import { useState } from "react";

/** Says what is wrong with a URL field, or nothing when it is fine. The Gateway still validates on save. */
export function urlFieldError(
  value: string,
  { required = false, protocols = ["http:", "https:"] }: { required?: boolean; protocols?: readonly string[] } = {},
): string | undefined {
  const text = value.trim();
  if (!text) return required ? "Enter a URL." : undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "Enter a full URL, starting with https:// or http://.";
  }
  return protocols.includes(parsed.protocol)
    ? undefined
    : `Use a URL that starts with ${protocols.map((item) => `${item}//`).join(" or ")}.`;
}

/** Says what is wrong with a JSON object field; an empty field is allowed. */
export function jsonObjectFieldError(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'Enter valid JSON, for example {"X-Client": "GoatCitadel"}.';
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Enter a JSON object in curly braces.";
  return Object.values(parsed).every((item) => typeof item === "string")
    ? undefined
    : "Each header value must be text in quotes.";
}

/**
 * Validates a field when it loses focus, then keeps the shown error current while the operator fixes it,
 * so an error never appears mid-typing but always clears as soon as the value is fixed.
 */
export function useBlurValidation(validate: (value: string) => string | undefined) {
  const [error, setError] = useState<string | undefined>();
  return {
    error,
    onBlur: (value: string) => setError(validate(value)),
    onChange: (value: string) => {
      if (error) setError(validate(value));
    },
  };
}
