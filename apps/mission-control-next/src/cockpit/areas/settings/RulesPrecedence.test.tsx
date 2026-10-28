// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULES_PRECEDENCE_STEPS, RulesPrecedenceExplainer, RulesPrecedenceLink } from "./RulesPrecedence";

let container: HTMLDivElement, root: Root;
async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("rules precedence copy", () => {
  it("puts tool groups right after deny lists, where the policy engine checks them", async () => {
    expect(RULES_PRECEDENCE_STEPS.slice(0, 3).map((step) => step.title)).toEqual([
      "Deny lists",
      "Tool groups (Capabilities)",
      "Permissions · profile limit",
    ]);
    await render(<RulesPrecedenceExplainer />);
    const steps = [...container.querySelectorAll("ol > li")].map((item) => item.textContent);
    expect(steps[1]).toBe(
      "Tool groups (Capabilities). A group switched off in Capabilities › Tools blocks its tools for the AI. Allow rules and grants can't lift it.",
    );
  });

  it("counts the five places that hold rules in the explainer and in the one-line pointer", async () => {
    await render(
      <>
        <RulesPrecedenceExplainer />
        <RulesPrecedenceLink />
      </>,
    );
    const paragraphs = [...container.querySelectorAll("p")].map((item) => item.textContent ?? "");
    expect(paragraphs).toContainEqual(
      expect.stringContaining(
        "Five places hold rules: Permissions, Tools, Trust & policy, Rules · Wards and the tool groups in Capabilities.",
      ),
    );
    expect(paragraphs).toContainEqual(
      expect.stringContaining(
        "Deny always wins across Permissions, Tools, Trust & policy, Rules · Wards and the tool groups in Capabilities.",
      ),
    );
    expect(container.textContent).not.toContain("Four pages");
  });
});
