import type {
  A2UIContract,
  A2UICapability,
  FollowOnParityTargetRecord,
} from "@goatcitadel/contracts";

const UI_CANVAS_CAPABILITIES: A2UICapability[] = [
  "scene_view",
  "selection",
  "inspect",
  "agent_apply",
];

const PLATFORM_CAPABILITY_MAP: Partial<Record<string, A2UICapability>> = {
  canvas: "scene_view",
  camera: "camera_input",
  screen: "screen_input",
  voice: "voice_input",
};

export function buildA2UIContract(
  automationCatalog: FollowOnParityTargetRecord | undefined,
  platformTargets: FollowOnParityTargetRecord[],
): A2UIContract | undefined {
  if (!automationCatalog && platformTargets.length === 0) {
    return undefined;
  }

  const scopes: A2UIContract["scopes"] = [];
  const transports: A2UIContract["transports"] = [];
  const uiCapabilities: A2UICapability[] = [];
  const platformCapabilities: A2UICapability[] = [];
  const notes: string[] = [];

  if (automationCatalog) {
    scopes.push("ui_canvas");
    transports.push("local_session");
    uiCapabilities.push(...UI_CANVAS_CAPABILITIES);
    notes.push("Mission Control is the first operator surface for a2ui.v1 proof and review.");
  }

  if (platformTargets.length > 0) {
    scopes.push("platform_canvas");
    transports.push("companion_session");
    for (const target of platformTargets) {
      for (const capability of target.capabilities) {
        const mapped = PLATFORM_CAPABILITY_MAP[capability];
        if (mapped && !platformCapabilities.includes(mapped)) {
          platformCapabilities.push(mapped);
        }
      }
    }
    notes.push("Platform canvas targets inherit a2ui.v1 through companion_session, but no companion runtime is shipped yet.");
  }

  return {
    contractId: "a2ui.v1",
    label: "A2UI Operator Contract",
    scopes,
    transports,
    operatorSurface: "mission_control",
    uiCapabilities,
    platformCapabilities,
    notes,
  };
}
