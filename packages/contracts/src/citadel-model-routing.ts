// Model routing by data sensitivity.
//
// Implements §14.1 classification + §14.2 routing policy from the Citadels spec.
// Each ChamberSensitivity level maps to exactly one ModelRoutingDecision.

import type { ChamberSensitivity } from "./citadels.js";

export type ModelRoutingDecision =
  | "any_approved" // Public: any approved model
  | "approved_cloud_or_local" // Internal: approved cloud/local
  | "cloud_with_approval" // Private: cloud only with user-approved provider
  | "prefer_local" // Sensitive: prefer local; cloud requires explicit disclosure
  | "local_only" // Restricted: local-only by default
  | "never_send"; // Secret: never send unless manually approved

export function routeModelForSensitivity(sensitivity: ChamberSensitivity): ModelRoutingDecision {
  switch (sensitivity) {
    case "public":
      return "any_approved";
    case "internal":
      return "approved_cloud_or_local";
    case "private":
      return "cloud_with_approval";
    case "sensitive":
      return "prefer_local";
    case "restricted":
      return "local_only";
    case "secret":
      return "never_send";
  }
}

// Provider posture for a routing decision. Aggregators (OpenRouter-style
// routers) are cloud providers whose ultimate model host is obscured, so they
// can never satisfy a local posture and must not be silently escalated to
// when the decision prefers local execution.
export interface ModelRouteProviderPosture {
  /** Model runs on the operator's machine (llama.cpp, Ollama, LM Studio, …). */
  isLocal: boolean;
  /** Cloud router that forwards to third-party hosts (see isAggregatorProvider). */
  isAggregator: boolean;
}

export type ModelRouteVerdict =
  | "allowed"
  | "requires_approval" // allowed only via a user-approved provider profile
  | "requires_disclosure" // allowed only with explicit cloud-use disclosure
  | "denied";

/**
 * Evaluates whether a provider posture may serve a data-sensitivity routing
 * decision. Deny-wins semantics; approval/disclosure verdicts are gates the
 * caller must resolve, not soft hints. `never_send` is denied for every
 * posture — a manual operator override lives outside this function.
 */
export function evaluateModelRouteForProvider(
  decision: ModelRoutingDecision,
  posture: ModelRouteProviderPosture,
): ModelRouteVerdict {
  if (decision === "never_send") {
    return "denied";
  }
  if (posture.isLocal && !posture.isAggregator) {
    // A local host is at least as restrictive as every non-secret decision.
    return "allowed";
  }
  switch (decision) {
    case "any_approved":
    case "approved_cloud_or_local":
      return "allowed";
    case "cloud_with_approval":
      return "requires_approval";
    case "prefer_local":
      // Plain cloud may be used with explicit disclosure; an aggregator may
      // not — its ultimate host is obscured, so escalation would be silent.
      return posture.isAggregator ? "denied" : "requires_disclosure";
    case "local_only":
      return "denied";
  }
}
