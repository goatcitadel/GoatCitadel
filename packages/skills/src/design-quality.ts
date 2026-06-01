import fs from "node:fs";
import path from "node:path";
import type {
  OpsDesignQualityCheck,
  OpsDesignQualityCheckStatus,
  OpsDesignQualitySeverity,
  OpsDesignQualitySnapshot,
} from "@goatcitadel/contracts";

const REQUIRED_SKILL_MODULES = [
  "SKILL.md",
  "enforcement.md",
  "audit.md",
  "components.md",
  "layout.md",
  "taste.md",
  "assets.md",
  "calibration.md",
  "examples.md",
] as const;

const REQUIRED_SKILL_PHRASES = [
  "Design Quality V1",
  "Start",
  "Iterate",
  "Polish",
  "Maintain",
  "surface intent",
  "design system/tokens",
  "craft rules",
  "Pre-Ship Loop",
  "five-dimension critique",
] as const;

const REQUIRED_ROUTING_PHRASES = ["design quality", "anti-slop", "visual polish", "design-system audit"] as const;

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

const PLACEHOLDER_PATTERNS = [{ id: "unresolved-placeholder", re: /<PLACEHOLDER|TODO_PLACEHOLDER/iu }] as const;

const ANTI_SLOP_PATTERNS = [
  {
    id: "default-indigo",
    re: /#(?:6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7)\b/iu,
  },
  {
    id: "generic-trust-gradient",
    re: /linear-gradient\([^)]*(?:purple|violet|indigo|#6366f1|#4f46e5|#8b5cf6|#7c3aed|#a855f7|#3b82f6|#06b6d4|cyan|pink)[^)]*\)/iu,
  },
  {
    id: "emoji-as-ui-icon",
    re: /[✨🚀🎯⚡🔥💡]/u,
  },
  {
    id: "invented-metric",
    re: /\b(?:10×\s+(?:faster|better|easier)|100×\s+(?:faster|better)|99\.\d+%\s+uptime|zero[- ]downtime|3×\s+more\s+(?:productive|efficient))\b/iu,
  },
  {
    id: "lorem-copy",
    re: /\blorem\s+ipsum\b/iu,
  },
  {
    id: "feature-one-copy",
    re: /\bfeature\s+(one|two|three|1|2|3)\b/iu,
  },
  {
    id: "placeholder-copy",
    re: /\bplaceholder\s+text\b/iu,
  },
] as const;

type DesignQualityHit = { path: string; pattern: string };

export function readDesignQualityEvidence(repoRoot: string): OpsDesignQualitySnapshot {
  const root = path.resolve(repoRoot);
  const checks: OpsDesignQualityCheck[] = [];
  const skillDir = path.join(root, "skills", "bundled", "design-intelligence");
  const skillFiles = REQUIRED_SKILL_MODULES.map((file) => path.join(skillDir, file));

  const missingModules = REQUIRED_SKILL_MODULES.filter((file) => !fs.existsSync(path.join(skillDir, file)));
  checks.push(
    check({
      id: "design-intelligence.modules",
      label: "Design-intelligence module integrity",
      severity: missingModules.length > 0 ? "P0" : "P3",
      status: missingModules.length > 0 ? "blocking" : "passing",
      owner: "skills/bundled/design-intelligence",
      evidence: "skills/bundled/design-intelligence",
      nextAction:
        missingModules.length > 0
          ? `Restore missing design-intelligence module(s): ${missingModules.join(", ")}.`
          : undefined,
    }),
  );

  const skillText = readText(path.join(skillDir, "SKILL.md"));
  const missingSkillPhrases = REQUIRED_SKILL_PHRASES.filter((phrase) => !includesPhrase(skillText, phrase));
  checks.push(
    check({
      id: "design-intelligence.lifecycle",
      label: "Lifecycle, register, and craft guidance",
      severity: missingSkillPhrases.length > 0 ? "P1" : "P3",
      status: missingSkillPhrases.length > 0 ? "advisory" : "passing",
      owner: "skills/bundled/design-intelligence",
      evidence: "skills/bundled/design-intelligence/SKILL.md",
      nextAction:
        missingSkillPhrases.length > 0
          ? `Add missing design-quality guidance phrase(s): ${missingSkillPhrases.join(", ")}.`
          : undefined,
    }),
  );

  const unresolvedSkillHits = [
    ...collectPatternHits(skillFiles, PLACEHOLDER_PATTERNS, { repoRoot: root }),
    ...collectBrokenMarkdownLinks(skillFiles, root),
  ];
  checks.push(
    check({
      id: "design-intelligence.placeholders",
      label: "No unresolved links or placeholders in design skill",
      severity: unresolvedSkillHits.length > 0 ? "P0" : "P3",
      status: unresolvedSkillHits.length > 0 ? "blocking" : "passing",
      owner: "skills/bundled/design-intelligence",
      evidence: unresolvedSkillHits[0]?.path ?? "skills/bundled/design-intelligence",
      nextAction:
        unresolvedSkillHits.length > 0
          ? `Resolve design skill link/placeholder hit(s): ${summarizeHits(unresolvedSkillHits)}.`
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
          ? `Refresh design-intelligence routing hints for: ${missingRoutingPhrases.join(", ")}.`
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

function collectPatternHits(
  rootsOrFiles: readonly string[],
  patterns: readonly { id: string; re: RegExp }[],
  options: { recursive?: boolean; repoRoot?: string } = {},
): DesignQualityHit[] {
  const hits: DesignQualityHit[] = [];
  for (const entryPath of rootsOrFiles) {
    const files = options.recursive ? listTextFiles(entryPath) : [entryPath];
    for (const filePath of files) {
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
