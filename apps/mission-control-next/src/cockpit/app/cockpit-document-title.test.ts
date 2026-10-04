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
});
