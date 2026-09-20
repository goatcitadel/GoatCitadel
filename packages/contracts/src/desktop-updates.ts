/** Installation metadata owned by the native desktop host, never runtime authority. */
export type DesktopUpdateChannel = "stable" | "preview";
export interface DesktopUpdateAsset {
  name: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}
export interface DesktopUpdateRelease {
  version: string;
  sourceCommit: string;
  buildSequence: number;
  tag: string;
  channel: DesktopUpdateChannel;
  publishedAt: string;
  releaseNotes: string;
  installer: DesktopUpdateAsset;
  publisherSigned: boolean;
}
export interface DesktopUpdateStatus {
  channel: DesktopUpdateChannel;
  phase: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  installedVersion: string;
  installedCommit: string | null;
  availableRelease: DesktopUpdateRelease | null;
  lastSuccessfulCheck: string | null;
  nextCheckAt: string | null;
  snoozedUntil: string | null;
  downloadedBytes: number;
  downloadedPath: string | null;
  message: string;
}
export type DesktopUpdateAction = "status" | "check" | "download" | "reveal" | "notes" | "snooze" | "channel";
export interface DesktopUpdateRequest {
  type: "goatcitadel.updates.request";
  requestId: string;
  action: DesktopUpdateAction;
  channel?: DesktopUpdateChannel;
  releaseTag?: string;
}
export interface DesktopUpdateResponse {
  type: "goatcitadel.updates.status";
  requestId?: string;
  error?: string | null;
  status: DesktopUpdateStatus;
}
