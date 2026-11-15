import { describe, expect, it } from "vitest";
import { checkLine } from "./plugin-install-view";

const GENERIC = "This skill didn't pass GoatCitadel's checks.";

describe("checkLine", () => {
  it("replaces the Gateway's generic skill line with the reason the Skills tab gives", () => {
    expect(checkLine({ status: "blocked", code: "VALIDATION_FAILED", message: GENERIC }, "skill")).toBe(
      "Its files aren't valid.",
    );
  });

  it("keeps the Gateway's own sentence for every other blocked message", () => {
    const own = "A skill with this name is already installed.";
    expect(checkLine({ status: "blocked", code: "VALIDATION_FAILED", message: own }, "skill")).toBe(own);
    expect(checkLine({ status: "blocked", code: "VALIDATION_FAILED", message: GENERIC }, "connector")).toBe(GENERIC);
  });

  it("keeps the generic line when the code has no sentence of its own", () => {
    expect(checkLine({ status: "blocked", code: "SKILL_CHECK_BLOCKED", message: GENERIC }, "skill")).toBe(GENERIC);
  });
});
