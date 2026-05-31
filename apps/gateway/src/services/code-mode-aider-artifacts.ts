import type {
  CapabilityArtifactRecord,
  CodeModeAiderAdapterOutcome,
  CodeModeAiderAdapterResultEnvelope,
} from "@goatcitadel/contracts";
import type { CodeModeAiderAdapterInvocationPlan } from "./code-mode-aider-adapter-plan.js";
import { parseCodeModeAiderAdapterResultEnvelope } from "./code-mode-aider-result-contract.js";

export interface CodeModeAiderArtifactPersister {
  persistText(input: {
    segments: string[];
    filename: string;
    content: string;
    mimeType: string;
  }): Promise<CapabilityArtifactRecord>;
  persistJson(input: { segments: string[]; filename: string; value: unknown }): Promise<CapabilityArtifactRecord>;
}

export interface CodeModeAiderArtifactBundleInput {
  runId: string;
  requestMarkdown: string;
  invocationPlan: CodeModeAiderAdapterInvocationPlan;
  outcome: CodeModeAiderAdapterOutcome;
  patch?: {
    kind: "unified_diff" | "git_patch";
    content: string;
    baseRef?: string;
    headRef?: string;
    fileCount?: number;
  };
  stdout?: string;
  stderr?: string;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
  command?: {
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
  };
}

export interface CodeModeAiderArtifactBundle {
  requestArtifact: CapabilityArtifactRecord;
  invocationPlanArtifact: CapabilityArtifactRecord;
  resultEnvelopeArtifact: CapabilityArtifactRecord;
  patchArtifact?: CapabilityArtifactRecord;
  stdoutArtifact?: CapabilityArtifactRecord;
  stderrArtifact?: CapabilityArtifactRecord;
  envelope: CodeModeAiderAdapterResultEnvelope;
  result: {
    aiderAdapter: {
      requestArtifact: CapabilityArtifactRecord;
      invocationPlanArtifact: CapabilityArtifactRecord;
      resultEnvelopeArtifact: CapabilityArtifactRecord;
      envelope: CodeModeAiderAdapterResultEnvelope;
    };
  };
}

export async function persistCodeModeAiderArtifactBundle(
  persister: CodeModeAiderArtifactPersister,
  input: CodeModeAiderArtifactBundleInput,
): Promise<CodeModeAiderArtifactBundle> {
  if (input.invocationPlan.runId !== input.runId) {
    throw new Error("Aider adapter invocation plan runId must match the Code Mode run.");
  }
  const segments = [input.runId, "aider"];
  const requestArtifact = await persister.persistText({
    segments,
    filename: "request.md",
    content: input.requestMarkdown,
    mimeType: "text/markdown",
  });
  const invocationPlanArtifact = await persister.persistJson({
    segments,
    filename: "invocation-plan.json",
    value: input.invocationPlan,
  });
  const patchArtifact = input.patch
    ? await persister.persistText({
        segments,
        filename: input.patch.kind === "git_patch" ? "aider.git.patch" : "aider.patch",
        content: input.patch.content,
        mimeType: "text/x-diff",
      })
    : undefined;
  const stdoutArtifact = input.stdout
    ? await persister.persistText({
        segments,
        filename: "stdout.log",
        content: input.stdout,
        mimeType: "text/plain",
      })
    : undefined;
  const stderrArtifact = input.stderr
    ? await persister.persistText({
        segments,
        filename: "stderr.log",
        content: input.stderr,
        mimeType: "text/plain",
      })
    : undefined;

  const envelope = parseCodeModeAiderAdapterResultEnvelope({
    contractVersion: 1,
    adapterId: "aider-cli-adapter",
    outcome: input.outcome,
    runId: input.runId,
    repository: input.invocationPlan.repository,
    command: {
      argvRedacted: input.invocationPlan.command.argvRedacted,
      cwdRelPath: input.invocationPlan.command.cwdRelPath,
      ...input.command,
    },
    ...(patchArtifact
      ? {
          patchArtifact: {
            kind: input.patch?.kind ?? "unified_diff",
            artifact: patchArtifact,
            baseRef: input.patch?.baseRef,
            headRef: input.patch?.headRef,
            fileCount: input.patch?.fileCount,
          },
        }
      : {}),
    ...(stdoutArtifact ? { stdoutArtifact } : {}),
    ...(stderrArtifact ? { stderrArtifact } : {}),
    ...(input.error ? { error: input.error } : {}),
    replay: input.invocationPlan.replay,
  });
  const resultEnvelopeArtifact = await persister.persistJson({
    segments,
    filename: "result-envelope.json",
    value: envelope,
  });

  return {
    requestArtifact,
    invocationPlanArtifact,
    resultEnvelopeArtifact,
    patchArtifact,
    stdoutArtifact,
    stderrArtifact,
    envelope,
    result: {
      aiderAdapter: {
        requestArtifact,
        invocationPlanArtifact,
        resultEnvelopeArtifact,
        envelope,
      },
    },
  };
}
