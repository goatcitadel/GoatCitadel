// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatHostStatus } from "./ChatHostStatus";

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

describe("Chat host status", () => {
  it("shows a host error as a Cockpit callout without announcing it", () => {
    act(() => root.render(<ChatHostStatus status={{ error: "Choose off effort instead.", refreshing: false }} />));
    expect(container.textContent).toBe("Choose off effort instead.");
    expect(container.querySelector('[role="alert"], [role="status"], [aria-live]')).toBeNull();
    expect(container.querySelector("p.error")).toBeNull();
  });

  it("shows the refresh line and nothing when idle", () => {
    act(() => root.render(<ChatHostStatus status={{ error: null, refreshing: true }} />));
    expect(container.textContent).toBe("Refreshing the conversation…");
    expect(container.querySelector('[role="alert"], [role="status"], [aria-live]')).toBeNull();
    act(() => root.render(<ChatHostStatus status={{ error: null, refreshing: false }} />));
    expect(container.textContent).toBe("");
    act(() => root.render(<ChatHostStatus />));
    expect(container.textContent).toBe("");
  });
});
