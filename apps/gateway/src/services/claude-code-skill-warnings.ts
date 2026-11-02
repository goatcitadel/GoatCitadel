import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillMarkdown } from "@goatcitadel/skills";

// How a Claude Code plugin's skill behaves differently in GoatCitadel, in plain lines for its piece. These are written
// by the plugin check, which knows the plugin; the Skill Hub records only which keys it left out. Nothing here changes
// the skill: it is kept byte for byte.

const LINES = {
  userInvocable:
    "In Claude Code only the AI could start this skill. Here you can also start it by name once it's switched on.",
  allowedTools: "Its pre-approved tools aren't kept. Your own tool rules and approvals apply.",
  modelEffort: "Its model and effort settings aren't kept.",
  whenToUse: "Its hints on when to use it aren't kept.",
  placeholders:
    "It uses values Claude Code fills in, such as $ARGUMENTS. GoatCitadel passes them to the AI as written.",
} as const;

const PLACEHOLDERS = /\$ARGUMENTS\b|\$[0-9]\b|\$\{CLAUDE_(?:SKILL_DIR|PLUGIN_ROOT|SESSION_ID)\}/u;
const CONNECTOR_TOOLS = /\bmcp__[A-Za-z0-9_]+__/u;
const SUBAGENTS = /\bsubagent(?:_type|s)?\b/iu;
const SCRIPTS = /\$\{CLAUDE_PLUGIN_ROOT\}\//u;

export function claudeCodeSkillWarnings(input: {
  /** SKILL.md as read from the snapshot. */
  skillMarkdown: string;
  /** Files in the skill folder other than SKILL.md. */
  otherFileCount: number;
  pluginId: string;
}): string[] {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseSkillMarkdown(input.skillMarkdown).frontmatter as unknown as Record<string, unknown>;
  } catch {
    // The review refuses a file it can't parse anyway.
    return [];
  }
  const text = input.skillMarkdown;
  const has = (key: string) => Object.hasOwn(frontmatter, key);
  const count = input.otherFileCount;
  const mentions = [
    ...(commandPattern(input.pluginId).test(text) ? ["commands"] : []),
    ...(CONNECTOR_TOOLS.test(text) ? ["other connectors' tools"] : []),
    ...(SUBAGENTS.test(text) ? ["subagents"] : []),
    ...(SCRIPTS.test(text) ? ["scripts"] : []),
  ];
  return [
    ...(has("user-invocable") && frontmatter["user-invocable"] === false ? [LINES.userInvocable] : []),
    ...(has("allowed-tools") ? [LINES.allowedTools] : []),
    ...(has("model") || has("effort") ? [LINES.modelEffort] : []),
    ...(has("when_to_use") ? [LINES.whenToUse] : []),
    ...(PLACEHOLDERS.test(text) ? [LINES.placeholders] : []),
    ...(count > 0
      ? [
          count === 1
            ? "1 other file in this skill is kept but never read."
            : `${count} other files in this skill are kept but never read.`,
        ]
      : []),
    ...(mentions.length > 0
      ? [
          `Its instructions mention parts of the plugin GoatCitadel left out (${mentions.join(", ")}). It may not work fully without them.`,
        ]
      : []),
  ];
}

/**
 * The warnings for the skill folder at `skillDir`: its SKILL.md (a plain file, read once; the snapshot bounds its
 * size) and how many other files it holds, counted through its subfolders. A SKILL.md that can't be read gives none.
 */
export async function readClaudeCodeSkillWarnings(skillDir: string, pluginId: string): Promise<string[]> {
  let skillMarkdown: string;
  try {
    const file = path.join(skillDir, "SKILL.md");
    if (!(await fs.lstat(file)).isFile()) return [];
    skillMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file));
  } catch {
    return [];
  }
  return claudeCodeSkillWarnings({ skillMarkdown, otherFileCount: (await countFiles(skillDir)) - 1, pluginId });
}

async function countFiles(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isFile()) total += 1;
    else if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name));
  }
  return total;
}

function commandPattern(pluginId: string): RegExp {
  // A plugin id is lowercase letters, digits and hyphens, so it needs no escaping.
  return new RegExp(`(^|[\\s(\`])/${pluginId}:[a-z0-9-]+`, "u");
}
