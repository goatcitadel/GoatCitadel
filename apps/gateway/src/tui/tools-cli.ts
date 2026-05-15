import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TuiApiClient } from "./api-client.js";
import { loadResolvedProfile } from "./profile.js";

interface ParsedArgs {
  profile?: string;
  gateway?: string;
  readOnly: boolean;
  command: "catalog" | "grant-add" | "grant-revoke" | "invoke";
  values: Record<string, string | boolean>;
}

type ToolsCliClient = Pick<TuiApiClient, "toolsCatalog" | "toolsCreateGrant" | "toolsRevokeGrant" | "toolsInvoke">;

interface ToolsCliDeps {
  loadResolvedProfile: typeof loadResolvedProfile;
  createClient: (input: ConstructorParameters<typeof TuiApiClient>[0]) => ToolsCliClient;
  writeOutput: (value: string) => void;
}

async function main(): Promise<void> {
  await runToolsCli(process.argv.slice(2));
}

export async function runToolsCli(argv: string[], deps: Partial<ToolsCliDeps> = {}): Promise<void> {
  const parsed = parseArgs(argv);
  const resolved = await (deps.loadResolvedProfile ?? loadResolvedProfile)({
    profileName: parsed.profile,
    gatewayOverride: parsed.gateway,
  });

  const client = (deps.createClient ?? ((input) => new TuiApiClient(input)))({
    baseUrl: resolved.profile.gatewayBaseUrl,
    auth: resolved.auth,
    readOnly: parsed.readOnly,
  });
  const writeOutput = deps.writeOutput ?? ((value: string) => process.stdout.write(value));

  if (parsed.command === "catalog") {
    const response = await client.toolsCatalog();
    printJson(response, writeOutput);
    return;
  }

  if (parsed.command === "grant-add") {
    const toolPattern = String(parsed.values.tool ?? parsed.values.toolPattern ?? "").trim();
    const decision = String(parsed.values.decision ?? "allow") as "allow" | "deny";
    const scope = String(parsed.values.scope ?? "session") as "global" | "session" | "agent" | "task";
    const scopeRef = String(parsed.values.scopeRef ?? parsed.values.scope_ref ?? "").trim();
    const grantType = String(parsed.values.grantType ?? parsed.values.grant_type ?? "persistent") as
      | "one_time"
      | "ttl"
      | "persistent";
    const createdBy = String(parsed.values.createdBy ?? parsed.values.created_by ?? "cli").trim();
    const expiresAt = String(parsed.values.expiresAt ?? parsed.values.expires_at ?? "").trim();
    if (!toolPattern) {
      throw new Error("--tool is required");
    }

    const created = await client.toolsCreateGrant({
      toolPattern,
      decision,
      scope,
      scopeRef: scope === "global" ? undefined : scopeRef || undefined,
      grantType,
      createdBy,
      expiresAt: expiresAt || undefined,
    });
    printJson(created, writeOutput);
    return;
  }

  if (parsed.command === "grant-revoke") {
    const grantId = String(parsed.values.grantId ?? parsed.values.grant_id ?? "").trim();
    if (!grantId) {
      throw new Error("--grant-id is required");
    }
    const response = await client.toolsRevokeGrant(grantId);
    printJson(response, writeOutput);
    return;
  }

  const toolName = String(parsed.values.tool ?? parsed.values.toolName ?? "").trim();
  const sessionId = String(parsed.values.session ?? parsed.values.sessionId ?? "demo-session").trim();
  const agentId = String(parsed.values.agent ?? parsed.values.agentId ?? "operator").trim();
  const taskId = String(parsed.values.task ?? parsed.values.taskId ?? "").trim();
  const argsRaw = String(parsed.values.args ?? "{}");
  if (!toolName) {
    throw new Error("--tool is required");
  }
  const args = JSON.parse(argsRaw) as Record<string, unknown>;
  const dryRun = Boolean(parsed.values["dry-run"] || parsed.values.dryRun);
  const response = await client.toolsInvoke({
    toolName,
    args,
    sessionId,
    agentId,
    taskId: taskId || undefined,
    dryRun,
    consentContext: {
      source: "tui",
      operatorId: "cli",
      reason: "tools-cli",
    },
  });
  printJson(response, writeOutput);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [first, second, ...rest] = argv;

  let command: ParsedArgs["command"];
  let optionArgs: string[];

  if (first === "catalog") {
    command = "catalog";
    optionArgs = [second, ...rest].filter((value) => value !== undefined) as string[];
  } else if (first === "grant" && second === "add") {
    command = "grant-add";
    optionArgs = rest;
  } else if (first === "grant" && second === "revoke") {
    command = "grant-revoke";
    optionArgs = rest;
  } else if (first === "invoke") {
    command = "invoke";
    optionArgs = [second, ...rest].filter((value) => value !== undefined) as string[];
  } else {
    throw new Error(
      'Usage: goat tools catalog | goat tools grant add --tool <pattern> --scope <scope> [--scope-ref <id>] | goat tools grant revoke --grant-id <id> | goat tools invoke --tool <name> --args \'{"k":"v"}\' [--dry-run]',
    );
  }

  const values: Record<string, string | boolean> = {};
  let profile: string | undefined;
  let gateway: string | undefined;
  let readOnly = false;

  for (let i = 0; i < optionArgs.length; i += 1) {
    const part = optionArgs[i];
    if (!part || !part.startsWith("--")) {
      continue;
    }
    const key = part.slice(2);
    if (key === "read-only") {
      readOnly = true;
      values[key] = true;
      continue;
    }
    const next = optionArgs[i + 1];
    if (!next || next.startsWith("--")) {
      values[key] = true;
      continue;
    }
    const normalizedKey = normalizeOptionKey(key);
    if (normalizedKey === "profile") {
      profile = next;
    } else if (normalizedKey === "gateway") {
      gateway = next;
    } else {
      values[normalizedKey] = next;
    }
    i += 1;
  }

  return {
    profile,
    gateway,
    readOnly,
    command,
    values,
  };
}

function normalizeOptionKey(value: string): string {
  return value.replace(/[-_]([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function printJson(value: unknown, writeOutput: (value: string) => void): void {
  writeOutput(`${JSON.stringify(value, null, 2)}\n`);
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(path.resolve(entry)).href);
}

export const __toolsCliInternals = {
  normalizeOptionKey,
  parseArgs,
};

if (isCliEntrypoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
