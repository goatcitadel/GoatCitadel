import { describe, it, expect } from "vitest";
import { roleCan } from "./citadel-sharing.js";
import type { CitadelRole, CitadelCapability } from "./citadel-sharing.js";

// ---------------------------------------------------------------------------
// Helper: assert a batch of (role, capability, expected) triples at once.
// ---------------------------------------------------------------------------
function expectMatrix(cases: ReadonlyArray<[CitadelRole, CitadelCapability, boolean]>): void {
  for (const [role, capability, expected] of cases) {
    expect(roleCan(role, capability), `roleCan("${role}", "${capability}") should be ${expected}`).toBe(expected);
  }
}

// ---------------------------------------------------------------------------
// owner — all capabilities granted
// ---------------------------------------------------------------------------
describe("owner", () => {
  it("can delete_citadel", () => {
    expect(roleCan("owner", "delete_citadel")).toBe(true);
  });

  it("is granted every capability", () => {
    expectMatrix([
      ["owner", "view", true],
      ["owner", "comment", true],
      ["owner", "contribute", true],
      ["owner", "run_missions", true],
      ["owner", "manage_council", true],
      ["owner", "manage_gates", true],
      ["owner", "manage_members", true],
      ["owner", "delete_citadel", true],
    ]);
  });
});

// ---------------------------------------------------------------------------
// steward — everything except delete_citadel
// ---------------------------------------------------------------------------
describe("steward", () => {
  it("can manage_members", () => {
    expect(roleCan("steward", "manage_members")).toBe(true);
  });

  it("cannot delete_citadel", () => {
    expect(roleCan("steward", "delete_citadel")).toBe(false);
  });

  it("can view, comment, contribute, run_missions, manage_council, manage_gates", () => {
    expectMatrix([
      ["steward", "view", true],
      ["steward", "comment", true],
      ["steward", "contribute", true],
      ["steward", "run_missions", true],
      ["steward", "manage_council", true],
      ["steward", "manage_gates", true],
    ]);
  });
});

// ---------------------------------------------------------------------------
// builder — view, comment, contribute, run_missions, manage_council only
// ---------------------------------------------------------------------------
describe("builder", () => {
  it("can manage_council", () => {
    expect(roleCan("builder", "manage_council")).toBe(true);
  });

  it("cannot manage_gates", () => {
    expect(roleCan("builder", "manage_gates")).toBe(false);
  });

  it("cannot manage_members", () => {
    expect(roleCan("builder", "manage_members")).toBe(false);
  });

  it("cannot delete_citadel", () => {
    expect(roleCan("builder", "delete_citadel")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// operator — view, comment, run_missions only
// ---------------------------------------------------------------------------
describe("operator", () => {
  it("can run_missions", () => {
    expect(roleCan("operator", "run_missions")).toBe(true);
  });

  it("cannot manage_gates", () => {
    expect(roleCan("operator", "manage_gates")).toBe(false);
  });

  it("cannot contribute", () => {
    expect(roleCan("operator", "contribute")).toBe(false);
  });

  it("cannot manage_council", () => {
    expect(roleCan("operator", "manage_council")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// contributor — view, comment, contribute only
// ---------------------------------------------------------------------------
describe("contributor", () => {
  it("can contribute", () => {
    expect(roleCan("contributor", "contribute")).toBe(true);
  });

  it("cannot run_missions", () => {
    expect(roleCan("contributor", "run_missions")).toBe(false);
  });

  it("cannot manage_council", () => {
    expect(roleCan("contributor", "manage_council")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// viewer — view only
// ---------------------------------------------------------------------------
describe("viewer", () => {
  it("can view", () => {
    expect(roleCan("viewer", "view")).toBe(true);
  });

  it("cannot contribute", () => {
    expect(roleCan("viewer", "contribute")).toBe(false);
  });

  it("cannot comment", () => {
    expect(roleCan("viewer", "comment")).toBe(false);
  });

  it("cannot run_missions", () => {
    expect(roleCan("viewer", "run_missions")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// guest — same read grant as viewer
// ---------------------------------------------------------------------------
describe("guest", () => {
  it("can view", () => {
    expect(roleCan("guest", "view")).toBe(true);
  });

  it("cannot comment", () => {
    expect(roleCan("guest", "comment")).toBe(false);
  });

  it("cannot contribute", () => {
    expect(roleCan("guest", "contribute")).toBe(false);
  });

  it("cannot run_missions", () => {
    expect(roleCan("guest", "run_missions")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agent — run_missions only (non-human identity)
// ---------------------------------------------------------------------------
describe("agent", () => {
  it("can run_missions", () => {
    expect(roleCan("agent", "run_missions")).toBe(true);
  });

  it("cannot view", () => {
    expect(roleCan("agent", "view")).toBe(false);
  });

  it("cannot comment", () => {
    expect(roleCan("agent", "comment")).toBe(false);
  });

  it("cannot contribute", () => {
    expect(roleCan("agent", "contribute")).toBe(false);
  });

  it("cannot manage_council", () => {
    expect(roleCan("agent", "manage_council")).toBe(false);
  });

  it("cannot delete_citadel", () => {
    expect(roleCan("agent", "delete_citadel")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-role boundary matrix — representative spot-checks
// ---------------------------------------------------------------------------
describe("cross-role boundary matrix", () => {
  it("only owner can delete_citadel", () => {
    const roles: CitadelRole[] = ["steward", "builder", "operator", "contributor", "viewer", "guest", "agent"];
    for (const role of roles) {
      expect(roleCan(role, "delete_citadel"), `${role} should not delete_citadel`).toBe(false);
    }
  });

  it("only owner and steward can manage_gates", () => {
    expectMatrix([
      ["owner", "manage_gates", true],
      ["steward", "manage_gates", true],
      ["builder", "manage_gates", false],
      ["operator", "manage_gates", false],
      ["contributor", "manage_gates", false],
      ["viewer", "manage_gates", false],
      ["guest", "manage_gates", false],
      ["agent", "manage_gates", false],
    ]);
  });

  it("agents are silent executors — only run_missions is granted", () => {
    const allCapabilities: CitadelCapability[] = [
      "view",
      "comment",
      "contribute",
      "run_missions",
      "manage_council",
      "manage_gates",
      "manage_members",
      "delete_citadel",
    ];
    for (const cap of allCapabilities) {
      const expected = cap === "run_missions";
      expect(roleCan("agent", cap), `agent.${cap} should be ${expected}`).toBe(expected);
    }
  });
});
