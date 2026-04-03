import type { Storage } from "@goatcitadel/storage";
import type { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { LlmService } from "./llm-service.js";
import type { RuntimeSettings } from "./gateway-service.js";

/**
 * Shared dependency bag passed to extracted sub-services.
 *
 * Every field mirrors a property (or thin wrapper) that GatewayService
 * already exposes internally.  Extracted services receive a readonly
 * reference instead of holding a back-pointer to the whole God Object.
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
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
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
