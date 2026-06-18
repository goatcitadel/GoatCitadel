export type TavernMediaConnectionProfile = "high" | "balanced" | "constrained" | "data_saver" | "unknown";

export interface TavernMediaConnectionSnapshot {
  saveData?: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
}

interface BrowserNetworkInformation {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
  readonly downlink?: number;
  readonly rtt?: number;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

type NavigatorWithConnection = Navigator & {
  readonly connection?: BrowserNetworkInformation;
  readonly mozConnection?: BrowserNetworkInformation;
  readonly webkitConnection?: BrowserNetworkInformation;
};

const CONSTRAINED_VIDEO_THRESHOLD_BYTES = 8 * 1024 * 1024;
const LARGE_MEDIA_THRESHOLD_BYTES = 25 * 1024 * 1024;

export function readTavernMediaConnectionSnapshot(
  navigatorLike: NavigatorWithConnection | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as NavigatorWithConnection),
): TavernMediaConnectionSnapshot {
  const connection = navigatorLike?.connection ?? navigatorLike?.mozConnection ?? navigatorLike?.webkitConnection;
  if (!connection) {
    return {};
  }
  return {
    saveData: connection.saveData,
    effectiveType: connection.effectiveType,
    downlinkMbps: connection.downlink,
    rttMs: connection.rtt,
  };
}

export function classifyTavernMediaConnection(snapshot: TavernMediaConnectionSnapshot): TavernMediaConnectionProfile {
  if (snapshot.saveData) {
    return "data_saver";
  }
  const effectiveType = snapshot.effectiveType?.toLowerCase();
  if (effectiveType === "slow-2g" || effectiveType === "2g") {
    return "data_saver";
  }
  if (effectiveType === "3g") {
    return "constrained";
  }
  if (typeof snapshot.downlinkMbps === "number" && snapshot.downlinkMbps > 0 && snapshot.downlinkMbps < 1.5) {
    return "constrained";
  }
  if (typeof snapshot.rttMs === "number" && snapshot.rttMs >= 500) {
    return "constrained";
  }
  if (effectiveType === "4g" && typeof snapshot.downlinkMbps === "number" && snapshot.downlinkMbps >= 5) {
    return "high";
  }
  if (effectiveType === "4g" || typeof snapshot.downlinkMbps === "number" || typeof snapshot.rttMs === "number") {
    return "balanced";
  }
  return "unknown";
}

export function getCurrentTavernMediaConnectionProfile(): TavernMediaConnectionProfile {
  return classifyTavernMediaConnection(readTavernMediaConnectionSnapshot());
}

export function shouldDeferTavernInlineMedia(input: {
  kind: "audio" | "video";
  sizeBytes: number;
  profile: TavernMediaConnectionProfile;
}): boolean {
  if (input.kind === "audio") {
    return input.profile === "data_saver" && input.sizeBytes > LARGE_MEDIA_THRESHOLD_BYTES;
  }
  if (input.profile === "data_saver") {
    return true;
  }
  if (input.profile === "constrained") {
    return input.sizeBytes > CONSTRAINED_VIDEO_THRESHOLD_BYTES;
  }
  return input.sizeBytes > LARGE_MEDIA_THRESHOLD_BYTES && input.profile !== "high";
}

export function tavernMediaPreloadForProfile(input: {
  kind: "audio" | "video";
  profile: TavernMediaConnectionProfile;
}): "none" | "metadata" {
  if (input.kind === "audio") {
    return "metadata";
  }
  return input.profile === "data_saver" || input.profile === "constrained" ? "none" : "metadata";
}
