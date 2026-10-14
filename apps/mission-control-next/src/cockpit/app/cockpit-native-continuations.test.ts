import { describe, expect, it } from "vitest";
import { resolveCockpitCompatibility, resolveCockpitContinuation } from "./cockpit-compatibility";
import { parseCockpitLocation } from "./routes";

const context = {
  search:
    "?citadelId=c&workspaceId=old&runId=run%3Aone&sessionId=session%2Fone&approvalId=approval%3Aold&keep=yes&keep=two&shell=classic&shellScope=visit",
  hash: "#evidence",
  workspaceId: "workspace-a",
};
describe("internal native owner continuations", () => {
  it.each([
    ["/ops/runtime?shell=classic", "/system/runtime"],
    ["/ops/diagnostics?shell=classic", "/system/runtime/diagnostics"],
    ["/ops/boards?shell=classic", "/system/dashboards"],
    ["/ops/costs?shell=classic", "/system/spend/details"],
    ["/system/dashboards/board%2Fone?workspaceId=workspace-a", "/system/dashboards/board%2Fone"],
    ["/work/tasks/task%2Fone?workspaceId=workspace-a", "/work/tasks/task%2Fone"],
    ["/work/runs/run%2Fone?workspaceId=workspace-a", "/work/runs/run%2Fone"],
    ["/inbox/approvals/approval%2Fone?approvalId=approval%2Fone&workspaceId=workspace-a", "/inbox"],
    ["/inbox?item=change_plan%3Aplan-a&workspaceId=workspace-a", "/inbox"],
    ["/library/skill/skill%3Areview?type=skill&workspaceId=workspace-a", "/library/skill/skill%3Areview"],
    [
      "/library/proposal/proposal%3Areview?type=proposal&workspaceId=workspace-a",
      "/library/proposal/proposal%3Areview",
    ],
    ["/settings/safety#approval-mode", "/settings/safety"],
    ["/settings/connections#addons", "/settings/connections"],
  ])("keeps canonical target and carried scope/query for %s", (input, pathname) => {
    const result = resolveCockpitContinuation(input, context);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Expected existing native owner");
    const url = new URL(result.href, "http://cockpit.invalid");
    expect(url.pathname).toBe(pathname);
    expect(url.searchParams.get("workspaceId")).toBe("workspace-a");
    expect(url.searchParams.get("citadelId")).toBe("c");
    expect(url.searchParams.get("runId")).toBe("run:one");
    expect(url.searchParams.get("sessionId")).toBe("session/one");
    expect(url.searchParams.getAll("keep")).toEqual(["yes", "two"]);
    expect(url.searchParams.get("shell")).toBe("cockpit");
    expect(url.searchParams.has("shellScope")).toBe(false);
    expect(url.hash).toBe(input.includes("#") ? new URL(input, "http://cockpit.invalid").hash : "#evidence");
  });
  it("lands generic task inspection on WorkBoard despite retained run context", () => {
    const result = resolveCockpitContinuation("/work", context);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Work owner unavailable");
    expect(parseCockpitLocation(new URL(result.href, "http://cockpit.invalid").pathname)).toEqual({
      area: "work",
      rest: [],
    });
    expect(new URL(result.href, "http://cockpit.invalid").searchParams.get("runId")).toBe("run:one");
  });
  it.each([
    "//foreign.invalid/ops/runtime",
    "https://foreign.invalid/ops/runtime",
    "/inbox/approvals/%2e%2e?shell=classic",
    "/unknown",
    "/inbox/approvals/a?approvalId=b",
    "/work/tasks/a/extra",
  ])("makes malformed/unported destinations explicit: %s", (input) => {
    expect(resolveCockpitContinuation(input, context)).toEqual({ kind: "missing" });
  });
  it("does not substitute another record for an unknown selected approval", () => {
    const result = resolveCockpitContinuation("/inbox/approvals/unknown?approvalId=unknown", context);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Approval inspection owner unavailable");
    expect(new URL(result.href, "http://cockpit.invalid").pathname).toBe("/inbox");
    expect(new URL(result.href, "http://cockpit.invalid").searchParams.get("approvalId")).toBe("unknown");
    // Data/404/auth outcomes still belong to the existing canonical approval owner.
  });
  it("preserves explicit operator Classic rollback at the original boundary", () => {
    expect(resolveCockpitCompatibility("/ops/runtime?shell=classic#backups")).toMatchObject({ kind: "classic" });
    expect(resolveCockpitContinuation("/ops/runtime?shell=classic#backups")).toMatchObject({ kind: "native" });
  });
  it.each(["w/one space", "workspace:one", " workspace "])(
    "retains the Gateway nonempty workspace contract exactly: %s",
    (workspaceId) => {
      const result = resolveCockpitContinuation("/work", { ...context, workspaceId });
      expect(result.kind).toBe("native");
      if (result.kind !== "native") throw new Error("Existing Work owner unavailable");
      const url = new URL(result.href, "http://cockpit.invalid");
      expect(url.pathname).toBe("/work");
      expect(url.searchParams.get("workspaceId")).toBe(workspaceId);
      expect(url.searchParams.get("sessionId")).toBe("session/one");
      expect(url.hash).toBe("#evidence");
    },
  );
  it("rejects an empty expected workspace without inventing a target scope", () => {
    expect(resolveCockpitContinuation("/work", { workspaceId: "" })).toEqual({ kind: "missing" });
  });
});
