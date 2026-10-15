// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ShellCommandExplanation } from "@goatcitadel/contracts";
import { ApprovalShellExplanations } from "./ApprovalShellExplanations";

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
    <ApprovalShellExplanations commands={["rm -rf build"]} explanations={[explanation]} />,
  );
  expect(host.querySelector("summary")?.textContent).toBe("Deletes the build folder · Danger risk");
  expect(host.textContent).toContain("Caution: Recursive delete. Removes every file below the folder.");
  expect(host.textContent).not.toContain("caution:");
  expect(host.textContent).not.toContain("· danger");
});
