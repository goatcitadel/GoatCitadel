import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "./frontmatter.js";
import { SkillsService } from "./loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const bundledDir = path.join(repoRoot, "skills", "bundled");
const skillDir = path.join(bundledDir, "goatcitadel-native-safe-self-improvement");
const skillFile = path.join(skillDir, "SKILL.md");
const mcpVetterDir = path.join(bundledDir, "mcp-vetter");
const mcpVetterFile = path.join(mcpVetterDir, "SKILL.md");
const agenticSkillArchitectDir = path.join(bundledDir, "agentic-skill-architect");
const agenticSkillArchitectFile = path.join(agenticSkillArchitectDir, "SKILL.md");

describe("goatcitadel-native-safe-self-improvement bundled skill", () => {
  it("parses normalized frontmatter metadata", async () => {
    const raw = await fs.readFile(skillFile, "utf8");
    const parsed = parseSkillMarkdown(raw);

    expect(parsed.frontmatter.name).toBe("GoatCitadel Native Safe Improvement");
    expect(parsed.frontmatter.metadata?.version).toBe("0.2.0");
    expect(parsed.frontmatter.metadata?.tags).toContain("self-improvement");
    expect(parsed.frontmatter.metadata?.tools).toEqual(["fs.read", "fs.write", "memory.read"]);
    expect(parsed.frontmatter.metadata?.keywords).toContain("log this routing gap");
    expect(parsed.frontmatter.metadata?.keywords).toContain("goatcitadel native safe improvement");
  });

  it("loads from the bundled skills source", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    const loaded = await service.reload();
    const skill = loaded.find((item) => item.name === "GoatCitadel Native Safe Improvement");

    expect(skill).toBeTruthy();
    expect(skill?.source).toBe("bundled");
    expect(skill?.declaredTools).toEqual(["fs.read", "fs.write", "memory.read"]);
    expect(skill?.keywords).toContain("post-task reflection");
    expect(skill?.keywords).toContain("self-improvement log");
  });

  it("supports explicit-by-name text and guarded auto activation without matching unrelated coding prompts", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    await service.reload();

    const explicit = service.resolveActivation({
      text: "Please use goatcitadel native safe improvement for this correction log.",
    });
    expect(explicit.selected.map((skill) => skill.name)).toContain("GoatCitadel Native Safe Improvement");

    const guardedAuto = service.resolveActivation({
      text: "That's wrong. Log this as workflow friction and log this routing gap.",
    });
    expect(guardedAuto.selected.map((skill) => skill.name)).toContain("GoatCitadel Native Safe Improvement");

    const unrelated = service.resolveActivation({
      text: "Fix the TypeScript error in the gateway route and add a regression test.",
    });
    expect(unrelated.selected.map((skill) => skill.name)).not.toContain("GoatCitadel Native Safe Improvement");

    const casualEnglish = service.resolveActivation({
      text: "That's wrong, from now on use strict TypeScript mode. Don't assume the type is correct.",
    });
    expect(casualEnglish.selected.map((skill) => skill.name)).not.toContain("GoatCitadel Native Safe Improvement");
  });
});

describe("mcp-vetter bundled skill", () => {
  it("parses frontmatter metadata and narrow activation keywords", async () => {
    const raw = await fs.readFile(mcpVetterFile, "utf8");
    const parsed = parseSkillMarkdown(raw);

    expect(parsed.frontmatter.name).toBe("mcp-vetter");
    expect(parsed.frontmatter.metadata?.version).toBe("0.1.0");
    expect(parsed.frontmatter.metadata?.tags).toContain("mcp");
    expect(parsed.frontmatter.metadata?.tools).toEqual(["fs.read", "memory.read"]);
    expect(parsed.frontmatter.metadata?.keywords).toContain("vet this mcp");
    expect(parsed.frontmatter.metadata?.keywords).toContain("mcp install review");
  });

  it("loads from the bundled source and triggers only for explicit MCP review prompts", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    await service.reload();

    const explicit = service.resolveActivation({
      text: "Please use mcp-vetter to review this MCP server before we install it.",
    });
    expect(explicit.selected.map((skill) => skill.name)).toContain("mcp-vetter");

    const keyword = service.resolveActivation({
      text: "Vet this MCP and tell me whether we should adopt it for GoatCitadel.",
    });
    expect(keyword.selected.map((skill) => skill.name)).toContain("mcp-vetter");

    const unrelated = service.resolveActivation({
      text: "Fix the Office focus mode layout and add a regression test.",
    });
    expect(unrelated.selected.map((skill) => skill.name)).not.toContain("mcp-vetter");
  });
});

describe("agentic-skill-architect bundled skill", () => {
  it("parses frontmatter metadata and targeted activation keywords", async () => {
    const raw = await fs.readFile(agenticSkillArchitectFile, "utf8");
    const parsed = parseSkillMarkdown(raw);

    expect(parsed.frontmatter.name).toBe("agentic-skill-architect");
    expect(parsed.frontmatter.metadata?.version).toBe("0.1.0");
    expect(parsed.frontmatter.metadata?.tags).toContain("agentic");
    expect(parsed.frontmatter.metadata?.tools).toEqual(["fs.read", "memory.read"]);
    expect(parsed.frontmatter.metadata?.keywords).toContain("design an agentic skill");
    expect(parsed.frontmatter.metadata?.keywords).toContain("skill vs runtime");
  });

  it("loads from the bundled source and triggers for skill-boundary review prompts only", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    await service.reload();

    const explicit = service.resolveActivation({
      text: "Please use agentic-skill-architect to review this skill architecture.",
    });
    expect(explicit.selected.map((skill) => skill.name)).toContain("agentic-skill-architect");

    const keyword = service.resolveActivation({
      text: "Is this actually a skill or should this be a skill or infrastructure decision instead?",
    });
    expect(keyword.selected.map((skill) => skill.name)).toContain("agentic-skill-architect");

    const unrelated = service.resolveActivation({
      text: "Fix the gateway route bug and add a regression test for approvals.",
    });
    expect(unrelated.selected.map((skill) => skill.name)).not.toContain("agentic-skill-architect");
  });
});
