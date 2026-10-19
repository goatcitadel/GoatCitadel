// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmptyLlmTransportDraft,
  type LlmTransportDraft,
} from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { ProviderTransportFields, transportErrorField } from "./ProviderTransportFields";

let root: Root, container: HTMLDivElement;
function Harness({ error }: { error?: string | null }) {
  const [draft, setDraft] = useState<LlmTransportDraft>(createEmptyLlmTransportDraft());
  return <ProviderTransportFields draft={draft} onChange={setDraft} disabled={false} error={error} />;
}
const describedText = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("provider request transport fields", () => {
  it("checks the headers JSON on blur and ties the error to the field", async () => {
    await act(async () => root.render(<Harness />));
    const headers = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(headers, "{not json");
      headers.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(headers.getAttribute("aria-invalid")).toBeNull();
    await act(async () => {
      headers.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(headers.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(headers)).toContain("Enter valid JSON");
  });

  it("shows a saved-request validation message on the field it belongs to and opens the group", async () => {
    await act(async () => root.render(<Harness error="Proxy settings require a proxy URL." />));
    expect(container.querySelector("details")?.open).toBe(true);
    const proxy = container.querySelector<HTMLInputElement>("input[type=url]")!;
    expect(proxy.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(proxy)).toContain("Proxy settings require a proxy URL.");
    expect(container.querySelector('[role="alert"]:not([id])')).toBeNull();
  });

  it("routes each message to its field, or to the group when no single field owns it", () => {
    expect(transportErrorField("Custom headers must be valid JSON.")).toBe("headers");
    expect(transportErrorField("Proxy settings require a proxy URL.")).toBe("proxy-url");
    expect(transportErrorField("Bearer auth requires either a token or token env var.")).toBe("other");
    expect(transportErrorField(null)).toBeNull();
  });
});
