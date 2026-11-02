import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { findInstallableConnectorTemplate } from "./connector-install-change-plan-adapter.js";

// Matches one MCP server of a Claude Code plugin to a connector template GoatCitadel ships. Only a remote server whose
// address is exactly a shipped template's address matches; everything else is left out with a plain reason. Nothing
// from the plugin's entry is copied anywhere: a match names a template, and the template is what gets installed.

export interface ClaudeCodeMcpServerEntry {
  /** The key in `mcpServers`. */
  name: string;
  /** `.mcp.json`, `.claude-plugin/plugin.json`, or the path plugin.json's `mcpServers` names. */
  definedIn: string;
  /** The entry as written. */
  config: unknown;
}

export type ClaudeCodeMcpMatch =
  | { kind: "matched"; templateId: string; label: string; dropsOwnSignIn: boolean }
  | { kind: "left_out"; reason: string };

const UNREADABLE = "It isn't a server GoatCitadel can read.";
const LOCAL_SERVER = "A local server, which would run a program. Plugins run no code.";
const NO_TYPE = "It doesn't say how it connects.";
const VARIABLE_ADDRESS = "Its address uses a value GoatCitadel can't fill in, so it can't be matched to a connector.";
const NOT_LISTED = "This app isn't in GoatCitadel's connector list. Add it yourself in Connectors.";
const OWN_SIGN_IN_KEYS = ["headers", "headersHelper", "oauth", "env"] as const;

/** `https:` only; lower-case host; default port; path without a trailing slash; no user, query or fragment. */
export function normalizeMcpAddress(raw: string): string | undefined {
  if (raw.includes("?") || raw.includes("#")) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    return undefined;
  }
  return `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/u, "")}`;
}

export function matchClaudeCodeMcpServer(
  entry: ClaudeCodeMcpServerEntry,
  templates: readonly McpServerTemplateRecord[],
): ClaudeCodeMcpMatch {
  const config = entry.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return leftOut(UNREADABLE);
  const server = config as Record<string, unknown>;
  if (Object.hasOwn(server, "command") || server.type === "stdio") return leftOut(LOCAL_SERVER);
  if (server.type === undefined) return leftOut(NO_TYPE);
  if (server.type !== "http" && server.type !== "sse") return leftOut(UNREADABLE);
  const url = typeof server.url === "string" ? server.url : undefined;
  if (url?.includes("${")) return leftOut(VARIABLE_ADDRESS);
  const address = url === undefined ? undefined : normalizeMcpAddress(url);
  const template =
    address === undefined
      ? undefined
      : templates.find(
          (item) =>
            item.transport === server.type && item.url !== undefined && normalizeMcpAddress(item.url) === address,
        );
  if (template === undefined) return leftOut(NOT_LISTED);
  const installable = findInstallableConnectorTemplate(templates, template.templateId);
  if (!installable.ok) return leftOut(installable.message);
  return {
    kind: "matched",
    templateId: template.templateId,
    label: template.label,
    dropsOwnSignIn: OWN_SIGN_IN_KEYS.some((key) => Object.hasOwn(server, key)),
  };
}

function leftOut(reason: string): ClaudeCodeMcpMatch {
  return { kind: "left_out", reason };
}
