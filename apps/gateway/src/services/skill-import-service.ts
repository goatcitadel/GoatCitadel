/* eslint-disable max-lines -- Skill import policy, normalization, and filesystem writes remain intentionally grouped for operator traceability. */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { parseSkillMarkdown } from "@goatcitadel/skills";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import type {
  SkillImportCandidate,
  SkillImportHistoryRecord,
  SkillImportSourceType,
  SkillImportValidationResult,
  SkillSourceLookupParsedSource,
  SkillSourceLookupResponse,
  SkillMergedSourceResult,
  SkillSourceListResponse,
  SkillSourceProvider,
  SkillSourceResultRecord,
  SkillSourceSearchRecord,
} from "@goatcitadel/contracts";
import type { SystemSettingsRepository } from "@goatcitadel/storage";

const IMPORT_HISTORY_KEY = "skill_import_history_v1";
const MAX_IMPORT_HISTORY = 300;
const execFileAsync = promisify(execFile);

interface MaterializedSkillSource {
  sourceDir: string;
  skillDir: string;
  skillFilePath: string;
  candidate: SkillImportCandidate;
  cleanup?: () => Promise<void>;
}

interface SkillImportInput {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
}

interface SkillInstallInput extends SkillImportInput {
  force?: boolean;
  confirmHighRisk?: boolean;
}

interface InstalledSkillSourceManifest {
  manifestVersion?: number;
  installedAt?: string;
  lastReviewedAt?: string;
  lastCheckedAt?: string;
  duplicateFamily?: string;
  reviewDisposition?: "allow" | "conditional" | "reference_only" | "reject";
  marketplaceListingUrl?: string;
  resolvedUpstream?: {
    url?: string;
    ref?: string;
    version?: string;
  };
  candidate?: {
    canonicalKey?: string;
    sourceRef?: string;
    sourceUrl?: string;
    repositoryUrl?: string;
  };
}

interface SkillInstallDuplicateMatch {
  scope: "extra" | "bundled";
  identifier: string;
  duplicateFamily?: string;
  canonicalKey?: string;
}

const HOSTED_SKILL_BUNDLE_FILES = [
  { remoteName: "skill.md", localName: "SKILL.md", required: true },
  { remoteName: "heartbeat.md", localName: "HEARTBEAT.md", required: false },
  { remoteName: "messaging.md", localName: "MESSAGING.md", required: false },
  { remoteName: "rules.md", localName: "RULES.md", required: false },
  { remoteName: "skill.json", localName: "skill.json", required: false },
] as const;

const FALLBACK_SOURCE_ITEMS: SkillSourceResultRecord[] = [
  {
    sourceProvider: "agentskill",
    sourceUrl: "https://agentskill.sh/readme",
    name: "AgentSkill Catalog",
    description: "Marketplace index and docs for SKILL.md style assets.",
    tags: ["catalog", "docs", "skills"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Review the catalog and copy the upstream repository or source path before installing.",
  },
  {
    sourceProvider: "agentskill",
    sourceUrl: "https://agentskill.sh/install",
    name: "AgentSkill Install Guide",
    description: "Installation and bootstrap guidance for marketplace skills.",
    tags: ["install", "guide"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Review the guide and use the upstream skill repository or local path for install.",
  },
  {
    sourceProvider: "skillsmp",
    sourceUrl: "https://skillsmp.com/docs",
    name: "SkillsMP Docs",
    description: "Reference docs for SkillsMP marketplace integration.",
    tags: ["docs", "skills"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Use the upstream repository or validated local source instead of the listing page itself.",
  },
  {
    sourceProvider: "skillsmp",
    sourceUrl: "https://skillsmp.com/",
    name: "SkillsMP Catalog",
    description: "Marketplace listings for reusable agent skills.",
    tags: ["catalog", "marketplace"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Search for the skill, then review the upstream repository before installing.",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/louis-szeto/harness-engineer",
    name: "Harness Engineer",
    description:
      "Harness-engineering framework that maps well to GoatCitadel's native skills, routing, memory, and trust surfaces.",
    tags: ["clawhub", "harness", "audit", "routing", "policy", "memory"],
    sourceKind: "reference",
    installability: "review_only",
    installHint:
      "Treat as a reference pattern. GoatCitadel should absorb the audit framing natively instead of importing this skill.",
    skillFamily: "harness_engineering",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/kennyzir/capability-evolver-pro",
    name: "Capability Evolver Pro",
    description:
      "Autonomous capability evolution workflow whose report-first ideas are useful, but whose self-modifying runtime model conflicts with GoatCitadel's trust posture.",
    tags: ["clawhub", "self-improvement", "evolver", "replay", "autonomous"],
    sourceKind: "reference",
    installability: "not_installable",
    installHint:
      "Treat as a bounded inspiration source only. Borrow report-first ideas without importing the autonomous self-modification loop.",
    skillFamily: "capability_evolution",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/rot13maxi/shards",
    name: "Shards",
    description: "Agent skill by @rot13maxi on ClawHub.",
    tags: ["clawhub", "skill", "shards", "coordination", "workflow"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Review the ClawHub listing and resolve the upstream repository or packaged source before importing.",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/aiwithabidi/chrome-devtools-mcp",
    name: "Chrome Devtools Mcp",
    description:
      "Chrome DevTools MCP - official browser automation and testing server for controlling Chrome via the MCP protocol.",
    tags: ["clawhub", "browser", "devtools", "mcp", "playwright", "automation", "testing"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Review the ClawHub listing and resolve the upstream repository or packaged source before importing.",
    skillFamily: "browser_automation",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/lucassynnott/cloudflare-api",
    name: "Cloudflare API",
    description: "Cloudflare-focused skill for zone, DNS, and API operations.",
    tags: ["clawhub", "cloudflare", "dns", "api"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint:
      "Pick one primary Cloudflare or DNS skill for GoatCitadel and import only the validated upstream repository.",
    skillFamily: "cloudflare_dns",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/1999AZZAR/cloudflare-manager",
    name: "Cloudflare Manager",
    description: "Cloudflare management skill for DNS and edge operations.",
    tags: ["clawhub", "cloudflare", "dns", "manager"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint:
      "Pick one primary Cloudflare or DNS skill for GoatCitadel and import only the validated upstream repository.",
    skillFamily: "cloudflare_dns",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/steipete/domain-dns-ops",
    name: "Domain DNS Ops",
    description:
      "Domain and DNS operations skill best treated as reference material unless it adds a unique workflow beyond the primary Cloudflare path.",
    tags: ["clawhub", "dns", "domain", "ops"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Keep as reference by default; prefer one primary Cloudflare or DNS skill for installation.",
    skillFamily: "cloudflare_dns",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/Dolverin/flaresolverr",
    name: "FlareSolverr",
    description: "FlareSolverr integration skill for sites that require a separately operated FlareSolverr service.",
    tags: ["clawhub", "flaresolverr", "browser", "network"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Only import after confirming a working FlareSolverr service is already part of the runtime.",
    skillFamily: "flaresolverr_runtime",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/steipete/gog",
    name: "GoG",
    description: "Google CLI and OAuth oriented workflow skill.",
    tags: ["clawhub", "google", "oauth", "cli"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Only import when Google CLI or OAuth workflows are an active GoatCitadel requirement.",
    skillFamily: "google_cli_oauth",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/TheSethRose/agent-browser",
    name: "Agent Browser",
    description: "Browser automation skill that overlaps existing agent-browser capability in the broader environment.",
    tags: ["clawhub", "browser", "automation", "agent-browser"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Treat as overlap reference unless the repo needs a distinct repo-managed browser skill variant.",
    skillFamily: "browser_automation",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/halthelobster/proactive-agent",
    name: "Proactive Agent",
    description: "Proactive workflow skill that should be mined for ideas first rather than installed immediately.",
    tags: ["clawhub", "proactive", "automation", "agent"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Use as a design reference first. Do not make it part of the first repo-managed install batch.",
    skillFamily: "proactive_automation",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/spclaudehome/skill-vetter",
    name: "Skill Vetter",
    description: "Skill vetting workflow that overlaps GoatCitadel's native import and trust posture.",
    tags: ["clawhub", "vetting", "trust", "review"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Treat as overlap reference; GoatCitadel already has native import validation and vetting controls.",
    skillFamily: "skill_vetting",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/ivangdavila/self-improving",
    name: "Self Improving",
    description: "Self-improvement workflow that overlaps GoatCitadel's bundled safe self-improvement capability.",
    tags: ["clawhub", "self-improving", "improvement", "replay"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Treat as overlap reference; GoatCitadel already ships a safer native self-improvement path.",
    skillFamily: "safe_self_improvement",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/Shaivpidadi/free-ride",
    name: "Free Ride",
    description: "OpenClaw-oriented skill with environment-specific assumptions.",
    tags: ["clawhub", "openclaw", "automation"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Only consider after confirming a concrete GoatCitadel use case and runtime compatibility.",
    skillFamily: "openclaw_experiment",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/maximeprades/auto-updater",
    name: "Auto Updater",
    description:
      "Auto-updater workflow best treated as a pattern source because GoatCitadel should implement updates natively and review-first.",
    tags: ["clawhub", "updater", "automation"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Use as a pattern reference only; prefer GoatCitadel's native report-first update review flow.",
    skillFamily: "auto_updates",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/NeilJo-GY/open-persona",
    name: "Open Persona",
    description: "Persona-oriented skill that is optional future capability rather than a first-batch install.",
    tags: ["clawhub", "persona", "identity"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Hold as an optional future capability rather than a first-pass repo-managed install.",
    skillFamily: "persona_runtime",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/linkbag/ai-swarm",
    name: "AI Swarm",
    description: "High-impact swarm automation skill that can mutate repositories and automation state aggressively.",
    tags: ["clawhub", "swarm", "automation", "agents"],
    sourceKind: "reference",
    installability: "not_installable",
    installHint:
      "Quarantine for now. Review manually before any future consideration because it can drive broad repo mutation and automation behavior.",
    skillFamily: "multi_agent_swarm",
  },
  {
    sourceProvider: "external",
    sourceUrl: "https://animalhouse.ai/skills/animal-house",
    repositoryUrl: "https://github.com/geeks-accelerator/animal-house-ai",
    upstreamUrl: "https://animalhouse.ai/skills/animal-house",
    name: "Animal House",
    description:
      "Virtual creature game and REST API for AI agents. Join the house by following the hosted skill instructions rather than importing it as a normal GoatCitadel skill.",
    tags: ["game", "virtual-pet", "api", "creatures", "pixel-art", "animalhouse", "rest"],
    sourceKind: "reference",
    installability: "not_installable",
    installHint:
      "Read the hosted instructions and interact with the live service directly. This is an external experience, not a normal installable GoatCitadel skill pack.",
  },
];

const LOOKUP_FAMILY_TERMS: Array<{ family: string; tokens: string[] }> = [
  {
    family: "browser_automation",
    tokens: ["browser", "playwright", "automation", "web", "e2e", "screenshot", "testing"],
  },
  { family: "cloudflare_dns", tokens: ["cloudflare", "dns", "domain", "zones"] },
  { family: "figma_design", tokens: ["figma", "design", "ui", "frontend", "implementation", "prototype"] },
  { family: "notebook_research", tokens: ["notebooklm", "notes", "research", "study", "knowledge", "source-grounded"] },
  {
    family: "messaging_notifications",
    tokens: ["discord", "slack", "notification", "notifications", "alert", "messaging", "channel"],
  },
  { family: "presentations", tokens: ["slides", "presentation", "deck", "ppt", "powerpoint"] },
  { family: "docs_authoring", tokens: ["docs", "documentation", "doc", "writing", "authoring"] },
  { family: "mcp_integrations", tokens: ["mcp", "integration", "server", "template", "connector"] },
  {
    family: "games_and_experiments",
    tokens: ["game", "virtual", "pet", "creature", "pixel", "animalhouse", "tamagotchi"],
  },
];

const REVIEW_POLICY_HINTS: Array<{
  pattern: RegExp;
  duplicateFamily?: string;
  reviewDisposition: "allow" | "conditional" | "reference_only" | "reject";
  message: string;
}> = [
  {
    pattern: /\bharness[-\s]?engineer\b/i,
    duplicateFamily: "harness_engineering",
    reviewDisposition: "reference_only",
    message:
      "GoatCitadel already owns harness engineering natively across Configure > Agents, Skills review, orchestration, memory, and policy. Keep this as a reference pattern only.",
  },
  {
    pattern: /\bcapability[-\s]?evolver\b|\bevolver\b/i,
    reviewDisposition: "reject",
    message:
      "Capability Evolver-style autonomous self-modification conflicts with GoatCitadel's explicit approval and proposal-before-activation trust posture. Borrow the report-first ideas, but do not import this runtime directly.",
  },
  {
    pattern: /\bself[-\s]?improv/i,
    duplicateFamily: "safe_self_improvement",
    reviewDisposition: "reject",
    message: "GoatCitadel already ships a native safe self-improvement bundle; keep this as reference only.",
  },
  {
    pattern: /\bskill[-\s]?vetter\b|\bvetter\b/i,
    duplicateFamily: "skill_vetting",
    reviewDisposition: "reject",
    message:
      "GoatCitadel already has native skill import vetting and a bundled MCP vetter; keep this as reference only.",
  },
  {
    pattern: /\b(ai[-\s]?swarm|swarm|council)\b/i,
    duplicateFamily: "multi_agent_swarm",
    reviewDisposition: "reject",
    message:
      "GoatCitadel already has a native orchestration direction for this swarm or council family; keep this as reference only.",
  },
  {
    pattern: /\bproactive[-\s]?agent\b/i,
    duplicateFamily: "proactive_automation",
    reviewDisposition: "reference_only",
    message: "Treat this as a design reference first, not a first-pass repo-managed install.",
  },
  {
    pattern: /\bauto[-\s]?updater\b/i,
    duplicateFamily: "auto_updates",
    reviewDisposition: "reference_only",
    message: "Use this as a pattern reference only; GoatCitadel should keep update review native and report-first.",
  },
  {
    pattern: /\bfree[-\s]?ride\b/i,
    duplicateFamily: "openclaw_experiment",
    reviewDisposition: "conditional",
    message: "Only install after confirming a concrete GoatCitadel use case and runtime compatibility.",
  },
  {
    pattern: /\bopen[-\s]?persona\b/i,
    duplicateFamily: "persona_runtime",
    reviewDisposition: "reference_only",
    message: "Hold this as optional future capability rather than part of the first install batch.",
  },
  {
    pattern: /\bflaresolverr\b/i,
    duplicateFamily: "flaresolverr_runtime",
    reviewDisposition: "conditional",
    message: "Only install after confirming a working FlareSolverr service already exists in the runtime.",
  },
  {
    pattern: /\bgog\b|google oauth|google cli/i,
    duplicateFamily: "google_cli_oauth",
    reviewDisposition: "conditional",
    message: "Only install when Google CLI or OAuth workflows are an active GoatCitadel requirement.",
  },
  {
    pattern: /\bcloudflare\b|\bdns\b|\bdomain[-\s]?dns\b/i,
    duplicateFamily: "cloudflare_dns",
    reviewDisposition: "allow",
    message:
      "Choose one primary Cloudflare or DNS skill for repo-managed installation and avoid overlapping installs in the same family.",
  },
];

const NATIVE_OVERLAP_HINTS: Record<
  string,
  {
    nativeAlternativeName: string;
    nativeDestination: string;
    blockingReason: string;
  }
> = {
  harness_engineering: {
    nativeAlternativeName: "Native harness audit and operator governance",
    nativeDestination: "Configure > Agents > Skills",
    blockingReason: "GoatCitadel already owns harness engineering natively across its operator surfaces.",
  },
  safe_self_improvement: {
    nativeAlternativeName: "Native memory maintenance",
    nativeDestination: "Observe > Artifacts > Memory",
    blockingReason: "GoatCitadel already has a native bounded memory-maintenance path for this family.",
  },
  skill_vetting: {
    nativeAlternativeName: "Native skill import trust posture",
    nativeDestination: "Configure > Agents > Skills",
    blockingReason: "GoatCitadel already ships native skill vetting and trust-governance for this family.",
  },
  multi_agent_swarm: {
    nativeAlternativeName: "Native orchestration and Herd surfaces",
    nativeDestination: "Operate > Cowork / Configure > Agents",
    blockingReason: "GoatCitadel already has a native orchestration direction for this family.",
  },
};

export class SkillImportService {
  public constructor(
    private readonly rootDir: string,
    private readonly systemSettings: SystemSettingsRepository,
  ) {}

  public async listSources(query?: string, limit = 25): Promise<SkillSourceListResponse> {
    const normalizedQuery = query?.trim().toLowerCase() || undefined;
    const { providers, items } = await this.collectSourceCatalog(Math.max(50, limit * 4));
    const merged = normalizedQuery
      ? rankSkillSourceItems(mergeSourceItems(items), normalizedQuery).slice(0, Math.max(1, Math.min(limit, 100)))
      : mergeSourceItems(items).slice(0, Math.max(1, Math.min(limit, 100)));
    const installedCanonicalKeys = this.readInstalledSourceCanonicalKeys();

    return {
      query: normalizedQuery,
      generatedAt: new Date().toISOString(),
      providers,
      items: merged.map((item) => ({
        ...item,
        alreadyInstalled: installedCanonicalKeys.has(item.canonicalKey),
      })),
    };
  }

  public async lookupSources(queryOrUrl: string, limit = 10): Promise<SkillSourceLookupResponse> {
    const query = queryOrUrl.trim();
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const generatedAt = new Date().toISOString();
    const installedCanonicalKeys = this.readInstalledSourceCanonicalKeys();
    if (!query) {
      return {
        query,
        generatedAt,
        providers: defaultLookupProviders(),
        items: [],
      };
    }

    const parsedSource = await resolveDirectSourceReference(query);
    if (parsedSource) {
      const item = mergeSourceItems([parsedSource.item]).map((candidate) => ({
        ...candidate,
        matchReason: candidate.matchReason ?? "Direct source match",
        matchedTerms: candidate.matchedTerms ?? [query],
        alreadyInstalled: installedCanonicalKeys.has(candidate.canonicalKey),
      }))[0];
      return {
        query,
        generatedAt,
        providers: defaultLookupProviders(),
        parsedSource: parsedSource.parsedSource,
        bestMatch: item,
        items: item ? [item] : [],
      };
    }

    const { providers, items } = await this.collectSourceCatalog(Math.max(60, boundedLimit * 5));
    const ranked = rankSkillSourceItems(mergeSourceItems(items), query)
      .slice(0, boundedLimit)
      .map((item) => ({
        ...item,
        alreadyInstalled: installedCanonicalKeys.has(item.canonicalKey),
      }));

    return {
      query,
      generatedAt,
      providers,
      bestMatch: ranked[0],
      items: ranked,
    };
  }

  public async validateImport(input: SkillImportInput): Promise<SkillImportValidationResult> {
    const importId = randomUUID();
    let materialized: MaterializedSkillSource | undefined;
    try {
      materialized = await this.materializeSkillSource(input);
      const validation = await this.validateMaterialized(materialized);
      this.appendHistory({
        importId,
        action: "validate",
        outcome: validation.valid ? "accepted" : "rejected",
        sourceProvider: validation.candidate.sourceProvider,
        sourceRef: validation.candidate.sourceRef,
        sourceType: validation.candidate.sourceType,
        canonicalKey: validation.candidate.canonicalKey,
        skillName: validation.inferredSkillName,
        skillId: validation.inferredSkillId,
        riskLevel: validation.riskLevel,
        details: {
          errors: validation.errors,
          warnings: validation.warnings,
        },
        createdAt: new Date().toISOString(),
      });
      return validation;
    } catch (error) {
      const sourceType = inferSourceType(input.sourceRef, input.sourceType);
      const sourceProvider = inferSourceProvider(input.sourceRef, input.sourceProvider);
      this.appendHistory({
        importId,
        action: "validate",
        outcome: "failed",
        sourceProvider,
        sourceRef: input.sourceRef,
        sourceType,
        canonicalKey: buildCanonicalKey({
          sourceProvider,
          sourceType,
          sourceRef: input.sourceRef,
        }),
        details: {
          error: (error as Error).message,
        },
        createdAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      await materialized?.cleanup?.().catch(() => undefined);
    }
  }

  public async installImport(input: SkillInstallInput): Promise<{
    validation: SkillImportValidationResult;
    installedPath: string;
    sourceManifestPath: string;
  }> {
    const importId = randomUUID();
    let materialized: MaterializedSkillSource | undefined;
    try {
      materialized = await this.materializeSkillSource(input);
      const validation = await this.validateMaterialized(materialized);
      if (!validation.valid) {
        this.appendHistory({
          importId,
          action: "install",
          outcome: "rejected",
          sourceProvider: validation.candidate.sourceProvider,
          sourceRef: validation.candidate.sourceRef,
          sourceType: validation.candidate.sourceType,
          canonicalKey: validation.candidate.canonicalKey,
          skillName: validation.inferredSkillName,
          skillId: validation.inferredSkillId,
          riskLevel: validation.riskLevel,
          details: {
            errors: validation.errors,
          },
          createdAt: new Date().toISOString(),
        });
        throw new Error(`Skill import validation failed: ${validation.errors.join("; ")}`);
      }
      if (validation.riskLevel === "high" && !input.confirmHighRisk) {
        this.appendHistory({
          importId,
          action: "install",
          outcome: "rejected",
          sourceProvider: validation.candidate.sourceProvider,
          sourceRef: validation.candidate.sourceRef,
          sourceType: validation.candidate.sourceType,
          canonicalKey: validation.candidate.canonicalKey,
          skillName: validation.inferredSkillName,
          skillId: validation.inferredSkillId,
          riskLevel: validation.riskLevel,
          details: {
            error: "high_risk_confirmation_required",
          },
          createdAt: new Date().toISOString(),
        });
        throw new Error("High-risk skill import requires explicit confirmation.");
      }

      const inferredId = validation.inferredSkillId || `import-${Date.now()}`;
      const installedPath = path.resolve(this.rootDir, "skills", "extra", inferredId);
      const targetExists = fsSync.existsSync(installedPath);
      if (targetExists && !input.force) {
        throw new Error(`Skill install target already exists: ${installedPath}`);
      }
      if (targetExists && input.force) {
        await fs.rm(installedPath, { recursive: true, force: true });
      }
      await fs.mkdir(path.dirname(installedPath), { recursive: true });
      await fs.cp(materialized.skillDir, installedPath, { recursive: true, force: Boolean(input.force) });

      const sourceManifestPath = path.join(installedPath, "source.json");
      const installedAt = new Date().toISOString();
      const duplicateFamily = deriveReviewPolicy({
        inferredSkillName: validation.inferredSkillName,
        sourceRef: validation.candidate.sourceRef,
      })?.duplicateFamily;
      const reviewDisposition = deriveReviewPolicy({
        inferredSkillName: validation.inferredSkillName,
        sourceRef: validation.candidate.sourceRef,
      })?.reviewDisposition;
      const curatedEntry = findCuratedSourceByUrl(validation.candidate.sourceRef);
      const resolvedUpstreamVersion =
        validation.candidate.sourceType === "git_url"
          ? await resolveGitHeadRevision(materialized.sourceDir).catch(() => undefined)
          : undefined;
      await fs.writeFile(
        sourceManifestPath,
        JSON.stringify(
          {
            manifestVersion: 2,
            installedAt,
            lastReviewedAt: installedAt,
            lastCheckedAt: installedAt,
            duplicateFamily,
            reviewDisposition,
            marketplaceListingUrl:
              curatedEntry?.sourceProvider === "clawhub" ||
              curatedEntry?.sourceProvider === "skillsmp" ||
              curatedEntry?.sourceProvider === "agentskill"
                ? curatedEntry.sourceUrl
                : undefined,
            resolvedUpstream: {
              url:
                validation.candidate.repositoryUrl ?? validation.candidate.sourceUrl ?? validation.candidate.sourceRef,
              ref: validation.candidate.sourceType === "git_url" ? "HEAD" : undefined,
              version: resolvedUpstreamVersion,
            },
            candidate: validation.candidate,
            riskLevel: validation.riskLevel,
            warnings: validation.warnings,
            checks: validation.checks,
          },
          null,
          2,
        ),
        "utf8",
      );

      this.appendHistory({
        importId,
        action: "install",
        outcome: "accepted",
        sourceProvider: validation.candidate.sourceProvider,
        sourceRef: validation.candidate.sourceRef,
        sourceType: validation.candidate.sourceType,
        canonicalKey: validation.candidate.canonicalKey,
        skillName: validation.inferredSkillName,
        skillId: validation.inferredSkillId,
        riskLevel: validation.riskLevel,
        details: {
          installedPath: path.relative(this.rootDir, installedPath).replaceAll("\\", "/"),
        },
        createdAt: new Date().toISOString(),
      });

      return {
        validation,
        installedPath,
        sourceManifestPath,
      };
    } catch (error) {
      const sourceType = inferSourceType(input.sourceRef, input.sourceType);
      const sourceProvider = inferSourceProvider(input.sourceRef, input.sourceProvider);
      this.appendHistory({
        importId,
        action: "install",
        outcome: "failed",
        sourceProvider,
        sourceRef: input.sourceRef,
        sourceType,
        canonicalKey: buildCanonicalKey({
          sourceProvider,
          sourceType,
          sourceRef: input.sourceRef,
        }),
        details: {
          error: (error as Error).message,
        },
        createdAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      await materialized?.cleanup?.().catch(() => undefined);
    }
  }

  public listHistory(limit = 100): SkillImportHistoryRecord[] {
    const rows = this.systemSettings.get<SkillImportHistoryRecord[]>(IMPORT_HISTORY_KEY)?.value ?? [];
    return rows.slice(0, Math.max(1, Math.min(limit, 300)));
  }

  private appendHistory(record: SkillImportHistoryRecord): void {
    const rows = this.systemSettings.get<SkillImportHistoryRecord[]>(IMPORT_HISTORY_KEY)?.value ?? [];
    this.systemSettings.set(IMPORT_HISTORY_KEY, [record, ...rows].slice(0, MAX_IMPORT_HISTORY));
  }

  private async collectSourceCatalog(limit: number): Promise<{
    providers: SkillSourceSearchRecord[];
    items: SkillSourceResultRecord[];
  }> {
    const boundedLimit = Math.max(25, Math.min(limit, 250));
    const providerResults = await Promise.all([
      this.searchProvider("agentskill", boundedLimit),
      this.searchProvider("skillsmp", boundedLimit),
    ]);
    return {
      providers: [...providerResults.map((item) => item.providerStatus), ...defaultLookupProviders()],
      items: [...providerResults.flatMap((item) => item.items), ...FALLBACK_SOURCE_ITEMS],
    };
  }

  private readInstalledSourceCanonicalKeys(): Set<string> {
    const keys = new Set<string>();
    const extraRoot = path.resolve(this.rootDir, "skills", "extra");
    if (!fsSync.existsSync(extraRoot)) {
      return keys;
    }
    for (const entry of fsSync.readdirSync(extraRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const sourceManifestPath = path.join(extraRoot, entry.name, "source.json");
      if (!fsSync.existsSync(sourceManifestPath)) {
        continue;
      }
      try {
        const parsed = JSON.parse(fsSync.readFileSync(sourceManifestPath, "utf8")) as {
          candidate?: { canonicalKey?: string; sourceRef?: string; repositoryUrl?: string; sourceUrl?: string };
        };
        const candidate = parsed.candidate;
        if (candidate?.canonicalKey) {
          keys.add(candidate.canonicalKey);
        }
        const repoRef = candidate?.repositoryUrl ?? candidate?.sourceUrl ?? candidate?.sourceRef;
        if (repoRef) {
          const normalized = normalizeRepoReference(repoRef);
          if (normalized) {
            keys.add(normalized);
          }
        }
      } catch {
        // Ignore malformed import manifests during source lookup.
      }
    }
    return keys;
  }

  private findDuplicateInstallMatches(input: {
    canonicalKey: string;
    duplicateFamily?: string;
    inferredSkillId?: string;
  }): SkillInstallDuplicateMatch[] {
    const matches: SkillInstallDuplicateMatch[] = [];
    const extraRoot = path.resolve(this.rootDir, "skills", "extra");
    if (fsSync.existsSync(extraRoot)) {
      for (const entry of fsSync.readdirSync(extraRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (input.inferredSkillId && entry.name === input.inferredSkillId) {
          continue;
        }
        const sourceManifestPath = path.join(extraRoot, entry.name, "source.json");
        if (!fsSync.existsSync(sourceManifestPath)) {
          continue;
        }
        try {
          const parsed = JSON.parse(fsSync.readFileSync(sourceManifestPath, "utf8")) as InstalledSkillSourceManifest;
          const manifestFamily =
            parsed.duplicateFamily ??
            deriveReviewPolicy({
              inferredSkillName: entry.name,
              sourceRef:
                parsed.candidate?.sourceRef ??
                parsed.candidate?.repositoryUrl ??
                parsed.candidate?.sourceUrl ??
                entry.name,
            })?.duplicateFamily;
          if (parsed.candidate?.canonicalKey && parsed.candidate.canonicalKey === input.canonicalKey) {
            matches.push({
              scope: "extra",
              identifier: `skills/extra/${entry.name}`,
              canonicalKey: parsed.candidate.canonicalKey,
              duplicateFamily: manifestFamily,
            });
            continue;
          }
          if (input.duplicateFamily && manifestFamily === input.duplicateFamily) {
            matches.push({
              scope: "extra",
              identifier: `skills/extra/${entry.name}`,
              canonicalKey: parsed.candidate?.canonicalKey,
              duplicateFamily: manifestFamily,
            });
          }
        } catch {
          // Ignore malformed manifests when checking duplicate installs.
        }
      }
    }

    const bundledMatches = findBundledDuplicateMatches(this.rootDir, input.duplicateFamily);
    return [...matches, ...bundledMatches];
  }

  private async searchProvider(
    provider: "agentskill" | "skillsmp",
    limit: number,
  ): Promise<{ providerStatus: SkillSourceSearchRecord; items: SkillSourceResultRecord[] }> {
    const started = Date.now();
    const providerLabel = provider === "agentskill" ? "AgentSkill" : "SkillsMP";
    const targetUrl = provider === "agentskill" ? "https://agentskill.sh/" : "https://skillsmp.com/";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);
      const response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "user-agent": "GoatCitadel/1.0.0",
        },
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const html = await response.text();
      const items = extractMarketplaceLinks(provider, html)
        .map((url) => ({
          sourceProvider: provider,
          sourceUrl: url,
          name: humanizeSkillName(url),
          description: `${providerLabel} listing candidate`,
          tags: deriveListingTags(url, provider),
          sourceKind: "marketplace_listing" as const,
          installability: "review_only" as const,
          installHint:
            "Review the listing provenance and use the upstream repository or validated local source for installation.",
          skillFamily: deriveSkillFamilyFromUrl(url),
        }))
        .slice(0, Math.max(1, Math.min(limit, 100)));

      return {
        providerStatus: {
          provider,
          providerLabel,
          available: true,
          status: "ok",
          latencyMs: Date.now() - started,
        },
        items,
      };
    } catch (error) {
      const fallbackItems = FALLBACK_SOURCE_ITEMS.filter((item) => item.sourceProvider === provider).slice(
        0,
        Math.max(1, Math.min(limit, 100)),
      );
      return {
        providerStatus: {
          provider,
          providerLabel,
          available: fallbackItems.length > 0,
          status: fallbackItems.length > 0 ? "degraded" : "unavailable",
          error: (error as Error).message,
          latencyMs: Date.now() - started,
        },
        items: fallbackItems,
      };
    }
  }

  private async materializeSkillSource(input: SkillImportInput): Promise<MaterializedSkillSource> {
    const sourceType = inferSourceType(input.sourceRef, input.sourceType);
    const sourceProvider = inferSourceProvider(input.sourceRef, input.sourceProvider);
    const sourceRef = input.sourceRef.trim();
    if (!sourceRef) {
      throw new Error("sourceRef is required");
    }
    if (isMarketplaceListingUrl(sourceRef)) {
      throw new Error(
        "Marketplace listing URLs are reference-only. Use skill lookup to find the upstream repository or validated source before importing.",
      );
    }
    const curatedEntry = findCuratedSourceByUrl(sourceRef);
    if (curatedEntry?.installability === "not_installable") {
      throw new Error(
        `This source is not installable: ${curatedEntry.name}. ${curatedEntry.installHint ?? "Review the hosted instructions directly instead of importing."}`,
      );
    }

    if (sourceType === "local_path") {
      const sourceDir = path.resolve(sourceRef);
      const stat = await fs.stat(sourceDir).catch(() => undefined);
      if (!stat || !stat.isDirectory()) {
        throw new Error(`Local source path is not a directory: ${sourceDir}`);
      }
      const skillDir = await resolveSkillDir(sourceDir);
      return {
        sourceDir,
        skillDir,
        skillFilePath: path.join(skillDir, "SKILL.md"),
        candidate: {
          sourceProvider,
          sourceType,
          sourceRef,
          canonicalKey: buildCanonicalKey({
            sourceProvider,
            sourceType,
            sourceRef,
          }),
          skillRootPath: skillDir,
        },
      };
    }

    if (sourceType === "local_zip") {
      const zipPath = path.resolve(sourceRef);
      const stat = await fs.stat(zipPath).catch(() => undefined);
      if (!stat || !stat.isFile()) {
        throw new Error(`Local zip path is not a file: ${zipPath}`);
      }
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skill-zip-"));
      const extracted = path.join(tempRoot, "extracted");
      await fs.mkdir(extracted, { recursive: true });
      await extractZip(zipPath, extracted);
      const skillDir = await resolveSkillDir(extracted);
      return {
        sourceDir: extracted,
        skillDir,
        skillFilePath: path.join(skillDir, "SKILL.md"),
        candidate: {
          sourceProvider,
          sourceType,
          sourceRef,
          canonicalKey: buildCanonicalKey({
            sourceProvider,
            sourceType,
            sourceRef,
          }),
          skillRootPath: skillDir,
        },
        cleanup: async () => {
          await fs.rm(tempRoot, { recursive: true, force: true });
        },
      };
    }

    if (sourceType === "remote_bundle") {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skill-remote-"));
      const bundleDir = path.join(tempRoot, "bundle");
      await fs.mkdir(bundleDir, { recursive: true });
      try {
        await materializeHostedSkillBundle(sourceRef, bundleDir);
      } catch (error) {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return {
        sourceDir: bundleDir,
        skillDir: bundleDir,
        skillFilePath: path.join(bundleDir, "SKILL.md"),
        candidate: {
          sourceProvider,
          sourceType,
          sourceRef,
          sourceUrl: sourceRef,
          canonicalKey: buildCanonicalKey({
            sourceProvider,
            sourceType,
            sourceRef,
            sourceUrl: sourceRef,
          }),
          skillRootPath: bundleDir,
        },
        cleanup: async () => {
          await fs.rm(tempRoot, { recursive: true, force: true });
        },
      };
    }

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skill-git-"));
    const cloneDir = path.join(tempRoot, "repo");
    try {
      await execFileAsync("git", ["clone", "--depth", "1", sourceRef, cloneDir], {
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`Failed to clone git source: ${(error as Error).message}`, { cause: error });
    }
    const skillDir = await resolveSkillDir(cloneDir);
    return {
      sourceDir: cloneDir,
      skillDir,
      skillFilePath: path.join(skillDir, "SKILL.md"),
      candidate: {
        sourceProvider,
        sourceType,
        sourceRef,
        repositoryUrl: sourceRef,
        canonicalKey: buildCanonicalKey({
          sourceProvider,
          sourceType,
          sourceRef,
        }),
        skillRootPath: skillDir,
      },
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      },
    };
  }

  private async validateMaterialized(source: MaterializedSkillSource): Promise<SkillImportValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let inferredSkillName: string | undefined;
    let inferredSkillId: string | undefined;
    let declaredTools: string[] = [];
    let requires: string[] = [];
    let instructionPreview = "";
    let frontmatterValid = false;
    let descriptionQuality = false;

    try {
      const rawSkill = await fs.readFile(source.skillFilePath, "utf8");
      const parsed = parseSkillMarkdown(rawSkill);
      frontmatterValid = true;
      inferredSkillName = parsed.frontmatter.name.trim();
      inferredSkillId = normalizeSkillId(parsed.frontmatter.name);
      declaredTools = parsed.frontmatter.metadata?.tools ?? [];
      requires = parsed.frontmatter.metadata?.requires ?? [];
      descriptionQuality =
        parsed.frontmatter.description.trim().length >= 24 &&
        parsed.frontmatter.description.trim().split(/\s+/).length >= 4;
      if (!descriptionQuality) {
        warnings.push("Description is very short; quality score reduced.");
      }
      instructionPreview = parsed.body.slice(0, 500);
    } catch (error) {
      errors.push(`Invalid SKILL.md: ${(error as Error).message}`);
    }

    const scan = await scanSkillDirectory(source.skillDir);
    const suspiciousScripts = scan.suspiciousSignals.length > 0;
    const networkIndicators = scan.networkSignals.length > 0;
    const licenseDetected = scan.licenseFiles.length > 0;
    const scanIncomplete = scan.skippedLargeFiles.length > 0 || scan.truncated;

    if (suspiciousScripts) {
      warnings.push("Potentially risky script indicators detected.");
    }
    if (networkIndicators) {
      warnings.push("Network usage indicators detected in skill files.");
    }
    if (scan.skippedLargeFiles.length > 0) {
      warnings.push(`Security scan skipped large files: ${summarizePathList(scan.skippedLargeFiles)}.`);
    }
    if (scan.truncated) {
      warnings.push("Security scan reached the file inspection limit; review the remaining files manually.");
    }
    if (!licenseDetected) {
      warnings.push("No license file detected.");
    }

    const reviewPolicy = deriveReviewPolicy({
      inferredSkillName,
      sourceRef: source.candidate.sourceRef,
    });
    const nativeOverlaps = buildNativeOverlapRecords(reviewPolicy?.duplicateFamily);
    if (reviewPolicy?.message) {
      if (reviewPolicy.reviewDisposition === "reject") {
        errors.push(reviewPolicy.message);
      } else {
        warnings.push(reviewPolicy.message);
      }
    }
    const duplicateMatches = this.findDuplicateInstallMatches({
      canonicalKey: source.candidate.canonicalKey,
      duplicateFamily: reviewPolicy?.duplicateFamily,
      inferredSkillId,
    });
    if (duplicateMatches.length > 0) {
      errors.push(buildDuplicateInstallMessage(duplicateMatches, reviewPolicy?.duplicateFamily));
    } else if (nativeOverlaps?.length) {
      const nativeOverlap = nativeOverlaps[0];
      if (nativeOverlap) {
        errors.push(
          `${nativeOverlap.blockingReason} Use ${nativeOverlap.nativeAlternativeName} at ${nativeOverlap.nativeDestination} instead.`,
        );
      }
    }
    const riskLevel = deriveRiskLevel({
      suspiciousScripts,
      networkIndicators,
      scanIncomplete,
      descriptionQuality,
      valid: errors.length === 0,
    });

    return {
      valid: errors.length === 0,
      riskLevel,
      reviewDisposition: reviewPolicy?.reviewDisposition,
      reviewMessage: reviewPolicy?.message,
      errors,
      warnings,
      checks: {
        frontmatterValid,
        descriptionQuality,
        suspiciousScripts,
        networkIndicators,
        licenseDetected,
      },
      candidate: source.candidate,
      inferredSkillName,
      inferredSkillId,
      installPath: inferredSkillId ? `skills/extra/${inferredSkillId}` : undefined,
      declaredTools,
      requires,
      networkSignals: scan.networkSignals,
      suspiciousSignals: scan.suspiciousSignals,
      licenseFiles: scan.licenseFiles,
      instructionPreview,
      nativeOverlaps,
    };
  }
}

function defaultLookupProviders(): SkillSourceSearchRecord[] {
  return [
    {
      provider: "local",
      providerLabel: "Local",
      available: true,
      status: "ok",
    },
    {
      provider: "github",
      providerLabel: "GitHub",
      available: true,
      status: "ok",
    },
    {
      provider: "clawhub",
      providerLabel: "ClawHub",
      available: true,
      status: "ok",
    },
    {
      provider: "external",
      providerLabel: "External",
      available: true,
      status: "ok",
    },
  ];
}

function rankSkillSourceItems(items: SkillMergedSourceResult[], query: string): SkillMergedSourceResult[] {
  const normalizedQuery = normalizeLookupText(query);
  const queryTokens = tokenizeLookupText(query);
  const ranked: SkillMergedSourceResult[] = [];
  for (const item of items) {
    const index = buildLookupIndex(item);
    const matchedTerms = queryTokens.filter((token) => index.expandedTokens.has(token));
    let score = item.combinedScore * 100;
    let matchReason = "";
    if (
      [item.sourceUrl, item.repositoryUrl, item.upstreamUrl]
        .filter((value): value is string => Boolean(value))
        .some((value) => normalizeLookupText(value) === normalizedQuery)
    ) {
      score += 1000;
      matchReason = "Direct source match";
    } else if (index.normalizedName === normalizedQuery || index.slug === normalizedQuery) {
      score += 800;
      matchReason = "Exact name match";
    } else if (queryTokens.length > 0 && queryTokens.every((token) => index.expandedTokens.has(token))) {
      score += 500;
      matchReason = "Capability match";
    } else if (matchedTerms.length > 0) {
      const nameHits = matchedTerms.filter((token) => index.nameTokens.has(token)).length;
      const tagHits = matchedTerms.filter((token) => index.tagTokens.has(token)).length;
      if (nameHits > 0) {
        score += 250 + nameHits * 25;
        matchReason = "Name match";
      } else if (tagHits > 0) {
        score += 180 + tagHits * 20;
        matchReason = "Tag/capability match";
      } else {
        score += 120 + matchedTerms.length * 15;
        matchReason = "Description match";
      }
    }
    if (!matchReason) {
      continue;
    }
    ranked.push({
      ...item,
      skillFamily: item.skillFamily ?? index.skillFamily,
      matchReason,
      matchedTerms: matchedTerms.slice(0, 8),
      combinedScore: Number((score / 1000).toFixed(3)),
    });
  }

  return ranked.sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) {
      return b.combinedScore - a.combinedScore;
    }
    return a.name.localeCompare(b.name);
  });
}

async function resolveDirectSourceReference(query: string): Promise<
  | {
      parsedSource: SkillSourceLookupParsedSource;
      item: SkillSourceResultRecord;
    }
  | undefined
> {
  const trimmed = query.trim();
  if (!trimmed) {
    return undefined;
  }
  const curatedMatch = findCuratedSourceByUrl(trimmed);
  if (curatedMatch) {
    return {
      parsedSource: {
        sourceProvider: curatedMatch.sourceProvider,
        sourceKind: curatedMatch.sourceKind ?? "reference",
        sourceUrl: curatedMatch.sourceUrl,
        upstreamUrl: curatedMatch.upstreamUrl,
        repositoryUrl: curatedMatch.repositoryUrl,
        installability: curatedMatch.installability ?? "review_only",
      },
      item: {
        ...curatedMatch,
        matchReason: curatedMatch.matchReason ?? "Direct source match",
        matchedTerms: curatedMatch.matchedTerms ?? [trimmed],
      },
    };
  }
  if (isGitHubUrl(trimmed)) {
    const provider: SkillSourceProvider = "github";
    return {
      parsedSource: {
        sourceProvider: provider,
        sourceKind: "upstream_repo",
        sourceUrl: trimmed,
        repositoryUrl: trimmed,
        upstreamUrl: trimmed,
        installability: "direct",
      },
      item: {
        sourceProvider: provider,
        sourceUrl: trimmed,
        repositoryUrl: trimmed,
        upstreamUrl: trimmed,
        name: humanizeSkillName(trimmed),
        description: "Direct GitHub skill source.",
        tags: deriveListingTags(trimmed, provider),
        sourceKind: "upstream_repo",
        installability: "direct",
        installHint: "Validate this repository directly before installing.",
        matchReason: "Direct source match",
        matchedTerms: [trimmed],
        skillFamily: deriveSkillFamilyFromUrl(trimmed),
      },
    };
  }

  if (isHostedSkillBundleUrl(trimmed)) {
    const provider = inferSourceProvider(trimmed);
    return {
      parsedSource: {
        sourceProvider: provider,
        sourceKind: "reference",
        sourceUrl: trimmed,
        upstreamUrl: trimmed,
        installability: "direct",
      },
      item: {
        sourceProvider: provider,
        sourceUrl: trimmed,
        upstreamUrl: trimmed,
        name: humanizeSkillName(trimmed),
        description: "Direct hosted SKILL.md bundle.",
        tags: ["skill", "hosted", "bundle"],
        sourceKind: "reference",
        installability: "direct",
        installHint: "GoatCitadel can import this hosted skill bundle directly.",
        matchReason: "Direct source match",
        matchedTerms: [trimmed],
      },
    };
  }

  if (isMarketplaceListingUrl(trimmed)) {
    const provider = inferSourceProvider(trimmed);
    const providerLabel = getProviderLabel(provider);
    const upstreamUrl = await resolveMarketplaceUpstream(trimmed);
    return {
      parsedSource: {
        sourceProvider: provider,
        sourceKind: "marketplace_listing",
        sourceUrl: trimmed,
        upstreamUrl,
        repositoryUrl: upstreamUrl,
        installability: "review_only",
      },
      item: {
        sourceProvider: provider,
        sourceUrl: trimmed,
        repositoryUrl: upstreamUrl,
        upstreamUrl,
        name: humanizeSkillName(trimmed),
        description: `${providerLabel} listing reference.`,
        tags: deriveListingTags(trimmed, provider),
        sourceKind: "marketplace_listing",
        installability: "review_only",
        installHint: upstreamUrl
          ? "Review the listing provenance, then validate the upstream repository before installing."
          : "Review the listing and resolve the upstream repository before installing.",
        matchReason: "Direct listing match",
        matchedTerms: [trimmed],
        skillFamily: deriveSkillFamilyFromUrl(trimmed),
      },
    };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return {
      parsedSource: {
        sourceProvider: inferSourceProvider(trimmed),
        sourceKind: "reference",
        sourceUrl: trimmed,
        installability: "review_only",
      },
      item: {
        sourceProvider: inferSourceProvider(trimmed),
        sourceUrl: trimmed,
        name: humanizeSkillName(trimmed),
        description: "Reference-only skill source URL.",
        tags: ["reference"],
        sourceKind: "reference",
        installability: "review_only",
        installHint: "Review the source provenance and use a direct repository, local path, or zip before installing.",
        matchReason: "Direct source match",
        matchedTerms: [trimmed],
      },
    };
  }

  if (looksLikeLocalSource(trimmed)) {
    const sourceType = inferSourceType(trimmed);
    const sourceUrl = trimmed.replaceAll("\\", "/");
    return {
      parsedSource: {
        sourceProvider: "local",
        sourceKind: "local",
        sourceUrl,
        installability: "direct",
      },
      item: {
        sourceProvider: "local",
        sourceUrl,
        name: sourceType === "local_zip" ? "Local zip skill source" : "Local skill source",
        description: "Local skill import source.",
        tags: sourceType === "local_zip" ? ["local", "zip"] : ["local", "path"],
        sourceKind: "local",
        installability: "direct",
        installHint: "Validate this local source directly before installing.",
        matchReason: "Direct source match",
        matchedTerms: [trimmed],
      },
    };
  }

  return undefined;
}

function inferSourceType(sourceRef: string, explicit?: SkillImportSourceType): SkillImportSourceType {
  if (explicit) {
    return explicit;
  }
  const trimmed = sourceRef.trim();
  if (isHostedSkillBundleUrl(trimmed)) {
    return "remote_bundle";
  }
  if (parseSkillSourceLocation(trimmed)) {
    return "git_url";
  }
  if (trimmed.toLowerCase().endsWith(".zip")) {
    return "local_zip";
  }
  return "local_path";
}

function inferSourceProvider(sourceRef: string, explicit?: SkillSourceProvider): SkillSourceProvider {
  if (explicit) {
    return explicit;
  }
  const sourceLocation = parseSkillSourceLocation(sourceRef.trim());
  const host = sourceLocation?.host;
  if (host === "agentskill.sh") {
    return "agentskill";
  }
  if (host === "skillsmp.com") {
    return "skillsmp";
  }
  if (host === "clawhub.ai") {
    return "clawhub";
  }
  if (host === "github.com") {
    return "github";
  }
  if (host === "animalhouse.ai") {
    return "external";
  }
  if (sourceLocation) {
    return "external";
  }
  return "local";
}

function buildCanonicalKey(input: {
  sourceProvider: SkillSourceProvider;
  sourceType: SkillImportSourceType;
  sourceRef: string;
  sourceUrl?: string;
  repositoryUrl?: string;
}): string {
  const repo = input.repositoryUrl ?? input.sourceUrl ?? input.sourceRef;
  const normalizedRepo = normalizeRepoReference(repo);
  if (normalizedRepo) {
    return normalizedRepo;
  }
  const hash = createHash("sha1").update(input.sourceRef).digest("hex").slice(0, 12);
  return `${input.sourceProvider}:${input.sourceType}:${hash}`;
}

function normalizeRepoReference(value: string): string | undefined {
  const sourceLocation = parseSkillSourceLocation(value);
  if (!sourceLocation) {
    return undefined;
  }
  const cleaned = normalizeHostedRepoPath(sourceLocation.path);
  if (!cleaned) {
    return undefined;
  }
  return `${sourceLocation.host}/${cleaned}`;
}

function parseSkillSourceLocation(value: string): { kind: "url" | "ssh"; host: string; path: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed.replace(/^git\+/i, "");
  try {
    const url = new URL(sanitized);
    if (!["http:", "https:", "ssh:"].includes(url.protocol)) {
      return undefined;
    }
    return {
      kind: "url",
      host: url.hostname.toLowerCase(),
      path: url.pathname,
    };
  } catch {
    const sshMatch = /^(?:[^@\s]+)@([^:\s]+):(.+)$/.exec(trimmed);
    const host = sshMatch?.[1];
    const path = sshMatch?.[2];
    if (!host || !path) {
      return undefined;
    }
    return {
      kind: "ssh",
      host: host.toLowerCase(),
      path,
    };
  }
}

function normalizeHostedRepoPath(value: string): string | undefined {
  const cleaned = value
    .split(/[?#]/, 1)[0]
    ?.replace(/\.git$/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return cleaned || undefined;
}

function mergeSourceItems(items: SkillSourceResultRecord[]): SkillMergedSourceResult[] {
  const merged = new Map<string, SkillMergedSourceResult>();
  for (const item of items) {
    const canonicalKey = buildCanonicalKey({
      sourceProvider: item.sourceProvider,
      sourceType: "git_url",
      sourceRef: item.repositoryUrl ?? item.sourceUrl,
      sourceUrl: item.sourceUrl,
      repositoryUrl: item.repositoryUrl,
    });
    const qualityScore = scoreQuality(item);
    const freshnessScore = scoreFreshness(item.updatedAt);
    const trustScore = scoreTrust(item.sourceProvider, item.repositoryUrl);
    const combinedScore = Number((qualityScore * 0.4 + freshnessScore * 0.25 + trustScore * 0.35).toFixed(3));

    const existing = merged.get(canonicalKey);
    if (!existing) {
      merged.set(canonicalKey, {
        ...item,
        canonicalKey,
        alternateProviders: [],
        qualityScore,
        freshnessScore,
        trustScore,
        combinedScore,
      });
      continue;
    }

    const nextProviders = new Set<SkillSourceProvider>([
      existing.sourceProvider,
      ...existing.alternateProviders,
      item.sourceProvider,
    ]);
    const nextPrimary =
      existing.combinedScore >= combinedScore
        ? existing
        : {
            ...existing,
            ...item,
            qualityScore,
            freshnessScore,
            trustScore,
            combinedScore,
          };
    nextPrimary.alternateProviders = [...nextProviders].filter((provider) => provider !== nextPrimary.sourceProvider);
    merged.set(canonicalKey, nextPrimary);
  }

  return [...merged.values()].sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) {
      return b.combinedScore - a.combinedScore;
    }
    return a.name.localeCompare(b.name);
  });
}

function scoreQuality(item: SkillSourceResultRecord): number {
  let score = 0.4;
  if (item.description.trim().length >= 40) {
    score += 0.2;
  }
  if (item.tags.length >= 2) {
    score += 0.15;
  }
  if (item.repositoryUrl) {
    score += 0.2;
  }
  if (item.name.trim().length >= 6) {
    score += 0.05;
  }
  return Number(Math.min(1, score).toFixed(3));
}

function scoreFreshness(updatedAt: string | undefined): number {
  if (!updatedAt) {
    return 0.45;
  }
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return 0.45;
  }
  const ageDays = Math.max(0, (Date.now() - updatedMs) / 86_400_000);
  if (ageDays <= 30) {
    return 1;
  }
  if (ageDays <= 90) {
    return 0.8;
  }
  if (ageDays <= 180) {
    return 0.6;
  }
  return 0.4;
}

function scoreTrust(provider: SkillSourceProvider, repositoryUrl?: string): number {
  let score =
    provider === "local"
      ? 0.95
      : provider === "github"
        ? 0.75
        : provider === "clawhub"
          ? 0.7
          : provider === "external"
            ? 0.6
            : 0.65;
  if (repositoryUrl && /github\.com/i.test(repositoryUrl)) {
    score += 0.1;
  }
  return Number(Math.min(1, score).toFixed(3));
}

function humanizeSkillName(url: string): string {
  try {
    const parsed = new URL(url);
    const pieces = parsed.pathname.split("/").filter(Boolean);
    const slug = pieces[pieces.length - 1] || "skill";
    return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return "Skill";
  }
}

function deriveListingTags(url: string, provider: SkillSourceProvider): string[] {
  const tokens = new Set<string>([provider]);
  for (const token of tokenizeLookupText(humanizeSkillName(url))) {
    tokens.add(token);
  }
  const family = deriveSkillFamilyFromUrl(url);
  if (family) {
    tokens.add(family);
    const familyTerms = LOOKUP_FAMILY_TERMS.find((item) => item.family === family)?.tokens ?? [];
    for (const token of familyTerms) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function deriveSkillFamilyFromUrl(url: string): string | undefined {
  const normalized = normalizeLookupText(url);
  return LOOKUP_FAMILY_TERMS.find((family) => family.tokens.some((token) => normalized.includes(token)))?.family;
}

function normalizeLookupText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLookupText(value: string): string[] {
  return normalizeLookupText(value).split(" ").filter(Boolean);
}

function buildLookupIndex(item: SkillSourceResultRecord): {
  normalizedName: string;
  slug: string;
  nameTokens: Set<string>;
  tagTokens: Set<string>;
  expandedTokens: Set<string>;
  skillFamily?: string;
} {
  const nameTokens = new Set(tokenizeLookupText(item.name));
  const descriptionTokens = tokenizeLookupText(item.description);
  const tagTokens = new Set(item.tags.flatMap((tag) => tokenizeLookupText(tag)));
  const urlTokens = [
    ...tokenizeLookupText(item.sourceUrl),
    ...tokenizeLookupText(item.repositoryUrl ?? ""),
    ...tokenizeLookupText(item.upstreamUrl ?? ""),
  ];
  const expandedTokens = new Set<string>([...nameTokens, ...descriptionTokens, ...tagTokens, ...urlTokens]);
  let skillFamily = item.skillFamily;
  for (const family of LOOKUP_FAMILY_TERMS) {
    if (family.tokens.some((token) => expandedTokens.has(token))) {
      skillFamily ??= family.family;
      for (const token of family.tokens) {
        expandedTokens.add(token);
      }
    }
  }
  return {
    normalizedName: normalizeLookupText(item.name),
    slug: humanizeSkillName(item.sourceUrl).toLowerCase().replace(/\s+/g, " "),
    nameTokens,
    tagTokens,
    expandedTokens,
    skillFamily,
  };
}

function deriveReviewPolicy(input: { inferredSkillName?: string; sourceRef: string }):
  | {
      duplicateFamily?: string;
      reviewDisposition: "allow" | "conditional" | "reference_only" | "reject";
      message: string;
    }
  | undefined {
  const haystack = `${input.inferredSkillName ?? ""} ${input.sourceRef}`.trim();
  for (const entry of REVIEW_POLICY_HINTS) {
    if (entry.pattern.test(haystack)) {
      return {
        duplicateFamily: entry.duplicateFamily,
        reviewDisposition: entry.reviewDisposition,
        message: entry.message,
      };
    }
  }
  return undefined;
}

function buildDuplicateInstallMessage(matches: SkillInstallDuplicateMatch[], duplicateFamily?: string): string {
  const locations = matches.map((match) => match.identifier).join(", ");
  const nativeOverlap = duplicateFamily ? NATIVE_OVERLAP_HINTS[duplicateFamily] : undefined;
  if (nativeOverlap) {
    return `${nativeOverlap.blockingReason} Use ${nativeOverlap.nativeAlternativeName} at ${nativeOverlap.nativeDestination} instead of importing this family from ${locations}.`;
  }
  if (duplicateFamily) {
    return `Duplicate skill family "${duplicateFamily}" is already present in ${locations}. Keep only one repo-managed install for that family.`;
  }
  return `An equivalent repo-managed skill source is already present in ${locations}.`;
}

function findBundledDuplicateMatches(rootDir: string, duplicateFamily?: string): SkillInstallDuplicateMatch[] {
  if (!duplicateFamily) {
    return [];
  }
  const bundledMatches: Array<{ family: string; identifier: string }> = [
    {
      family: "safe_self_improvement",
      identifier: "skills/bundled/goatcitadel-native-safe-self-improvement",
    },
    {
      family: "skill_vetting",
      identifier: "skills/bundled/mcp-vetter",
    },
  ];
  return bundledMatches
    .filter((item) => item.family === duplicateFamily && fsSync.existsSync(path.resolve(rootDir, item.identifier)))
    .map((item) => ({
      scope: "bundled" as const,
      identifier: item.identifier,
      duplicateFamily: item.family,
    }));
}

function buildNativeOverlapRecords(duplicateFamily?: string) {
  if (!duplicateFamily) {
    return undefined;
  }
  const overlap = NATIVE_OVERLAP_HINTS[duplicateFamily];
  if (!overlap) {
    return undefined;
  }
  return [
    {
      overlapFamily: duplicateFamily,
      nativeAlternativeName: overlap.nativeAlternativeName,
      nativeDestination: overlap.nativeDestination,
      blockingReason: overlap.blockingReason,
    },
  ];
}

async function resolveGitHeadRevision(repoDir: string): Promise<string | undefined> {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    windowsHide: true,
  });
  const stdout = String(result.stdout ?? "").trim();
  return stdout || undefined;
}

// SECURITY (codex finding #14): The marketplace allowlist is the security
// boundary that prevents `lookupSkillSources` from being used as an
// authenticated SSRF primitive. Compare against `URL.host` exactly — never
// against substrings of the request — so attacker-supplied URLs like
// `http://127.0.0.1:2375/version?x=https://skillsmp.com/` cannot satisfy the
// check.
const MARKETPLACE_HOSTS = new Set<string>([
  "skillsmp.com",
  "www.skillsmp.com",
  "agentskill.sh",
  "www.agentskill.sh",
  "clawhub.ai",
  "www.clawhub.ai",
]);

async function resolveMarketplaceUpstream(sourceUrl: string): Promise<string | undefined> {
  try {
    const parsed = new URL(sourceUrl);
    if (!MARKETPLACE_HOSTS.has(parsed.host.toLowerCase())) {
      return undefined;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    const response = await fetchAllowlisted(parsed.toString(), {
      allowlist: [...MARKETPLACE_HOSTS],
      timeoutMs: 9000,
      init: {
        headers: {
          "user-agent": "GoatCitadel/1.0.0",
        },
      },
    });
    if (!response.ok) {
      return undefined;
    }
    const html = await response.text();
    const match = html.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/tree\/[^\s"'<>]+)?/i);
    return match?.[0];
  } catch {
    return undefined;
  }
}

function isGitHubUrl(value: string): boolean {
  return /github\.com\//i.test(value) || /^git@github\.com:/i.test(value);
}

function isHostedSkillBundleUrl(value: string): boolean {
  return /^https?:\/\/.+\/skill\.md(?:[?#].*)?$/i.test(value.trim());
}

function isMarketplaceListingUrl(value: string): boolean {
  // SECURITY (codex finding #14): Parse the value as a URL and check the
  // exact host against `MARKETPLACE_HOSTS`. Previously this used an
  // unanchored substring regex (`/https?:\/\/(...)\//i.test(value)`) which
  // matched any input containing a marketplace URL anywhere — including
  // `http://127.0.0.1:2375/version?x=https://skillsmp.com/`, turning the
  // skill-lookup endpoint into a SSRF primitive against the Docker socket
  // and other internal services.
  try {
    const parsed = new URL(value.trim());
    return MARKETPLACE_HOSTS.has(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

// Test-only export for skill-import.marketplace-host.security.test.ts.
export const __isMarketplaceListingUrlForTests = isMarketplaceListingUrl;

async function materializeHostedSkillBundle(sourceUrl: string, targetDir: string): Promise<void> {
  const bundleUrl = new URL(sourceUrl);
  const baseUrl = new URL(".", bundleUrl);
  let primaryFetched = false;

  for (const file of HOSTED_SKILL_BUNDLE_FILES) {
    const fileUrl = new URL(file.remoteName, baseUrl);
    try {
      const response = await fetchHostedSkillBundleFile(fileUrl.toString());
      if (!response.ok) {
        if (file.required) {
          throw new Error(`HTTP ${response.status}`);
        }
        continue;
      }
      const content = await response.text();
      await fs.writeFile(path.join(targetDir, file.localName), content, "utf8");
      if (file.required) {
        primaryFetched = true;
      }
    } catch (error) {
      if (file.required) {
        throw new Error(`Failed to fetch hosted skill bundle file ${file.localName}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  }

  if (!primaryFetched) {
    throw new Error(`Hosted skill bundle is missing required SKILL.md content: ${sourceUrl}`);
  }
}

async function fetchHostedSkillBundleFile(url: string): Promise<Response> {
  return fetchAllowlisted(url, {
    allowlist: ["*"],
    timeoutMs: 9000,
    init: {
      headers: {
        "user-agent": "GoatCitadel/1.0.0",
      },
    },
  });
}

function getProviderLabel(provider: SkillSourceProvider): string {
  switch (provider) {
    case "agentskill":
      return "AgentSkill";
    case "skillsmp":
      return "SkillsMP";
    case "clawhub":
      return "ClawHub";
    case "github":
      return "GitHub";
    case "external":
      return "External";
    case "local":
    default:
      return "Local";
  }
}

function findCuratedSourceByUrl(value: string): SkillSourceResultRecord | undefined {
  const normalized = normalizeLookupText(value);
  return FALLBACK_SOURCE_ITEMS.find((item) =>
    [item.sourceUrl, item.upstreamUrl, item.repositoryUrl]
      .filter((candidate): candidate is string => Boolean(candidate))
      .some((candidate) => normalizeLookupText(candidate) === normalized),
  );
}

function looksLikeLocalSource(value: string): boolean {
  return (
    value.endsWith(".zip") ||
    /^[a-z]:\\/i.test(value) ||
    value.startsWith("./") ||
    value.startsWith(".\\") ||
    value.startsWith("/") ||
    value.startsWith("..\\") ||
    value.startsWith("../")
  );
}

function extractMarketplaceLinks(provider: "agentskill" | "skillsmp", html: string): string[] {
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  const found = new Set<string>();
  let match: RegExpExecArray | null = hrefRegex.exec(html);
  while (match) {
    const href = match[1] ?? "";
    const absolute = toAbsoluteMarketplaceUrl(provider, href);
    if (!absolute) {
      match = hrefRegex.exec(html);
      continue;
    }
    if (provider === "agentskill" && !/agentskill\.sh\/(skills?|learn|readme)/i.test(absolute)) {
      match = hrefRegex.exec(html);
      continue;
    }
    if (provider === "skillsmp" && !/skillsmp\.com\/(skills?|docs|marketplace)/i.test(absolute)) {
      match = hrefRegex.exec(html);
      continue;
    }
    found.add(absolute);
    match = hrefRegex.exec(html);
  }
  return [...found];
}

function toAbsoluteMarketplaceUrl(provider: "agentskill" | "skillsmp", href: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("mailto:")) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const base = provider === "agentskill" ? "https://agentskill.sh" : "https://skillsmp.com";
  return new URL(trimmed, base).toString();
}

async function resolveSkillDir(rootDir: string): Promise<string> {
  const direct = path.join(rootDir, "SKILL.md");
  if (fsSync.existsSync(direct)) {
    return rootDir;
  }

  const queue = [rootDir];
  let scannedDirs = 0;
  while (queue.length > 0 && scannedDirs < 250) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    scannedDirs += 1;
    const entries = await (async (): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> => {
      try {
        return await fs.readdir(current, { withFileTypes: true });
      } catch {
        return [];
      }
    })();

    const hasSkill = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (hasSkill) {
      return current;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".git")) {
        continue;
      }
      queue.push(path.join(current, entry.name));
    }
  }

  throw new Error("Unable to locate SKILL.md in the provided source.");
}

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  try {
    await execFileAsync("tar", ["-xf", zipPath, "-C", targetDir], { windowsHide: true });
    return;
  } catch {
    // continue to fallback
  }

  if (process.platform === "win32") {
    const command = `Expand-Archive -Path "${zipPath.replaceAll('"', '""')}" -DestinationPath "${targetDir.replaceAll('"', '""')}" -Force`;
    await execFileAsync("powershell", ["-NoProfile", "-Command", command], { windowsHide: true });
    return;
  }

  throw new Error("Unable to extract zip file in this runtime. Extract locally and use sourceType=local_path.");
}

async function scanSkillDirectory(dir: string): Promise<{
  suspiciousSignals: string[];
  networkSignals: string[];
  licenseFiles: string[];
  skippedLargeFiles: string[];
  truncated: boolean;
}> {
  const suspiciousSignals = new Set<string>();
  const networkSignals = new Set<string>();
  const licenseFiles = new Set<string>();
  const skippedLargeFiles = new Set<string>();
  const queue = [dir];
  let scannedFiles = 0;
  let truncated = false;

  while (queue.length > 0 && scannedFiles < 220) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await (async (): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> => {
      try {
        return await fs.readdir(current, { withFileTypes: true });
      } catch {
        return [];
      }
    })();

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".git")) {
          queue.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scannedFiles += 1;
      if (/^(license|copying)(\..*)?$/i.test(entry.name)) {
        licenseFiles.add(path.relative(dir, fullPath).replaceAll("\\", "/"));
      }
      if (scannedFiles > 220) {
        truncated = true;
        break;
      }
      const readResult = await tryReadFileText(fullPath);
      if (readResult.skippedLargeFile) {
        skippedLargeFiles.add(path.relative(dir, fullPath).replaceAll("\\", "/"));
      }
      if (!readResult.text) {
        continue;
      }
      const text = readResult.text;
      if (/(rm\s+-rf|del\s+\/f|powershell\s+-enc|invoke-webrequest\s+.*\|\s*iex)/i.test(text)) {
        suspiciousSignals.add(path.relative(dir, fullPath).replaceAll("\\", "/"));
      }
      if (/(https?:\/\/|fetch\s*\(|axios\.|curl\s+)/i.test(text)) {
        networkSignals.add(path.relative(dir, fullPath).replaceAll("\\", "/"));
      }
    }
  }
  if (queue.length > 0) {
    truncated = true;
  }

  return {
    suspiciousSignals: [...suspiciousSignals],
    networkSignals: [...networkSignals],
    licenseFiles: [...licenseFiles],
    skippedLargeFiles: [...skippedLargeFiles],
    truncated,
  };
}

async function tryReadFileText(filePath: string): Promise<{ text: string; skippedLargeFile: boolean }> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 220_000) {
      return { text: "", skippedLargeFile: true };
    }
    const content = await fs.readFile(filePath, "utf8");
    return { text: content, skippedLargeFile: false };
  } catch {
    return { text: "", skippedLargeFile: false };
  }
}

function deriveRiskLevel(input: {
  suspiciousScripts: boolean;
  networkIndicators: boolean;
  scanIncomplete: boolean;
  descriptionQuality: boolean;
  valid: boolean;
}): "low" | "medium" | "high" {
  if (!input.valid || input.suspiciousScripts) {
    return "high";
  }
  if (input.networkIndicators || input.scanIncomplete || !input.descriptionQuality) {
    return "medium";
  }
  return "low";
}

function summarizePathList(paths: string[], limit = 3): string {
  const preview = paths.slice(0, limit).join(", ");
  if (paths.length <= limit) {
    return preview;
  }
  return `${preview}, +${paths.length - limit} more`;
}

function normalizeSkillId(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "imported-skill";
}
