import type { Storage } from "@goatcitadel/storage";
import type { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { LlmService } from "./llm-service.js";
import type { RuntimeSettings } from "./gateway-service.js";

/**
 * Transitional shared dependency bag for services that still need more than a
 * tiny local contract.
 *
 * New or newly-narrowed services should prefer dedicated local interfaces or
 * `Pick<>` contracts over accepting this full bag by default.
 */
export interface ServiceContext {
  readonly storage: Storage;
  readonly config: GatewayRuntimeConfig;
  readonly llmService: LlmService;
  readonly policyEngine: ToolPolicyEngine;

  /** Thin delegate – appends a realtime event and emits it. */
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;

  /** Throws if the given feature flag is disabled. */
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void;

  /** Returns whether the given feature flag is enabled. */
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean;

  /** Returns the raw gateway SQL handle (better-sqlite3 Database). */
  readonly gatewaySql: Storage["gatewaySql"];

  /** Normalizes an optional workspace id to a safe default. */
  normalizeWorkspaceId(workspaceId?: string): string;
}
