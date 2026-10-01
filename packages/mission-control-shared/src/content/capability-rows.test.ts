import { describe, expect, it } from "vitest";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { presentCapabilityDescription, presentCapabilityStatus, presentCapabilityTitle } from "./capability-rows";

const entry: CapabilityCatalogEntry = {
  capabilityId: "review",
  kind: "skill",
  category: "built_in",
  title: "Agentic Skill Architect",
  summary: "# Agentic Skill Architect\n\nBuilds a governed skill from a request.",
  callable: true,
};

describe("capability presentation", () => {
  it("keeps authored title case and skips duplicate Markdown headings", () => {
    expect(presentCapabilityTitle(entry)).toBe("Agentic Skill Architect");
    expect(presentCapabilityTitle({ title: "agentic-skill-architect" })).toBe("Agentic skill architect");
    expect(presentCapabilityTitle({ title: "bankr" })).toBe("Bankr");
    expect(presentCapabilityDescription(entry)).toBe("Builds a governed skill from a request.");
    expect(presentCapabilityDescription({ ...entry, summary: "# Agentic Skill Architect" })).toBe("No description recorded.");
  });

  it("uses catalog truth for callability", () => {
    expect(presentCapabilityStatus(entry)).toEqual({ label: "Available", tone: "done" });
    expect(presentCapabilityStatus({ ...entry, callable: false, reviewWarning: "Review required" })).toEqual({ label: "Degraded", tone: "waiting" });
  });
});
