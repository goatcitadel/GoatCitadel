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
