import type {
  FollowOnParityEpicId,
  FollowOnParityEpicRecord,
  FollowOnParityReport,
  OpenclawParityBlockerCounts,
  OpenclawParityBlockerKind,
  OpenclawParityBlockerRecord,
  OpenclawParityEpicDefinition,
  OpenclawParityEpicId,
  OpenclawParityProgramEpicRecord,
  OpenclawParityProgramReport,
} from "@goatcitadel/contracts";
import {
  OPENCLAW_PARITY_COMPLETED_EPIC_IDS,
  OPENCLAW_PARITY_COMPLETION_ORDER,
  OPENCLAW_PARITY_EPICS,
  OPENCLAW_PARITY_OPEN_EPIC_IDS,
} from "@goatcitadel/contracts";

const UNSAFE_CLAIMS: string[] = [
  "Slack, Telegram, Google Chat, Teams, and Discord are not yet safe to claim as fully stabilized inbound/outbound channels.",
  "Tier-1 planned channels remain unfinished: WhatsApp, iMessage/BlueBubbles, and Signal.",
  "Tier-2 planned channels remain unfinished: Mattermost, LINE, Zalo OA, and Zalo Personal.",
  "Browser, packaging, companion, A2UI, voice, and published extension SDK proof still require current evidence before parity can be called complete.",
];

export function buildOpenclawParityProgramReport(
  followOnParity: FollowOnParityReport,
  generatedAt = followOnParity.generatedAt,
): OpenclawParityProgramReport {
  const followOnEpicMap = new Map<FollowOnParityEpicId, FollowOnParityEpicRecord>(
    followOnParity.epics.map((epic) => [epic.epicId, epic]),
  );
  const epics = OPENCLAW_PARITY_EPICS.map((definition) =>
    buildProgramEpicRecord(
      definition,
      followOnParity,
      followOnEpicMap.get(definition.epicId as FollowOnParityEpicId),
    ),
  );
  const nextEpicId = OPENCLAW_PARITY_COMPLETION_ORDER.find((epicId) =>
    OPENCLAW_PARITY_OPEN_EPIC_IDS.includes(epicId),
  );
  const nextEpic = epics.find((epic) => epic.epicId === nextEpicId);
  const blockerCounts = countProgramBlockers(epics);

  return {
    generatedAt,
    completedEpicIds: [...OPENCLAW_PARITY_COMPLETED_EPIC_IDS],
    openEpicIds: [...OPENCLAW_PARITY_OPEN_EPIC_IDS],
    completionOrder: [...OPENCLAW_PARITY_COMPLETION_ORDER],
    nextEpicId,
    nextSlice: nextEpic?.nextSlice ?? "Full parity is complete.",
    unsafeClaims: [...UNSAFE_CLAIMS],
    blockerCounts,
    epics,
  };
}

function buildProgramEpicRecord(
  definition: OpenclawParityEpicDefinition,
  followOnParity: FollowOnParityReport,
  followOnEpic?: FollowOnParityEpicRecord,
): OpenclawParityProgramEpicRecord {
  if (followOnEpic) {
    return {
      epicId: definition.epicId,
      label: definition.label,
      status: definition.status,
      summary: followOnEpic.summary,
      nextSlice: followOnEpic.nextSlice,
      blockers: buildFollowOnEpicBlockers(definition.epicId, followOnParity),
    };
  }

  switch (definition.epicId) {
    case "GC-P0-01":
      return record(definition, {
        summary: "Shared channel runtime semantics are already routed through the common capability/action contract used by the current shipped channel surfaces.",
        nextSlice: "Keep the shared channel-core contract as the only truth source while remaining beta and planned channels finish against it.",
        blockers: [],
      });
    case "GC-P0-02":
      return record(definition, {
        summary: "Core beta channels exist, but Slack, Telegram, Google Chat, Teams, and Discord still need inbound/runtime hardening plus channel-by-channel operator proof before they are safe to claim as fully stabilized.",
        nextSlice: "Close the remaining inbound/runtime gaps for each beta channel, then rerun channel-specific setup, diagnostics, and smoke proof before promoting the claim.",
        blockers: [
          blocker(
            "repo_runtime",
            "Slack, Telegram, Google Chat, Teams, and Discord still need the last inbound/runtime hardening tranche before the full stabilization claim is defensible.",
          ),
          blocker(
            "manual_operator",
            "Core beta channels still need a fresh operator proof pass after the final hardening tranche; code-complete alone does not close the claim.",
          ),
        ],
      });
    case "GC-P0-03":
      return record(definition, {
        summary: "Tier-1 planned channels are still open: WhatsApp, iMessage/BlueBubbles, and Signal need to move from partial bridge seams to full parity support.",
        nextSlice: "Ship Tier-1 channels one at a time with capability truth, setup UX, diagnostics, tests, and operator proof before marking any of them complete.",
        blockers: [
          blocker(
            "repo_runtime",
            "WhatsApp, iMessage/BlueBubbles, and Signal still lack the full inbound normalization and action/runtime parity needed to leave planned status.",
          ),
          blocker(
            "manual_operator",
            "Tier-1 channels still need repeatable operator proof before catalog maturity can be promoted truthfully.",
          ),
        ],
      });
    case "GC-P0-05":
      return record(definition, {
        summary: "The shared channel action API is already complete enough to serve as the stable send/reply/react/unsend/typing contract boundary for parity work.",
        nextSlice: "Keep new channels on the same action contract and avoid UI-only behavior branches that would fork parity truth.",
        blockers: [],
      });
    case "GC-P1-04":
      return record(definition, {
        summary: "Tier-2 planned channels remain open: Mattermost, LINE, Zalo OA, and Zalo Personal are still pending implementation and proof.",
        nextSlice: "Reuse the Tier-1 completion template for Tier-2 channels so catalog maturity, diagnostics, tests, and operator proof stay aligned.",
        blockers: [
          blocker(
            "repo_runtime",
            "Mattermost, LINE, Zalo OA, and Zalo Personal still have partial outbound seams but not the full parity bar for inbound/runtime behavior.",
          ),
          blocker(
            "manual_operator",
            "Tier-2 channels still need repeatable operator proof before any completion claim is safe.",
          ),
        ],
      });
    default:
      return record(definition, {
        summary: `${definition.label} is still tracked as ${definition.status.replaceAll("_", " ")}.`,
        nextSlice: "Use the parity completion program and live follow-on report to close the next smallest truthful slice.",
        blockers: [],
      });
  }
}

function record(
  definition: OpenclawParityEpicDefinition,
  details: Pick<OpenclawParityProgramEpicRecord, "summary" | "nextSlice" | "blockers">,
): OpenclawParityProgramEpicRecord {
  return {
    epicId: definition.epicId,
    label: definition.label,
    status: definition.status,
    summary: details.summary,
    nextSlice: details.nextSlice,
    blockers: details.blockers,
  };
}

function buildFollowOnEpicBlockers(
  epicId: OpenclawParityEpicId,
  followOnParity: FollowOnParityReport,
): OpenclawParityBlockerRecord[] {
  switch (epicId) {
    case "GC-P0-06":
      return [
        ...repoBlockingIssues(followOnParity.browser.blockingIssues),
        blocker(
          "manual_operator",
          describeArtifactBlocker(
            "Browser proof",
            followOnParity.browser.artifactStatus,
            followOnParity.deploymentProfile,
          ),
        ),
      ];
    case "GC-P0-07":
      return [
        blocker(
          "external_repo",
          "Platform-side Android proof for a2ui.v1 still depends on the separate GoatCitadel-mobile runtime.",
        ),
        blocker(
          "manual_operator",
          "Mission Control and Android proof bundles still need to be recorded for the Office Lab handoff plus directed-move lane.",
        ),
      ];
    case "GC-P1-08":
      return [
        blocker(
          "external_repo",
          "Android companion runtime/UI proof still depends on the separate GoatCitadel-mobile repo and runtime.",
        ),
        blocker(
          "manual_operator",
          "The Android/emulator companion proof bundle is still missing for approved-device exchange, signed mutations, SSE replay/resume, and refresh rotation.",
        ),
      ];
    case "GC-P1-09":
      return [
        blocker(
          "manual_operator",
          describeArtifactBlocker(
            "Packaging proof",
            followOnParity.packaging.proofStatus,
            followOnParity.deploymentProfile,
          ),
        ),
      ];
    case "GC-P1-10":
      return [
        blocker(
          "repo_runtime",
          "The shared contracts, live reports, and roadmap docs still have to stay in lockstep as later parity tranches land.",
        ),
      ];
    case "GC-P2-11":
      return [
        ...repoBlockingIssues(followOnParity.plugins.blockingIssues),
        blocker(
          "publication",
          "@goatcitadel/extensions-sdk is still workspace-local and unpublished, so public SDK parity is not complete.",
        ),
      ];
    case "GC-P2-12":
      return [
        ...repoBlockingIssues(followOnParity.voice.blockingIssues),
        blocker(
          "manual_operator",
          describeArtifactBlocker(
            "Voice proof",
            followOnParity.voice.artifactStatus,
            followOnParity.deploymentProfile,
          ),
        ),
      ];
    default:
      return [];
  }
}

function repoBlockingIssues(issues: string[]): OpenclawParityBlockerRecord[] {
  return issues.map((issue) => blocker("repo_runtime", issue));
}

function blocker(
  kind: OpenclawParityBlockerKind,
  summary: string,
): OpenclawParityBlockerRecord {
  return {
    kind,
    summary,
  };
}

function countProgramBlockers(
  epics: OpenclawParityProgramEpicRecord[],
): OpenclawParityBlockerCounts {
  const counts: OpenclawParityBlockerCounts = {
    repo_runtime: 0,
    manual_operator: 0,
    external_repo: 0,
    publication: 0,
  };
  for (const epic of epics) {
    for (const entry of epic.blockers) {
      counts[entry.kind] += 1;
    }
  }
  return counts;
}

function describeArtifactBlocker(
  label: string,
  status: FollowOnParityReport["companion"]["artifactStatus"] | FollowOnParityReport["browser"]["artifactStatus"],
  deploymentProfile?: FollowOnParityReport["deploymentProfile"],
): string {
  if (!status.hasArtifact) {
    return `${label} artifact is still missing and must be exported from System before the parity claim can close.`;
  }
  if (status.freshness === "stale") {
    return `${label} artifact is stale${typeof status.ageDays === "number" ? ` (${status.ageDays} day(s) old)` : ""} and must be refreshed before the parity claim can close.`;
  }
  if (
    deploymentProfile
    && "matchedCurrentProfile" in status
    && status.latestArtifactDeploymentProfile
    && !status.matchedCurrentProfile
  ) {
    return `${label} artifact targets ${status.latestArtifactDeploymentProfile} instead of ${deploymentProfile}; rerun the lane under the active profile before closing parity.`;
  }
  return `${label} still depends on a current, reproducible operator run under the active deployment posture before parity can be called complete.`;
}
