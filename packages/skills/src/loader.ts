import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedSkill, SkillResolveInput, SkillActivationDecision } from "@goatcitadel/contracts";
import { parseSkillMarkdown } from "./frontmatter.js";
import { resolveSkillPrecedence } from "./precedence.js";
import { resolveSkillActivation } from "./activation.js";
import { resolveGeneratedRoutingHints } from "./routing-hints.generated.js";

export interface SkillSource {
  source: LoadedSkill["source"];
  dir: string;
}

export class SkillsService {
  private loaded: LoadedSkill[] = [];

  public constructor(private readonly sources: SkillSource[]) {}

  public async reload(): Promise<LoadedSkill[]> {
    const all: LoadedSkill[] = [];
    for (const source of this.sources) {
      const sourceSkills = await loadSourceSkills(source);
      all.push(...sourceSkills);
    }

    this.loaded = resolveSkillPrecedence(all);
    return this.loaded;
  }

  public list(): LoadedSkill[] {
    return this.loaded;
  }

  public resolveActivation(input: SkillResolveInput): SkillActivationDecision {
    return resolveSkillActivation(input, this.loaded);
  }
}

async function loadSourceSkills(source: SkillSource): Promise<LoadedSkill[]> {
  try {
    const entries = await fs.readdir(source.dir, { withFileTypes: true });
    const skills: LoadedSkill[] = [];

    const directSourceSkill = await loadSkillFromDir(source, source.dir);
    if (directSourceSkill) {
      skills.push(directSourceSkill);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDir = path.join(source.dir, entry.name);
      const loaded = await loadSkillFromDir(source, skillDir);
      if (loaded) {
        skills.push(loaded);
      }
    }

    return skills;
  } catch {
    return [];
  }
}

async function loadSkillFromDir(source: SkillSource, skillDir: string): Promise<LoadedSkill | undefined> {
  const skillFile = path.join(skillDir, "SKILL.md");
  try {
    const raw = await fs.readFile(skillFile, "utf8");
    const parsed = parseSkillMarkdown(raw);
    const stat = await fs.stat(skillFile);
    return {
      skillId: `${source.source}:${parsed.frontmatter.name}`,
      name: parsed.frontmatter.name,
      source: source.source,
      dir: skillDir,
      tags: parsed.frontmatter.metadata?.tags ?? [],
      declaredTools: parsed.frontmatter.metadata?.tools ?? [],
      requires: parsed.frontmatter.metadata?.requires ?? [],
      keywords: parsed.frontmatter.metadata?.keywords ?? [],
      routingHints: resolveGeneratedRoutingHints(parsed.frontmatter.name),
      instructionBody: parsed.body,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}
