export const PERMISSION_REVIEW_VERSION = "goatcitadel.agent-comparison.permissions.v1";
export const PERMISSION_REVIEW_FILE = "native-permission-review.json";
export const EXECUTION_BINDING_FIELDS = [
  "executionId",
  "manifestSha256",
  "cellId",
  "revision",
  "effectiveConfigSha256",
  "fixtureSha256",
];

const VALUES = {
  files: ["workspace_only", "host_user", "disabled", "unknown"],
  terminal: [
    "per_command_approval",
    "allowlist_miss_approval",
    "risk_based_approval",
    "unrestricted",
    "denied",
    "disabled",
    "unknown",
  ],
  skills: ["review_before_activation", "automatic_activation", "disabled", "unknown"],
  schedule: ["authorized_destination", "per_send_approval", "disabled", "unknown"],
};

export function normalizeComparisonPermissions(policy) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).length !== Object.keys(VALUES).length ||
    Object.entries(VALUES).some(([key, values]) => !values.includes(policy[key]))
  )
    throw new Error("Record the explicit file, terminal, skill, and delivery permission policy.");
  return Object.fromEntries(Object.keys(VALUES).map((key) => [key, policy[key]]));
}

// Called only after the native adapter checks its reviewed product revision.
// These describe configuration semantics, not hostile-code isolation.
export function nativeComparisonPermissions(product, tools) {
  return normalizeComparisonPermissions({
    files: tools.includes("files") ? (product === "hermes" ? "host_user" : "workspace_only") : "disabled",
    terminal: tools.includes("terminal")
      ? product === "hermes"
        ? "risk_based_approval"
        : product === "openclaw"
          ? "allowlist_miss_approval"
          : "per_command_approval"
      : "disabled",
    skills:
      ["goatcitadel", "openclaw", "hermes"].includes(product) && tools.includes("skills")
        ? "review_before_activation"
        : "disabled",
    schedule: "disabled",
  });
}

export function normalizePermissionEvidence(value) {
  if (value === null || value === undefined) return null;
  if (value.schemaVersion !== PERMISSION_REVIEW_VERSION || !/^[a-f0-9]{64}$/u.test(value.evidenceSha256 ?? ""))
    throw new Error("Permission equivalence requires retained native review evidence.");
  return {
    schemaVersion: PERMISSION_REVIEW_VERSION,
    policy: normalizeComparisonPermissions(value.policy),
    evidenceSha256: value.evidenceSha256,
  };
}
