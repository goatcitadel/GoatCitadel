import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLAUDE_CODE_PLUGIN_MANIFEST_PATH } from "@goatcitadel/contracts";

// Writes a Claude Code plugin tree for a test. Fixtures are written here, never committed as folders.

export interface ClaudeCodePluginFixture {
  /** Written to `.claude-plugin/plugin.json`; a string is written as is. */
  pluginJson?: Record<string, unknown> | string;
  /** Folder name under `skills/` → SKILL.md text. */
  skills?: Record<string, string>;
  /** Any other relative path → text. */
  files?: Record<string, string>;
  /** Written to `.mcp.json`. */
  mcpJson?: Record<string, unknown>;
}

export async function writeClaudeCodePluginFixture(dir: string, fixture: ClaudeCodePluginFixture): Promise<void> {
  const writes: Array<[string, string]> = [];
  if (fixture.pluginJson !== undefined) {
    const text =
      typeof fixture.pluginJson === "string" ? fixture.pluginJson : `${JSON.stringify(fixture.pluginJson, null, 2)}\n`;
    writes.push([CLAUDE_CODE_PLUGIN_MANIFEST_PATH, text]);
  }
  for (const [folder, markdown] of Object.entries(fixture.skills ?? {})) {
    writes.push([`skills/${folder}/SKILL.md`, markdown]);
  }
  for (const [relativePath, text] of Object.entries(fixture.files ?? {})) writes.push([relativePath, text]);
  if (fixture.mcpJson !== undefined) writes.push([".mcp.json", `${JSON.stringify(fixture.mcpJson, null, 2)}\n`]);
  for (const [relativePath, text] of writes) {
    const target = path.join(dir, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
}

/** A plain Claude Code SKILL.md. */
export function claudeCodeSkillMarkdown(name: string, body = "Write short notes.\n", extraFrontmatter = ""): string {
  return `---\nname: ${name}\ndescription: Turns a long document into short notes for the team.\n${extraFrontmatter}---\n\n${body}`;
}
