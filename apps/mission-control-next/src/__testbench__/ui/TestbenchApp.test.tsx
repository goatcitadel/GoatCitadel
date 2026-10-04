// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestbenchEnv } from "../env";
import { fail, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { TestbenchApp } from "./TestbenchApp";
import type { TestbenchDeps } from "./use-testbench";

interface ConfirmStubProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", async () => {
  const { createElement } = await import("react");
  return {
    ConfirmModal: (props: ConfirmStubProps) =>
      props.open
        ? createElement(
            "div",
            { role: "dialog", "aria-label": props.title },
            createElement("p", null, props.message),
            createElement("button", { type: "button", onClick: props.onConfirm }, props.confirmLabel ?? "Confirm"),
            createElement("button", { type: "button", onClick: props.onCancel }, "Cancel"),
          )
        : null,
  };
});

const ENV: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "/tmp/sandbox",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};
const SANDBOX_REQUEST: TargetRequest = { requested: "sandbox", origin: ENV.sandboxOrigin };
const REAL_REQUEST: TargetRequest = { requested: "real", origin: ENV.realOrigin };

function makeChecks() {
  const external = vi.fn(async () => pass("External ok."));
  const checks: CheckDef[] = [
    {
      id: "demo.read",
      kind: "probe",
      domain: "health",
      title: "Demo read",
      tier: "read",
      routes: ["GET /api/v1/demo"],
      run: async () => pass("Read ok."),
    },
    {
      id: "demo.mutate",
      kind: "probe",
      domain: "chat",
      title: "Demo mutate",
      tier: "mutate",
      routes: ["POST /api/v1/demo"],
      run: async () => pass("Mutate ok."),
    },
    {
      id: "demo.journey",
      kind: "journey",
      domain: "chat",
      title: "Demo journey",
      tier: "mutate",
      routes: ["POST /api/v1/demo"],
      steps: ["First step", "Second step"],
      run: async (ctx) => {
        await ctx.step("First step", async () => undefined);
        return fail("Second step never ran.");
      },
    },
    {
      id: "demo.host",
      kind: "probe",
      domain: "code-mode",
      title: "Demo host",
      tier: "host",
      routes: ["POST /api/v1/code-mode/runs"],
      run: async () => pass("Host ok."),
    },
    {
      id: "demo.external",
      kind: "probe",
      domain: "llm",
      title: "Demo external",
      tier: "external",
      realSafe: true,
      routes: ["POST /api/v1/dev/verification/provider-exercise"],
      description: "Spends tokens.",
      run: external,
    },
  ];
  return { checks, external };
}

function makeDeps(handWritten: readonly CheckDef[], overrides: Partial<TestbenchDeps> = {}): TestbenchDeps {
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

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

async function render(ui: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(ui);
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

async function waitForText(expected: string): Promise<void> {
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

function buttonNamed(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  );
  if (!found) {
    throw new Error(`No button named ${name}`);
  }
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe("TestbenchApp", () => {
  it("shows the verified sandbox, the coverage meter, and every check", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("SANDBOX ✓ verified");
    expect(text()).toContain("Coverage 2 / 3 routes (67%)");
    expect(text()).toContain("Demo journey");
  });

  it("runs every allowed check, skips the rest, and announces the result", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Run all allowed");
    await click(buttonNamed("Run all allowed"));
    await waitForText("Run completed: 2 pass, 1 fail, 0 blocked, 2 skipped.");
    expect(text()).toContain("Host checks are off for this run.");
  });

  it("runs a host check once the per-run opt-in is ticked", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Allow host checks");
    expect(buttonNamed("Run Demo host").disabled).toBe(true);
    const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await click(toggle as HTMLInputElement);
    expect(buttonNamed("Run Demo host").disabled).toBe(false);
  });

  it("keeps mutating checks disabled with the reason on the real gateway", async () => {
    const deps = makeDeps(makeChecks().checks, { apiBase: () => "http://127.0.0.1:8787" });
    await render(<TestbenchApp targetRequest={REAL_REQUEST} env={ENV} deps={deps} />);
    await waitForText("REAL gateway");
    expect(text()).toContain("Mutating checks never run on the real gateway.");
    expect(buttonNamed("Run Demo mutate").disabled).toBe(true);
  });

  it("asks for confirmation before an external check and runs it once confirmed", async () => {
    const { checks, external } = makeChecks();
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(checks)} />);
    await waitForText("Demo external");
    await click(buttonNamed("Run Demo external"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Spends tokens.");
    expect(external).not.toHaveBeenCalled();
    await click(buttonNamed("Run it"));
    await waitForText("Run completed: 1 pass");
    expect(external).toHaveBeenCalledTimes(1);
  });

  it("shows journey steps, including steps that never ran, in the drawer", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Run all allowed");
    await click(buttonNamed("Run all allowed"));
    await waitForText("Run completed");
    const journeyRow = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testbench-row]")).find((row) =>
      row.textContent?.includes("Demo journey"),
    );
    await click(journeyRow as HTMLButtonElement);
    const drawer = document.querySelector('aside[aria-label="Demo journey details"]');
    expect(drawer?.textContent).toContain("✓ First step");
    expect(drawer?.textContent).toContain("Second step (not run)");
    expect(drawer?.textContent).toContain("Second step never ran.");
  });

  it("lists uncovered routes and stale claims", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Uncovered routes (1)");
    await click(buttonNamed("Uncovered routes (1)"));
    expect(text()).toContain("GET /api/v1/uncovered/:thingId");
    expect(text()).toContain("claimed by demo.host");
  });

  it("copies a Markdown report", async () => {
    const writeText = vi.fn(async (_markdown: string) => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Copy report");
    await click(buttonNamed("Copy report"));
    await waitForText("Report copied as Markdown.");
    expect(writeText.mock.calls[0]?.[0]).toContain("# GoatCitadel test bench report");
  });

  it("explains an unreachable gateway with the dev-server hint", async () => {
    const deps = makeDeps([], { preflight: async () => ({ status: "unreachable", message: "Network error." }) });
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={deps} />);
    await waitForText("Gateway unreachable");
    expect(text()).toContain("port 5173");
  });

  it("reports coverage as unavailable when the route list cannot be read", async () => {
    const deps = makeDeps(makeChecks().checks, {
      fetchManifest: async () => {
        throw new Error("API error 404");
      },
    });
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={deps} />);
    await waitForText("Coverage unavailable: API error 404");
  });

  it("moves focus between rows with the arrow keys", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Demo read");
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testbench-row]"));
    rows[0]?.focus();
    await act(async () => {
      rows[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[1]);
  });
});
