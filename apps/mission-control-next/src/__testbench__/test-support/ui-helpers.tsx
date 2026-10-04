import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TestbenchEnv } from "../env";
import type { TargetRequest } from "../gateway-target/resolve-target";
import type { TestbenchDeps } from "../ui/use-testbench";
import type { CheckDef } from "../runner/types";

export const ENV: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "/tmp/sandbox",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};
export const SANDBOX_REQUEST: TargetRequest = { requested: "sandbox", origin: ENV.sandboxOrigin };
export const REAL_REQUEST: TargetRequest = { requested: "real", origin: ENV.realOrigin };

interface ConfirmStubProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Stands in for the shared ConfirmModal: a plain dialog with the same props, no portal or focus trap. */
export function confirmModalStub() {
  return {
    ConfirmModal: (props: ConfirmStubProps) =>
      props.open ? (
        <div role="dialog" aria-label={props.title}>
          <p>{props.message}</p>
          <button type="button" onClick={props.onConfirm}>
            {props.confirmLabel ?? "Confirm"}
          </button>
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      ) : null,
  };
}

export function makeDeps(handWritten: readonly CheckDef[], overrides: Partial<TestbenchDeps> = {}): TestbenchDeps {
  return {
    apiBase: () => "http://127.0.0.1:41873",
    preflight: async () => ({ status: "ready", message: "Gateway ready." }),
    fetchStatus: async () => ({ diagnosticsEnabled: true, rootDir: "/tmp/sandbox" }),
    fetchManifest: async () => ({
      items: [
        { method: "GET", url: "/api/v1/demo", tracked: true, accessClass: "operator" },
        { method: "POST", url: "/api/v1/demo", tracked: true, accessClass: "operator" },
        { method: "GET", url: "/api/v1/uncovered/:thingId", tracked: true, accessClass: "operator" },
      ],
    }),
    seed: async () => ({ workspaceId: "ws-test" }),
    handWritten,
    ...overrides,
  };
}

/** A route list that matches the single route `makeCheck` claims, so no auto-probes or stale claims appear. */
export const TEST_ROUTE_MANIFEST: TestbenchDeps["fetchManifest"] = async () => ({
  items: [{ method: "GET", url: "/api/v1/test", tracked: true, accessClass: "operator" }],
});

const roots: Root[] = [];

export function cleanup(): void {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
}

export async function render(ui: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(ui);
  });
}

export function text(): string {
  return document.body.textContent ?? "";
}

export async function waitForText(expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (text().includes(expected)) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Text not found: ${expected}\n${text()}`);
}

export function buttonNamed(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  );
  if (!found) {
    throw new Error(`No button named ${name}`);
  }
  return found;
}

export function buttonStartingWith(prefix: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.trim().startsWith(prefix),
  );
  if (!found) {
    throw new Error(`No button starting with ${prefix}`);
  }
  return found;
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** The main (selectable) button of every visible check row, in display order. */
export function rowButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testbench-row]"));
}

/** The visible check titles, without the kind label that follows each title. */
export function rowTitles(): string[] {
  return rowButtons().map((row) => row.querySelector(".testbench-row-title")?.firstChild?.textContent?.trim() ?? "");
}

export function rowFor(title: string): HTMLButtonElement {
  const index = rowTitles().indexOf(title);
  const row = rowButtons()[index];
  if (!row) {
    throw new Error(`No row titled ${title}; rows are ${rowTitles().join(", ")}`);
  }
  return row;
}
