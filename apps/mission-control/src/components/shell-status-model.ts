import type { WorkTrustTone } from "../pages/chat/work-trust";

export interface ShellStatusEntry {
  id: string;
  label: string;
  value: string;
  note?: string;
  tone?: WorkTrustTone;
  actionLabel?: string;
}

export interface StatusCenterSection {
  id: string;
  title: string;
  summary: string;
  entries: ShellStatusEntry[];
}

export interface ShellStatusSummary {
  tone: WorkTrustTone;
  label: string;
  note: string;
  approvalCount: number;
  sections: StatusCenterSection[];
}
