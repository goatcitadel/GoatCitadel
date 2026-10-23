import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudeCliError } from "./claude-code-cli-process.js";
import { claudeCliUserMessage, failClaudeCliStep } from "./claude-code-cli-output.js";
import { CLAUDE_CLI_RESULTS_DIR, type ClaudeCliStubTool } from "./claude-code-cli-mcp-stub.js";
import { CLAUDE_CLI_MCP_SERVER_NAME, CLAUDE_CLI_MCP_TOOL_PREFIX } from "./claude-code-cli-tool-step.js";

/**
 * Per-step tool manifest and run-dir files for the Claude Code CLI tool bridge.
 * The CLI sees GoatCitadel tools through an inert stdio MCP stub that only
 * serves the manifest; calls are intercepted and run by the governed runner.
 */

// Defined beside the stream tripwires, which cannot import this module at runtime without a cycle.
export { CLAUDE_CLI_MCP_SERVER_NAME, CLAUDE_CLI_MCP_TOOL_PREFIX };

/** Longest tool name (prefix included) the CLI accepts. */
const MAX_CLI_TOOL_NAME_LENGTH = 64;
const STUB_FILE_BASENAME = "claude-code-cli-mcp-stub";

export interface ClaudeCliToolManifest {
  /** What the stub serves; names are bare (the CLI adds the `mcp__goatcitadel__` prefix). */
  tools: ClaudeCliStubTool[];
  /** Full `mcp__goatcitadel__<name or alias>` names mapped to the runner's model name. */
  cliNameToModelName: ReadonlyMap<string, string>;
  sha256: string;
  nonce: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildClaudeCliToolManifest(tools: ReadonlyArray<Record<string, unknown>>): ClaudeCliToolManifest {
  const stubTools: ClaudeCliStubTool[] = [];
  const cliNameToModelName = new Map<string, string>();
  tools.forEach((tool, index) => {
    const definition = isRecord(tool.function) ? tool.function : undefined;
    const name = definition?.name;
    if (!definition || typeof name !== "string" || name.length === 0) {
      failClaudeCliStep("claude_cli_bridge_unavailable", "a tool definition has no name");
    }
    const exposedName =
      CLAUDE_CLI_MCP_TOOL_PREFIX.length + name.length > MAX_CLI_TOOL_NAME_LENGTH
        ? `t${index}_${sha256Hex(name).slice(0, 8)}`
        : name;
    const cliName = `${CLAUDE_CLI_MCP_TOOL_PREFIX}${exposedName}`;
    if (cliNameToModelName.has(cliName) || [...cliNameToModelName.values()].includes(name)) {
      failClaudeCliStep("claude_cli_bridge_unavailable", "tool names are not unique");
    }
    cliNameToModelName.set(cliName, name);
    stubTools.push({
      name: exposedName,
      description: typeof definition.description === "string" ? definition.description : "",
      // MCP requires an object-typed inputSchema; one loose schema would fail the whole tools/list.
      inputSchema: isRecord(definition.parameters)
        ? { ...definition.parameters, type: "object" }
        : { type: "object", properties: {} },
    });
  });
  return {
    tools: stubTools,
    cliNameToModelName,
    sha256: sha256Hex(JSON.stringify(stubTools)),
    nonce: randomUUID(),
  };
}

export async function writeClaudeCliBridgeFiles(input: {
  runDir: string;
  manifest: ClaudeCliToolManifest;
  nodePath: string;
  stubPath: string;
}): Promise<{ mcpConfigPath: string }> {
  const toolsPath = path.join(input.runDir, "tools.json");
  const mcpConfigPath = path.join(input.runDir, "mcp.json");
  const toolsFile = {
    tools: input.manifest.tools,
    nonce: input.manifest.nonce,
    sha256: input.manifest.sha256,
  };
  const mcpConfig = {
    mcpServers: {
      [CLAUDE_CLI_MCP_SERVER_NAME]: {
        type: "stdio",
        command: input.nodePath,
        args: [input.stubPath, toolsPath],
        env: {},
      },
    },
  };
  try {
    // Where the Gateway stages tool results for the parked stub to deliver.
    await fs.promises.mkdir(path.join(input.runDir, CLAUDE_CLI_RESULTS_DIR), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(toolsPath, JSON.stringify(toolsFile), { mode: 0o600 });
    await fs.promises.writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
  } catch (error) {
    throw new ClaudeCliError("claude_cli_bridge_unavailable", claudeCliUserMessage("claude_cli_bridge_unavailable"), {
      cause: error,
    });
  }
  return { mcpConfigPath };
}

/** The compiled stub next to this module in `dist`, or the `.ts` source in source runs. */
export function resolveClaudeCliStubPath(
  fileExists: (filePath: string) => boolean,
  baseDir: string = import.meta.dirname,
): string | undefined {
  return [".js", ".ts"]
    .map((extension) => path.join(baseDir, `${STUB_FILE_BASENAME}${extension}`))
    .find((candidate) => fileExists(candidate));
}
