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
    const sourceSkills = await Promise.all(this.sources.map((source) => loadSourceSkills(source)));

    this.loaded = resolveSkillPrecedence(sourceSkills.flat());
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
    const loaded = await Promise.all([
      loadSkillFromDir(source, source.dir),
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => loadSkillFromDir(source, path.join(source.dir, entry.name))),
    ]);

    return loaded.filter((skill): skill is LoadedSkill => skill !== undefined);
  } catch {
    return [];
  }
}

async function loadSkillFromDir(source: SkillSource, skillDir: string): Promise<LoadedSkill | undefined> {
  const skillFile = path.join(skillDir, "SKILL.md");
  try {
    const [raw, stat] = await Promise.all([fs.readFile(skillFile, "utf8"), fs.stat(skillFile)]);
    const parsed = parseSkillMarkdown(raw);
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
