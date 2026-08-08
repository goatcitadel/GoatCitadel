/* eslint-disable max-lines -- Skill import policy, normalization, and filesystem writes remain intentionally grouped for operator traceability. */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { parseSkillMarkdown } from "@goatcitadel/skills";
import { assertWritePathInJail, fetchAllowlisted } from "@goatcitadel/policy-engine";
import { readBoundedResponseBytes, readBoundedResponseText } from "./bounded-response-reader.js";
import { assertSafeGitPositionalArg } from "./security-utils.js";
import { NETWORK_INDICATOR_PATTERN, SUSPICIOUS_SCRIPT_PATTERN } from "./skill-content-validation.js";
import { PROMPTWARE_MAX_FINDINGS, scanPromptwareContent } from "./assembled-prompt-injection-guard.js";
import {
  SKILL_BUNDLE_MANIFEST_FILENAME,
  isSkillBundleAssetLocationAllowed,
  normalizeSkillBundleAssetPath,
  parseSkillBundleManifest,
  validateSkillBundleManifestDirectory,
} from "./skill-bundle-manifest.js";
import {
  SKILL_CONTENT_INTEGRITY_LIMITS,
  SkillContentIntegrityLimitError,
  captureSkillContentIntegrity,
  preflightSkillContentTree,
  readBoundedSkillTextFile,
  readBoundedSkillSourceManifestSync,
  shouldIncludeSkillContentPath,
  skillContentIntegrityMatches,
} from "./skill-content-integrity.js";
import type {
  SkillContentIntegrityManifest,
  SkillImportCandidate,
  SkillImportCompatibility,
  SkillImportCompatibilitySource,
  SkillImportExternalToolMapping,
  SkillImportHistoryRecord,
  SkillImportProvenance,
  SkillImportScriptDisposition,
  SkillPromptwareFinding,
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
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

const IMPORT_HISTORY_KEY = "skill_import_history_v1";
const MAX_IMPORT_HISTORY = 300;
const MAX_SKILL_SCAN_FILES = 80;
const TEMP_CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;
const execFileAsync = promisify(execFile);

const HARDENED_GIT_CONFIG = [
  "protocol.allow=never",
  "protocol.https.allow=always",
  "http.followRedirects=false",
] as const;
const GIT_MATERIALIZATION_TIMEOUT_MS = 60_000;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_TREE_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const GIT_METADATA_MAX_BYTES = 16 * 1024 * 1024;
const GIT_METADATA_MAX_ENTRIES = 2_048;

interface MaterializedSkillSource {
  sourceDir: string;
  skillDir: string;
  skillFilePath: string;
  candidate: SkillImportCandidate;
  cleanup?: () => Promise<void>;
}

export interface SkillImportInput {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
}

/**
 * Ephemeral production-review view. The callback is awaited before any
 * materialized temporary source is removed; its paths must never be retained
 * as runtime authority.
 */
export interface MaterializedSkillReviewContext {
  skillDir: string;
  validation: SkillImportValidationResult;
  declaredVersion?: string;
  resolvedGitCommit?: string;
  validateExactDirectory: (skillDir: string) => Promise<SkillImportValidationResult>;
}

interface SkillInstallInput extends SkillImportInput {
  force?: boolean;
  confirmHighRisk?: boolean;
}

/**
 * HX-402 P2: the legacy executable install is retired. Validation stays
 * advisory, but executable installation redirects into the HX-413 Skill Hub
 * owner (immutable snapshots, byte/audit/permission checks, approval linkage).
 * `confirmHighRisk` is NOT approval and filesystem publication is NOT
 * recoverable immutable authority, so this surface can no longer publish
 * bytes, alter callability, or write a competing lifecycle claim.
 */
export interface SkillImportRedirectResult {
  disposition: "redirected_to_skill_hub";
  validation: SkillImportValidationResult;
  redirect: {
    owner: "skill_hub";
    reviewRoute: "/api/v1/skills/hub/reviews";
    sourceRef: string;
    /** Present when the source maps onto a governed hub review source type. */
    sourceType?: "git_url" | "remote_bundle";
    eligible: boolean;
    ineligibleReason?: string;
  };
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
  { remoteName: SKILL_BUNDLE_MANIFEST_FILENAME, localName: SKILL_BUNDLE_MANIFEST_FILENAME, required: false },
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
    installHint: "Treat as a Google connector playbook; route OAuth and diagnostics through native integrations.",
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
    installHint:
      "Use as durable proactive runs and notification taxonomy reference; do not install as a separate runtime.",
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
    installability: "not_installable",
    installHint: "Reject direct import; use GoatCitadel's native improvement ledger and review-first activation path.",
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
    installHint: "Treat as provider cost advisor and prompt-ergonomics input until runtime compatibility is proven.",
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
    installHint: "Use as Update Scout and improvement ledger reference only; keep updates report-first.",
    skillFamily: "auto_updates",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/steipete/github",
    name: "GitHub",
    description: "GitHub workflow skill best treated as a governed connector playbook, not a raw callable import.",
    tags: ["clawhub", "github", "review", "connector", "playbook"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Treat as a GitHub connector playbook only when it adds a concrete governed review workflow.",
    skillFamily: "github_connector_playbook",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/oswalpalash/ontology",
    name: "Ontology",
    description: "Ontology and typed-memory skill whose useful ideas map to GoatCitadel's MemoryLifecycleService.",
    tags: ["clawhub", "ontology", "memory", "entities", "relations"],
    sourceKind: "reference",
    installability: "review_only",
    installHint:
      "Treat as MemoryLifecycleService reference; use structured entities and relations instead of importing.",
    skillFamily: "typed_memory_ontology",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/biostartechnology/humanizer",
    name: "Humanizer",
    description: "Copy and tone refinement skill that maps to GoatCitadel prompt-pack and UI copy guidance.",
    tags: ["clawhub", "copy", "tone", "prompt-pack"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Use conditionally as a copy lint prompt-pack rubric; do not weaken runtime truth or safety language.",
    skillFamily: "copy_humanizer",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/gpyangyoujun/multi-search-engine",
    name: "Multi Search Engine",
    description:
      "Search aggregation concept that GoatCitadel should absorb through the global search broker with Chinese domestic engines removed.",
    tags: ["clawhub", "search", "research", "broker"],
    sourceKind: "reference",
    installability: "review_only",
    installHint:
      "Use as global search broker reference only; Baidu, 360, Sogou, WeChat, Shenma, Google HK, and Bing CN stay excluded.",
    skillFamily: "global_search_broker",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/steipete/openai-whisper",
    name: "OpenAI Whisper",
    description: "Whisper workflow reference that overlaps GoatCitadel's managed local whisper.cpp transcription path.",
    tags: ["clawhub", "voice", "whisper", "transcription"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Keep as managed local whisper.cpp documentation reference; do not duplicate the voice runtime.",
    skillFamily: "voice_transcription",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/jk-0001/automation-workflows",
    name: "Automation Workflows",
    description:
      "Automation recipe ideas that map to WorkflowRecipeService, cron review queues, and explicit operator review.",
    tags: ["clawhub", "automation", "workflow", "cron", "recipes"],
    sourceKind: "reference",
    installability: "review_only",
    installHint:
      "Use as WorkflowRecipeService and Automation Designer inspiration; cron schedules remain review intent until explicitly created.",
    skillFamily: "automation_designer",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/0xneosoul/neosoul-decision-agent",
    name: "Neosoul Decision Agent",
    description: "Decision-journal concept that maps to GoatCitadel structured decision records and retrospectives.",
    tags: ["clawhub", "decision", "journal", "retrospective"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Use as Decision Journal reference; decisions belong in native memory lifecycle records.",
    skillFamily: "decision_journal",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/nextfrontierbuilds/elite-longterm-memory",
    name: "Elite Longterm Memory",
    description: "Long-term memory skill whose durable ideas overlap GoatCitadel's governed memory lifecycle owner.",
    tags: ["clawhub", "memory", "longterm", "lifecycle"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Keep as MemoryLifecycleService reference; do not import another memory owner.",
    skillFamily: "typed_memory_ontology",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/matagul/desktop-control",
    name: "Desktop Control",
    description:
      "Desktop automation concept that is too high-risk for direct import without a visible operator session runtime.",
    tags: ["clawhub", "desktop", "automation", "high-risk"],
    sourceKind: "reference",
    installability: "not_installable",
    installHint:
      "Reject direct import. Future desktop control requires explicit operator session, allowlisted apps, audit, and stop control.",
    skillFamily: "desktop_control_high_risk",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/pskoett/self-improving-agent",
    name: "Self Improving Agent",
    description:
      "Self-improving agent workflow that conflicts with GoatCitadel's proposal-before-activation trust model.",
    tags: ["clawhub", "self-improvement", "agent", "autonomous"],
    sourceKind: "reference",
    installability: "not_installable",
    installHint: "Reject direct import; use the native improvement ledger and review-first activation path.",
    skillFamily: "safe_self_improvement",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/mpociot/superdesign",
    name: "Superdesign",
    description: "Design-review rubric that maps to Mission Control Next frontend guidance and UI lint checks.",
    tags: ["clawhub", "design", "frontend", "review"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Use as Mission Control Next frontend review guidance; do not install as a callable design authority.",
    skillFamily: "frontend_review_guidance",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/xobi667/ui-ux-pro-max",
    name: "UI UX Pro Max",
    description:
      "UI/UX review skill that overlaps GoatCitadel's Mission Control Next design system and visual proof lanes.",
    tags: ["clawhub", "ui", "ux", "frontend", "review"],
    sourceKind: "reference",
    installability: "review_only",
    installHint: "Use as Mission Control Next UI review checklist input and visual proof guidance.",
    skillFamily: "frontend_review_guidance",
  },
  {
    sourceProvider: "clawhub",
    sourceUrl: "https://clawhub.ai/lura2/canvas",
    name: "Canvas",
    description:
      "Canvas automation concept that overlaps A2UI proof lanes and should stay conditional until host proof exists.",
    tags: ["clawhub", "canvas", "a2ui", "automation"],
    sourceKind: "marketplace_listing",
    installability: "review_only",
    installHint: "Conditional only: use the A2UI proof lane, diagnostics, and host proof before runtime activation.",
    skillFamily: "canvas_a2ui",
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
  { family: "global_search_broker", tokens: ["search", "multi", "engine", "research", "broker"] },
  { family: "typed_memory_ontology", tokens: ["ontology", "memory", "longterm", "entity", "relation"] },
  { family: "decision_journal", tokens: ["decision", "journal", "retrospective"] },
  { family: "automation_designer", tokens: ["automation", "workflow", "recipe", "cron"] },
  { family: "frontend_review_guidance", tokens: ["superdesign", "ui", "ux", "frontend", "design"] },
  { family: "voice_transcription", tokens: ["whisper", "voice", "transcription"] },
  { family: "canvas_a2ui", tokens: ["canvas", "a2ui"] },
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
    pattern: /\bdesktop[-\s]?control\b/i,
    duplicateFamily: "desktop_control_high_risk",
    reviewDisposition: "reject",
    message:
      "Desktop control is too high-risk for direct skill import. Future support must be a native visible operator session with app allowlists, audit, and stop control.",
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
    message:
      "Treat this as a proactive taxonomy reference. GoatCitadel owns prompted notifications and durable autonomous runs natively.",
  },
  {
    pattern: /\bauto[-\s]?updater\b/i,
    duplicateFamily: "auto_updates",
    reviewDisposition: "reference_only",
    message: "Use this as a pattern reference only; GoatCitadel should keep update review native and report-first.",
  },
  {
    pattern: /\bmulti[-\s]?search[-\s]?engine\b/i,
    duplicateFamily: "global_search_broker",
    reviewDisposition: "reference_only",
    message:
      "Use this as global search broker inspiration only. GoatCitadel excludes Chinese domestic engines and keeps provider status explicit.",
  },
  {
    pattern: /\bontology\b|\belite[-\s]?longterm[-\s]?memory\b/i,
    duplicateFamily: "typed_memory_ontology",
    reviewDisposition: "reference_only",
    message:
      "Use as a typed-memory reference. Entities, relations, and long-term memory policy belong under MemoryLifecycleService.",
  },
  {
    pattern: /\bneosoul[-\s]?decision[-\s]?agent\b|\bdecision[-\s]?agent\b/i,
    duplicateFamily: "decision_journal",
    reviewDisposition: "reference_only",
    message: "Use as a decision-journal reference; GoatCitadel records decisions and retrospectives natively.",
  },
  {
    pattern: /\bautomation[-\s]?workflows\b/i,
    duplicateFamily: "automation_designer",
    reviewDisposition: "reference_only",
    message:
      "Use as Automation Designer reference only. WorkflowRecipeService records schedule intent without auto-creating cron jobs.",
  },
  {
    pattern: /\bopenai[-\s]?whisper\b|\bwhisper\b/i,
    duplicateFamily: "voice_transcription",
    reviewDisposition: "reference_only",
    message: "GoatCitadel already manages local whisper.cpp transcription; keep this as voice-doc reference only.",
  },
  {
    pattern: /\bsuperdesign\b|\bui[-\s]?ux[-\s]?pro[-\s]?max\b/i,
    duplicateFamily: "frontend_review_guidance",
    reviewDisposition: "reference_only",
    message:
      "Use as frontend review guidance. Mission Control Next design, copy, and visual proof lanes remain the implementation owners.",
  },
  {
    pattern: /\bhumanizer\b/i,
    duplicateFamily: "copy_humanizer",
    reviewDisposition: "conditional",
    message: "Use conditionally as a copy rubric only; it must not soften safety, policy, or runtime-truth language.",
  },
  {
    pattern: /\bcanvas\b/i,
    duplicateFamily: "canvas_a2ui",
    reviewDisposition: "conditional",
    message: "Use conditionally as an A2UI/Canvas reference until host proof exists.",
  },
  {
    pattern: /clawhub\.ai\/steipete\/github\b|\bgithub[-\s]?skill\b/i,
    duplicateFamily: "github_connector_playbook",
    reviewDisposition: "conditional",
    message: "Use conditionally as a GitHub connector playbook only when it adds a concrete governed review workflow.",
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
  proactive_automation: {
    nativeAlternativeName: "Native proactive durable runs and notification taxonomy",
    nativeDestination: "Chat/Cowork proactive settings",
    blockingReason: "GoatCitadel already owns proactive runs natively through durable execution.",
  },
  auto_updates: {
    nativeAlternativeName: "Update Scout and improvement ledger",
    nativeDestination: "Ops > Runtime / Library > Improvements",
    blockingReason: "Updates must stay report-first and proposal-backed instead of auto-applying.",
  },
  openclaw_experiment: {
    nativeAlternativeName: "Native OpenClaw parity and governed execution",
    nativeDestination: "Docs > OpenClaw parity / Cowork",
    blockingReason: "OpenClaw-derived workflows need compatibility review before runtime use.",
  },
  google_cli_oauth: {
    nativeAlternativeName: "Native integration diagnostics and OAuth guidance",
    nativeDestination: "Settings > Integrations",
    blockingReason: "Google CLI/OAuth flows should remain connector-scoped and operator-visible.",
  },
  global_search_broker: {
    nativeAlternativeName: "Global search broker",
    nativeDestination: "Research search API",
    blockingReason: "Search aggregation is implemented through an allowed-engine broker with explicit provider status.",
  },
  typed_memory_ontology: {
    nativeAlternativeName: "Memory entities and relations",
    nativeDestination: "Library > Memory",
    blockingReason: "Typed memory belongs under MemoryLifecycleService with write-gate governance.",
  },
  decision_journal: {
    nativeAlternativeName: "Decision journal",
    nativeDestination: "Library > Memory",
    blockingReason: "Decision records and retrospectives are native structured memory records.",
  },
  automation_designer: {
    nativeAlternativeName: "Automation Designer",
    nativeDestination: "Ops > Runtime / Cowork recipes",
    blockingReason: "Automation recipes are advisory until explicit operator plan or cron creation.",
  },
  voice_transcription: {
    nativeAlternativeName: "Managed local whisper.cpp voice runtime",
    nativeDestination: "Settings > Runtime / Voice",
    blockingReason: "GoatCitadel already owns local transcription runtime setup and diagnostics.",
  },
  frontend_review_guidance: {
    nativeAlternativeName: "Mission Control Next frontend review guidance",
    nativeDestination: "Docs and visual proof lanes",
    blockingReason: "UI/UX guidance belongs in native frontend review and visual regression flows.",
  },
  canvas_a2ui: {
    nativeAlternativeName: "A2UI Canvas proof lane",
    nativeDestination: "Ops > Diagnostics / A2UI contract",
    blockingReason: "Canvas automation requires host proof before callable runtime activation.",
  },
  desktop_control_high_risk: {
    nativeAlternativeName: "Future native desktop automation design",
    nativeDestination: "Docs > Desktop automation safety",
    blockingReason: "Direct desktop control is blocked until explicit visible operator-session safeguards exist.",
  },
};

export class SkillImportService {
  public constructor(
    private readonly rootDir: string,
    private readonly systemSettings: Pick<Storage["systemSettings"], "get" | "set">,
  ) {}

  /**
   * Materialize and validate a source for a bounded caller-owned operation.
   * Cleanup always completes before the returned promise settles, including
   * when validation or the callback fails.
   */
  public async withMaterializedValidation<T>(
    input: SkillImportInput,
    callback: (context: MaterializedSkillReviewContext) => Promise<T> | T,
  ): Promise<T> {
    let materialized: MaterializedSkillSource | undefined;
    try {
      materialized = await this.materializeSkillSource(input);
      const validation = await this.validateMaterialized(materialized);
      let declaredVersion: string | undefined;
      try {
        const raw = await readBoundedSkillTextFile(
          materialized.skillFilePath,
          SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes,
          "Imported SKILL.md",
        );
        const value = parseSkillMarkdown(raw).frontmatter.metadata?.version;
        declaredVersion = typeof value === "string" && value.trim() ? value.normalize("NFKC").trim() : undefined;
      } catch {
        declaredVersion = undefined;
      }
      const resolvedGitCommit =
        validation.candidate.sourceType === "git_url"
          ? await resolveGitHeadRevision(materialized.sourceDir)
          : undefined;
      if (validation.candidate.sourceType === "git_url" && !/^[a-f0-9]{40}$/u.test(resolvedGitCommit ?? "")) {
        throw new Error("Resolved Git source revision is not an exact commit SHA.");
      }
      if (resolvedGitCommit && validation.provenance) {
        validation.provenance = { ...validation.provenance, commitSha: resolvedGitCommit };
        validation.candidate = { ...validation.candidate, provenance: validation.provenance };
      }
      return await callback({
        skillDir: materialized.skillDir,
        validation,
        declaredVersion,
        resolvedGitCommit,
        validateExactDirectory: async (skillDir) => {
          const exactSkillDir = path.resolve(skillDir);
          return this.validateMaterialized({
            sourceDir: exactSkillDir,
            skillDir: exactSkillDir,
            skillFilePath: path.join(exactSkillDir, "SKILL.md"),
            candidate: {
              ...materialized!.candidate,
              skillRootPath: exactSkillDir,
            },
          });
        },
      });
    } finally {
      await materialized?.cleanup?.().catch(() => undefined);
    }
  }

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
      await this.appendHistory({
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
          provenance: validation.provenance,
          externalToolMappings: validation.externalToolMappings,
          scriptDisposition: validation.scriptDisposition,
          bundleManifest: validation.bundleManifest,
          compatibility: validation.compatibility,
        },
        createdAt: new Date().toISOString(),
      });
      return validation;
    } catch (error) {
      const sourceType = inferSourceType(input.sourceRef, input.sourceType);
      const sourceProvider = inferSourceProvider(input.sourceRef, input.sourceProvider);
      await this.appendHistory({
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

  /**
   * HX-402 P2: retired executable install. The legacy validation ladder stays
   * advisory and byte-exact (staging copy + exact-tree validation + the
   * high-risk confirmation refusal), but nothing is ever published: no bytes
   * reach `skills/extra`, no skill state row is written, no lifecycle claim is
   * minted. Valid sources receive a structured redirect into the HX-413 Skill
   * Hub owner, whose review/install/activate path is the only executable
   * authority.
   */
  public async installImport(input: SkillInstallInput): Promise<SkillImportRedirectResult> {
    const importId = randomUUID();
    let materialized: MaterializedSkillSource | undefined;
    let stagingPath: string | undefined;
    try {
      materialized = await this.materializeSkillSource(input);
      const sourceSkillDir = materialized.skillDir;
      const skillsRoot = path.resolve(this.rootDir, "skills");
      const stagingRoot = path.resolve(skillsRoot, ".import-staging");
      stagingPath = path.resolve(stagingRoot, importId);
      assertWritePathInJail(stagingPath, [stagingRoot]);
      await preflightSkillContentTree(sourceSkillDir);
      await fs.mkdir(stagingRoot, { recursive: true });
      await fs.rm(stagingPath, { recursive: true, force: true });
      await fs.cp(sourceSkillDir, stagingPath, {
        recursive: true,
        force: false,
        filter: (sourcePath) =>
          shouldIncludeSkillContentPath(path.relative(sourceSkillDir, sourcePath).replaceAll("\\", "/")),
      });
      const stagedMaterialized: MaterializedSkillSource = {
        sourceDir: stagingPath,
        skillDir: stagingPath,
        skillFilePath: path.join(stagingPath, "SKILL.md"),
        candidate: materialized.candidate,
      };
      const validation = await this.validateMaterialized(stagedMaterialized);
      if (!validation.valid) {
        await this.appendHistory({
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
            provenance: validation.provenance,
            externalToolMappings: validation.externalToolMappings,
            scriptDisposition: validation.scriptDisposition,
            bundleManifest: validation.bundleManifest,
            compatibility: validation.compatibility,
          },
          createdAt: new Date().toISOString(),
        });
        throw new Error(`Skill import validation failed: ${validation.errors.join("; ")}`);
      }
      if (validation.riskLevel === "high" && !input.confirmHighRisk) {
        await this.appendHistory({
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
            provenance: validation.provenance,
            externalToolMappings: validation.externalToolMappings,
            scriptDisposition: validation.scriptDisposition,
            bundleManifest: validation.bundleManifest,
            compatibility: validation.compatibility,
          },
          createdAt: new Date().toISOString(),
        });
        throw new Error("High-risk skill import requires explicit confirmation.");
      }

      const redirect = buildSkillHubRedirect(validation);
      await this.appendHistory({
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
          disposition: "redirected_to_skill_hub",
          redirect,
          provenance: validation.provenance,
          externalToolMappings: validation.externalToolMappings,
          scriptDisposition: validation.scriptDisposition,
          bundleManifest: validation.bundleManifest,
          compatibility: validation.compatibility,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        disposition: "redirected_to_skill_hub",
        validation,
        redirect,
      };
    } catch (error) {
      const sourceType = inferSourceType(input.sourceRef, input.sourceType);
      const sourceProvider = inferSourceProvider(input.sourceRef, input.sourceProvider);
      await this.appendHistory({
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
      if (stagingPath) {
        await fs.rm(stagingPath, TEMP_CLEANUP_OPTIONS).catch(() => undefined);
      }
      await materialized?.cleanup?.().catch(() => undefined);
    }
  }

  public async listHistory(limit = 100): Promise<SkillImportHistoryRecord[]> {
    const rows = (await this.systemSettings.get<SkillImportHistoryRecord[]>(IMPORT_HISTORY_KEY))?.value ?? [];
    return rows.slice(0, Math.max(1, Math.min(limit, 300)));
  }

  private async appendHistory(record: SkillImportHistoryRecord): Promise<void> {
    const rows = (await this.systemSettings.get<SkillImportHistoryRecord[]>(IMPORT_HISTORY_KEY))?.value ?? [];
    await this.systemSettings.set(IMPORT_HISTORY_KEY, [record, ...rows].slice(0, MAX_IMPORT_HISTORY));
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
        const parsed = readBoundedSkillSourceManifestSync(sourceManifestPath) as {
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
          const parsed = readBoundedSkillSourceManifestSync(sourceManifestPath) as InstalledSkillSourceManifest;
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
      const html = await readBoundedResponseText(response, {
        maxBytes: 512 * 1024,
        timeoutMs: 9_000,
        label: `${providerLabel} listing`,
      });
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
      try {
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
            await removeTempRoot(tempRoot);
          },
        };
      } catch (error) {
        await removeTempRoot(tempRoot).catch(() => undefined);
        throw error;
      }
    }

    if (sourceType === "remote_bundle") {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skill-remote-"));
      const bundleDir = path.join(tempRoot, "bundle");
      await fs.mkdir(bundleDir, { recursive: true });
      try {
        await materializeHostedSkillBundle(sourceRef, bundleDir);
      } catch (error) {
        await removeTempRoot(tempRoot).catch(() => undefined);
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
          await removeTempRoot(tempRoot);
        },
      };
    }

    const safeSourceRef = assertSafeGitPositionalArg(sourceRef, "Git source ref");
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skill-git-"));
    const cloneDir = path.join(tempRoot, "repo");
    const materializationController = new AbortController();
    const materializationTimeout = setTimeout(
      () => materializationController.abort(new Error("Git skill materialization timed out.")),
      GIT_MATERIALIZATION_TIMEOUT_MS,
    );
    try {
      await execFileAsync("git", buildHardenedGitCloneArgs(safeSourceRef, cloneDir), {
        windowsHide: true,
        env: buildSanitizedSkillImportGitEnvironment(),
        signal: materializationController.signal,
        timeout: GIT_MATERIALIZATION_TIMEOUT_MS,
        maxBuffer: GIT_TREE_OUTPUT_MAX_BYTES,
      });
      await assertBoundedGitMetadata(cloneDir);
      await materializeBoundedGitTree(cloneDir, materializationController.signal);
      await preflightSkillContentTree(cloneDir);
    } catch (error) {
      await removeTempRoot(tempRoot).catch(() => undefined);
      throw new Error(`Failed to clone git source: ${(error as Error).message}`, { cause: error });
    } finally {
      clearTimeout(materializationTimeout);
    }
    let skillDir: string;
    try {
      skillDir = await resolveSkillDir(cloneDir);
    } catch (error) {
      await removeTempRoot(tempRoot).catch(() => undefined);
      throw error;
    }
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
        await removeTempRoot(tempRoot);
      },
    };
  }

  private async validateMaterialized(source: MaterializedSkillSource): Promise<SkillImportValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let initialContentIntegrity: SkillContentIntegrityManifest | undefined;
    let inferredSkillName: string | undefined;
    let inferredSkillId: string | undefined;
    let declaredTools: string[] = [];
    let requires: string[] = [];
    let instructionPreview = "";
    let frontmatterValid = false;
    let descriptionQuality = false;

    try {
      initialContentIntegrity = await captureSkillContentIntegrity(source.skillDir);
    } catch (error) {
      errors.push(`Skill payload fingerprint failed: ${(error as Error).message}`);
    }

    try {
      const rawSkill = await readBoundedSkillTextFile(
        source.skillFilePath,
        SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes,
        "Imported SKILL.md",
      );
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
    const promptwareScan = initialContentIntegrity
      ? await scanPromptwareIntegrityFiles(source.skillDir, initialContentIntegrity)
      : { findings: [], unscannedPaths: ["<content-integrity-unavailable>"] };
    const suspiciousScripts = scan.suspiciousSignals.length > 0;
    const networkIndicators = scan.networkSignals.length > 0;
    const licenseDetected = scan.licenseFiles.length > 0;
    const scanIncomplete = scan.skippedLargeFiles.length > 0 || scan.truncated;
    const promptwareSafe = promptwareScan.findings.length === 0;
    const promptwareScanComplete = promptwareScan.unscannedPaths.length === 0;
    const externalToolMappings = mapImportedSkillTools(declaredTools);
    const scriptDisposition = buildScriptDisposition(scan.scriptFiles, scan.suspiciousSignals);
    const bundleManifest = await validateSkillBundleManifestDirectory(source.skillDir);

    if (suspiciousScripts) {
      warnings.push("Potentially risky script indicators detected.");
    }
    if (scriptDisposition.action !== "none") {
      warnings.push("Imported scripts remain non-callable until reviewed and activated.");
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
    if (!promptwareSafe) {
      errors.push(
        `Prompt-injection instructions detected in skill files: ${summarizePathList(
          Array.from(new Set(promptwareScan.findings.map((finding) => finding.sourcePath))),
        )}.`,
      );
    }
    if (!promptwareScanComplete) {
      errors.push(
        `Promptware scan incomplete for model-facing files: ${summarizePathList(promptwareScan.unscannedPaths)}.`,
      );
    }
    if (!licenseDetected) {
      warnings.push("No license file detected.");
    }
    if (bundleManifest.status === "valid") {
      warnings.push("Portable skill bundle manifest verified; scripts remain non-callable until governed activation.");
    }
    if (bundleManifest.status === "invalid") {
      errors.push(...bundleManifest.errors);
      warnings.push(...bundleManifest.warnings);
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
    const compatibility = buildSkillImportCompatibility(source, {
      bundleManifestStatus: bundleManifest.status,
      hasErrors: errors.length > 0,
      nativeOverlapCount: nativeOverlaps?.length ?? 0,
      scriptDispositionAction: scriptDisposition.action,
    });
    for (const warning of compatibility.warnings) {
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    }
    let contentIntegrity: SkillContentIntegrityManifest | undefined;
    if (initialContentIntegrity) {
      try {
        const finalContentIntegrity = await captureSkillContentIntegrity(source.skillDir);
        if (!skillContentIntegrityMatches(initialContentIntegrity, finalContentIntegrity)) {
          errors.push("Skill source changed during validation; retry against a stable source snapshot.");
        } else {
          contentIntegrity = finalContentIntegrity;
        }
      } catch (error) {
        errors.push(`Skill payload recheck failed: ${(error as Error).message}`);
      }
    }
    const provenance = buildSkillImportProvenance(source.candidate, contentIntegrity);
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
        promptwareSafe,
        promptwareScanComplete,
      },
      candidate: {
        ...source.candidate,
        provenance,
        externalToolMappings,
        scriptDisposition,
        bundleManifest,
        compatibility,
      },
      inferredSkillName,
      inferredSkillId,
      installPath: inferredSkillId ? `skills/extra/${inferredSkillId}` : undefined,
      declaredTools,
      requires,
      networkSignals: scan.networkSignals,
      suspiciousSignals: scan.suspiciousSignals,
      licenseFiles: scan.licenseFiles,
      promptwareFindings: promptwareScan.findings,
      promptwareUnscannedPaths: promptwareScan.unscannedPaths,
      instructionPreview,
      externalToolMappings,
      scriptDisposition,
      bundleManifest,
      compatibility,
      provenance,
      nativeOverlaps,
    };
  }
}

/**
 * HX-402 P2: map a validated legacy install request onto the governed HX-413
 * Skill Hub review surface. Only hosted sources the hub can independently
 * re-materialize are eligible; local paths and local archives cannot become
 * executable through any legacy path.
 */
function buildSkillHubRedirect(validation: SkillImportValidationResult): SkillImportRedirectResult["redirect"] {
  const sourceType = validation.candidate.sourceType;
  if (sourceType === "git_url" || sourceType === "remote_bundle") {
    return {
      owner: "skill_hub",
      reviewRoute: "/api/v1/skills/hub/reviews",
      sourceRef: validation.candidate.sourceRef,
      sourceType,
      eligible: true,
    };
  }
  return {
    owner: "skill_hub",
    reviewRoute: "/api/v1/skills/hub/reviews",
    sourceRef: validation.candidate.sourceRef,
    eligible: false,
    ineligibleReason:
      "Local sources cannot be installed: publish the skill to a hosted git repository or HTTPS bundle and review it through the governed Skill Hub.",
  };
}

function buildSkillImportCompatibility(
  source: MaterializedSkillSource,
  input: {
    bundleManifestStatus: "absent" | "valid" | "invalid";
    hasErrors: boolean;
    nativeOverlapCount: number;
    scriptDispositionAction: SkillImportScriptDisposition["action"];
  },
): SkillImportCompatibility {
  const sources: SkillImportCompatibilitySource[] = [];
  if (fsSync.existsSync(source.skillFilePath)) {
    sources.push("skill_md");
  }
  if (input.bundleManifestStatus !== "absent") {
    sources.push("goatcitadel_skill_bundle");
  }
  if (isAgentSkillCompatibleSource(source)) {
    sources.push("agent_skills");
  }
  if (hasAgentsMd(source)) {
    sources.push("agents_md");
  }
  const warnings: string[] = [];
  if (sources.includes("agent_skills")) {
    warnings.push(
      "Agent Skills compatibility metadata detected; imported material remains review-only until governed activation.",
    );
  }
  if (sources.includes("agents_md")) {
    warnings.push(
      "AGENTS.md guidance detected as provenance only; it is not promoted into runtime authority by import validation.",
    );
  }
  if (input.scriptDispositionAction !== "none") {
    warnings.push(
      "Imported scripts remain non-callable and are not exposed through callableCatalog by compatibility metadata.",
    );
  }
  const reviewOnly =
    input.hasErrors ||
    input.nativeOverlapCount > 0 ||
    input.scriptDispositionAction !== "none" ||
    sources.includes("agents_md");
  return {
    sources: sources.length ? sources : ["skill_md"],
    warnings,
    callability: reviewOnly ? "review_only" : "governed_candidate",
  };
}

function isAgentSkillCompatibleSource(source: MaterializedSkillSource): boolean {
  const refs = [source.candidate.sourceRef, source.candidate.sourceUrl, source.candidate.repositoryUrl]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return (
    source.candidate.sourceProvider === "agentskill" ||
    refs.includes("agentskill") ||
    refs.includes("agentskills") ||
    fsSync.existsSync(path.join(source.skillDir, "skill.json")) ||
    fsSync.existsSync(path.join(source.sourceDir, "skill.json"))
  );
}

function hasAgentsMd(source: MaterializedSkillSource): boolean {
  return [
    path.join(source.skillDir, "AGENTS.md"),
    path.join(source.skillDir, "agents.md"),
    path.join(source.sourceDir, "AGENTS.md"),
    path.join(source.sourceDir, "agents.md"),
  ].some((candidatePath) => fsSync.existsSync(candidatePath));
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
  const result = await execFileAsync("git", [...hardenedGitConfigArgs(), "rev-parse", "HEAD"], {
    cwd: repoDir,
    windowsHide: true,
    env: buildSanitizedSkillImportGitEnvironment(),
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 4_096,
  });
  const stdout = String(result.stdout ?? "").trim();
  return stdout || undefined;
}

function hardenedGitConfigArgs(): string[] {
  return HARDENED_GIT_CONFIG.flatMap((entry) => ["-c", entry]);
}

function buildHardenedGitCloneArgs(sourceRef: string, cloneDir: string): string[] {
  return [
    ...hardenedGitConfigArgs(),
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--no-checkout",
    `--filter=blob:limit=${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1}`,
    "--",
    sourceRef,
    cloneDir,
  ];
}

interface MaterializedGitTreeFile {
  objectId: string;
  relativePath: string;
  bytes: number;
}

async function materializeBoundedGitTree(repoDir: string, signal: AbortSignal): Promise<void> {
  const listing = await runBoundedGit(repoDir, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    signal,
    encoding: "utf8",
    maxBuffer: GIT_TREE_OUTPUT_MAX_BYTES,
  });
  const files = parseBoundedGitTree(String(listing.stdout ?? ""));
  let totalBytes = 0;
  for (const file of files) {
    const sizeResult = await runBoundedGit(repoDir, ["cat-file", "-s", file.objectId], {
      signal,
      encoding: "utf8",
      maxBuffer: 4_096,
    });
    const rawSize = String(sizeResult.stdout ?? "").trim();
    if (!/^(?:0|[1-9]\d*)$/u.test(rawSize)) {
      throw new SkillContentIntegrityLimitError(
        `Git skill blob ${file.relativePath} is unavailable inside the bounded partial clone.`,
      );
    }
    const bytes = Number(rawSize);
    if (!Number.isSafeInteger(bytes) || bytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes) {
      throw new SkillContentIntegrityLimitError(
        `Git skill blob ${file.relativePath} exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes} bytes.`,
      );
    }
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes) {
      throw new SkillContentIntegrityLimitError(
        `Git skill tree exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes} total bytes.`,
      );
    }
    file.bytes = bytes;
  }

  for (const file of files) {
    const blob = await runBoundedGit(repoDir, ["cat-file", "blob", file.objectId], {
      signal,
      encoding: "buffer",
      maxBuffer: SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1_024,
    });
    const content = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(blob.stdout ?? "");
    if (content.byteLength !== file.bytes) {
      throw new Error(`Git skill blob ${file.relativePath} changed during bounded materialization.`);
    }
    const destination = path.resolve(repoDir, ...file.relativePath.split("/"));
    assertWritePathInJail(destination, [repoDir]);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, { flag: "wx" });
  }
}

function parseBoundedGitTree(output: string): MaterializedGitTreeFile[] {
  const records = output ? output.split("\0") : [];
  if (records.at(-1) === "") records.pop();
  if (records.length > SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles) {
    throw new SkillContentIntegrityLimitError(
      `Git skill tree exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles} files.`,
    );
  }
  const files: MaterializedGitTreeFile[] = [];
  const portablePaths = new Set<string>();
  const directories = new Set<string>();
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator <= 0) throw new Error("Git skill tree returned malformed metadata.");
    const metadata = record.slice(0, separator).split(" ");
    const relativePath = record.slice(separator + 1);
    const [mode, objectType, objectId] = metadata;
    if (mode !== "100644" || objectType !== "blob" || !/^[a-f0-9]{40}$/u.test(objectId ?? "")) {
      throw new Error(`Git skill tree contains a symlink, submodule, or unsupported object at ${relativePath}.`);
    }
    assertPortableGitTreePath(relativePath);
    const collisionKey = relativePath.toLowerCase();
    if (portablePaths.has(collisionKey) || directories.has(collisionKey)) {
      throw new Error(`Git skill tree contains a case-colliding path: ${relativePath}.`);
    }
    portablePaths.add(collisionKey);
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join("/").toLowerCase();
      if (portablePaths.has(directory)) {
        throw new Error(`Git skill tree contains a file-directory collision: ${relativePath}.`);
      }
      directories.add(directory);
    }
    if (directories.size + portablePaths.size > SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries) {
      throw new SkillContentIntegrityLimitError(
        `Git skill tree exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries} filesystem entries.`,
      );
    }
    files.push({ objectId: objectId!, relativePath, bytes: 0 });
  }
  return files;
}

function assertPortableGitTreePath(relativePath: string): void {
  const segments = relativePath.split("/");
  if (
    !relativePath ||
    relativePath.length > 4_096 ||
    relativePath !== relativePath.normalize("NFKC") ||
    relativePath.includes("\\") ||
    relativePath.includes("\uFFFD") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        containsAsciiControlCharacter(segment) ||
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        segment.toLowerCase() === ".git" ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
    )
  ) {
    throw new Error(`Git skill tree contains a non-portable path: ${relativePath}.`);
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

async function assertBoundedGitMetadata(repoDir: string): Promise<void> {
  const objectsDir = path.join(repoDir, ".git", "objects");
  const queue = [objectsDir];
  let entries = 0;
  let bytes = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > GIT_METADATA_MAX_ENTRIES) {
        throw new SkillContentIntegrityLimitError(
          `Git partial-clone metadata exceeds ${GIT_METADATA_MAX_ENTRIES} entries.`,
        );
      }
      const childPath = path.join(current, child.name);
      const stat = await fs.lstat(childPath);
      if (stat.isSymbolicLink()) throw new Error("Git partial-clone metadata contains a symbolic link.");
      if (stat.isDirectory()) {
        queue.push(childPath);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (!Number.isSafeInteger(bytes) || bytes > GIT_METADATA_MAX_BYTES) {
          throw new SkillContentIntegrityLimitError(
            `Git partial-clone metadata exceeds ${GIT_METADATA_MAX_BYTES} bytes.`,
          );
        }
      } else {
        throw new Error("Git partial-clone metadata contains an unsupported filesystem entry.");
      }
    }
  }
}

function runBoundedGit(
  cwd: string,
  args: string[],
  options: { signal: AbortSignal; encoding: "utf8" | "buffer"; maxBuffer: number },
) {
  return execFileAsync("git", [...hardenedGitConfigArgs(), ...args], {
    cwd,
    windowsHide: true,
    env: buildSanitizedSkillImportGitEnvironment(),
    signal: options.signal,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer,
    encoding: options.encoding === "buffer" ? null : "utf8",
  });
}

function buildSanitizedSkillImportGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  ) as NodeJS.ProcessEnv;
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Test-only projection for the production Git trust boundary. It exposes no
// subprocess primitive and keeps environment assertions deterministic.
export function __skillImportGitSecurityForTests(): {
  args: string[];
  cloneArgs: string[];
  env: NodeJS.ProcessEnv;
} {
  return {
    args: hardenedGitConfigArgs(),
    cloneArgs: buildHardenedGitCloneArgs("https://github.com/example/repo.git", "C:/bounded/repo"),
    env: buildSanitizedSkillImportGitEnvironment(),
  };
}

export function __parseSkillImportGitTreeForTests(output: string): MaterializedGitTreeFile[] {
  return parseBoundedGitTree(output);
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
    const html = await readBoundedResponseText(response, {
      maxBytes: 512 * 1024,
      timeoutMs: 9_000,
      label: "Skill marketplace listing",
    });
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

// Test-only export for skill-id normalization coverage.
export const __normalizeSkillIdForTests = normalizeSkillId;

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
      const content = await readBoundedResponseText(response, {
        maxBytes: 512 * 1024,
        timeoutMs: 9_000,
        label: `Hosted skill bundle ${file.localName}`,
      });
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

  await materializeHostedSkillBundleManifestAssets(baseUrl, targetDir);
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

async function materializeHostedSkillBundleManifestAssets(baseUrl: URL, targetDir: string): Promise<void> {
  const manifestPath = path.join(targetDir, SKILL_BUNDLE_MANIFEST_FILENAME);
  const manifestRaw = await fs.readFile(manifestPath, "utf8").catch(() => undefined);
  if (!manifestRaw) {
    return;
  }
  const manifest = parseSkillBundleManifest(manifestRaw);
  if (manifest.assets.length > SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles) {
    throw new SkillContentIntegrityLimitError(
      `Hosted skill bundle exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles} declared files.`,
    );
  }
  const initialPayload = await captureSkillContentIntegrity(targetDir);
  let materializedFiles = initialPayload.fileCount;
  let materializedBytes = initialPayload.totalBytes;
  for (const asset of manifest.assets) {
    const normalized = normalizeSkillBundleAssetPath(asset.path);
    if (!isSkillBundleAssetLocationAllowed(normalized, asset.kind)) {
      throw new Error(`Hosted skill bundle asset ${normalized} is outside the allowed bundle paths.`);
    }
    if (fsSync.existsSync(path.join(targetDir, ...normalized.split("/")))) {
      continue;
    }
    if (materializedFiles + 1 > SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles) {
      throw new SkillContentIntegrityLimitError(
        `Hosted skill bundle exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles} materialized files.`,
      );
    }
    const assetUrl = new URL(toHostedBundleRemotePath(normalized), baseUrl);
    const response = await fetchHostedSkillBundleFile(assetUrl.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch hosted skill bundle asset ${normalized}: HTTP ${response.status}`);
    }
    const content = Buffer.from(
      await readBoundedResponseBytes(response, {
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 9_000,
        label: `Hosted skill bundle asset ${normalized}`,
      }),
    );
    if (materializedBytes + content.byteLength > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes) {
      throw new SkillContentIntegrityLimitError(
        `Hosted skill bundle exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes} total bytes.`,
      );
    }
    const targetPath = path.join(targetDir, ...normalized.split("/"));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content);
    materializedFiles += 1;
    materializedBytes += content.byteLength;
  }
}

function toHostedBundleRemotePath(relativePath: string): string {
  switch (relativePath) {
    case "SKILL.md":
      return "skill.md";
    case "HEARTBEAT.md":
      return "heartbeat.md";
    case "MESSAGING.md":
      return "messaging.md";
    case "RULES.md":
      return "rules.md";
    default:
      return relativePath;
  }
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
  const queue = [rootDir];
  let scannedDirs = 0;
  const candidates: string[] = [];
  while (queue.length > 0 && scannedDirs < 250) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    scannedDirs += 1;
    const entries = await fs.readdir(current, { withFileTypes: true });

    const hasSkill = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (hasSkill) {
      candidates.push(current);
      if (candidates.length > 1) {
        throw new Error("Skill source is ambiguous because it contains multiple SKILL.md files.");
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === ".git") {
        continue;
      }
      queue.push(path.join(current, entry.name));
    }
  }

  if (queue.length > 0) {
    throw new Error("Skill source directory scan exceeded its bounded limit.");
  }
  if (candidates.length === 1) return candidates[0]!;

  throw new Error("Unable to locate SKILL.md in the provided source.");
}

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  await extractZipWithAdmZip(zipPath, targetDir);
}

async function extractZipWithAdmZip(zipPath: string, targetDir: string): Promise<void> {
  const archiveStat = await fs.stat(zipPath);
  if (archiveStat.size > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes) {
    throw new SkillContentIntegrityLimitError(
      `Skill zip exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes} compressed bytes.`,
    );
  }
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries) {
    throw new SkillContentIntegrityLimitError(
      `Skill zip exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries} entries.`,
    );
  }
  let declaredFiles = 0;
  let declaredBytes = 0;
  for (const entry of entries) {
    normalizeZipEntryPath(entry.entryName);
    if (entry.isDirectory) {
      continue;
    }
    declaredFiles += 1;
    if (declaredFiles > SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles) {
      throw new SkillContentIntegrityLimitError(`Skill zip exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles} files.`);
    }
    if (
      !Number.isSafeInteger(entry.header.size) ||
      entry.header.size < 0 ||
      entry.header.size > SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes
    ) {
      throw new SkillContentIntegrityLimitError(
        `Skill zip entry ${entry.entryName} exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes} bytes.`,
      );
    }
    declaredBytes += entry.header.size;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes) {
      throw new SkillContentIntegrityLimitError(
        `Skill zip exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes} uncompressed bytes.`,
      );
    }
  }

  let extractedBytes = 0;
  for (const entry of entries) {
    const relativePath = normalizeZipEntryPath(entry.entryName);
    const destination = path.resolve(targetDir, ...relativePath.split("/"));
    assertWritePathInJail(destination, [targetDir]);
    if (entry.isDirectory) {
      await fs.mkdir(destination, { recursive: true });
      continue;
    }
    const content = entry.getData();
    if (content.byteLength !== entry.header.size || content.byteLength > SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes) {
      throw new SkillContentIntegrityLimitError(
        `Skill zip entry ${entry.entryName} expanded beyond its declared bounds.`,
      );
    }
    extractedBytes += content.byteLength;
    if (extractedBytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes) {
      throw new SkillContentIntegrityLimitError(
        `Skill zip exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes} extracted bytes.`,
      );
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
}

function normalizeZipEntryPath(entryName: string): string {
  const portable = entryName.replace(/\\/g, "/");
  const segments = portable.split("/").filter(Boolean);
  const normalized = path.posix.normalize(portable);
  if (
    entryName.includes("\0") ||
    entryName !== entryName.normalize("NFKC") ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
    ) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(entryName)
  ) {
    throw new Error(`Unsafe zip entry path: ${entryName}`);
  }
  return normalized;
}

async function scanSkillDirectory(dir: string): Promise<{
  suspiciousSignals: string[];
  networkSignals: string[];
  licenseFiles: string[];
  scriptFiles: string[];
  skippedLargeFiles: string[];
  truncated: boolean;
}> {
  const suspiciousSignals = new Set<string>();
  const networkSignals = new Set<string>();
  const licenseFiles = new Set<string>();
  const scriptFiles = new Set<string>();
  const skippedLargeFiles = new Set<string>();
  const queue = [dir];
  let scannedFiles = 0;
  let truncated = false;

  while (queue.length > 0 && scannedFiles < MAX_SKILL_SCAN_FILES) {
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
        if (entry.name !== ".git") {
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
      if (/\.(ps1|bat|cmd|sh|bash|zsh|py|js|mjs|cjs|ts)$/i.test(entry.name)) {
        scriptFiles.add(path.relative(dir, fullPath).replaceAll("\\", "/"));
      }
      if (scannedFiles > MAX_SKILL_SCAN_FILES) {
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
      if (SUSPICIOUS_SCRIPT_PATTERN.test(text)) {
        suspiciousSignals.add(path.relative(dir, fullPath).replaceAll("\\", "/"));
      }
      if (NETWORK_INDICATOR_PATTERN.test(text)) {
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
    scriptFiles: [...scriptFiles],
    skippedLargeFiles: [...skippedLargeFiles],
    truncated,
  };
}

async function scanPromptwareIntegrityFiles(
  dir: string,
  integrity: SkillContentIntegrityManifest,
): Promise<{ findings: SkillPromptwareFinding[]; unscannedPaths: string[] }> {
  const findings: SkillPromptwareFinding[] = [];
  const unscannedPaths: string[] = [];

  for (const entry of integrity.files) {
    if (!/\.(?:md|txt)$/iu.test(entry.path) || !shouldIncludeSkillContentPath(entry.path)) {
      continue;
    }
    try {
      const content = await readBoundedSkillTextFile(
        path.join(dir, ...entry.path.split("/")),
        SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes,
        `Promptware scan file ${entry.path}`,
      );
      const fileFindings = scanPromptwareContent({
        source: "imported_skill",
        sourcePath: entry.path,
        content,
      }).map(({ source: _source, marker: _marker, ...finding }) => ({
        ...finding,
        sourcePath: finding.sourcePath ?? entry.path,
      }));
      findings.push(...fileFindings.slice(0, Math.max(0, PROMPTWARE_MAX_FINDINGS - findings.length)));
    } catch {
      unscannedPaths.push(entry.path);
    }
  }

  return { findings, unscannedPaths };
}

function buildSkillImportProvenance(
  candidate: SkillImportCandidate,
  contentIntegrity?: SkillContentIntegrityManifest,
): SkillImportProvenance {
  return {
    sourceProvider: candidate.sourceProvider,
    sourceRef: candidate.sourceRef,
    sourceType: candidate.sourceType,
    sourceUrl: candidate.sourceUrl,
    repositoryUrl: candidate.repositoryUrl,
    capturedAt: new Date().toISOString(),
    contentIntegrity,
    nonCallableUntilActivated: true,
  };
}

function mapImportedSkillTools(declaredTools: string[]): SkillImportExternalToolMapping[] {
  const nativeToolAliases = new Map<string, { capabilityId: string; label: string }>([
    ["browser", { capabilityId: "tool:browser.search", label: "browser.search" }],
    ["browser.search", { capabilityId: "tool:browser.search", label: "browser.search" }],
    ["web_search", { capabilityId: "tool:browser.search", label: "browser.search" }],
    ["search", { capabilityId: "tool:browser.search", label: "browser.search" }],
    ["http", { capabilityId: "tool:http.get", label: "http.get" }],
    ["http.get", { capabilityId: "tool:http.get", label: "http.get" }],
    ["memory", { capabilityId: "tool:memory.read", label: "memory.read" }],
    ["memory.read", { capabilityId: "tool:memory.read", label: "memory.read" }],
    ["file.read", { capabilityId: "tool:file.read_range", label: "file.read_range" }],
    ["fs.read", { capabilityId: "tool:fs.read", label: "fs.read" }],
    ["shell", { capabilityId: "tool:shell.exec", label: "shell.exec" }],
    ["shell.exec", { capabilityId: "tool:shell.exec", label: "shell.exec" }],
  ]);
  return Array.from(new Set(declaredTools.map((tool) => tool.trim()).filter(Boolean))).map((declaredTool) => {
    const mapped = nativeToolAliases.get(declaredTool.toLowerCase());
    if (mapped) {
      return {
        declaredTool,
        mappedCapabilityId: mapped.capabilityId,
        mappedCapabilityLabel: mapped.label,
        disposition: "mapped",
        reason: "Matched to a governed GoatCitadel tool name; activation policy still controls callability.",
      };
    }
    return {
      declaredTool,
      disposition: "unmapped",
      reason: "No native tool mapping was inferred; review before activation.",
    };
  });
}

function buildScriptDisposition(scriptFiles: string[], suspiciousSignals: string[]): SkillImportScriptDisposition {
  if (scriptFiles.length === 0) {
    return {
      action: "none",
      scriptFiles: [],
      notes: ["No script files were detected during import scan."],
    };
  }
  const suspicious = new Set(suspiciousSignals);
  return {
    action: suspiciousSignals.length > 0 ? "review_required" : "blocked_until_activation",
    scriptFiles,
    notes: scriptFiles.map((file) =>
      suspicious.has(file)
        ? `${file} contains high-risk script indicators and requires manual review.`
        : `${file} is recorded as non-callable until governed activation.`,
    ),
  };
}

async function removeTempRoot(tempRoot: string): Promise<void> {
  await fs.rm(tempRoot, TEMP_CLEANUP_OPTIONS);
}

async function tryReadFileText(filePath: string): Promise<{ text: string; skippedLargeFile: boolean }> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 220_000) {
      return { text: "", skippedLargeFile: true };
    }
    const content = await readBoundedSkillTextFile(filePath, 220_000, "Imported skill scan file");
    return { text: content, skippedLargeFile: false };
  } catch (error) {
    if (error instanceof SkillContentIntegrityLimitError) {
      return { text: "", skippedLargeFile: true };
    }
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

export function normalizeSkillId(name: string): string {
  const trimmed = name.trim();
  if (path.isAbsolute(trimmed) || /[/\\]/.test(trimmed)) {
    throw new Error(`Skill name must not contain path separators: ${trimmed}`);
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (normalized.length === 0 || /^\.+$/.test(normalized) || normalized.includes("..")) {
    throw new Error(`Skill name does not yield a safe skill id: ${trimmed}`);
  }
  return normalized;
}
