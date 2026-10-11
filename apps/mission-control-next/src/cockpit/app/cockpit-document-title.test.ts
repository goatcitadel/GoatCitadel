import { describe, expect, it } from "vitest";
import { cockpitDocumentTitle } from "./cockpit-document-title";

describe("cockpit document title", () => {
  it("uses the classic shell's prefix with the area label", () => {
    expect(cockpitDocumentTitle("Inbox")).toBe("GoatCitadel Inbox");
  });

  it("adds a readable section label", () => {
    expect(cockpitDocumentTitle("Settings", "models")).toBe("GoatCitadel Settings · Models");
    expect(cockpitDocumentTitle("Settings", "first-run")).toBe("GoatCitadel Settings · First run");
    expect(cockpitDocumentTitle("Work", "")).toBe("GoatCitadel Work");
  });

  it("names settings and library sections from the route model instead of the URL slug", () => {
    expect(cockpitDocumentTitle("Settings", "onboarding", "settings")).toBe("GoatCitadel Settings · Get started");
    expect(cockpitDocumentTitle("Settings", "providers", "settings")).toBe("GoatCitadel Settings · Providers & models");
    expect(cockpitDocumentTitle("Settings", "first-run", "settings")).toBe("GoatCitadel Settings · First run");
    expect(cockpitDocumentTitle("Settings", "models", "settings")).toBe("GoatCitadel Settings · Models");
    expect(cockpitDocumentTitle("Settings", "citadel", "settings")).toBe("GoatCitadel Settings · Citadel");
    expect(cockpitDocumentTitle("Library", "prompt-packs", "library")).toBe("GoatCitadel Library · Prompt packs");
    expect(cockpitDocumentTitle("Library", "citadel", "library")).toBe("GoatCitadel Library · Citadel setup");
  });

  it("maps cockpit system and work views onto their ops labels and humanises unknown slugs", () => {
    expect(cockpitDocumentTitle("System", "spend", "system")).toBe("GoatCitadel System · Costs");
    expect(cockpitDocumentTitle("System", "dashboards", "system")).toBe("GoatCitadel System · Saved boards");
    expect(cockpitDocumentTitle("System", "browser-sessions", "system")).toBe("GoatCitadel System · Sessions");
    expect(cockpitDocumentTitle("System", "health", "system")).toBe("GoatCitadel System · Health");
    expect(cockpitDocumentTitle("Work", "kanban", "work")).toBe("GoatCitadel Work · Kanban");
    expect(cockpitDocumentTitle("Work", "schedules", "work")).toBe("GoatCitadel Work · Schedules");
    expect(cockpitDocumentTitle("Work", "mystery-slug", "work")).toBe("GoatCitadel Work · Mystery slug");
    expect(cockpitDocumentTitle("Inbox", "approval%3A1", "inbox")).toBe("GoatCitadel Inbox · Approval:1");
  });
});
