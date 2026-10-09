import type { ChannelSetupTestResult, ChannelSetupFinalizationEligibility, IntegrationConnection, ChannelProbeStepRecord } from "@goatcitadel/contracts";

/** The Gateway classifies exceptions; warning text and UI actions cannot waive required checks. */
export function evaluateChannelSetupEligibility(result: ChannelSetupTestResult, connection: IntegrationConnection, cleanupAcknowledged = false): ChannelSetupFinalizationEligibility {
  const blockingReasons: string[] = [];
  let requiresAcknowledgement = false;
  const receipt = result.probe?.steps.some((step) => step.key.endsWith("_sandbox_send") && step.status === "pass" && Boolean(step.providerMessageId));
  const optionalCleanup = (step: ChannelProbeStepRecord | undefined) => step?.status === "warn" && step.disposition === "advisory" && step.key.endsWith("_sandbox_cleanup") && receipt;
  const requireCleanup = () => {
    if (cleanupAcknowledged) return;
    requiresAcknowledgement = true;
    blockingReasons.push("The sandbox message was accepted, but cleanup needs an explicit operator acknowledgement.");
  };
  if (result.status === "error") blockingReasons.push("Required setup checks failed. Resolve the errors and retest.");
  for (const issue of result.issues) {
    if (issue.level === "info") continue;
    if (issue.key === "inbound_access_allowlist_empty" && issue.level !== "error") { issue.disposition = "deferred"; continue; }
    if (issue.key === "inbound_access_legacy_open" && connection.config.inboundAccessMode === "open_legacy" && issue.level !== "error") { issue.disposition = "advisory"; continue; }
    if (issue.key === "target" && connection.key === "discord" && connection.config.guildPolicy === "off" && !connection.config.defaultChannelId && issue.level !== "error") { issue.disposition = "deferred"; continue; }
    const step = result.probe?.steps.find((candidate) => candidate.key === issue.key);
    if (issue.level !== "error" && optionalCleanup(step)) { issue.disposition = "advisory"; requireCleanup(); continue; }
    issue.disposition = "blocking";
    blockingReasons.push(issue.message);
  }
  // Probe truth remains authoritative even when a diagnostic projection omitted an issue.
  for (const step of result.probe?.steps ?? []) {
    if (step.status === "fail") blockingReasons.push(step.message || step.label + " failed.");
    else if (step.status === "warn") {
      if (optionalCleanup(step)) requireCleanup();
      else blockingReasons.push(step.message || step.label + " remains unverified.");
    } else if (step.status === "skipped" && step.disposition !== "deferred") blockingReasons.push(step.label + " has not been verified.");
  }
  if (result.status === "warn" && result.issues.length === 0 && !result.probe?.steps.some((step) => step.status === "warn")) blockingReasons.push("Required setup checks have not passed.");
  return { allowed: blockingReasons.length === 0, blockingReasons: [...new Set(blockingReasons)].slice(0, 50), ...(result.evidenceId ? { evidenceId: result.evidenceId } : {}), ...(requiresAcknowledgement ? { requiresAcknowledgement: true } : {}) };
}
