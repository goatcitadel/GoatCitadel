import type {
  A2UICapability,
  CompanionAuthRequirement,
  CompanionBootstrapFeature,
  CompanionContract,
  CompanionServerPrerequisite,
  CompanionTransportLane,
  FollowOnParityTargetRecord,
} from "@goatcitadel/contracts";

const ANDROID_TARGET_ID = "platform.android-canvas-camera-screen";

const PLATFORM_CAPABILITY_MAP: Partial<Record<string, A2UICapability>> = {
  canvas: "scene_view",
  camera: "camera_input",
  screen: "screen_input",
  voice: "voice_input",
};

const TRANSPORT_LANES: CompanionTransportLane[] = [
  "foreground_sse",
  "push_refresh",
  "manual_refresh",
];

const AUTH_REQUIREMENTS: CompanionAuthRequirement[] = [
  "device_identity",
  "short_lived_access_token",
  "rotating_refresh_token",
  "request_signing",
  "replay_protection",
];

const SERVER_PREREQUISITES: CompanionServerPrerequisite[] = [
  "device_pairing",
  "token_rotation",
  "request_signing",
  "sse_resume",
  "per_device_audit",
];

const BOOTSTRAP_FEATURES: CompanionBootstrapFeature[] = [
  "dashboard",
  "chat",
  "approvals",
  "tasks",
  "settings",
  "event_feed",
];

export function buildCompanionContract(
  platformTargets: FollowOnParityTargetRecord[],
  options: {
    androidRuntimeProven?: boolean;
  } = {},
): CompanionContract | undefined {
  const androidTarget = platformTargets.find((target) => target.catalogId === ANDROID_TARGET_ID);
  if (!androidTarget) {
    return undefined;
  }

  const deviceCapabilities = androidTarget.capabilities.reduce<A2UICapability[]>((acc, capability) => {
    const mapped = PLATFORM_CAPABILITY_MAP[capability];
    if (mapped && !acc.includes(mapped)) {
      acc.push(mapped);
    }
    return acc;
  }, []);

  return {
    contractId: "companion.android.v1",
    label: "Android Companion Bootstrap Contract",
    pairedSurfaceContractId: "a2ui.v1",
    primaryTarget: "android",
    bootstrapStatus: "server_foundation",
    repoStrategy: "separate_repo",
    bootstrapRepo: "GoatCitadel-mobile",
    targetCatalogIds: platformTargets.map((target) => target.catalogId),
    deviceCapabilities,
    transportLanes: TRANSPORT_LANES,
    authRequirements: AUTH_REQUIREMENTS,
    serverPrerequisites: SERVER_PREREQUISITES,
    bootstrapFeatures: BOOTSTRAP_FEATURES,
    notes: [
      "Android is the first companion bootstrap target and should ship from the separate GoatCitadel-mobile repo, not this monorepo.",
      "Foreground SSE with resume is the primary realtime lane; push refresh and manual refresh cover background/mobile constraints.",
      options.androidRuntimeProven
        ? "Live gateway proof now covers companion session exchange, refresh rotation, signed mutation verification, replay protection, and SSE resume, and Android runtime/UI proof is now on file for the separate mobile repo."
        : "Live gateway proof now covers companion session exchange, refresh rotation, signed mutation verification, replay protection, and SSE resume; the remaining gap is Android runtime/UI proof in the separate mobile repo.",
    ],
  };
}
