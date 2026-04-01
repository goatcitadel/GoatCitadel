export type A2UIContractId = "a2ui.v1";

export type A2UIScope = "ui_canvas" | "platform_canvas";

export type A2UITransport = "local_session" | "companion_session";

export type A2UIOperatorSurface = "mission_control";

export type A2UICapability =
  | "scene_view"
  | "selection"
  | "inspect"
  | "agent_apply"
  | "camera_input"
  | "screen_input"
  | "voice_input";

export interface A2UIContract {
  contractId: A2UIContractId;
  label: string;
  scopes: A2UIScope[];
  transports: A2UITransport[];
  operatorSurface: A2UIOperatorSurface;
  uiCapabilities: A2UICapability[];
  platformCapabilities: A2UICapability[];
  notes: string[];
}
