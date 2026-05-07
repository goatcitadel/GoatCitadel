export function looksLikePromptLabGuidanceLoadingSummaryPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bworkspace\b/.test(normalized) &&
    /\bguidance\b/.test(normalized) &&
    (/\bglobal\b/.test(normalized) || /\brepo\b/.test(normalized) || /\bchain\b/.test(normalized)) &&
    (/\brepo docs?\b/.test(normalized) ||
      /\brepo\b[\s,/-]*docs?\b/.test(normalized) ||
      /\bguidance loading chain\b/.test(normalized) ||
      /\bguidance loading path\b/.test(normalized)) &&
    (/\bload(?:ed|ing)?\b/.test(normalized) || /\bpath\b/.test(normalized) || /\bchain\b/.test(normalized)) &&
    !/\bmemory\b/.test(normalized)
  );
}

export function looksLikeWorkspaceGuidancePrecedencePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bworkspace\b/.test(normalized) &&
    /\bguidance\b/.test(normalized) &&
    (/\bprecedence\b/.test(normalized) || /\boverride\b/.test(normalized)) &&
    (/\boperator-visible\b/.test(normalized) ||
      /\bexact assertions needed\b/.test(normalized) ||
      /\bexact minimal automated check\b/.test(normalized) ||
      /\bexact minimal automated test\b/.test(normalized))
  );
}

export function looksLikePromptLabDurableRunClaimExclusivityPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\btwo workers\b/.test(normalized) && /\bsame queued durable run\b/.test(normalized) && /\bclaim\b/.test(normalized)
  );
}

export function looksLikePromptLabDurableRunLeaseRecoveryPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bexpired durable-run lease\b|\bexpired durable run lease\b/.test(normalized) &&
    /\bdifferent worker\b/.test(normalized) &&
    /\b(still-active leased run|still active leased run|active lease)\b/.test(normalized)
  );
}

export function looksLikePromptLabDurableRunRetryBackoffPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bretry-gated queued durable runs\b|\bretry gated queued durable runs\b/.test(normalized) &&
    /\bbackoff window expires\b|\bbackoff window\b/.test(normalized)
  );
}

export function looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bwaiting\b/.test(normalized) &&
    /\bpaused\b/.test(normalized) &&
    /\bterminal\b/.test(normalized) &&
    /\brelease any active lease\b/.test(normalized)
  );
}

export function looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bapproval\b/.test(normalized) &&
    /\bwake\b/.test(normalized) &&
    /\b(ordering|before confirmed wake|confirmed wake|approval-wait|approval wait)\b/.test(normalized) &&
    /\bexact minimal automated check\b|\bexact minimal automated test\b|\btarget test file\b/.test(normalized)
  );
}

export function looksLikePromptLabDurableRunMinimalTestPrompt(userTask: string | undefined): boolean {
  return (
    looksLikePromptLabDurableRunClaimExclusivityPrompt(userTask) ||
    looksLikePromptLabDurableRunLeaseRecoveryPrompt(userTask) ||
    looksLikePromptLabDurableRunRetryBackoffPrompt(userTask) ||
    looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt(userTask) ||
    looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask)
  );
}

export function looksLikePromptLabLifecycleCanonicalLinkagePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bruntime lifecycle\b/.test(normalized) &&
    /\bcanonical\b/.test(normalized) &&
    /\blinkage\b/.test(normalized) &&
    /\bpayload\b/.test(normalized) &&
    /\bpreview\b/.test(normalized) &&
    /\b(inferred|inference)\b/.test(normalized) &&
    (/\bdiagnostics\b/.test(normalized) || /\bfallback path\b/.test(normalized))
  );
}

export function looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bruntime lifecycle\b/.test(normalized) &&
    /\bcanonical linkage\b/.test(normalized) &&
    /\binferred linkage\b/.test(normalized) &&
    /\bmissing linkage\b/.test(normalized) &&
    /\bapprovals?\b/.test(normalized) &&
    /\bdurable runs?\b/.test(normalized) &&
    /\bsessions?\b/.test(normalized) &&
    /\bturns?\b/.test(normalized)
  );
}

export function looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bdurable-run wake logic\b|\bdurable run wake logic\b/.test(normalized) &&
    /\bapproval wake helpers?\b/.test(normalized) &&
    /\boperator resume path\b|\boperator resume\b/.test(normalized)
  );
}

export function looksLikePromptLabRealtimeEventMetadataPropagationPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\beventclass\b/.test(normalized) &&
    /\beventauthority\b/.test(normalized) &&
    /\blinks\b/.test(normalized) &&
    /\bproducer\b/.test(normalized) &&
    /\bstorage\b/.test(normalized) &&
    /\boperator-facing api\b|\boperator facing api\b/.test(normalized)
  );
}

export function looksLikePromptLabEventEnvelopeAuthorityPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bevent\b/.test(normalized) &&
    /\b(publishing|storage|publishing and storage)\b/.test(normalized) &&
    /\beventclass\b/.test(normalized) &&
    /\beventauthority\b/.test(normalized) &&
    /\blinks\b/.test(normalized) &&
    /\binference still required\b|\bnot found\b/.test(normalized)
  );
}

export function looksLikePromptLabEventLinkPropagationCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bevent\b/.test(normalized) &&
    /\blinks?\b/.test(normalized) &&
    /\bclassification\b/.test(normalized) &&
    /\bproducer\b/.test(normalized) &&
    /\boperator-visible\b|\boperator visible\b|\bapi\b|\bui\b/.test(normalized) &&
    /\b(role-labeled|role labeled|architect|qa|product|ops|researcher)\b/.test(normalized)
  );
}

export function looksLikePromptLabApprovalWakeFlowPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bapproval wait\b/.test(normalized) &&
    /\bwake\b/.test(normalized) &&
    /\b(event emission|operational event|publishrealtime|realtime event)\b/.test(normalized)
  );
}

export function looksLikeWorkspaceRoutesGuidanceCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\bworkspace routes\b/.test(normalized) &&
      /\bguidance docs?\b/.test(normalized) &&
      /\brelated services\b/.test(normalized) &&
      /\bfirst fresh regression checks to add\b/.test(normalized)) ||
    (/\bworkspace loading\b/.test(normalized) &&
      /\bguidance docs?\b/.test(normalized) &&
      /\bproject[- ]binding behavior\b/.test(normalized) &&
      /\beffective override chain\b/.test(normalized))
  );
}

export function looksLikePromptLabGuidanceRegressionSliceCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bguidance\b/.test(normalized) &&
    /\bprecedence\b/.test(normalized) &&
    /\brepo(?:-| )?binding\b|\bproject binding\b|\boverride clarity\b|\boperator-visible override\b/.test(normalized) &&
    /\bfresh regression slice\b|\bsmallest fresh regression\b|\bregression slice\b/.test(normalized)
  );
}

export function looksLikePromptLabMemoryLifecycleCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bmemory\b/.test(normalized) &&
    /\b(lifecycle|routes?|services?|ui|copy|operator-facing|operator facing)\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|architect|qa|product|ops|synthesis)\b/.test(normalized)
  );
}

export function looksLikePromptLabCronReportCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\b(cron|scheduled|review queue|update-review|update review)\b/.test(normalized) &&
    /\b(report|cost|status|operator)\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|architect|qa|product|ops|synthesis)\b/.test(normalized)
  );
}

export function looksLikePromptLabRank1HardeningCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\b(rank[- ]?1|rank 1|hardening|cross-system|cross system)\b/.test(normalized) &&
    /\b(approval|wake|durable|lifecycle)\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|architect|qa|product|ops|synthesis)\b/.test(normalized)
  );
}

export function looksLikePromptLabApprovalPartialFailureCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bapproval resolution\b/.test(normalized) &&
    /\bwake helpers?\b/.test(normalized) &&
    /\bdownstream effect visibility\b/.test(normalized) &&
    /\bpartial[- ]failure cases?\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|product|qa)\b/.test(normalized)
  );
}

export function looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\btyped wake outcome contract\b/.test(normalized) &&
      /\bdurable-run wake logic\b|\bdurable wake logic\b/.test(normalized) &&
      /\bapproval-wait wake handling\b|\bapproval wait wake handling\b/.test(normalized)) ||
    (/\btyped wake outcomes?\b/.test(normalized) &&
      /\bcontract file\b/.test(normalized) &&
      /\bproducer call sites?\b|\bproducer\b/.test(normalized) &&
      /\bconsumer\/status shaping\b|\bconsumer or status shaping\b|\bconsumer\b/.test(normalized) &&
      /\bcompatibility note\b/.test(normalized) &&
      /\bvalidation path\b|\bvalidation step\b/.test(normalized))
  );
}

export function looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\btyped wake outcomes?\b/.test(normalized) &&
    (/\bcontract file\b/.test(normalized) || /\bname the contract file\b/.test(normalized)) &&
    (/\bproducer call sites?\b/.test(normalized) || /\bproducer\b/.test(normalized)) &&
    (/\bconsumer\/status shaping\b/.test(normalized) ||
      /\bconsumer or status shaping\b/.test(normalized) ||
      (/\bconsumer\b/.test(normalized) && /\bstatus\b/.test(normalized))) &&
    (/\bvalidation step\b/.test(normalized) || /\bvalidation path\b/.test(normalized)) &&
    /\bpatch points?\b/.test(normalized)
  );
}

export function looksLikePromptLabPromptPackGateSelectionTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bgate selection\b/.test(normalized) &&
    /\bexpansion pack\b/.test(normalized) &&
    /\bolder baseline\b|\bbaseline\b/.test(normalized)
  );
}

export function looksLikePromptLabCoworkExtraHeadingMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bcowork\b/.test(normalized) &&
    (/\bextra headings?\b/.test(normalized) || /\bfake cowork headings?\b/.test(normalized)) &&
    /\binline contract echoes?\b|\bcontract echoes?\b|\bprompt lab\b/.test(normalized) &&
    /\bexact minimal automated (?:test|check)\b|\bpropose the exact minimal automated\b/.test(normalized)
  );
}

export function looksLikePromptLabWrappedDependentsParserTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return /\bpnpm outdated -r\b/.test(normalized) && /\bdependents column wraps?\b/.test(normalized);
}

export function looksLikePromptLabSkillExtraOverlapInstallTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\boverlapping skill families\b|\bduplicate skill famil/.test(normalized) &&
    /\bskills\/extra\b/.test(normalized) &&
    /\bblocked\b|\breject\b|\bprevent/.test(normalized)
  );
}

export function looksLikePromptLabPromptPackV2DistinctTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bgoatcitadel_prompt_pack_v2\.md\b/.test(normalized) &&
    (/\bparse(?:s|d)? cleanly\b/.test(normalized) || /\bparses cleanly\b/.test(normalized)) &&
    /\b(frozen baseline|baseline fixture|remains distinct|distinct from)\b/.test(normalized)
  );
}

export function looksLikePromptLabEnvSourceLabelMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\benv-loaded prompt pack\b|\benv loaded prompt pack\b/.test(normalized) && /\bsource label\b/.test(normalized)
  );
}

export function looksLikePromptLabJudgeDefaultsMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bjudge defaults?\b/.test(normalized) &&
    /\bexpanded pack\b/.test(normalized) &&
    (/\bfrozen baseline\b/.test(normalized) || /\bbaseline\b/.test(normalized))
  );
}

export function looksLikePromptLabPromptPackParserRegressionPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    looksLikePromptLabPromptPackV2DistinctTestPrompt(userTask) ||
    (/\bgoatcitadel_prompt_pack_v2\.md\b/.test(normalized) &&
      (/\bparse(?:s|d)? cleanly\b/.test(normalized) || /\bparsing path\b/.test(normalized)) &&
      (/\bfrozen baseline\b/.test(normalized) || /\bbaseline fixture\b/.test(normalized)) &&
      /\b(regression test|parser-focused regression|parser focused regression)\b/.test(normalized))
  );
}

export function looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bwake lifecycle writes reflect actual outcome ordering\b/.test(normalized) &&
    /\bapproval-wait storage\b|\bapproval wait storage\b/.test(normalized) &&
    /\bdurable wake calls\b/.test(normalized)
  );
}

export function looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bpersisted leases\b/.test(normalized) &&
    /\bdurable-run storage\b|\bdurable run storage\b/.test(normalized) &&
    /\bclaim logic\b/.test(normalized) &&
    /\brecovery logic\b/.test(normalized)
  );
}

export function looksLikePromptLabLifecycleProvenancePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bcanonical-linkage-first reads\b|\bcanonical linkage first reads\b/.test(normalized) &&
    /\bprovenance fields?\b/.test(normalized) &&
    /\blifecycle assembly\b/.test(normalized)
  );
}

export function looksLikePromptLabMissionControlTruthLabelingPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bmission control truth labeling\b/.test(normalized) &&
    /\bcanonical\b/.test(normalized) &&
    /\binferred\b/.test(normalized) &&
    /\bmissing links?\b/.test(normalized)
  );
}

export function looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\bexplicit event authority envelope\b/.test(normalized) ||
      (/\bevent producers\b/.test(normalized) &&
        /\brealtime-event storage\b|\brealtime event storage\b/.test(normalized) &&
        /\brelated contracts\b/.test(normalized))) &&
    /\beventclass\b/.test(normalized) &&
    /\beventauthority\b/.test(normalized) &&
    /\blinks\b/.test(normalized)
  );
}

export function looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\btwo-worker harness coverage\b|\btwo worker harness coverage\b/.test(normalized) ||
      (/\btwo-worker\b|\btwo worker\b/.test(normalized) &&
        /\bclaim\b/.test(normalized) &&
        /\brecovery\b/.test(normalized) &&
        /\bsingle-process\b|\bsingle process\b/.test(normalized))) &&
    (/\bclaim race\b/.test(normalized) || /\bclaim and recovery test\b/.test(normalized))
  );
}

export function looksLikePromptLabApprovalEffectsHardeningPatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\bapproval-effects hardening\b|\bapproval effects hardening\b/.test(normalized) ||
      (/\bapproval resolution\b/.test(normalized) &&
        /\bdownstream effect handling\b/.test(normalized) &&
        /\bcanonical approval state\b/.test(normalized))) &&
    /\bidempotent effect tracking\b|\boutbox path\b/.test(normalized) &&
    /\bcanonical approval state\b/.test(normalized)
  );
}

export function looksLikeSkillImportOverlapCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /skill-import-service\.ts/.test(normalized) &&
    /\boverlap\b/.test(normalized) &&
    /\b(next|fresh)\b/.test(normalized) &&
    /\bcases?\b/.test(normalized)
  );
}

export function looksLikePromptPackRepoBindingCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\brepo-binding\b|\brepo binding\b/.test(normalized) &&
    /\btool-path resolution\b|\btool path resolution\b/.test(normalized) &&
    /\bnegative-result honesty checks\b|\bnegative result honesty checks\b/.test(normalized)
  );
}
