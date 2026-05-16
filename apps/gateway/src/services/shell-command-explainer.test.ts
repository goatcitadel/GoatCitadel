import { describe, expect, it } from "vitest";
import { explainCommandsForApproval } from "./shell-command-explainer.js";

describe("explainCommandsForApproval", () => {
  it("returns explanations matching the shared parser", () => {
    const out = explainCommandsForApproval(["git push --force origin main", "pnpm install"]);
    expect(out).toHaveLength(2);
    expect(out[0].highestRisk).toBe("danger");
    expect(out[1].highestRisk).toBe("info");
  });

  it("returns empty array for empty input", () => {
    expect(explainCommandsForApproval([])).toEqual([]);
  });

  it("preserves command order", () => {
    const out = explainCommandsForApproval(["pnpm install", "rm -rf /tmp/x"]);
    expect(out[0].command).toBe("pnpm install");
    expect(out[1].command).toBe("rm -rf /tmp/x");
  });
});
