import { clampInt, redactSecretText } from "@goatcitadel/contracts";
import {
  isOfficialResearchSearchInvocation,
  resolveOfficialSearchProviders,
} from "./research-search-official-providers.js";

const STATE_ACTIONS: Readonly<Record<string, string>> = {
  "browser.cookies.get": "Read cookies",
  "browser.cookies.set": "Set cookies",
  "browser.cookies.clear": "Clear cookies",
  "browser.storage.get": "Read browser storage",
  "browser.storage.set": "Set browser storage",
  "browser.storage.clear": "Clear browser storage",
  "browser.context.configure": "Configure the browser session",
};

export function browserApprovalPreview(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? redactSecretText(value.trim(), { env: process.env }).value : undefined;
  if (toolName === "browser.search") {
    const query = text(args.query);
    if (!query) return undefined;
    const official = isOfficialResearchSearchInvocation(args);
    const backend = official
      ? resolveOfficialSearchProviders(args).join(", ")
      : (text(args.backend) ?? "Configured web search");
    return {
      target: backend,
      input: query,
      optionsSummary: `Maximum results: ${clampInt(args.limit ?? args.maxResults, official && args.mode === "research" ? 10 : 5, 1, official ? 20 : 25)}`,
      ...(text(args.engine) ? { engineSummary: text(args.engine) } : {}),
      ...(official
        ? {
            modeSummary: args.mode === "research" ? "Research" : "Quick",
            freshnessSummary: text(args.freshness) ?? "Any time",
          }
        : {}),
      summary: "Send this query to web search and return matching results.",
    };
  }
  const action = STATE_ACTIONS[toolName];
  if (!action || !Object.hasOwn(STATE_ACTIONS, toolName)) return undefined;

  const details: string[] = [];
  const add = (label: string, value: unknown) => {
    const display = text(value);
    if (display) details.push(`${label}: ${display}`);
  };
  if (toolName.startsWith("browser.cookies.")) {
    const cookies = toolName === "browser.cookies.set" && Array.isArray(args.cookies) ? args.cookies : [args];
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) continue;
      const record = cookie as Record<string, unknown>;
      add("Cookie name", record.name);
      add("Domain", record.domain);
      add("URL", record.url);
      add("Path", record.path);
      if (toolName === "browser.cookies.set") {
        add("Same-site policy", record.sameSite);
        for (const key of ["expires", "secure", "httpOnly"]) {
          if (Object.hasOwn(record, key)) add(key, String(record[key]));
        }
      }
    }
  } else if (toolName.startsWith("browser.storage.")) {
    add("Origin", args.origin);
    add("Storage", args.storage ?? (toolName === "browser.storage.set" ? "local" : "both"));
    if (toolName !== "browser.storage.get") {
      if (
        toolName === "browser.storage.set" &&
        args.entries &&
        typeof args.entries === "object" &&
        !Array.isArray(args.entries)
      ) {
        for (const key of Object.keys(args.entries)) add("Entry", key);
      } else add("Entry", args.key);
    }
  } else {
    for (const key of ["locale", "timezoneId"]) {
      if (Object.hasOwn(args, key)) add(key === "locale" ? "Locale" : "Time zone", args[key] ?? "Clear");
    }
    if (args.reset === true || args.reset === "true" || args.reset === 1 || args.reset === "1")
      details.push("Reset browser session");
    for (const [key, label] of [
      ["geolocation", "Geolocation"],
      ["extraHTTPHeaders", "Request headers"],
      ["httpCredentials", "HTTP credentials"],
    ] as const) {
      if (Object.hasOwn(args, key)) details.push(`${label}: ${args[key] == null ? "Clear" : "Update"}`);
    }
  }
  const fallback = toolName.startsWith("browser.cookies.")
    ? "All cookies within the allowed scope"
    : "This conversation’s browser session";
  return {
    target: `${action} in this conversation’s browser session`,
    input: details.length ? details.join("\n") : fallback,
    summary: "Cookie, storage, and credential values are hidden. Existing session and host restrictions apply.",
  };
}
