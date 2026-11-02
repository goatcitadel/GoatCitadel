import fs from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "@goatcitadel/contracts";
import { SKILL_RUNS_SHELL_COMMANDS, hasClaudeCodeShellLines } from "./skill-hub-claude-code-dialect.js";

// The Skill Hub review's check of a Claude Code skill's text. SKILL.md is the only file of a plugin skill GoatCitadel
// puts into the model's context, so it is the only file read. The file is read, never rewritten.

const SHELL_LINES_MESSAGE = "Claude Code skill runs shell commands, which GoatCitadel doesn't allow.";

/**
 * Refuses a skill read as Claude Code format whose SKILL.md holds a shell line, anywhere in the file. Without a dialect
 * nothing is read here: GoatCitadel never runs such lines for a native skill, and the native scans judge its text.
 * The refusal has the review's own shape (`field` is the code); the plugin panel words the code.
 */
export async function assertNoClaudeCodeShellLines(
  skillDir: string,
  dialect: "claude_code" | undefined,
): Promise<void> {
  if (dialect !== "claude_code") return;
  const skillMarkdown = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  if (hasClaudeCodeShellLines(skillMarkdown)) {
    throw new ValidationError({ message: SHELL_LINES_MESSAGE, field: SKILL_RUNS_SHELL_COMMANDS });
  }
}
