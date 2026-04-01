import type { FollowOnParityReport, FollowOnProofLaneStepRecord, VoiceProofLaneDraft } from "@goatcitadel/contracts";
import { GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS } from "./follow-on-proof-lane-metadata.js";

const VOICE_PROOF_LANE = GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS.voice;

export function buildVoiceProofLaneDraft(report: FollowOnParityReport): VoiceProofLaneDraft {
  const generatedAt = new Date().toISOString();
  const runtimeReady = report.voice.runtimeReadiness === "ready";
  const modelReady = Boolean(report.voice.selectedModelId);
  const voiceReady = runtimeReady && modelReady;
  const recoveryActions = buildVoiceRecoveryActions(report);
  const steps: FollowOnProofLaneStepRecord[] = [
    {
      stepId: "preflight",
      title: "Confirm voice runtime posture",
      status: voiceReady ? "ready" : "blocked",
      instructions: voiceReady
        ? `Confirm the managed voice runtime is ${report.voice.runtimeReadiness}, the selected model is ${report.voice.selectedModelId}, and current talk/wake state is visible before starting the proof run.`
        : "Install or repair the managed voice runtime and select an active local model before attempting the voice proof lane.",
      evidenceHint: "Capture the live runtime readiness, selected model, and current talk/wake state from System or Settings.",
    },
    {
      stepId: "transcription",
      title: "Run a one-shot transcription pass",
      status: voiceReady ? "ready" : "blocked",
      instructions: "Transcribe one local audio sample and confirm the transcript returns without falling back to a missing-runtime or missing-model error.",
      evidenceHint: "Record the input sample, transcript output, and any runtime warnings.",
    },
    {
      stepId: "talk-cycle",
      title: "Run a Talk Mode start/stop cycle",
      status: voiceReady ? "ready" : "blocked",
      instructions: report.voice.talkState === "running"
        ? "Stop the current talk session first, then start a fresh session and stop it cleanly to prove state transitions."
        : "Start a fresh talk session, verify the running state becomes visible, then stop it cleanly.",
      evidenceHint: "Capture session ids, visible state transitions, and any operator-facing failure text.",
    },
    {
      stepId: "wake-cycle",
      title: "Run a Wake Mode enable/disable cycle",
      status: voiceReady ? "ready" : "blocked",
      instructions: report.voice.wakeEnabled
        ? "Disable the current wake listener, then re-enable and disable it once more to prove operator control and state visibility."
        : "Enable the wake listener once, confirm the running state becomes visible, then disable it again.",
      evidenceHint: "Record wake enabled/state transitions and any readiness or model errors.",
    },
    {
      stepId: "bundle",
      title: "Complete the voice proof bundle",
      status: voiceReady ? "ready" : "blocked",
      instructions: `Fill ${VOICE_PROOF_LANE.templatePath} using ${VOICE_PROOF_LANE.checklistPath}.`,
      evidenceHint: "Attach transcript output, talk/wake state transitions, runtime notes, and recovery steps for any failures.",
    },
  ];

  const blockingIssues = [
    ...report.voice.blockingIssues,
    ...steps.filter((step) => step.status === "blocked").map((step) => `${step.title} is blocked.`),
  ];
  const summary = voiceReady
    ? `Voice proof lane is ready with runtime ${report.voice.runtimeReadiness}, model ${report.voice.selectedModelId}, talk ${report.voice.talkState}, and wake ${report.voice.wakeEnabled ? report.voice.wakeState : "disabled"}.`
    : "Voice proof lane is blocked until the managed runtime is ready and a local model is selected.";

  return {
    generatedAt,
    deploymentProfile: report.deploymentProfile,
    authMode: report.authMode,
    summary,
    checklistPath: VOICE_PROOF_LANE.checklistPath,
    templatePath: VOICE_PROOF_LANE.templatePath,
    blockingIssues: Array.from(new Set(blockingIssues)),
    recoveryActions,
    steps,
    markdown: buildVoiceProofLaneMarkdown(report, generatedAt, summary, recoveryActions, steps),
  };
}

export function buildVoiceProofLaneArtifactPath(draft: VoiceProofLaneDraft): string {
  const day = draft.generatedAt.slice(0, 10);
  const timestamp = draft.generatedAt
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return `${VOICE_PROOF_LANE.artifactRoot}/${day}/voice-proof-bundle-${draft.deploymentProfile}-${timestamp}.md`;
}

function buildVoiceProofLaneMarkdown(
  report: FollowOnParityReport,
  generatedAt: string,
  summary: string,
  recoveryActions: string[],
  steps: FollowOnProofLaneStepRecord[],
): string {
  return [
    "# Voice Wake And Talk Proof Bundle Draft",
    "",
    `Generated: ${generatedAt}`,
    `Deployment profile: ${report.deploymentProfile}`,
    `Auth mode: ${report.authMode}`,
    `Checklist: ${VOICE_PROOF_LANE.checklistPath}`,
    `Template: ${VOICE_PROOF_LANE.templatePath}`,
    "",
    "## Summary",
    summary,
    "",
    "## Live Runtime Snapshot",
    `- Runtime readiness: ${report.voice.runtimeReadiness}`,
    `- Selected model: ${report.voice.selectedModelId ?? "none"}`,
    `- Talk state: ${report.voice.talkState}`,
    `- Wake state: ${report.voice.wakeEnabled ? report.voice.wakeState : "disabled"}`,
    `- Last error: ${report.voice.lastError ?? "none"}`,
    "",
    "## Recovery Actions",
    ...(recoveryActions.length > 0
      ? recoveryActions.map((action, index) => `${index + 1}. ${action}`)
      : ["1. No recovery actions are currently active. Voice is ready for the next proof-lane run."]),
    "",
    "## Lane Steps",
    ...steps.flatMap((step, index) => [
      `${index + 1}. ${step.title} [${step.status}]`,
      `Instructions: ${step.instructions}`,
      `Evidence: ${step.evidenceHint}`,
      "",
    ]),
  ].join("\n");
}

function buildVoiceRecoveryActions(report: FollowOnParityReport): string[] {
  return report.voice.recoveryActions;
}
