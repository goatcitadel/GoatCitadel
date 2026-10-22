import { describe, expect, it } from "vitest";
import { presentAuthorityMessage } from "./runtime-authority-copy";

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
