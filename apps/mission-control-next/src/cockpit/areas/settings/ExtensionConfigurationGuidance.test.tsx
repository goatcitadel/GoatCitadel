// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IntegrationConfigurationGuidance } from "@goatcitadel/contracts";
import { ExtensionConfigurationGuidance } from "./ExtensionConfigurationGuidance";
import { IntegrationFormFields } from "./IntegrationFormFields";

const guidance: IntegrationConfigurationGuidance = {
  pluginId: "fixture",
  pluginVersion: "1.2.3",
  supportedFieldKeys: ["endpoint"],
  form: {
    version: "goatcitadel.extension-configuration.v1",
    prerequisites: ["Create a service account before setup."],
    fields: [
      {
        key: "endpoint",
        label: "Service endpoint",
        help: "Use the service URL.",
        kind: "url",
        defaultValue: "https://author.invalid",
      },
      { key: "credential", label: "Credential owner", kind: "secret_ref", referenceKind: "credential", required: true },
    ],
    sampleTask: {
      prompt: "Propose a read-only sample before running it.",
      expectedOutcome: "A tool result after approval",
    },
  },
};
let container: HTMLDivElement, root: Root;
const copy = vi.fn();
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows prerequisites, field guidance and an explicitly proposed sample without adding inputs or running a task", async () => {
  await act(async () => root.render(<ExtensionConfigurationGuidance guidance={guidance} />));
  expect(container.textContent).toContain("Create a service account before setup");
  expect(container.textContent).toContain("Use the service URL");
  expect(container.textContent).toContain("supported secure credential owner");
  expect(container.textContent).toContain("not an execution result");
  expect(container.querySelectorAll("input,textarea,select")).toHaveLength(0);
  expect(container.textContent).not.toContain("https://author.invalid");
  expect(copy).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(copy).toHaveBeenCalledWith(guidance.form.sampleTask!.prompt);
  expect(container.textContent).toContain("Review it in Chat before sending");
});
it("consumes guidance in the existing editor while preserving saved values and owner fields", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <IntegrationFormFields
        schema={{
          catalogId: "fixture",
          title: "Fixture",
          configurationGuidance: guidance,
          fields: [{ key: "endpoint", label: "Service endpoint", type: "url", defaultValue: "https://owner.invalid" }],
        }}
        value={{ endpoint: "https://saved.invalid" }}
        onChange={onChange}
      />,
    ),
  );
  expect(container.querySelectorAll("input")).toHaveLength(1);
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("https://saved.invalid");
  expect(container.textContent).toContain("Extension setup guidance");
  expect(onChange).not.toHaveBeenCalled();
});
it("leaves old manifests unchanged and explains unsupported future guidance without rendering it", async () => {
  await act(async () => root.render(<ExtensionConfigurationGuidance />));
  expect(container.textContent).toBe("");
  await act(async () =>
    root.render(<ExtensionConfigurationGuidance guidance={{ ...guidance, form: { version: "future" } as never }} />),
  );
  expect(container.textContent).toContain("guidance version is unsupported");
  expect(container.querySelector("button")).toBeNull();
});
it("keeps the sample reviewable after clipboard failure", async () => {
  copy.mockRejectedValueOnce(new Error("denied"));
  await act(async () => root.render(<ExtensionConfigurationGuidance guidance={guidance} />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).toContain("copy it manually");
  expect(container.textContent).toContain(guidance.form.sampleTask!.prompt);
});
