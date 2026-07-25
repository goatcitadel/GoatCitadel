import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedSkill, SkillResolveInput, SkillActivationDecision } from "@goatcitadel/contracts";
import { parseSkillMarkdown, resolveSkillNameViolation } from "./frontmatter.js";
import { resolveSkillPrecedence } from "./precedence.js";
import { resolveSkillActivation } from "./activation.js";
import { resolveGeneratedRoutingHints } from "./routing-hints.generated.js";

export interface SkillSource {
  source: LoadedSkill["source"];
  dir: string;
}

// Minimal logging seam so the loader can surface skill discovery/parse problems
// instead of swallowing them, without coupling this low-level package to a
// concrete logger. Defaults to `console`; tests inject a spy.
export interface SkillsLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

const defaultLogger: SkillsLogger = {
  // eslint-disable-next-line no-console -- skill discovery/parse problems must surface in local runtime logs; callers can inject a structured logger.
  warn: (message, context) => console.warn(`[goatcitadel] ${message}`, context ?? {}),
  // eslint-disable-next-line no-console -- unexpected skill source-read failures must surface in local runtime logs; callers can inject a structured logger.
  error: (message, context) => console.error(`[goatcitadel] ${message}`, context ?? {}),
};

function isErrnoException(error: unknown, code: string): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}

export class SkillsService {
  private loaded: LoadedSkill[] = [];

  public constructor(
    private readonly sources: SkillSource[],
    private readonly logger: SkillsLogger = defaultLogger,
  ) {}

  public async reload(): Promise<LoadedSkill[]> {
    const sourceSkills = await Promise.all(this.sources.map((source) => loadSourceSkills(source, this.logger)));

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

async function loadSourceSkills(source: SkillSource, logger: SkillsLogger): Promise<LoadedSkill[]> {
  let entries;
  try {
    entries = await fs.readdir(source.dir, { withFileTypes: true });
  } catch (error) {
    // A missing source directory is an expected, benign state (e.g. no
    // workspace/managed skills installed yet) — return empty silently. Any
    // other readdir failure (permissions, I/O) is unexpected and must be
    // surfaced rather than masquerading as "no skills".
    if (isErrnoException(error, "ENOENT")) {
      return [];
    }
    logger.error(`Failed to read skill source directory ${source.dir}`, {
      source: source.source,
      error: (error as Error).message,
    });
    return [];
  }

  const loaded = await Promise.all([
    loadSkillFromDir(source, source.dir, logger),
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadSkillFromDir(source, path.join(source.dir, entry.name), logger)),
  ]);

  return loaded.filter((skill): skill is LoadedSkill => skill !== undefined);
}

async function loadSkillFromDir(
  source: SkillSource,
  skillDir: string,
  logger: SkillsLogger,
): Promise<LoadedSkill | undefined> {
  const skillFile = path.join(skillDir, "SKILL.md");
  let raw: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [raw, stat] = await Promise.all([fs.readFile(skillFile, "utf8"), fs.stat(skillFile)]);
  } catch (error) {
    // Directories without a SKILL.md (ENOENT) are simply not skills — skip
    // them quietly. Other read errors are logged so a genuinely unreadable
    // skill file is not silently dropped.
    if (!isErrnoException(error, "ENOENT")) {
      logger.warn(`Failed to read SKILL.md at ${skillFile}`, {
        source: source.source,
        error: (error as Error).message,
      });
    }
    return undefined;
  }

  try {
    const parsed = parseSkillMarkdown(raw);
    const nameViolation = resolveSkillNameViolation(parsed.frontmatter.name);
    if (nameViolation) {
      // An unsafe name would flow into the `skill:<source>:<name>` capability
      // id and fail chat-turn capability-profile sealing on every send. Reject
      // the skill here, at load time, where the author can see exactly why.
      logger.warn(`Skipping skill with unsafe name at ${skillFile}: name ${nameViolation}`, {
        source: source.source,
        skillName: parsed.frontmatter.name,
        reason: `name ${nameViolation}`,
      });
      return undefined;
    }
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
  } catch (error) {
    // A malformed SKILL.md (bad frontmatter shape, invalid YAML) is reported so
    // operators can see *which* skill failed and why, rather than the file
    // vanishing from the catalog with no signal.
    logger.warn(`Failed to parse SKILL.md at ${skillFile}`, {
      source: source.source,
      error: (error as Error).message,
    });
    return undefined;
  }
}
