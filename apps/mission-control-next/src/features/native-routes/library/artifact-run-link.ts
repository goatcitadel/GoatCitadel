import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";

export function readArtifactRunId(artifact: ChatGeneratedArtifactRecord): string | undefined {
  const record = artifact as ChatGeneratedArtifactRecord & {
    runId?: string;
    durableRunId?: string;
    trace?: {
      durable?: { runId?: string };
      durableRunId?: string;
      runId?: string;
    };
  };
  return (
    record.runId ??
    record.durableRunId ??
    record.trace?.durable?.runId ??
    record.trace?.durableRunId ??
    record.trace?.runId
  );
}
