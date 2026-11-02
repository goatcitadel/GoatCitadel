import { describe, expect, it } from "vitest";
import { claudeCodeSkillWarnings } from "./claude-code-skill-warnings.js";

const HEAD = "name: notes\ndescription: Turns a long document into short notes for the team.\n";

function skill(frontmatter = "", body = "Write short notes.\n"): string {
  return `---\n${HEAD}${frontmatter}---\n\n${body}`;
}

function warnings(markdown: string, otherFileCount = 0): string[] {
  return claudeCodeSkillWarnings({ skillMarkdown: markdown, otherFileCount, pluginId: "notes-kit" });
}

const LEFT_OUT = (list: string) =>
  `Its instructions mention parts of the plugin GoatCitadel left out (${list}). It may not work fully without them.`;

describe("claudeCodeSkillWarnings", () => {
  it.each([
    [
      "user-invocable: false",
      skill("user-invocable: false\n"),
      0,
      "In Claude Code only the AI could start this skill. Here you can also start it by name once it's switched on.",
    ],
    [
      "allowed-tools",
      skill("allowed-tools: Read, Grep\n"),
      0,
      "Its pre-approved tools aren't kept. Your own tool rules and approvals apply.",
    ],
    ["model", skill("model: opus\n"), 0, "Its model and effort settings aren't kept."],
    ["effort", skill("effort: high\n"), 0, "Its model and effort settings aren't kept."],
    ["when_to_use", skill("when_to_use: When notes are needed.\n"), 0, "Its hints on when to use it aren't kept."],
    [
      "placeholders",
      skill("", "Use $ARGUMENTS here.\n"),
      0,
      "It uses values Claude Code fills in, such as $ARGUMENTS. GoatCitadel passes them to the AI as written.",
    ],
    ["one other file", skill(), 1, "1 other file in this skill is kept but never read."],
    ["three other files", skill(), 3, "3 other files in this skill are kept but never read."],
    ["a left-out command", skill("", "Then run /notes-kit:deploy now.\n"), 0, LEFT_OUT("commands")],
  ])("warns about %s", (_label, markdown, otherFileCount, line) => {
    expect(warnings(markdown, otherFileCount)).toEqual([line]);
  });

  it.each([["$1"], ["${CLAUDE_SKILL_DIR}"], ["${CLAUDE_SESSION_ID}"]])("finds the placeholder %s", (placeholder) => {
    expect(warnings(skill("", `Use ${placeholder}.\n`))).toHaveLength(1);
  });

  it("warns when a skill mentions a left-out command, connector tool, subagent or script", () => {
    const body = [
      "(/notes-kit:ship) first.",
      "Call mcp__plugin_noteskit_docs__search.",
      "Use a subagent for review.",
      "Run ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh.",
    ].join("\n");
    expect(warnings(skill("", body))).toEqual([
      "It uses values Claude Code fills in, such as $ARGUMENTS. GoatCitadel passes them to the AI as written.",
      LEFT_OUT("commands, other connectors' tools, subagents, scripts"),
    ]);
  });

  it("gives each line once, in order", () => {
    const markdown = skill(
      "model: opus\neffort: high\nallowed-tools: Read\nuser-invocable: false\n",
      "$ARGUMENTS $1\n",
    );
    expect(warnings(markdown, 2)).toEqual([
      "In Claude Code only the AI could start this skill. Here you can also start it by name once it's switched on.",
      "Its pre-approved tools aren't kept. Your own tool rules and approvals apply.",
      "Its model and effort settings aren't kept.",
      "It uses values Claude Code fills in, such as $ARGUMENTS. GoatCitadel passes them to the AI as written.",
      "2 other files in this skill are kept but never read.",
    ]);
  });

  it("gives no warnings for a plain skill", () => {
    expect(warnings(skill("user-invocable: true\n", "Mention /other-plugin:cmd and $ARG and $10.\n"))).toEqual([]);
  });

  it("gives no warnings for a file it can't parse", () => {
    expect(warnings("no frontmatter at all", 0)).toEqual([]);
  });
});
