// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ShellCommandExplanation } from "@goatcitadel/contracts";
import { ApprovalShellExplanations } from "./ApprovalShellExplanations";
import { higherApprovalRisk } from "./inbox-vocabulary";

it("shows shell risk on the shared Safe/Caution/Danger scale instead of raw risk tokens", () => {
  const explanation: ShellCommandExplanation = {
    command: "rm -rf build",
    parsed: true,
    program: "rm",
    summary: "Deletes the build folder",
    details: [],
    risks: [{ level: "caution", label: "Recursive delete", explanation: "Removes every file below the folder." }],
    highestRisk: "danger",
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <ApprovalShellExplanations commands={[{ text: explanation.command }]} explanations={[explanation]} />,
  );
  expect(host.querySelector("summary")?.textContent).toBe("Deletes the build folder · Danger");
  expect(host.textContent).toContain("Caution: Recursive delete. Removes every file below the folder.");
  expect(host.textContent).not.toContain("caution:");
  expect(host.textContent).not.toContain("· danger");
});

it("never shows a lower risk than the approval's own (U-IN-010)", () => {
  const safe: ShellCommandExplanation = {
    command: "ls",
    parsed: true,
    program: "ls",
    summary: "Lists files",
    details: [],
    risks: [],
    highestRisk: "info",
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <ApprovalShellExplanations commands={[{ text: "ls" }]} explanations={[safe]} approvalRisk="danger" />,
  );
  expect(host.querySelector("summary")?.textContent).toBe("Lists files · Danger");
  host.innerHTML = renderToStaticMarkup(
    <ApprovalShellExplanations commands={[{ text: "ls" }]} explanations={[safe]} approvalRisk="safe" />,
  );
  expect(host.querySelector("summary")?.textContent).toBe("Lists files · Safe");
});

it("keeps the approval's own risk when the shell rating has no mapping, or the approval's level is unknown", () => {
  const unmapped = undefined as unknown as Parameters<typeof higherApprovalRisk>[1];
  expect(higherApprovalRisk("danger", unmapped)).toBe("danger");
  const unknown = "extreme" as unknown as Parameters<typeof higherApprovalRisk>[0];
  expect(higherApprovalRisk(unknown, "danger")).toBe("extreme");
  expect(higherApprovalRisk("caution", "danger")).toBe("danger");
  expect(higherApprovalRisk("nuclear", "danger")).toBe("nuclear");
});
