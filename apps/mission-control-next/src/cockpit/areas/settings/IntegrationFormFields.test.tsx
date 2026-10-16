// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IntegrationFormSchema } from "@goatcitadel/contracts";
import { IntegrationFormFields } from "./IntegrationFormFields";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mirrors the Gateway's `automation.gmail` catalog schema: handle names and env references, no raw secrets. */
const gmail: IntegrationFormSchema = {
  catalogId: "automation.gmail",
  title: "Gmail Connection",
  description: "Configure Gmail integration using OAuth token handles or env references.",
  allowAdvancedJson: true,
  fields: [
    { key: "label", label: "Connection Label", type: "text", defaultValue: "Gmail" },
    {
      key: "clientIdEnv",
      label: "Client ID ENV Var",
      type: "text",
      placeholder: "GMAIL_CLIENT_ID",
      secretRef: true,
      advanced: true,
    },
    {
      key: "clientSecretEnv",
      label: "Client Secret ENV Var",
      type: "text",
      placeholder: "GMAIL_CLIENT_SECRET",
      secretRef: true,
      advanced: true,
    },
    {
      key: "refreshTokenHandle",
      label: "Refresh Token Handle",
      type: "text",
      placeholder: "gmail-primary",
      required: true,
    },
    { key: "enabled", label: "Enabled", type: "boolean", defaultValue: true },
  ],
} as IntegrationFormSchema;

const LOCK_NOTICE = "Use the supported secure setup owner for this credential.";
const input = (label: string) => {
  const node = [...container.querySelectorAll("label")].find((item) => item.textContent?.startsWith(label));
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(node?.getAttribute("for") ?? "")}`);
};
const fieldText = (label: string) => input(label)?.parentElement?.textContent ?? "";

it("keeps the Gmail refresh-token handle name editable instead of locking it as a credential", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<IntegrationFormFields schema={gmail} value={{}} onChange={onChange} />));
  const handle = input("Refresh Token Handle")!;
  expect(handle.disabled).toBe(false);
  expect(handle.type).toBe("text");
  expect(fieldText("Refresh Token Handle")).not.toContain(LOCK_NOTICE);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(handle, "gmail-primary");
    handle.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith({ refreshTokenHandle: "gmail-primary" });
});

it("keeps secret references editable as variable names and locks only schema-declared password fields", async () => {
  const schema = {
    ...gmail,
    fields: [...gmail.fields, { key: "apiToken", label: "Raw API Token", type: "password" as const }],
  };
  await act(async () => root.render(<IntegrationFormFields schema={schema} value={{}} onChange={vi.fn()} />));
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Show advanced fields")!.click(),
  );
  const secretEnv = input("Client Secret ENV Var")!;
  expect(secretEnv.disabled).toBe(false);
  expect(fieldText("Client Secret ENV Var")).toContain("Environment reference; enter a variable name.");
  expect(fieldText("Client Secret ENV Var")).not.toContain(LOCK_NOTICE);
  const raw = input("Raw API Token")!;
  expect(raw.disabled).toBe(true);
  expect(raw.type).toBe("password");
  expect(fieldText("Raw API Token")).toContain(LOCK_NOTICE);
});
