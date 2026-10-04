// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fail, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import {
  ENV,
  REAL_REQUEST,
  SANDBOX_REQUEST,
  buttonNamed,
  cleanup,
  click,
  makeDeps,
  render,
  rowFor,
  rowButtons,
  text,
  waitForText,
} from "../test-support/ui-helpers";
import { TestbenchApp } from "./TestbenchApp";

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", async () =>
  (await import("../test-support/ui-helpers")).confirmModalStub(),
);

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

afterEach(cleanup);

function dialog(): Element | null {
  return document.querySelector('[role="dialog"]');
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
    expect(dialog()?.textContent).toContain("Spends tokens.");
    expect(external).not.toHaveBeenCalled();
    await click(buttonNamed("Run it"));
    await waitForText("Run completed: 1 pass");
    expect(external).toHaveBeenCalledTimes(1);
  });

  it("states where an external check runs and its own cost, without a generic cost claim", async () => {
    const { checks } = makeChecks();
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(checks)} />);
    await waitForText("Demo external");
    await click(buttonNamed("Run Demo external"));
    const message = dialog()?.textContent ?? "";
    expect(message).toContain(
      "“Demo external” runs against the sandbox gateway and leaves this machine. Spends tokens.",
    );
    expect(message).not.toContain("provider tokens");
  });

  it("names the real gateway in the confirmation when an allowlisted check runs there", async () => {
    const deps = makeDeps(makeChecks().checks, { apiBase: () => "http://127.0.0.1:8787" });
    await render(<TestbenchApp targetRequest={REAL_REQUEST} env={ENV} deps={deps} />);
    await waitForText("REAL gateway");
    await click(buttonNamed("Run Demo external"));
    expect(dialog()?.textContent).toContain(
      "“Demo external” runs against the real gateway at http://127.0.0.1:8787 and leaves this machine.",
    );
  });

  it("does not run an external check when the confirmation is cancelled", async () => {
    const { checks, external } = makeChecks();
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(checks)} />);
    await waitForText("Demo external");
    await click(buttonNamed("Run Demo external"));
    expect(dialog()).not.toBeNull();
    await click(buttonNamed("Cancel"));
    expect(dialog()).toBeNull();
    expect(external).not.toHaveBeenCalled();
    expect(rowFor("Demo external").textContent).toContain("○ not run");
  });

  it("asks again every time: a confirmation covers only the run it was given for", async () => {
    const { checks, external } = makeChecks();
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(checks)} />);
    await waitForText("Demo external");
    await click(buttonNamed("Run Demo external"));
    await click(buttonNamed("Run it"));
    await waitForText("Run completed: 1 pass");
    expect(external).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();

    await click(buttonNamed("Run Demo external"));
    expect(dialog()).not.toBeNull();
    expect(external).toHaveBeenCalledTimes(1);
  });

  it("never runs an external check from Run all, even after it was confirmed once", async () => {
    const { checks, external } = makeChecks();
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(checks)} />);
    await waitForText("Demo external");
    await click(buttonNamed("Run Demo external"));
    await click(buttonNamed("Run it"));
    await waitForText("Run completed: 1 pass");

    await click(buttonNamed("Run all allowed"));
    await waitForText("Run completed: 2 pass, 1 fail, 0 blocked, 2 skipped.");
    expect(external).toHaveBeenCalledTimes(1);
    await click(rowFor("Demo external"));
    const drawer = document.querySelector('aside[aria-label="Demo external details"]');
    expect(drawer?.textContent).toContain("External checks run only after you confirm them.");
  });

  it("shows journey steps, including steps that never ran, in the drawer", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Run all allowed");
    await click(buttonNamed("Run all allowed"));
    await waitForText("Run completed");
    await click(rowFor("Demo journey"));
    const drawer = document.querySelector('aside[aria-label="Demo journey details"]');
    expect(drawer?.textContent).toContain("✓ First step");
    expect(drawer?.textContent).toContain("○ Second step (not run)");
    expect(drawer?.textContent).not.toContain("– Second step");
    expect(drawer?.textContent).toContain("Second step never ran.");
  });

  it("lists uncovered routes and stale claims", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Uncovered routes (1)");
    await click(buttonNamed("Uncovered routes (1)"));
    expect(text()).toContain("GET /api/v1/uncovered/:thingId");
    expect(text()).toContain("claimed by demo.host");
  });

  it("switches views with pressed buttons in a labelled group, not a partial tab pattern", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Uncovered routes (1)");
    expect(document.querySelector('[role="tab"], [role="tablist"]')).toBeNull();
    expect(document.querySelector('[role="group"][aria-label="Test bench views"]')).not.toBeNull();
    expect(buttonNamed("Live console").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("Uncovered routes (1)").getAttribute("aria-pressed")).toBe("false");
    await click(buttonNamed("Uncovered routes (1)"));
    expect(buttonNamed("Live console").getAttribute("aria-pressed")).toBe("false");
    expect(buttonNamed("Uncovered routes (1)").getAttribute("aria-pressed")).toBe("true");
    expect(rowButtons()).toHaveLength(0);
    await click(buttonNamed("Live console"));
    expect(rowButtons().length).toBeGreaterThan(0);
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
    const rows = rowButtons();
    rows[0]?.focus();
    await act(async () => {
      rows[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[1]);
  });
});
