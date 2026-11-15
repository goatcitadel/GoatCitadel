import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { explainShellCommand } from "@goatcitadel/mission-control-shared";
import { buildApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-generic-evidence";
import { ShellExplanationList } from "./ShellExplanationList";

describe("Classic approval shell explanations", () => {
  it("keeps the selected commands when preview and replay differ from stored explanation text", () => {
    const preview = { command: "echo preview" };
    const replay = { command: "echo replay" };
    const evidence = buildApprovalEvidenceModel(preview, replay);
    const stored = [
      { ...explainShellCommand(preview.command), summary: "Gateway preview explanation" },
      { ...explainShellCommand("echo former"), summary: "Unrelated stored explanation" },
    ];
    const markup = renderToStaticMarkup(
      <ShellExplanationList commands={evidence!.commandPreviews!} explanations={stored} />,
    );

    expect(markup).toContain("Gateway preview explanation");
    expect(markup).toContain(replay.command);
    expect(markup).not.toContain("echo former");
    expect(markup).not.toContain("Unrelated stored explanation");
  });

  it("keeps the visible order and uses stored explanations for exact matches", () => {
    const first = "echo first";
    const second = "echo second";
    const markup = renderToStaticMarkup(
      <ShellExplanationList
        commands={[{ text: first }, { text: second }]}
        explanations={[
          { ...explainShellCommand(second), summary: "Gateway explained second" },
          { ...explainShellCommand(first), summary: "Gateway explained first" },
        ]}
      />,
    );

    expect(markup).toContain("Gateway explained first");
    expect(markup).toContain("Gateway explained second");
    expect(markup.indexOf(first)).toBeLessThan(markup.indexOf(second));
  });

  it("keeps command-array entries separate and presents long commands as shortened previews", () => {
    const command = "echo " + "sample ".repeat(24) + "end marker";
    const evidence = buildApprovalEvidenceModel({ commands: ["echo first", command, "echo last"] });
    const markup = renderToStaticMarkup(
      <ShellExplanationList
        commands={evidence!.commandPreviews!}
        explanations={[{ ...explainShellCommand(command), summary: "Full stored explanation" }]}
      />,
    );

    expect(markup).toContain("echo first");
    expect(markup).toContain("echo last");
    expect(markup).toContain("Command preview is shortened.");
    expect(markup).not.toContain("end marker");
    expect(markup).not.toContain("Full stored explanation");
  });
});
