/**
 * Office page data types extracted from OfficePage.tsx (Step 10).
 */

import type { RealtimeEvent } from "../../api/client";
import type { AgentDirectoryRecord } from "../../data/agent-roster";
import type { OfficeZoneId } from "../../data/office-zones";
import type { OfficeAttentionLevel, OfficeDeskAgent } from "../../components/OfficeCanvas";

export type AgentRisk = "none" | "approval" | "blocked" | "error";

export interface OfficeAgentModel extends AgentDirectoryRecord {
  currentAction: string;
  currentThought: string;
  taskId?: string;
  sessionId?: string;
  currentTaskLabel: string;
  lastSeenAt?: string;
  lastEventType?: string;
  risk: AgentRisk;
  eventTrail: RealtimeEvent[];
  activityState: OfficeDeskAgent["activityState"];
  collabPeers: string[];
  zoneId: OfficeZoneId;
  zoneLabel: string;
  attentionLevel: OfficeAttentionLevel;
  behaviorDirective: string;
  workloadScore: number;
}

export interface OfficeZoneTelemetry {
  zoneId: OfficeZoneId;
  label: string;
  totalAgents: number;
  activeAgents: number;
  linkedAgents: number;
  alertAgents: number;
  focus: string;
  attentionLevel: OfficeAttentionLevel;
  workloadScore: number;
  lastSignalAt?: string;
  laneCount: number;
  landmark: string;
  architectureNote: string;
}

export interface OfficeZoneActivityLane {
  fromZoneId: OfficeZoneId;
  toZoneId: OfficeZoneId;
  fromLabel: string;
  toLabel: string;
  strength: number;
  count: number;
  risk: boolean;
  label: string;
}

export interface OfficeSignalRoute {
  roleId: string;
  zoneId: OfficeZoneId;
  kind: "approval" | "blocked" | "error";
  label: string;
  intensity: number;
}

export interface AgentHandoff {
  label: string;
  detail: string;
  timestamp?: string;
}

export interface OfficeAssetPack {
  operatorModelPath?: string;
  goatModelPath?: string;
  goatModelVariant?: "animated" | "fallback" | "procedural";
  goatModelLabel?: string;
  roomFloorTilePath?: string;
  roomWallPath?: string;
  roomWindowWallPath?: string;
  roomColumnPath?: string;
  roomLightPath?: string;
  deskModelPath?: string;
  commandDeskModelPath?: string;
  chairModelPath?: string;
  lockerModelPath?: string;
  shelfModelPath?: string;
  crateModelPath?: string;
  accessPointModelPath?: string;
  computerModelPath?: string;
  mugModelPath?: string;
}
