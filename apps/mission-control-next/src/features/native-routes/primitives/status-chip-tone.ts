import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { StatusChipTone } from "./StatusChip";

const tones: Readonly<Record<StatusTone, StatusChipTone>> = {
  running: "live",
  waiting: "warning",
  done: "success",
  failed: "critical",
  neutral: "muted",
};

export function statusChipTone(tone: StatusTone): StatusChipTone {
  return tones[tone];
}
