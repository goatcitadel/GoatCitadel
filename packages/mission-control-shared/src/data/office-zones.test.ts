import { describe, expect, it } from "vitest";
import { inferOfficeZone, officeZoneLabel } from "./office-zones";

describe("office-zones", () => {
  it("classifies zones using the shared keyword map", () => {
    expect(inferOfficeZone({ roleId: "runtime-ops", title: "Runtime Engineer" })).toBe("operations");
    expect(inferOfficeZone({ roleId: "platform-observability", title: "Observability Lead" })).toBe("operations");
    expect(inferOfficeZone({ roleId: "security-watch", title: "Security Analyst" })).toBe("security");
    expect(inferOfficeZone({ roleId: "policy-guardrail", title: "Policy Guardrail Steward" })).toBe("security");
    expect(inferOfficeZone({ roleId: "architect", title: "Product Architect" })).toBe("command");
    expect(inferOfficeZone({ roleId: "planner", title: "Planning Lead" })).toBe("command");
    expect(inferOfficeZone({ roleId: "coder", title: "QA Integration Engineer" })).toBe("build");
    expect(inferOfficeZone({ roleId: "unknown", title: "Warm Reserve" })).toBe("operations");
  });

  it("returns stable human-readable zone labels", () => {
    expect(officeZoneLabel("command")).toBe("Command Deck");
    expect(officeZoneLabel("build")).toBe("Build Bay");
    expect(officeZoneLabel("research")).toBe("Research Lab");
    expect(officeZoneLabel("security")).toBe("Security Watch");
    expect(officeZoneLabel("operations")).toBe("Ops Lane");
  });
});
