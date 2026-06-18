import { describe, it, expect } from "vitest";
import { wardMatchesAction, evaluateWards, type CitadelWard } from "./citadel-wards.js";

describe("wardMatchesAction", () => {
  it("exact match succeeds", () => {
    expect(wardMatchesAction("email.send", "email.send")).toBe(true);
  });

  it("exact match fails when action differs", () => {
    expect(wardMatchesAction("email.send", "email.receive")).toBe(false);
  });

  it("dot in pattern is treated as literal dot, not regex wildcard", () => {
    expect(wardMatchesAction("emailXsend", "email.send")).toBe(false);
  });

  it("database.* wildcard matches a sub-action", () => {
    expect(wardMatchesAction("database.*", "database.insert")).toBe(true);
  });

  it("database.* wildcard matches a deeper sub-action", () => {
    expect(wardMatchesAction("database.*", "database.write.prod")).toBe(true);
  });

  it("database.* does NOT match a different top-level prefix", () => {
    expect(wardMatchesAction("database.*", "filesystem.read")).toBe(false);
  });

  it("* matches anything", () => {
    expect(wardMatchesAction("*", "email.send")).toBe(true);
    expect(wardMatchesAction("*", "database.insert")).toBe(true);
    expect(wardMatchesAction("*", "anything.at.all")).toBe(true);
  });
});

describe("evaluateWards", () => {
  it("no matching ward → allow", () => {
    const wards: CitadelWard[] = [{ name: "email-deny", actionPattern: "email.*", effect: "deny" }];
    expect(evaluateWards(wards, "filesystem.read")).toBe("allow");
  });

  it("no wards at all → allow", () => {
    expect(evaluateWards([], "email.send")).toBe("allow");
  });

  it("deny-wins when both deny and allow ward match the same action", () => {
    const wards: CitadelWard[] = [
      { name: "allow-all", actionPattern: "*", effect: "allow" },
      { name: "deny-email", actionPattern: "email.*", effect: "deny" },
    ];
    expect(evaluateWards(wards, "email.send")).toBe("deny");
  });

  it("require_approval returned when only that ward matches", () => {
    const wards: CitadelWard[] = [{ name: "approval-db", actionPattern: "database.*", effect: "require_approval" }];
    expect(evaluateWards(wards, "database.insert")).toBe("require_approval");
  });

  it("deny-wins over require_approval", () => {
    const wards: CitadelWard[] = [
      { name: "approval-all", actionPattern: "*", effect: "require_approval" },
      { name: "deny-db", actionPattern: "database.*", effect: "deny" },
    ];
    expect(evaluateWards(wards, "database.delete")).toBe("deny");
  });

  it("require_dry_run returned when it is the highest-priority match", () => {
    const wards: CitadelWard[] = [
      { name: "dry-run-db", actionPattern: "database.*", effect: "require_dry_run" },
      { name: "allow-all", actionPattern: "*", effect: "allow" },
    ];
    expect(evaluateWards(wards, "database.insert")).toBe("require_dry_run");
  });

  it("route_local returned when it is the highest-priority match", () => {
    const wards: CitadelWard[] = [
      { name: "local-llm", actionPattern: "llm.*", effect: "route_local" },
      { name: "redact-all", actionPattern: "*", effect: "redact" },
    ];
    expect(evaluateWards(wards, "llm.infer")).toBe("route_local");
  });

  it("redact returned when it is the highest-priority match", () => {
    const wards: CitadelWard[] = [
      { name: "redact-pii", actionPattern: "pii.*", effect: "redact" },
      { name: "allow-all", actionPattern: "*", effect: "allow" },
    ];
    expect(evaluateWards(wards, "pii.export")).toBe("redact");
  });

  it("allow returned when only allow wards match", () => {
    const wards: CitadelWard[] = [{ name: "allow-email", actionPattern: "email.*", effect: "allow" }];
    expect(evaluateWards(wards, "email.send")).toBe("allow");
  });
});
