import { describe, expect, it } from "vitest";
import { t } from "./i18n.js";

describe("t", () => {
  it("returns English string for known key without params", () => {
    expect(t("shell.summary.empty")).toBe("Empty shell command");
  });

  it("interpolates params into a known key", () => {
    expect(t("shell.git_push.force_summary", { branch: "main", remote: "origin" })).toBe(
      "Force-push branch 'main' to remote 'origin'",
    );
  });

  it("returns the key itself when missing (fail-safe)", () => {
    // @ts-expect-error - intentionally passing an unknown key
    expect(t("shell.does_not_exist")).toBe("shell.does_not_exist");
  });

  it("ignores unused params", () => {
    expect(t("shell.summary.empty", { extra: "ignored" })).toBe("Empty shell command");
  });
});
