import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, resolveSkillNameViolation } from "./frontmatter.js";
import { SkillsService } from "./loader.js";
import { enumerateSkillRoutes } from "./skill-module-routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const bundledDir = path.join(repoRoot, "skills", "bundled");
const skillDir = path.join(bundledDir, "goatcitadel-native-safe-self-improvement");
const skillFile = path.join(skillDir, "SKILL.md");
const mcpVetterDir = path.join(bundledDir, "mcp-vetter");
const mcpVetterFile = path.join(mcpVetterDir, "SKILL.md");
const agenticSkillArchitectDir = path.join(bundledDir, "agentic-skill-architect");
const agenticSkillArchitectFile = path.join(agenticSkillArchitectDir, "SKILL.md");
const impeccableFile = path.join(bundledDir, "impeccable", "SKILL.md");

describe("goatcitadel-native-safe-self-improvement bundled skill", () => {
  it("parses normalized frontmatter metadata", async () => {
    const raw = await fs.readFile(skillFile, "utf8");
    const parsed = parseSkillMarkdown(raw);

    expect(parsed.frontmatter.name).toBe("goatcitadel-native-safe-self-improvement");
    expect(parsed.frontmatter.metadata?.version).toBe("0.2.0");
    expect(parsed.frontmatter.metadata?.tags).toContain("self-improvement");
    expect(parsed.frontmatter.metadata?.tools).toEqual(["fs.read", "fs.write", "memory.read"]);
    expect(parsed.frontmatter.metadata?.keywords).toContain("log this routing gap");
    expect(parsed.frontmatter.metadata?.keywords).toContain("goatcitadel native safe improvement");
    expect(parsed.frontmatter.metadata?.keywords).toContain("goatcitadel-native-safe-self-improvement");
  });

  it("loads from the bundled skills source", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    const loaded = await service.reload();
    const skill = loaded.find((item) => item.name === "goatcitadel-native-safe-self-improvement");

    expect(skill).toBeTruthy();
    expect(skill?.source).toBe("bundled");
    // The skill id feeds `skill:<skillId>` capability ids; it must stay
    // identifier-safe or chat-turn capability profiles fail to seal.
    expect(skill?.skillId).toBe("bundled:goatcitadel-native-safe-self-improvement");
    expect(skill?.declaredTools).toEqual(["fs.read", "fs.write", "memory.read"]);
    expect(skill?.keywords).toContain("goatcitadel-native-safe-self-improvement");
    expect(skill?.keywords).toContain("post-task reflection");
    expect(skill?.keywords).toContain("self-improvement log");
    expect(skill?.routingHints?.phrases).toContain("log this routing gap");
  });

  it("supports explicit-by-name text and guarded auto activation without matching unrelated coding prompts", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    await service.reload();

    const explicit = service.resolveActivation({
      text: "Please use goatcitadel native safe improvement for this correction log.",
    });
    expect(explicit.selected.map((skill) => skill.name)).toContain("goatcitadel-native-safe-self-improvement");

    const explicitSlug = service.resolveActivation({
      text: "Please use goatcitadel-native-safe-self-improvement for this correction log.",
    });
    expect(explicitSlug.selected.map((skill) => skill.name)).toContain("goatcitadel-native-safe-self-improvement");

    const guardedAuto = service.resolveActivation({
      text: "That's wrong. Log this as workflow friction and log this routing gap.",
    });
    expect(guardedAuto.selected.map((skill) => skill.name)).toContain("goatcitadel-native-safe-self-improvement");

    const unrelated = service.resolveActivation({
      text: "Fix the TypeScript error in the gateway route and add a regression test.",
    });
    expect(unrelated.selected.map((skill) => skill.name)).not.toContain("goatcitadel-native-safe-self-improvement");

    const casualEnglish = service.resolveActivation({
      text: "That's wrong, from now on use strict TypeScript mode. Don't assume the type is correct.",
    });
    expect(casualEnglish.selected.map((skill) => skill.name)).not.toContain("goatcitadel-native-safe-self-improvement");
  });

  it("keeps every bundled skill name identifier-safe so capability profiles can seal", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    const loaded = await service.reload();

    expect(loaded.length).toBeGreaterThan(0);
    for (const skill of loaded) {
      expect(resolveSkillNameViolation(skill.name), `skill ${skill.skillId} has an unsafe name`).toBeUndefined();
    }
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
    expect(parsed.frontmatter.metadata?.version).toBe("0.2.0");
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

describe("impeccable bundled skill", () => {
  it("parses frontmatter metadata and narrow activation keywords", async () => {
    const raw = await fs.readFile(impeccableFile, "utf8");
    const parsed = parseSkillMarkdown(raw);

    expect(parsed.frontmatter.name).toBe("impeccable");
    expect(parsed.frontmatter.metadata?.version).toBe("0.1.0");
    expect(parsed.frontmatter.metadata?.tags).toContain("design");
    expect(parsed.frontmatter.metadata?.keywords).toContain("impeccable");
    expect(parsed.frontmatter.metadata?.keywords).toContain("landing page");
  });

  it("loads from the bundled source with an identifier-safe id", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    const loaded = await service.reload();
    const skill = loaded.find((item) => item.name === "impeccable");

    expect(skill).toBeTruthy();
    expect(skill?.source).toBe("bundled");
    expect(skill?.skillId).toBe("bundled:impeccable");
    expect(resolveSkillNameViolation(skill?.name ?? "")).toBeUndefined();
  });

  it("activates on explicit mentions and landing-page polish prompts but not on backend work", async () => {
    const service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
    await service.reload();

    const explicit = service.resolveActivation({ text: "Please use impeccable for this page." });
    expect(explicit.selected.map((skill) => skill.name)).toContain("impeccable");

    const explicitWithCommand = service.resolveActivation({ text: "@skill impeccable polish the settings page" });
    expect(explicitWithCommand.selected.map((skill) => skill.name)).toContain("impeccable");

    const keyword = service.resolveActivation({ text: "Polish this landing page hero so it feels less generic." });
    expect(keyword.selected.map((skill) => skill.name)).toContain("impeccable");

    const unrelated = service.resolveActivation({
      text: "Fix the TypeScript error in the gateway route and add a regression test.",
    });
    expect(unrelated.selected.map((skill) => skill.name)).not.toContain("impeccable");
  });

  // The gateway throws (never truncates) when a routed module or route exceeds its ceiling, so an
  // oversize module after a re-sync would fail every design turn; this pins the shipped tree.
  it("keeps every routed module within the gateway byte ceilings on the shipped tree", async () => {
    const impeccableDir = path.join(bundledDir, "impeccable");

    for (const route of enumerateSkillRoutes({ skillId: "bundled:impeccable", skillName: "impeccable" })) {
      let total = 0;
      for (const module of route.modules) {
        const size = (await fs.stat(path.join(impeccableDir, module.relativePath))).size;
        expect(size, `${route.routeId} ${module.relativePath}`).toBeLessThanOrEqual(
          module.maxBytes ?? Number.POSITIVE_INFINITY,
        );
        total += size;
      }
      expect(total, route.routeId).toBeLessThanOrEqual(route.budgetBytes);
    }
  });
});
