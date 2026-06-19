// Scenario registry. Add a scenario by creating a file in this directory that
// default-exports a scenario object (see benchmark/lib/harness.mjs for the shape)
// and listing it here. Order is the report order.

import capabilityAgentTask from "./capability-agent-task.mjs";
import trustDenyWinsWard from "./trust-deny-wins-ward.mjs";
import trustDryRunHashMismatch from "./trust-dry-run-hash-mismatch.mjs";
import trustUnknownSenderRejected from "./trust-unknown-sender-rejected.mjs";
import trustEvidenceReceiptVerify from "./trust-evidence-receipt-verify.mjs";
import reliabilityNoOrphanOnTimeout from "./reliability-no-orphan-on-timeout.mjs";
import reliabilityDurableResume from "./reliability-durable-resume.mjs";

export const scenarios = [
  // CAPABILITY
  capabilityAgentTask,
  // TRUST
  trustDenyWinsWard,
  trustDryRunHashMismatch,
  trustUnknownSenderRejected,
  trustEvidenceReceiptVerify,
  // RELIABILITY
  reliabilityNoOrphanOnTimeout,
  reliabilityDurableResume,
];

export default scenarios;
