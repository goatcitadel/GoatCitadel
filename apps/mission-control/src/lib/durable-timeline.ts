import type { DurableRunTimelineEvent } from "@goatcitadel/contracts";

export interface DurableTimelinePresentation {
  label: string;
  detail?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function describeDurableTimelineEvent(
  event: Pick<DurableRunTimelineEvent, "eventType" | "payload" | "stepKey">,
): DurableTimelinePresentation {
  const payload = event.payload ?? {};
  const actorId = readString(payload.actorId);
  const previousStatus = readString(payload.previousStatus);
  const phaseId = readString(payload.phaseId);
  const waveId = readString(payload.waveId);
  const reason = readString(payload.reason);
  const eventKey = readString(payload.eventKey);

  switch (event.eventType) {
    case "run_created":
      return { label: "Run created" };
    case "run_started":
      if (phaseId || waveId) {
        return {
          label: "Execution started",
          detail: [waveId, phaseId].filter(Boolean).join(" · "),
        };
      }
      return { label: "Worker picked up run" };
    case "run_paused":
      if (actorId === "orchestration" && previousStatus === "queued") {
        return { label: "Held until explicit start" };
      }
      if (actorId === "orchestration" && previousStatus === "running") {
        return {
          label: "Worker parked for approval",
          detail: reason,
        };
      }
      return {
        label: "Run paused",
        detail: reason ?? [actorId, previousStatus].filter(Boolean).join(" · "),
      };
    case "run_resumed":
      if (phaseId || waveId) {
        return {
          label: "Execution resumed",
          detail: [waveId, phaseId].filter(Boolean).join(" · "),
        };
      }
      if (actorId === "orchestration" && previousStatus === "paused") {
        return { label: "Released to worker" };
      }
      return {
        label: "Run resumed",
        detail: [actorId, previousStatus].filter(Boolean).join(" · "),
      };
    case "run_waiting":
      return {
        label: "Waiting for event",
        detail: eventKey,
      };
    case "run_woken":
      return {
        label: "Wake event received",
        detail: eventKey,
      };
    case "run_retry_scheduled":
      return { label: "Retry scheduled", detail: reason };
    case "run_cancelled":
      return { label: "Run cancelled", detail: actorId };
    case "run_completed":
      return { label: "Run completed" };
    case "run_failed":
      return { label: "Run failed", detail: reason };
    case "run_dead_lettered":
      return { label: "Moved to dead letter", detail: reason };
    case "dead_letter_recovered":
      return { label: "Recovered from dead letter", detail: actorId };
    default:
      return {
        label: String(event.eventType).replaceAll("_", " "),
      };
  }
}
