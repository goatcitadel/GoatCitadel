// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { fail, pass } from "../runner/assert";
import type { CheckDef, CheckResult } from "../runner/types";
import { deferred, makeCheck } from "../test-support/scheduler-helpers";
import {
  ENV,
  SANDBOX_REQUEST,
  TEST_ROUTE_MANIFEST,
  buttonNamed,
  buttonStartingWith,
  cleanup,
  click,
  makeDeps,
  render,
  rowFor,
  rowTitles,
  text,
  typeInto,
  waitForText,
} from "../test-support/ui-helpers";
import { TestbenchApp } from "./TestbenchApp";

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", async () =>
  (await import("../test-support/ui-helpers")).confirmModalStub(),
);

afterEach(cleanup);

async function renderChecks(checks: readonly CheckDef[]): Promise<void> {
  const deps = makeDeps(checks, { fetchManifest: TEST_ROUTE_MANIFEST });
  await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={deps} />);
  await waitForText("Run all allowed");
}

function neverFinishes(): Promise<CheckResult> {
  return new Promise<CheckResult>(() => undefined);
}

function liveRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-live="polite"]');
}

function railButton(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>(".testbench-rail-list button")).find(
    (button) => button.querySelector("span")?.textContent === label,
  );
  if (!found) {
    throw new Error(`No rail button for ${label}`);
  }
  return found;
}

function searchBox(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
}

describe("TestbenchApp result states", () => {
  it("renders every result state with its icon and its word", async () => {
    await renderChecks([
      makeCheck("Passes", "read", async () => pass("ok")),
      makeCheck("Fails", "read", async () => fail("nope")),
      makeCheck("Blocked", "read", async () => ({ status: "blocked", summary: "Disabled on this gateway." })),
      makeCheck("Host only", "host", async () => pass("host")),
      makeCheck("Hangs", "mutate", neverFinishes),
      makeCheck("Queued behind", "mutate", async () => pass("later")),
    ]);
    for (const title of rowTitles()) {
      expect(rowFor(title).textContent).toContain("○ not run");
    }

    await click(buttonNamed("Run all allowed"));
    await waitForText("◌ running");
    expect(rowFor("Passes").textContent).toContain("✓ pass");
    expect(rowFor("Fails").textContent).toContain("✕ fail");
    expect(rowFor("Blocked").textContent).toContain("◐ blocked");
    expect(rowFor("Host only").textContent).toContain("– skipped");
    expect(rowFor("Hangs").textContent).toContain("◌ running");
    expect(rowFor("Queued behind").textContent).toContain("… queued");

    await click(buttonNamed("Stop"));
    await waitForText("Run stopped: 1 pass, 1 fail, 1 blocked, 1 skipped, 2 cancelled.");
    expect(rowFor("Hangs").textContent).toContain("■ cancelled");
    expect(rowFor("Queued behind").textContent).toContain("■ cancelled");
  });

  it("marks the in-flight check cancelled when Stop is pressed", async () => {
    await renderChecks([makeCheck("Hangs", "mutate", neverFinishes)]);
    expect(buttonNamed("Stop").disabled).toBe(true);
    await click(buttonNamed("Run all allowed"));
    await waitForText("◌ running");
    expect(buttonNamed("Stop").disabled).toBe(false);
    expect(buttonNamed("Run all allowed").disabled).toBe(true);

    await click(buttonNamed("Stop"));
    await waitForText("Run stopped");
    expect(rowFor("Hangs").textContent).toContain("■ cancelled");
    expect(buttonNamed("Stop").disabled).toBe(true);
    await click(rowFor("Hangs"));
    expect(document.querySelector('aside[aria-label="Hangs details"]')?.textContent).toContain(
      "Stopped before it finished.",
    );
  });

  it("announces the outcome once per run in a polite live region that stays empty while running", async () => {
    const gate = deferred();
    await renderChecks([
      makeCheck("Slow", "read", async () => {
        await gate.promise;
        return pass("done");
      }),
    ]);
    const region = liveRegion();
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(region?.textContent).toBe("");

    await click(buttonNamed("Run all allowed"));
    await waitForText("◌ running");
    expect(liveRegion()?.textContent).toBe("");

    await act(async () => {
      gate.resolve();
    });
    const sentence = "Run completed: 1 pass, 0 fail, 0 blocked, 0 skipped.";
    await waitForText(sentence);
    expect(liveRegion()).toBe(region);
    expect(liveRegion()?.textContent).toBe(sentence);
    expect(text().split("Run completed").length - 1).toBe(1);
  });

  it("shows the run-level banner when the gateway becomes unreachable mid-run", async () => {
    await renderChecks([
      makeCheck("Network down", "read", async () => {
        throw new ApiRequestError("Network error GET /api/v1/test: fetch failed", {
          kind: "network",
          method: "GET",
          path: "/api/v1/test",
        });
      }),
      makeCheck("Never reached", "mutate", async () => pass("later")),
    ]);
    expect(document.querySelector('[role="alert"]')).toBeNull();

    await click(buttonNamed("Run all allowed"));
    await waitForText("Run halted because the gateway became unreachable");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Gateway unreachable:");
    expect(rowFor("Network down").textContent).toContain("✕ fail");
    expect(rowFor("Never reached").textContent).toContain("○ not run");
  });
});

describe("TestbenchApp filters and areas", () => {
  async function renderMixedRun(): Promise<void> {
    await renderChecks([
      makeCheck("Passes", "read", async () => pass("ok"), { domain: "health" }),
      makeCheck("Fails", "read", async () => fail("nope"), { domain: "chat" }),
      makeCheck("Host only", "host", async () => pass("host"), { domain: "chat" }),
    ]);
    await click(buttonNamed("Run all allowed"));
    await waitForText("Run completed: 1 pass, 1 fail, 0 blocked, 1 skipped.");
  }

  it("narrows the list with the status chips", async () => {
    await renderMixedRun();
    expect(rowTitles()).toEqual(["Passes", "Fails", "Host only"]);
    await click(buttonStartingWith("✕ Failing"));
    expect(rowTitles()).toEqual(["Fails"]);
    expect(buttonStartingWith("✕ Failing").getAttribute("aria-pressed")).toBe("true");
    await click(buttonStartingWith("– Skipped"));
    expect(rowTitles()).toEqual(["Host only"]);
    await click(buttonNamed("All"));
    expect(rowTitles()).toEqual(["Passes", "Fails", "Host only"]);
  });

  it("narrows the list with the tier chips and the search box", async () => {
    await renderMixedRun();
    await click(buttonNamed("host"));
    expect(rowTitles()).toEqual(["Host only"]);
    await click(buttonNamed("host"));
    await typeInto(searchBox(), "pass");
    expect(rowTitles()).toEqual(["Passes"]);
    await typeInto(searchBox(), "no such check");
    expect(rowTitles()).toEqual([]);
    expect(text()).toContain("No checks match these filters.");
  });

  it("narrows the list to one area from the rail and back to all areas", async () => {
    await renderMixedRun();
    await click(railButton("Chat"));
    expect(rowTitles()).toEqual(["Fails", "Host only"]);
    expect(railButton("Chat").getAttribute("aria-current")).toBe("true");
    await click(railButton("Health"));
    expect(rowTitles()).toEqual(["Passes"]);
    await click(railButton("All areas"));
    expect(rowTitles()).toEqual(["Passes", "Fails", "Host only"]);
  });

  it("narrows the list from the area dropdown used on small screens", async () => {
    await renderMixedRun();
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Area"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "health";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rowTitles()).toEqual(["Passes"]);
  });
});
