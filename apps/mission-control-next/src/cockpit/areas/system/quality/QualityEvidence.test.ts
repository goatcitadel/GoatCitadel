import { expect, it } from "vitest";
import { promptPackQualityHref } from "./QualityEvidence";
import { resolveCockpitCompatibility } from "../../../app/cockpit-compatibility";
it("resolves a known native pack destination with canonical workspace and retained run/scoring context", () => {
  const target = new URL(
    promptPackQualityHref("pack/one", {
      search:
        "?view=stale&workspaceId=foreign&runId=run%3Atwo&sessionId=s%2F1&scoring=human&keep=yes&shell=classic&shellScope=visit",
      hash: "#scores",
      workspaceId: "actual",
      citadelId: "c",
    }),
    "http://cockpit.invalid",
  );
  expect(target.pathname).toBe("/library/prompt-packs");
  expect(target.searchParams.get("view")).toBe("pack:pack/one");
  expect(target.searchParams.get("workspaceId")).toBe("actual");
  expect(target.searchParams.get("citadelId")).toBe("c");
  expect(target.searchParams.get("runId")).toBe("run:two");
  expect(target.searchParams.get("sessionId")).toBe("s/1");
  expect(target.searchParams.get("scoring")).toBe("human");
  expect(target.searchParams.get("keep")).toBe("yes");
  expect(target.hash).toBe("#scores");
  expect(target.searchParams.get("shell")).toBe("cockpit");
  expect(target.searchParams.has("shellScope")).toBe(false);
  expect(resolveCockpitCompatibility("/library/prompt-packs?view=pack%3Apack%2Fone&shell=classic").kind).toBe(
    "classic",
  );
});
it("offers unselected native Library browsing without retaining a stale selection", () => {
  const target = new URL(
    promptPackQualityHref(undefined, { search: "?view=stale&runId=r", hash: "#retained" }),
    "http://cockpit.invalid",
  );
  expect(target.searchParams.has("view")).toBe(false);
  expect(target.searchParams.get("runId")).toBe("r");
  expect(target.hash).toBe("#retained");
});
