// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustPolicySnapshot } from "@goatcitadel/mission-control-shared/api/trust";
import type { Dialog } from "../../ui/Dialog";
import { TrustPolicySettings } from "./TrustPolicySettings";

const api = vi.hoisted(() => ({ fetchTrustPolicySnapshot: vi.fn(), navigate: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/trust", () => ({
  fetchTrustPolicySnapshot: api.fetchTrustPolicySnapshot,
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: api.navigate }) }));
vi.mock("../../ui/Dialog", () => ({
  Dialog: (props: ComponentProps<typeof Dialog>) =>
    props.open ? (
      <section role="dialog" aria-label={props.title}>
        {props.children}
      </section>
    ) : null,
}));
let root: Root, container: HTMLDivElement, snapshot: TrustPolicySnapshot;
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find((item) => item.textContent === label)!;
async function render() {
  await act(async () => root.render(<TrustPolicySettings />));
  await vi.waitFor(() => expect(button("Refresh trust snapshot").disabled).toBe(false));
}
async function search(value: string) {
  await act(async () => {
    const input = container.querySelector('input[type="search"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(index: number, value: string) {
  await act(async () => {
    const input = container.querySelectorAll("select")[index]!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected Trust mutation or transport"))),
  );
  snapshot = {
    generatedAt: "2026-09-30T12:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    enforcementSources: ["tools.grants", "skills.lifecycle"],
    sources: [{ key: "skills", owner: "skills.lifecycle", status: "available", itemCount: 1 }],
    permissionProfiles: [],
    localOperatorOverrides: [],
    addons: [],
    mcpServers: [],
    capabilities: { inspectable: [], callable: [] },
    toolGrants: [
      {
        grantId: "deny-one",
        toolPattern: "shell.*",
        decision: "deny",
        posture: "blocked",
        source: "tools.grants",
        scope: "workspace",
        scopeRef: "workspace-other",
      },
    ],
    skills: [
      {
        skillId: "recorded-skill",
        name: "Recorded skill",
        state: "enabled",
        callable: true,
        posture: "medium_trust_unverified",
        source: "skills.lifecycle",
        declaredMetadata: {
          requiredEnv: [{ name: "SYNTHETIC_KEY", secret: true }],
          stateDirs: [{ path: "state/evidence", writeable: true }],
          dependencies: { tools: ["fs.read"], skillIds: ["dependency-one"], capabilities: ["network"] },
        },
        missingRequiredEnv: ["SYNTHETIC_KEY"],
        bundleWarnings: ["Declared secret needs review"],
      },
    ],
    lastUseEvidence: [
      {
        source: "skills.lifecycle",
        subjectType: "skill",
        subjectId: "recorded-skill",
        runId: "run-exact",
        approvalId: "approval-exact",
        evidenceRef: "evidence-exact",
        usageCount: 0,
      },
    ],
  };
  api.fetchTrustPolicySnapshot.mockImplementation(async () => snapshot);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("native Trust evidence", () => {
  it("filters shared owner evidence by declarations, status and kind without asserting workspace authority", async () => {
    await render();
    expect(container.textContent).toContain("across recorded scopes");
    expect(container.textContent).not.toContain("current workspace");
    expect(container.textContent).toContain("2 matching rows");
    await search("SYNTHETIC_KEY");
    expect(container.textContent).toContain("1 matching rows");
    await select(0, "needs_review");
    await select(1, "source");
    const inspect = container.querySelector<HTMLButtonElement>('[aria-label="Inspect trust evidence Recorded skill"]')!;
    await act(async () => inspect.click());
    const detail = container.querySelector('[role="dialog"]')!;
    for (const value of [
      "skill:recorded-skill",
      "run-exact",
      "approval-exact",
      "evidence-exact",
      "0 uses",
      "SYNTHETIC_KEY",
      "state/evidence",
      "dependency-one",
    ])
      expect(detail.textContent).toContain(value);
    expect(detail.textContent).toContain("secret value not shown");
    await act(async () =>
      detail.querySelector<HTMLAnchorElement>('a[href="/library?type=skill&shell=cockpit"]')!.click(),
    );
    expect(api.navigate).toHaveBeenCalledExactlyOnceWith("/library?type=skill&shell=cockpit");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("labels partial sources and replaces old posture with unavailable evidence after a failed refresh", async () => {
    snapshot.sources.push({
      key: "capabilities.callable",
      owner: "capabilities.catalog",
      status: "unavailable",
      itemCount: 0,
      error: "Catalog not reachable",
    });
    await render();
    expect(container.textContent).toContain("Partial snapshot");
    expect(container.textContent).toContain("Catalog not reachable");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Inspect trust evidence Recorded skill"]')!.click(),
    );
    api.fetchTrustPolicySnapshot.mockRejectedValue(new Error("Gateway offline"));
    await act(async () => button("Refresh trust snapshot").click());
    await vi.waitFor(() => expect(container.textContent).toContain("Trust snapshot unavailable"));
    expect(container.querySelector('[aria-label="Trust evidence rows"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("unavailable in the latest snapshot");
    expect(container.querySelector('[role="dialog"] a')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps inspection bounded and makes a removed selection explicit on a new snapshot", async () => {
    snapshot.toolGrants = Array.from({ length: 60 }, (_, index) => ({
      grantId: `grant-${index}`,
      toolPattern: `tool.${index}`,
      decision: "deny",
      posture: "blocked",
      source: "tools.grants",
    }));
    await render();
    expect(container.querySelectorAll('[aria-label="Trust evidence rows"] > li')).toHaveLength(48);
    await act(async () => button("Show more trust evidence").click());
    expect(container.querySelectorAll('[aria-label="Trust evidence rows"] > li')).toHaveLength(61);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Inspect trust evidence Recorded skill"]')!.click(),
    );
    snapshot = { ...snapshot, skills: [], lastUseEvidence: [], generatedAt: "2026-09-30T13:00:00.000Z" };
    await act(async () => button("Refresh trust snapshot").click());
    await vi.waitFor(() =>
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain("unavailable in the latest snapshot"),
    );
    expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain("evidence-exact");
  });
  it("rejects an owner response without the read-only contract marker", async () => {
    api.fetchTrustPolicySnapshot.mockResolvedValue({ ...snapshot, mutationSemantics: "write" });
    await render();
    expect(container.textContent).toContain("did not provide the read-only Trust snapshot contract");
    expect(container.querySelector('[aria-label="Trust evidence rows"]')).toBeNull();
  });
});
