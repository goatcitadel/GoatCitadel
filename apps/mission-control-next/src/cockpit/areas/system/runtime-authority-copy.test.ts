import { describe, expect, it } from "vitest";
import { presentAuthorityMessage } from "./runtime-authority-copy";
import { headingForCode } from "./runtime-authority-wording";

/** Every code the Gateway's runtime authority projection emits without counts. */
const PLAIN_CODES = [
  "approvals_unavailable",
  "approvals_malformed",
  "approvals_some_malformed",
  "approvals_empty",
  "runs_unavailable",
  "runs_malformed",
  "runs_some_malformed",
  "runs_window_incomplete",
  "runs_empty",
  "run_signal",
  "run_signals_unavailable",
  "run_status_unknown",
  "durable_workers_unavailable",
  "durable_workers_malformed",
  "durable_workers_window_incomplete",
  "durable_workers_some_malformed",
  "durable_workers_more_beyond_window",
  "durable_worker_idle",
  "worker_lease_expired",
  "worker_heartbeat_stale",
  "worker_lease_current",
  "mesh_workers_unavailable",
  "mesh_workers_window_incomplete",
  "mesh_workers_malformed",
  "mesh_workers_empty",
  "local_runtime_unavailable",
  "backup_none_published",
  "backup_unreadable",
  "backup_malformed",
  "backup_verified",
  "backup_verified_stale",
  "release_verified",
  "release_unverified",
  "release_certificate_malformed",
  "release_metadata_incomplete",
  "release_certificate_missing",
  "build_modified",
  "build_clean",
  "build_integrity_unknown",
  "running_build_identity_unavailable",
  "config_generation_unavailable",
  "config_reconciliation_clear",
  "config_recovery_not_needed",
  "manual_reconciliation_unavailable",
  "manual_reconciliation_window_incomplete",
  "manual_reconciliation_malformed",
  "manual_reconciliation_clear",
  "manual_reconciliation",
  "manual_reconciliation_some_malformed",
  "manual_reconciliation_more_beyond_window",
];
const GLOSSARY =
  /\b(Gateway|evidence|owner|replay|revision|snapshot|posture|projection|canonical|durable|admitted|readback)\b/i;

describe("every runtime authority code is worded (SY-N06)", () => {
  it.each(PLAIN_CODES)("%s has a sentence and a heading in operator words", (code) => {
    const sentence = presentAuthorityMessage({ code });
    expect(sentence, code).toBeTruthy();
    expect(sentence).not.toMatch(GLOSSARY);
    // A single run keeps its own name as its heading.
    if (code === "run_status_unknown") return;
    expect(headingForCode(code), code).toBeTruthy();
    expect(headingForCode(code)).not.toMatch(GLOSSARY);
  });

  it("words run status and approval settlement codes, and leaves an unknown part to the fallback", () => {
    expect(presentAuthorityMessage({ code: "run_failed" })).toBe("This run failed.");
    expect(presentAuthorityMessage({ code: "run_dead_lettered" })).toBe("This run stopped after repeated failures.");
    expect(presentAuthorityMessage({ code: "approval_rejected_effects_settled" })).toBe(
      "Denied; every follow-on action finished.",
    );
    expect(presentAuthorityMessage({ code: "approval_pending_awaiting_decision" })).toBe("Waiting for a decision.");
    expect(presentAuthorityMessage({ code: "approval_approved_something_new" })).toBeUndefined();
    expect(presentAuthorityMessage({ code: "run_teleported" })).toBeUndefined();
  });

  it("words counted codes, and falls back when a needed count is missing", () => {
    expect(presentAuthorityMessage({ code: "config_generation", counts: { revision: 8 } })).toBe(
      "Version 8 of the configuration is active.",
    );
    expect(presentAuthorityMessage({ code: "config_generation" })).toBeUndefined();
    expect(presentAuthorityMessage({ code: "backup_failed", count: 2 })).toBe(
      "The latest backup didn't verify: 2 problems found.",
    );
    expect(
      presentAuthorityMessage({
        code: "config_reconciliation_pending",
        counts: { owners: 1, transaction: 0, mirrors: 1 },
      }),
    ).toBe("Waiting on runtime parts picking up the new configuration and a configuration copy being repaired.");
    expect(presentAuthorityMessage({ code: "config_recovered_attention", counts: { revision: 3 } })).toBe(
      "Startup recovered the configuration at version 3, but the result needs a look.",
    );
  });

  it("heads each kind by its longest known prefix and leaves per-record runs and approvals to their own names", () => {
    expect(headingForCode("backup_verified_stale")).toBe("Latest backup");
    expect(headingForCode("worker_leases_checked")).toBe("Workers");
    expect(headingForCode("approval_records_available")).toBe("Approvals");
    expect(headingForCode("run_completed")).toBeUndefined();
    expect(headingForCode("approval_approved_effects_settled")).toBeUndefined();
  });
});

describe("presentAuthorityMessage (SY-N06)", () => {
  it("words approval record counts with real plurals, as a recent window", () => {
    expect(presentAuthorityMessage({ code: "approval_records_available", count: 1 })).toBe(
      "1 approval record is in this workspace's recent window.",
    );
    expect(presentAuthorityMessage({ code: "approval_records_available", count: 3 })).toBe(
      "3 approval records are in this workspace's recent window.",
    );
    expect(presentAuthorityMessage({ code: "approval_records_available", count: 0 })).toBe(
      "No approval records are in this workspace's recent window.",
    );
  });

  it("falls back to the server prose when a count the wording needs is missing or invalid", () => {
    expect(presentAuthorityMessage({ code: "approval_records_available", count: -1 })).toBeUndefined();
    expect(presentAuthorityMessage({ code: "approval_records_available" })).toBeUndefined();
    expect(presentAuthorityMessage({ code: "local_runtime_ready" })).toBeUndefined();
    expect(presentAuthorityMessage({ code: "mesh_workers", counts: { currentNodes: 1 } })).toBeUndefined();
    expect(
      presentAuthorityMessage({ code: "worker_leases_checked", counts: { runs: 1, expired: 0.5, stale: 0 } }),
    ).toBeUndefined();
    // A code with no count in its wording still words without one.
    expect(presentAuthorityMessage({ code: "approval_records_unavailable" })).toBeDefined();
  });

  it("words worker, mesh and local runtime counts without (s) or internal terms", () => {
    const messages = [
      presentAuthorityMessage({ code: "worker_leases_checked", counts: { runs: 4, expired: 1, stale: 0 } }),
      presentAuthorityMessage({
        code: "mesh_workers",
        counts: { currentNodes: 1, staleNodes: 2, activeLeases: 0, expiredLeases: 1 },
      }),
      presentAuthorityMessage({ code: "local_runtime_disabled", count: 1 }),
      presentAuthorityMessage({ code: "local_runtime_unhealthy_leases", count: 2 }),
      presentAuthorityMessage({ code: "local_runtime_failed", count: 0 }),
      presentAuthorityMessage({ code: "local_runtime_starting", count: 0 }),
      presentAuthorityMessage({ code: "local_runtime_ready", count: 0 }),
      presentAuthorityMessage({ code: "local_runtime_not_ready", count: 1 }),
    ];
    expect(messages).toEqual([
      "4 running runs checked: 1 expired or missing lease and 0 stale heartbeats.",
      "1 current node, 2 stale nodes, 0 active leases and 1 expired lease.",
      "The local runtime is off, with 1 active lease.",
      "2 active leases, but the local runtime isn't running and healthy.",
      "The local runtime stopped or failed while it should be running, with 0 active leases.",
      "The local runtime is starting, with 0 active leases.",
      "The local runtime is ready, with 0 active leases.",
      "The local runtime isn't running, with 1 active lease.",
    ]);
    for (const message of messages) expect(message).not.toMatch(/\(s\)|Gateway|projection|canonical|durable/u);
  });

  it("returns undefined for a code it doesn't know, so the caller can fall back", () => {
    expect(presentAuthorityMessage({ code: "something_new", count: 1 })).toBeUndefined();
  });
});
