import fs from "node:fs";
import path from "node:path";
import type {
  OpsDesignQualityCheck,
  OpsDesignQualityCheckStatus,
  OpsDesignQualitySeverity,
  OpsDesignQualitySnapshot,
} from "@goatcitadel/contracts";
// The calibrated anti-slop table lives with the design detector so Ops evidence and runtime advisories share it.
import { ANTI_SLOP_PATTERNS, DESIGN_DETECTOR_RULES } from "./design-detector/rules.js";
import { enumerateSkillRoutes, IMPECCABLE_SKILL_ID, IMPECCABLE_SKILL_NAME } from "./skill-module-routes.js";

function isRetiringClassicPath(filePath: string): boolean {
  return /[\\/]features[\\/](?:native-routes|threaded-surface)[\\/]/u.test(filePath);
}

// Every module any impeccable route can inject, read from the same route table the runtime uses, so a
// module that vanishes from an install blocks here before a turn fails its exact-byte verification.
const SKILL_DIR = path.join("skills", "bundled", "impeccable");
const REQUIRED_SKILL_MODULES: readonly string[] = [
  ...new Set(
    enumerateSkillRoutes({ skillId: IMPECCABLE_SKILL_ID, skillName: IMPECCABLE_SKILL_NAME }).flatMap((route) =>
      route.modules.map((module) => module.relativePath),
    ),
  ),
];
// GoatCitadel authors this one module itself; the sync script never writes it.
const LOCAL_SKILL_MODULES = new Set(["reference/artifacts.md"]);

const REQUIRED_SKILL_PHRASES = [
  "Vendored from",
  "PRODUCT.md",
  "DESIGN.md",
  "Core principles",
  "Not available in this vendored build",
] as const;

const REQUIRED_ROUTING_PHRASES = [
  "design quality",
  "anti-slop",
  "visual polish",
  "design-system audit",
  "document design",
  "presentation design",
  "pptx deck",
  "html artifact",
] as const;

const REQUIRED_PROVENANCE_FILES = ["UPSTREAM.md", "LICENSE", "NOTICE"] as const;
const UPSTREAM_COMMIT_PATTERN = /Commit:\s*`[0-9a-f]{40}`/u;

// Upstream impeccable ships a launcher that downloads a binary; the vendored prose must never
// point at it, and no injectable file may name the providers the repo excludes.
const LAUNCHER_PATTERNS = [
  { id: "unresolved {{placeholder}}", re: /\{\{/u },
  // `npx impeccable`, `npx -y impeccable`, `npx --yes impeccable@latest`, `npx -p impeccable impeccable ...`
  { id: "npx impeccable", re: /\bnpx\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+impeccable\b/iu },
  { id: "impeccable launcher verb", re: /\bimpeccable (?:detect|pin|hooks|context|doctor)\b/iu },
  { id: "~/.impeccable", re: /~\/\.impeccable/u },
  { id: ".impeccable/ path", re: /\.impeccable\//u },
  { id: "grok", re: /grok/iu },
  { id: "xai", re: /\bxai\b/iu },
  { id: "x.ai", re: /\bx\.ai\b/iu },
] as const;

const ARTIFACTS_MODULE = "reference/artifacts.md";
const ARTIFACTS_MODULE_MAX_BYTES = 8 * 1024;

const REQUIRED_PROOF_SCRIPTS = [
  "verify:design:quality",
  "verify:surface:regression",
  "verify:visual:regression",
] as const;

const REQUIRED_TOKEN_FILES = [
  "apps/mission-control-next/src/styles/mission-control-next-tokens.css",
  "apps/mission-control-next/src/styles/mission-control-next-foundation.css",
  "apps/mission-control-next/src/styles/mission-control-next.css",
] as const;

const UI_SCAN_ROOTS = ["apps/mission-control-next/src", "packages/mission-control-shared/src"] as const;
const MISSION_CONTROL_RAW_COLOR_BUDGET = 92;

const PLACEHOLDER_PATTERNS = [{ id: "unresolved-placeholder", re: /<PLACEHOLDER|TODO_PLACEHOLDER/iu }] as const;

const RAW_COLOR_LITERAL_PATTERNS = [
  { id: "raw-hex-color", re: /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/u },
  { id: "raw-rgb-color", re: /\brgba?\(/iu },
  { id: "raw-hsl-color", re: /\bhsla?\(/iu },
  { id: "raw-oklch-color", re: /\boklch\(/iu },
] as const;

type DesignQualityHit = { path: string; pattern: string };

export function readDesignQualityEvidence(repoRoot: string): OpsDesignQualitySnapshot {
  const root = path.resolve(repoRoot);
  const checks: OpsDesignQualityCheck[] = [];
  const skillDir = path.join(root, SKILL_DIR);
  const skillOwner = SKILL_DIR.replace(/\\/gu, "/");
  const skillFiles = REQUIRED_SKILL_MODULES.map((file) => path.join(skillDir, file));

  const missingModules = REQUIRED_SKILL_MODULES.filter((file) => !fs.existsSync(path.join(skillDir, file)));
  checks.push(
    check({
      id: "impeccable.modules",
      label: "Impeccable module integrity",
      severity: missingModules.length > 0 ? "P0" : "P3",
      status: missingModules.length > 0 ? "blocking" : "passing",
      owner: skillOwner,
      evidence: skillOwner,
      nextAction:
        missingModules.length > 0
          ? `Restore missing impeccable module(s): ${missingModules
              .map((file) =>
                LOCAL_SKILL_MODULES.has(file)
                  ? `${file} (GoatCitadel-authored, restore from git)`
                  : `${file} (re-run the sync script)`,
              )
              .join(", ")}.`
          : undefined,
    }),
  );

  const skillText = readText(path.join(skillDir, "SKILL.md"));
  const missingSkillPhrases = REQUIRED_SKILL_PHRASES.filter((phrase) => !includesPhrase(skillText, phrase));
  checks.push(
    check({
      id: "impeccable.lifecycle",
      label: "Provenance, context, and craft guidance in SKILL.md",
      severity: missingSkillPhrases.length > 0 ? "P1" : "P3",
      status: missingSkillPhrases.length > 0 ? "advisory" : "passing",
      owner: skillOwner,
      evidence: `${skillOwner}/SKILL.md`,
      nextAction:
        missingSkillPhrases.length > 0
          ? `Add missing design guidance phrase(s) through the sync script: ${missingSkillPhrases.join(", ")}.`
          : undefined,
    }),
  );

  const unresolvedSkillHits = [
    ...collectPatternHits(skillFiles, PLACEHOLDER_PATTERNS, { repoRoot: root }),
    ...collectBrokenMarkdownLinks(skillFiles, root),
  ];
  checks.push(
    check({
      id: "impeccable.placeholders",
      label: "No unresolved links or placeholders in the design skill",
      severity: unresolvedSkillHits.length > 0 ? "P0" : "P3",
      status: unresolvedSkillHits.length > 0 ? "blocking" : "passing",
      owner: skillOwner,
      evidence: unresolvedSkillHits[0]?.path ?? skillOwner,
      nextAction:
        unresolvedSkillHits.length > 0
          ? `Resolve design skill link/placeholder hit(s): ${summarizeHits(unresolvedSkillHits)}.`
          : undefined,
    }),
  );

  const missingProvenance = REQUIRED_PROVENANCE_FILES.filter((file) => !fs.existsSync(path.join(skillDir, file)));
  const upstreamPinned = UPSTREAM_COMMIT_PATTERN.test(readText(path.join(skillDir, "UPSTREAM.md")));
  const provenanceProblems = [
    ...missingProvenance.map((file) => `missing ${file}`),
    ...(upstreamPinned || missingProvenance.includes("UPSTREAM.md") ? [] : ["UPSTREAM.md pins no 40-hex commit"]),
  ];
  checks.push(
    check({
      id: "impeccable.provenance",
      label: "Vendored provenance is recorded (UPSTREAM.md, LICENSE, NOTICE)",
      severity: provenanceProblems.length > 0 ? "P0" : "P3",
      status: provenanceProblems.length > 0 ? "blocking" : "passing",
      owner: skillOwner,
      evidence: `${skillOwner}/UPSTREAM.md`,
      nextAction:
        provenanceProblems.length > 0
          ? `Re-run the impeccable sync script to restore provenance: ${provenanceProblems.join("; ")}.`
          : undefined,
    }),
  );

  // Only SKILL.md and reference/ reach a model; UPSTREAM.md and NOTICE legitimately describe what was stripped.
  const launcherHits = collectPatternHits(
    [path.join(skillDir, "SKILL.md"), path.join(skillDir, "reference")],
    LAUNCHER_PATTERNS,
    { recursive: true, repoRoot: root },
  );
  checks.push(
    check({
      id: "impeccable.launcher-strings",
      label: "No launcher, placeholder, or excluded-provider strings in the injectable files",
      severity: launcherHits.length > 0 ? "P0" : "P3",
      status: launcherHits.length > 0 ? "blocking" : "passing",
      owner: skillOwner,
      evidence: launcherHits[0]?.path ?? skillOwner,
      nextAction:
        launcherHits.length > 0
          ? `Remove launcher/provider hit(s) via the sync script: ${summarizeHits(launcherHits)}.`
          : undefined,
    }),
  );

  const artifactsBytes = Buffer.byteLength(readText(path.join(skillDir, ARTIFACTS_MODULE)), "utf8");
  checks.push(
    check({
      id: "impeccable.artifacts-budget",
      label: "Artifacts module stays within its injection budget",
      severity: artifactsBytes > ARTIFACTS_MODULE_MAX_BYTES ? "P1" : "P3",
      status: artifactsBytes > ARTIFACTS_MODULE_MAX_BYTES ? "advisory" : "passing",
      owner: skillOwner,
      evidence: `${skillOwner}/${ARTIFACTS_MODULE}`,
      nextAction:
        artifactsBytes > ARTIFACTS_MODULE_MAX_BYTES
          ? `Trim ${ARTIFACTS_MODULE} to 8 KiB or less (currently ${artifactsBytes} bytes); it is injected on every deck and document turn.`
          : undefined,
    }),
  );

  const tokenMissing = REQUIRED_TOKEN_FILES.filter((file) => !fs.existsSync(path.join(root, file)));
  checks.push(
    check({
      id: "mission-control.tokens",
      label: "Mission Control design tokens are present",
      severity: tokenMissing.length > 0 ? "P0" : "P3",
      status: tokenMissing.length > 0 ? "blocking" : "passing",
      owner: "apps/mission-control-next",
      evidence: tokenMissing[0] ?? "apps/mission-control-next/src/styles",
      nextAction: tokenMissing.length > 0 ? `Restore missing token file(s): ${tokenMissing.join(", ")}.` : undefined,
    }),
  );

  // Token sources declare the palette, so their literals are the point, not a leak. Classic keeps its tokens file;
  // the cockpit is styled in isolation from Classic and has exactly one token file of its own.
  const cockpitTokenFile = path.resolve(
    root,
    "apps",
    "mission-control-next",
    "src",
    "cockpit",
    "styles",
    "cockpit-tokens.css",
  );
  const rawColorHits = collectRawColorLiteralHits([path.join(root, "apps", "mission-control-next", "src")], {
    recursive: true,
    repoRoot: root,
    exclude: (filePath) =>
      filePath.endsWith("mission-control-next-tokens.css") || path.resolve(filePath) === cockpitTokenFile,
  });
  checks.push(
    check({
      id: "mission-control.raw-color-budget",
      label: "Mission Control non-token raw color budget",
      severity: rawColorHits.length > MISSION_CONTROL_RAW_COLOR_BUDGET ? "P0" : "P3",
      status: rawColorHits.length > MISSION_CONTROL_RAW_COLOR_BUDGET ? "blocking" : "passing",
      owner: "apps/mission-control-next",
      evidence: rawColorHits[0]?.path ?? "apps/mission-control-next/src/styles/mission-control-next-tokens.css",
      nextAction:
        rawColorHits.length > MISSION_CONTROL_RAW_COLOR_BUDGET
          ? `Move raw color literal(s) into mission-control-next-tokens.css or reduce non-token CSS hits to ${MISSION_CONTROL_RAW_COLOR_BUDGET} or fewer; current hits: ${rawColorHits.length}.`
          : undefined,
    }),
  );

  const routingText = readText(path.join(root, "packages", "skills", "src", "routing-hints.generated.ts"));
  const missingRoutingPhrases = REQUIRED_ROUTING_PHRASES.filter((phrase) => !includesPhrase(routingText, phrase));
  checks.push(
    check({
      id: "skills.routing-hints.design-quality",
      label: "Design-quality routing hints",
      severity: missingRoutingPhrases.length > 0 ? "P1" : "P3",
      status: missingRoutingPhrases.length > 0 ? "advisory" : "passing",
      owner: "packages/skills",
      evidence: "packages/skills/src/routing-hints.generated.ts",
      nextAction:
        missingRoutingPhrases.length > 0
          ? `Refresh the impeccable routing hints for: ${missingRoutingPhrases.join(", ")}.`
          : undefined,
    }),
  );

  const packageJsonText = readText(path.join(root, "package.json"));
  const missingProofScripts = REQUIRED_PROOF_SCRIPTS.filter(
    (script) => !includesPhrase(packageJsonText, `"${script}"`),
  );
  checks.push(
    check({
      id: "design-quality.proof-lanes",
      label: "Design proof lanes are wired",
      severity: missingProofScripts.length > 0 ? "P0" : "P3",
      status: missingProofScripts.length > 0 ? "blocking" : "passing",
      owner: "scripts",
      evidence: "package.json",
      nextAction:
        missingProofScripts.length > 0
          ? `Wire missing design proof script(s): ${missingProofScripts.join(", ")}.`
          : undefined,
    }),
  );

  const antiSlopHits = collectPatternHits(
    UI_SCAN_ROOTS.map((scanRoot) => path.join(root, scanRoot)),
    ANTI_SLOP_PATTERNS,
    { recursive: true, repoRoot: root },
  );
  checks.push(
    check({
      id: "mission-control.anti-slop.scan",
      label: "Calibrated anti-slop scan",
      severity: antiSlopHits.length > 0 ? "P2" : "P3",
      status: antiSlopHits.length > 0 ? "advisory" : "passing",
      owner: "mission-control-next",
      evidence: antiSlopHits[0]?.path ?? "apps/mission-control-next/src",
      nextAction:
        antiSlopHits.length > 0
          ? `Review token-backed intent for anti-slop hit(s): ${summarizeHits(antiSlopHits)}.`
          : undefined,
    }),
  );

  // Cockpit-only craft-floor advisories (plan D6): counts per rule, informational, never blocking. The
  // retiring Classic shell is out of scope.
  const craftFloorHits = collectPatternHits(
    [
      path.join(root, "apps", "mission-control-next", "src", "cockpit"),
      path.join(root, "packages", "mission-control-shared", "src", "components"),
    ],
    DESIGN_DETECTOR_RULES,
    { recursive: true, repoRoot: root, exclude: isRetiringClassicPath },
  );
  const craftFloorCounts = [...new Map(craftFloorHits.map((hit) => [hit.pattern, 0]))]
    .map(([pattern]) => `${pattern}: ${craftFloorHits.filter((hit) => hit.pattern === pattern).length}`)
    .sort();
  checks.push(
    check({
      id: "mission-control.craft-floor.scan",
      label: "Craft-floor advisory scan",
      severity: craftFloorHits.length > 0 ? "P2" : "P3",
      status: craftFloorHits.length > 0 ? "advisory" : "passing",
      owner: "mission-control-next",
      evidence: craftFloorHits[0]?.path ?? "apps/mission-control-next/src/cockpit",
      nextAction:
        craftFloorHits.length > 0
          ? `Informational craft-floor advisories by rule (never blocking): ${craftFloorCounts.join(", ")}.`
          : undefined,
    }),
  );

  const summary = summarizeDesignQualityChecks(checks);
  return {
    state: "available",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      source: "repo_files",
      callsProviders: false,
      mutationPerformed: false,
      note: "Design quality evidence reads repo files only. It does not run providers, open browsers, mutate source, or update visual baselines.",
    },
    summary,
    checks,
    warnings:
      summary.advisoryCount > 0
        ? ["Design quality advisories are calibrated signals, not release blockers unless promoted to P0."]
        : [],
  };
}

export function summarizeDesignQualityChecks(
  checks: readonly OpsDesignQualityCheck[],
): OpsDesignQualitySnapshot["summary"] {
  return {
    totalChecks: checks.length,
    passingCount: checks.filter((item) => item.status === "passing").length,
    advisoryCount: checks.filter((item) => item.status === "advisory").length,
    blockingCount: checks.filter((item) => item.status === "blocking").length,
    unknownCount: checks.filter((item) => item.status === "unknown").length,
    p0Count: checks.filter((item) => item.severity === "P0").length,
    p1Count: checks.filter((item) => item.severity === "P1").length,
    p2Count: checks.filter((item) => item.severity === "P2").length,
    p3Count: checks.filter((item) => item.severity === "P3").length,
  };
}

export function hasBlockingDesignQualityFindings(snapshot: OpsDesignQualitySnapshot): boolean {
  return snapshot.summary.blockingCount > 0 || snapshot.checks.some((checkItem) => checkItem.status === "blocking");
}

function check(input: {
  id: string;
  label: string;
  severity: OpsDesignQualitySeverity;
  status: OpsDesignQualityCheckStatus;
  owner: string;
  evidence: string;
  nextAction?: string;
}): OpsDesignQualityCheck {
  return {
    id: input.id,
    label: input.label,
    severity: input.severity,
    status: input.status,
    owner: input.owner,
    evidence: normalizeEvidencePath(input.evidence),
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
  };
}

function collectRawColorLiteralHits(
  rootsOrFiles: readonly string[],
  options: { recursive?: boolean; repoRoot?: string; exclude?: (filePath: string) => boolean } = {},
): DesignQualityHit[] {
  const hits: DesignQualityHit[] = [];
  for (const entryPath of rootsOrFiles) {
    const files = options.recursive ? listTextFiles(entryPath) : [entryPath];
    for (const filePath of files) {
      if (options.exclude?.(filePath)) continue;
      const text = readText(filePath);
      if (!text) continue;
      for (const pattern of RAW_COLOR_LITERAL_PATTERNS) {
        const re = new RegExp(
          pattern.re.source,
          pattern.re.flags.includes("g") ? pattern.re.flags : `${pattern.re.flags}g`,
        );
        for (const _match of text.matchAll(re)) {
          hits.push({ path: normalizeEvidencePath(filePath, options.repoRoot), pattern: pattern.id });
        }
      }
    }
  }
  return hits;
}

function collectPatternHits(
  rootsOrFiles: readonly string[],
  patterns: readonly { id: string; re: RegExp }[],
  options: { recursive?: boolean; repoRoot?: string; exclude?: (filePath: string) => boolean } = {},
): DesignQualityHit[] {
  const hits: DesignQualityHit[] = [];
  for (const entryPath of rootsOrFiles) {
    const files = options.recursive ? listTextFiles(entryPath) : [entryPath];
    for (const filePath of files) {
      if (options.exclude?.(filePath)) continue;
      const text = readText(filePath);
      if (!text) continue;
      for (const pattern of patterns) {
        if (pattern.re.test(text)) {
          hits.push({ path: normalizeEvidencePath(filePath, options.repoRoot), pattern: pattern.id });
        }
      }
    }
  }
  return hits;
}

function collectBrokenMarkdownLinks(files: readonly string[], repoRoot: string): DesignQualityHit[] {
  const hits: DesignQualityHit[] = [];
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/gu;
  for (const filePath of files) {
    const text = readText(filePath);
    if (!text) continue;
    for (const match of text.matchAll(linkPattern)) {
      const target = match[1]?.trim();
      if (!target) continue;
      const normalizedTarget = target.replace(/^<|>$/gu, "");
      if (isExternalOrAnchorLink(normalizedTarget)) continue;
      const localTarget = normalizedTarget.split(/[?#]/u)[0]?.trim();
      if (!localTarget || path.isAbsolute(localTarget)) continue;
      const resolved = path.resolve(path.dirname(filePath), localTarget);
      if (!fs.existsSync(resolved)) {
        hits.push({
          path: normalizeEvidencePath(filePath, repoRoot),
          pattern: `broken-link:${target}`,
        });
      }
    }
  }
  return hits;
}

function isExternalOrAnchorLink(target: string): boolean {
  return target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target);
}

function listTextFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return shouldScanFile(root) ? [root] : [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", "coverage"].includes(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isFile() && shouldScanFile(full)) out.push(full);
    }
  }
  return out;
}

function shouldScanFile(filePath: string): boolean {
  return /\.(?:ts|tsx|js|jsx|css|md)$/iu.test(filePath) && !/\.test\.(?:ts|tsx|js|jsx)$/iu.test(filePath);
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function includesPhrase(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

function summarizeHits(hits: readonly DesignQualityHit[]): string {
  return hits
    .slice(0, 4)
    .map((hit) => `${hit.pattern} at ${hit.path}`)
    .join("; ");
}

function normalizeEvidencePath(filePath: string, repoRoot?: string): string {
  if (repoRoot && path.isAbsolute(filePath)) {
    const relative = path.relative(repoRoot, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.replace(/\\/gu, "/");
    }
  }
  return filePath.replace(/\\/gu, "/");
}
