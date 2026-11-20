import type { GatewayTransport } from "@goatcitadel/mission-control-shared/api/gateway-transport";
export interface PracticeSession {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly transport: GatewayTransport;
  readonly changes: EventTarget;
  readonly sample: { active: boolean; sent: boolean; decision: "approved" | "rejected" | null; stage: number };
  update(changes: Partial<PracticeSession["sample"]>): void;
  dispose(): void;
}
export function createPracticeSession(origin?: string): PracticeSession;
