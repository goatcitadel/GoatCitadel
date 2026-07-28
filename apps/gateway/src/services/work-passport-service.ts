import { createHash } from "node:crypto";
import {
  WORK_PASSPORT_DOMAINS,
  assertWorkPassportBaseline,
  type OperatorProfileRecord,
  type WorkPassportActionPosture,
  type WorkPassportBaseline,
  type WorkPassportBaselineUpdateInput,
  type WorkPassportBoundary,
  type WorkPassportConsequence,
  type WorkPassportDomain,
  type WorkPassportRecord,
  type WorkPassportReviewPosture,
  type WorkPassportTaskSignal,
} from "@goatcitadel/contracts";
import type { OperatorProfileService } from "./operator-profile-service.js";

const SOURCE_PREFIX = "work-passport:";
const ROLE_SOURCE = `${SOURCE_PREFIX}role`;
const DOMAIN_SOURCE_PREFIX = `${SOURCE_PREFIX}domain:`;
const SENSITIVE_DOMAINS = new Set<WorkPassportDomain>([
  "finance",
  "healthcare",
  "human_resources",
  "legal",
  "security",
]);

interface DomainRule {
  domain: WorkPassportDomain;
  reason: string;
  patterns: RegExp[];
}

const DOMAIN_RULES: DomainRule[] = [
  {
    domain: "administration",
    reason: "scheduling and administrative workflow cues",
    patterns: [/\bschedul(?:e|ing)\b/i, /\bcalendar\b/i, /\bdata entry\b/i, /\bfiling\b/i],
  },
  {
    domain: "customer_experience",
    reason: "customer support and service cues",
    patterns: [/\bcustomer support\b/i, /\bsupport ticket\b/i, /\bcomplaint\b/i, /\bcustomer experience\b/i],
  },
  {
    domain: "data_analysis",
    reason: "data, metrics, and statistical analysis cues",
    patterns: [
      /\bdataset\b/i,
      /\bstatistic(?:s|al)?\b/i,
      /\bmetrics?\b/i,
      /\bdashboard\b/i,
      /\bsql\b/i,
      /\banaly[sz]e data\b/i,
    ],
  },
  {
    domain: "design",
    reason: "visual, interaction, and design-system cues",
    patterns: [
      /\bfigma\b/i,
      /\buser experience\b/i,
      /\bui\/ux\b/i,
      /\bdesign system\b/i,
      /\bwireframe\b/i,
      /\bprototype\b/i,
    ],
  },
  {
    domain: "engineering",
    reason: "software and system implementation cues",
    patterns: [
      /\bcode\b/i,
      /\bsoftware\b/i,
      /\bapi\b/i,
      /\bdebug\b/i,
      /\bdeploy(?:ment)?\b/i,
      /\btypescript\b/i,
      /\bpython\b/i,
      /\bdatabase\b/i,
    ],
  },
  {
    domain: "finance",
    reason: "financial accounting, payment, or investment cues",
    patterns: [
      /\bbudget\b/i,
      /\baccounting\b/i,
      /\bfinancial\b/i,
      /\binvoice\b/i,
      /\bpayment\b/i,
      /\binvest(?:ment|ing)?\b/i,
      /\btax\b/i,
    ],
  },
  {
    domain: "healthcare",
    reason: "clinical, medical, or patient-care cues",
    patterns: [
      /\bpatient\b/i,
      /\bclinical\b/i,
      /\bmedical\b/i,
      /\bdiagnos(?:e|is)\b/i,
      /\bprescri(?:be|ption)\b/i,
      /\btreatment\b/i,
    ],
  },
  {
    domain: "human_resources",
    reason: "employment and people-operations cues",
    patterns: [
      /\bhiring\b/i,
      /\brecruit(?:ing|ment)?\b/i,
      /\bemployee\b/i,
      /\bperformance review\b/i,
      /\btermination\b/i,
      /\bcompensation\b/i,
    ],
  },
  {
    domain: "legal",
    reason: "legal, regulatory, or contract cues",
    patterns: [
      /\blegal\b/i,
      /\bcontract\b/i,
      /\bregulat(?:ion|ory)\b/i,
      /\bcompliance\b/i,
      /\bliability\b/i,
      /\bterms of service\b/i,
    ],
  },
  {
    domain: "marketing",
    reason: "campaign, audience, and content-marketing cues",
    patterns: [/\bmarketing\b/i, /\bcampaign\b/i, /\bseo\b/i, /\bbrand\b/i, /\baudience\b/i, /\bcontent strategy\b/i],
  },
  {
    domain: "operations",
    reason: "process, logistics, and operating workflow cues",
    patterns: [
      /\boperations\b/i,
      /\bworkflow\b/i,
      /\blogistics\b/i,
      /\bsupply chain\b/i,
      /\bprocess improvement\b/i,
      /\bincident response\b/i,
    ],
  },
  {
    domain: "procurement",
    reason: "vendor, sourcing, and purchasing cues",
    patterns: [/\bprocurement\b/i, /\bvendor\b/i, /\bsourcing\b/i, /\bpurchase order\b/i, /\brfp\b/i],
  },
  {
    domain: "project_management",
    reason: "planning, delivery, and project-control cues",
    patterns: [
      /\bproject plan\b/i,
      /\bmilestone\b/i,
      /\broadmap\b/i,
      /\bbacklog\b/i,
      /\bstakeholder\b/i,
      /\bdeadline\b/i,
    ],
  },
  {
    domain: "research",
    reason: "research, literature, and evidence-synthesis cues",
    patterns: [/\bresearch\b/i, /\bliterature review\b/i, /\bpaper\b/i, /\bstudy\b/i, /\bevidence\b/i, /\bcitation\b/i],
  },
  {
    domain: "sales",
    reason: "selling, pipeline, and account-development cues",
    patterns: [
      /\bsales\b/i,
      /\bprospect\b/i,
      /\blead generation\b/i,
      /\bcrm\b/i,
      /\bdeal\b/i,
      /\baccount executive\b/i,
    ],
  },
  {
    domain: "security",
    reason: "security, privacy, and access-control cues",
    patterns: [
      /\bsecurity\b/i,
      /\bvulnerab(?:ility|le)\b/i,
      /\bthreat model\b/i,
      /\baccess control\b/i,
      /\bauthentication\b/i,
      /\bprivacy\b/i,
      /\bcredential\b/i,
    ],
  },
];

const EXTERNAL_ACTION_PATTERN =
  /\b(?:send|publish|deploy to production|execute|transfer|purchase|pay|file|submit|approve|sign|delete|terminate|hire|fire|prescribe)\b/i;
const DECISION_PATTERN = /\b(?:decide|recommend|approve|authorize|determine|assess|advise|final decision)\b/i;
const DRAFT_PATTERN = /\b(?:draft|outline|brainstorm|explore|summari[sz]e|compare|research)\b/i;

export class WorkPassportService {
  public constructor(private readonly operatorProfiles: OperatorProfileService) {}

  public getBaseline(workspaceId: string): WorkPassportBaseline {
    const profile = this.operatorProfiles.findOperatorProfile(workspaceId);
    return profile ? baselineFromProfile(profile) : { configured: false, primaryDomains: [] };
  }

  public updateBaseline(input: WorkPassportBaselineUpdateInput): WorkPassportBaseline {
    const roleLabel = input.roleLabel?.trim();
    const primaryDomains = [...new Set(input.primaryDomains)];
    const candidate: WorkPassportBaseline = {
      configured: primaryDomains.length > 0,
      ...(roleLabel ? { roleLabel } : {}),
      primaryDomains,
    };
    assertWorkPassportBaseline(candidate);
    const result = this.operatorProfiles.replaceOperatorManagedFacts(input.workspaceId, {
      sourceRefPrefix: SOURCE_PREFIX,
      facts: [
        ...(roleLabel ? [{ kind: "fact" as const, content: roleLabel, confidence: 1, sourceRef: ROLE_SOURCE }] : []),
        ...primaryDomains.map((domain) => ({
          kind: "fact" as const,
          content: domain,
          confidence: 1,
          sourceRef: `${DOMAIN_SOURCE_PREFIX}${domain}`,
        })),
      ],
    });
    if (result.blockedFacts.length > 0) {
      throw new Error("The Work Passport baseline was rejected because it resembles sensitive secret material.");
    }
    return baselineFromProfile(result.record);
  }

  public classify(workspaceId: string, content: string): WorkPassportRecord {
    const baseline = this.getBaseline(workspaceId);
    const taskSignals = classifyDomains(content);
    const boundary = classifyBoundary(baseline, taskSignals);
    const sensitive = taskSignals.some((signal) => SENSITIVE_DOMAINS.has(signal.domain));
    const externalAction = EXTERNAL_ACTION_PATTERN.test(content);
    const consequentialDecision = DECISION_PATTERN.test(content);
    const consequence: WorkPassportConsequence =
      externalAction || (sensitive && consequentialDecision)
        ? "high"
        : sensitive || boundary === "cross_domain" || boundary === "mixed"
          ? "moderate"
          : "low";
    const review = buildReview(consequence, boundary, sensitive);
    const evidenceRequirements = collectEvidence(taskSignals, review.requirements);
    const actionPosture: WorkPassportActionPosture = externalAction
      ? "approval_before_external_action"
      : consequence === "high" || review.posture !== "self_check"
        ? "ready_for_review"
        : DRAFT_PATTERN.test(content)
          ? "draft"
          : "explore";
    const hashMaterial = JSON.stringify({ baseline, taskSignals, boundary, consequence, review, actionPosture });
    return {
      passportId: `work-passport-${createHash("sha256").update(hashMaterial).digest("hex").slice(0, 24)}`,
      schemaVersion: "work.passport.v1",
      classificationMode: "deterministic_local_v1",
      baseline,
      taskSignals,
      boundary,
      consequence,
      review,
      evidenceRequirements,
      actionPosture,
      limitations: [
        "Local deterministic task signals; not an occupation, competence, legal, or performance assessment.",
        "The passport does not grant tools, bypass policy, or replace accountable human judgment.",
      ],
      operatorCorrectionAllowed: true,
    };
  }
}

function baselineFromProfile(profile: OperatorProfileRecord): WorkPassportBaseline {
  const roleLabel = profile.facts.find((fact) => fact.sourceRef === ROLE_SOURCE)?.content.trim();
  const domains = profile.facts
    .filter((fact) => fact.sourceRef?.startsWith(DOMAIN_SOURCE_PREFIX))
    .map((fact) => fact.sourceRef?.slice(DOMAIN_SOURCE_PREFIX.length))
    .filter((value): value is WorkPassportDomain => WORK_PASSPORT_DOMAINS.includes(value as WorkPassportDomain));
  const primaryDomains = [...new Set(domains)];
  return {
    configured: primaryDomains.length > 0,
    ...(roleLabel ? { roleLabel } : {}),
    primaryDomains,
    revision: profile.revision,
  };
}

function classifyDomains(content: string): WorkPassportTaskSignal[] {
  return DOMAIN_RULES.map((rule) => {
    const matches = rule.patterns.filter((pattern) => pattern.test(content)).length;
    return { rule, matches };
  })
    .filter((entry) => entry.matches > 0)
    .sort((left, right) => right.matches - left.matches || left.rule.domain.localeCompare(right.rule.domain))
    .slice(0, 3)
    .map(({ rule, matches }) => ({
      domain: rule.domain,
      strength: matches >= 3 ? "high" : matches === 2 ? "medium" : "low",
      reasons: [rule.reason],
    }));
}

function classifyBoundary(baseline: WorkPassportBaseline, taskSignals: WorkPassportTaskSignal[]): WorkPassportBoundary {
  if (taskSignals.length === 0) return "generic_or_unclear";
  if (!baseline.configured) return "baseline_not_configured";
  const within = taskSignals.filter((signal) => baseline.primaryDomains.includes(signal.domain)).length;
  if (within === taskSignals.length) return "within_baseline";
  if (within === 0) return "cross_domain";
  return "mixed";
}

function buildReview(
  consequence: WorkPassportConsequence,
  boundary: WorkPassportBoundary,
  sensitive: boolean,
): { posture: WorkPassportReviewPosture; reason: string; requirements: string[] } {
  if (consequence === "high" && sensitive) {
    return {
      posture: "domain_expert_required",
      reason: "The task combines consequential action or advice with a high-stakes domain.",
      requirements: ["Obtain review from an accountable domain expert before relying on or acting on the output."],
    };
  }
  if (consequence !== "low" || boundary === "cross_domain" || boundary === "mixed") {
    return {
      posture: "independent_review",
      reason:
        boundary === "cross_domain" || boundary === "mixed"
          ? "The task reaches beyond at least part of the operator-defined workspace baseline."
          : "The task carries moderate consequence or high-stakes subject matter.",
      requirements: ["Have a second qualified person review assumptions, evidence, and the proposed action."],
    };
  }
  return {
    posture: "self_check",
    reason: "No cross-domain or consequential-action signal was detected.",
    requirements: ["Check key facts, assumptions, and citations before use."],
  };
}

function collectEvidence(taskSignals: WorkPassportTaskSignal[], reviewRequirements: string[]): string[] {
  const requirements = new Set<string>(reviewRequirements);
  for (const signal of taskSignals) {
    if (signal.domain === "research" || signal.domain === "legal" || signal.domain === "healthcare") {
      requirements.add("Cite current primary sources for material factual claims.");
    }
    if (signal.domain === "engineering" || signal.domain === "security" || signal.domain === "data_analysis") {
      requirements.add("Record reproducible validation evidence for material technical claims or changes.");
    }
    if (signal.domain === "finance") {
      requirements.add("Verify figures, dates, and assumptions against the authoritative financial source.");
    }
    if (signal.domain === "human_resources") {
      requirements.add("Check applicable policy and document accountable human review of employment decisions.");
    }
  }
  return [...requirements].slice(0, 12);
}
