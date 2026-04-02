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
  OPENCLAW_PARITY_COMPLETION_ORDER,
  OPENCLAW_PARITY_EPICS,
} from "@goatcitadel/contracts";

const BASE_UNSAFE_CLAIMS: string[] = [
  "Discord, Slack, and Telegram still need fresh per-provider operator proof whenever runtime or policy behavior changes.",
  "Google Chat and Teams are outbound webhook lanes only; do not over-claim inbound/runtime parity they do not implement.",
  "WhatsApp, Signal, iMessage/BlueBubbles, Mattermost, LINE, Zalo OA, and Zalo Personal now have narrower beta lanes with guided live-probe coverage, but each still has explicit capability limits that must stay visible.",
  "Packaging still requires current clean-install, packaged-startup, and rollback evidence before parity can be called complete.",
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
    epics.some((epic) => epic.epicId === epicId && epic.status !== "complete"),
  );
  const nextEpic = epics.find((epic) => epic.epicId === nextEpicId);
  const blockerCounts = countProgramBlockers(epics);
  const completedEpicIds = epics
    .filter((epic) => epic.status === "complete")
    .map((epic) => epic.epicId);
  const openEpicIds = epics
    .filter((epic) => epic.status !== "complete")
    .map((epic) => epic.epicId);

  return {
    generatedAt,
    completedEpicIds,
    openEpicIds,
    completionOrder: [...OPENCLAW_PARITY_COMPLETION_ORDER],
    nextEpicId,
    nextSlice: nextEpic?.nextSlice ?? "Full parity is complete.",
    unsafeClaims: buildUnsafeClaims(followOnParity),
    blockerCounts,
    epics,
  };
}

function buildUnsafeClaims(
  followOnParity: FollowOnParityReport,
): string[] {
  const claims = [...BASE_UNSAFE_CLAIMS];
  const fullVoiceCoverage = hasFullVoiceProofCoverage(followOnParity);
  const voiceProofCurrent = (
    followOnParity.voice.artifactStatus.hasArtifact
    && followOnParity.voice.artifactStatus.freshness === "current"
    && followOnParity.voice.artifactStatus.matchedCurrentProfile
    && followOnParity.voice.blockingIssues.length === 0
    && followOnParity.voice.recoveryActions.length === 0
  );

  if (fullVoiceCoverage) {
    claims.push(
      "Voice proof now covers the managed local-first runtime across local_dev, trusted_local, and remote_hardened; do not over-claim hosted or cloud voice parity beyond that lane.",
    );
  } else if (voiceProofCurrent) {
    claims.push(
      "Broader voice parity beyond the current local-first runtime lane still requires deliberate widening; do not over-claim cloud-grade or cross-profile parity from the current proof bundle.",
    );
  } else {
    claims.push(
      "Voice parity still requires a current, profile-matched proof bundle before parity can be called complete for the active deployment posture.",
    );
  }

  return claims;
}

function buildProgramEpicRecord(
  definition: OpenclawParityEpicDefinition,
  followOnParity: FollowOnParityReport,
  followOnEpic?: FollowOnParityEpicRecord,
): OpenclawParityProgramEpicRecord {
  const resolvedStatus = resolveProgramEpicStatus(definition, followOnParity, followOnEpic);
  if (followOnEpic) {
    return {
      epicId: definition.epicId,
      label: definition.label,
      status: resolvedStatus,
      summary: followOnEpic.summary,
      nextSlice: followOnEpic.nextSlice,
      blockers: resolvedStatus === "complete"
        ? []
        : buildFollowOnEpicBlockers(definition.epicId, followOnParity),
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
        status: resolvedStatus,
        summary: "Discord, Slack, and Telegram now have inbound/runtime coverage plus guided probes, while Google Chat and Teams are accurate outbound webhook lanes rather than full inbound channels.",
        nextSlice: "Keep Discord, Slack, and Telegram proofs fresh, and keep Google Chat and Teams explicitly documented as outbound webhook providers instead of inventing uniform channel parity.",
        blockers: resolvedStatus === "complete"
          ? []
          : [
            blocker(
              "repo_runtime",
              "Google Chat and Teams are webhook-only outbound lanes today, so the remaining work is keeping provider-lane truth exact rather than claiming inbound/runtime behavior they do not support.",
            ),
            blocker(
              "manual_operator",
              "Discord, Slack, and Telegram still need fresh per-provider operator proof whenever runtime, setup, or policy behavior changes; code-complete alone does not close the claim.",
            ),
          ],
      });
    case "GC-P0-03":
      return record(definition, {
        status: resolvedStatus,
        summary: "WhatsApp, Signal, and iMessage/BlueBubbles now ship with guided setup, live runtime probes, and truthful beta-lane documentation that matches the current runtime bounds of each provider.",
        nextSlice: "Keep the Tier-1 operator proof current and only widen provider capabilities when the runtime and docs move together.",
        blockers: resolvedStatus === "complete"
          ? []
          : [
            blocker(
              "repo_runtime",
              "WhatsApp still lacks delete parity, iMessage remains a local outbound bridge with platform-dependent limits, and Signal is still only a narrow outbound send lane.",
            ),
            blocker(
              "manual_operator",
              "Tier-1 providers still need repeatable operator proof that matches each provider's actual supported action set before any further maturity claims are promoted.",
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
        status: resolvedStatus,
        summary: "Mattermost, LINE, Zalo OA, and Zalo Personal now ship with guided setup, live runtime probes, and truthful beta-lane documentation that matches the current bounds of each channel runtime.",
        nextSlice: "Keep the Tier-2 operator proof current and only widen provider capabilities when the runtime and docs move together.",
        blockers: resolvedStatus === "complete"
          ? []
          : [
            blocker(
              "repo_runtime",
              "Mattermost remains an outbound bot bridge, LINE only ships a narrow send lane plus optional inbound webhook routing, and the Zalo lanes are still limited bridge runtimes.",
            ),
            blocker(
              "manual_operator",
              "Mattermost, LINE, Zalo OA, and Zalo Personal still need repeatable operator proof that matches their current bounds before any further maturity claims are promoted.",
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
  details: Pick<OpenclawParityProgramEpicRecord, "summary" | "nextSlice" | "blockers"> & {
    status?: OpenclawParityProgramEpicRecord["status"];
  },
): OpenclawParityProgramEpicRecord {
  return {
    epicId: definition.epicId,
    label: definition.label,
    status: details.status ?? definition.status,
    summary: details.summary,
    nextSlice: details.nextSlice,
    blockers: details.blockers,
  };
}

function resolveProgramEpicStatus(
  definition: OpenclawParityEpicDefinition,
  followOnParity: FollowOnParityReport,
  followOnEpic?: FollowOnParityEpicRecord,
): OpenclawParityEpicDefinition["status"] {
  switch (definition.epicId) {
    case "GC-P0-06":
      if (
        followOnEpic?.state === "have_foundation"
        && followOnParity.browser.artifactStatus.hasArtifact
        && followOnParity.browser.artifactStatus.freshness === "current"
        && followOnParity.browser.artifactStatus.matchedCurrentProfile
        && followOnParity.browser.blockingIssues.length === 0
      ) {
        return "complete";
      }
      return definition.status;
    case "GC-P0-07":
      if (
        followOnEpic?.state === "have_foundation"
        && followOnParity.canvas.artifactStatus.hasArtifact
        && followOnParity.canvas.artifactStatus.freshness === "current"
        && followOnParity.canvas.artifactStatus.matchedCurrentProfile
        && followOnParity.canvas.blockingIssues.length === 0
      ) {
        return "complete";
      }
      return definition.status;
    case "GC-P1-08":
      if (
        followOnEpic?.state === "have_foundation"
        && followOnParity.companion.artifactStatus.hasArtifact
        && followOnParity.companion.artifactStatus.freshness === "current"
        && followOnParity.companion.blockingIssues.length === 0
      ) {
        return "complete";
      }
      return definition.status;
    case "GC-P2-12":
      if (hasFullVoiceProofCoverage(followOnParity)) {
        return "complete";
      }
      return definition.status;
    default:
      return definition.status;
  }
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
    case "GC-P2-12":
      if (
        followOnParity.voice.artifactStatus.hasArtifact
        && followOnParity.voice.artifactStatus.freshness === "current"
        && followOnParity.voice.artifactStatus.matchedCurrentProfile
        && followOnParity.voice.blockingIssues.length === 0
        && followOnParity.voice.recoveryActions.length === 0
      ) {
        const remainingProfiles = [
          ...followOnParity.voice.proofCoverage.staleProfiles,
          ...followOnParity.voice.proofCoverage.missingProfiles,
        ];
        return [
          blocker(
            "repo_runtime",
            remainingProfiles.length > 0
              ? `The current local-first voice proof lane is closed for ${followOnParity.deploymentProfile}, but widened hardening is still open for ${remainingProfiles.join(", ")}.`
              : "The current local-first voice proof lane is closed for the active deployment profile; remaining work is broader product hardening or any future profile widening, not missing operator evidence.",
          ),
        ];
      }
      return [
        ...repoBlockingIssues(followOnParity.voice.blockingIssues),
        ...followOnParity.voice.recoveryActions.map((action) => blocker("repo_runtime", action)),
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

function hasFullVoiceProofCoverage(followOnParity: FollowOnParityReport): boolean {
  return (
    followOnParity.voice.artifactStatus.hasArtifact
    && followOnParity.voice.artifactStatus.freshness === "current"
    && followOnParity.voice.artifactStatus.matchedCurrentProfile
    && followOnParity.voice.blockingIssues.length === 0
    && followOnParity.voice.recoveryActions.length === 0
    && followOnParity.voice.proofCoverage.currentProfiles.includes("local_dev")
    && followOnParity.voice.proofCoverage.currentProfiles.includes("trusted_local")
    && followOnParity.voice.proofCoverage.currentProfiles.includes("remote_hardened")
  );
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
