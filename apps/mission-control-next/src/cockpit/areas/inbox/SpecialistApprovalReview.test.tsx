// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalRequest, ApprovalEffectRecord, CodeModeRunRecord, CodeModeRunArtifactPreview } from "@goatcitadel/contracts";
import { ApprovalDecisionBar } from "./ApprovalDecisionBar";
import { SpecialistApprovalReview } from "./SpecialistApprovalReview";
import {
  specialistEvidenceMatches,
  specialistEvidenceKey,
  type SpecialistEvidence,
} from "./specialist-approval-evidence";
import { __resetInboxApprovalAttemptsForTests } from "./inbox-approval-attempts";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
const api = vi.hoisted(() => ({ read: vi.fn(), replay: vi.fn(), code: vi.fn(), source: vi.fn(), decide: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: api.read,
  fetchApprovalReplay: api.replay,
}));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  fetchCodeModeRun: api.code,
  fetchCodeModeRunArtifact: api.source,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ resolveApproval: api.decide }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "one" }),
}));
const approval: ApprovalRequest = {
  approvalId: "code-approval",
  kind: "code_mode.run",
  riskLevel: "caution",
  explanationStatus: "not_requested",
  status: "pending",
  payload: { runId: "code-run", codeHash: "hash", wrapperManifestHash: "wrappers", capabilitySnapshotId: "snapshot" },
  preview: { targets: ["source.js"] },
  linkage: { workspaceId: "one" },
  createdAt: "2026-01-01",
};
const code = {
  runId: "code-run",
  approvalId: "code-approval",
  workspaceId: "one",
  status: "approval_pending",
  codeHash: "hash",
  wrapperManifestHash: "wrappers",
  capabilitySnapshotId: "snapshot",
  codeArtifact: { relPath: "source.js" },
  language: "javascript",
} as CodeModeRunRecord;
const source = {
  runId: "code-run",
  artifactKind: "source",
  sha256: "hash",
  content: "return 1;",
  truncated: false,
  verifiedAt: "first",
} as CodeModeRunArtifactPreview;
const evidence: SpecialistEvidence = { replay: { approval, events: [], effects: [] }, code, source };
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  __resetInboxApprovalAttemptsForTests();
  api.read.mockResolvedValue(approval);
  api.replay.mockResolvedValue(evidence.replay);
  api.code.mockResolvedValue(code);
  api.source.mockResolvedValue({ ...source, verifiedAt: "second" });
  api.decide.mockResolvedValue({ approval: { ...approval, status: "approved" }, effects: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render(value = evidence, record = approval) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalDecisionBar
          approval={record}
          workspaceId="one"
          specialistEvidence={value}
          onResolved={vi.fn()}
          onInvalidated={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  );
}
async function click(name: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => !item.closest('[aria-hidden="true"]') && item.textContent === name,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
it.each([
  ["Home", 0],
  ["End", 2400],
])("keeps %s inside complete focused code source and retains immutable-source preflight", async (key, top) => {
  const content = `${"// Read every line before approval.\n".repeat(80)}return 1;\n`;
  const value = { ...evidence, source: { ...source, content } };
  await render(value);
  await click("Review approval");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const region = dialog.querySelector<HTMLElement>('[aria-label="Reviewed code source"]')!;
  Object.defineProperties(region, { scrollHeight: { value: 2800 }, clientHeight: { value: 400 } });
  dialog.scrollTop = 900;
  region.scrollTop = 360;
  region.focus();
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => { region.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(region.scrollTop).toBe(top);
  expect(dialog.scrollTop).toBe(900);
  expect(document.activeElement).toBe(region);
  expect(region.textContent).toBe(content);
  expect(api.decide).not.toHaveBeenCalled();
  api.source.mockResolvedValue({ ...source, content, sha256: "changed" });
  await click("Approve once");
  expect(api.source).toHaveBeenCalled();
  expect(api.decide).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Specialist evidence changed");
});
it("keeps code-source page, arrow, Tab and modified keys native", async () => {
  await render();
  await click("Review approval");
  const region = document.querySelector<HTMLElement>('[role="dialog"] [aria-label="Reviewed code source"]')!;
  region.scrollTop = 120;
  region.focus();
  const nativeKeys: KeyboardEventInit[] = [
    ...["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Tab"].map((key) => ({ key })),
    { key: "Tab", shiftKey: true },
    ...["Home", "End"].flatMap((key) => [
      { key, ctrlKey: true }, { key, metaKey: true }, { key, altKey: true }, { key, shiftKey: true },
    ]),
  ];
  for (const init of nativeKeys) {
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    region.dispatchEvent(event);
    expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    expect(region.scrollTop).toBe(120);
    expect(document.activeElement).toBe(region);
  }
  await act(async () => {
    region.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.decide).not.toHaveBeenCalled();
});
it("shows exact source in deliberate caution review; Cancel has no effect and confirm checks current artifact then decides once", async () => {
  await render();
  await click("Review approval");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("return 1;");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("source.js");
  const scrollRegion = document.querySelector<HTMLElement>('[role="region"][aria-label="Approval action evidence"]')!;
  expect(scrollRegion.tabIndex).toBe(0); scrollRegion.focus(); expect(document.activeElement).toBe(scrollRegion);
  await click("Cancel");
  expect(api.decide).not.toHaveBeenCalled();
  await click("Review approval");
  await click("Approve once");
  expect(api.decide).toHaveBeenCalledExactlyOnceWith("code-approval", "approve");
  expect(api.source).toHaveBeenCalledWith("code-run", "source", {
    workspaceId: "one",
    sessionId: undefined,
    turnId: undefined,
  });
});
it("bounds long Code metadata while retaining complete source bytes and keyboard access", async () => {
  const token = "owned_" + "a".repeat(220);
  const content = `// ${token}\nreturn 1;\n`;
  await act(async () =>
    root.render(
      <SpecialistApprovalReview
        approval={approval}
        evidence={{
          ...evidence,
          code: {
            ...code,
            workspaceId: token,
            permissionProfileLabel: token,
            requestedOutputIntent: token,
            codeArtifact: { ...code.codeArtifact, relPath: `folder/${token}.js` },
          },
          source: { ...source, content },
        }}
      />,
    ),
  );
  const review = host.querySelector('[aria-label="Governed code review"]')!;
  expect(review.classList.contains("grid-cols-1")).toBe(true);
  expect(review.classList.contains("wrap-anywhere")).toBe(true);
  expect(review.textContent).toContain(`Workspace ${token}`);
  expect(review.textContent).toContain(`folder/${token}.js`);
  const region = host.querySelector<HTMLElement>('[aria-label="Reviewed code source"]')!;
  expect(region.textContent).toBe(content);
  expect(region.classList.contains("max-w-full")).toBe(true);
  expect(region.tabIndex).toBe(0);
  region.focus();
  expect(document.activeElement).toBe(region);
});
it("blocks changed immutable source and actor changes before decision", async () => {
  await render();
  await click("Review approval");
  api.source.mockResolvedValue({ ...source, sha256: "changed" });
  await click("Approve once");
  expect(api.decide).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Specialist evidence changed");
  await act(async () => notifyGatewayAccessChanged());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("rejects missing, truncated and foreign specialist evidence", () => {
  expect(specialistEvidenceMatches(approval, { ...evidence, source: undefined })).toBe(false);
  expect(specialistEvidenceMatches(approval, { ...evidence, source: { ...source, truncated: true } })).toBe(false);
  expect(specialistEvidenceMatches(approval, { ...evidence, code: { ...code, workspaceId: "foreign" } })).toBe(false);
  expect(specialistEvidenceKey(evidence)).toBe(
    specialistEvidenceKey({ ...evidence, source: { ...source, verifiedAt: "later" } }),
  );
});
it("native launch hash and file disclosure remain exact and expiring evidence", async () => {
  const worker = {
    ...approval,
    kind: "remote_worker.native_runtime",
    payload: { nativeRuntime: { expectation: { requestSha256: "request" } } },
  };
  const native = {
    replay: {
      approval: worker,
      events: [],
      effects: [],
      nativeRuntimeReview: {
        requestSha256: "request",
        imagePath: "worker.exe",
        commandLine: "worker.exe",
        workingDirectory: "C:/owned",
        environment: {},
        limits: {
          processLimit: 1,
          memoryBytes: 1048576,
          cpuMilli: 1000,
          wallMs: 1000,
          rawOutputBytes: 100,
          diagnosticBytes: 100,
          inputBytes: 100,
        },
      },
    },
  } as SpecialistEvidence;
  expect(specialistEvidenceMatches(worker, native)).toBe(true);
  expect(specialistEvidenceMatches(worker, { replay: { ...native.replay, nativeRuntimeReview: undefined } })).toBe(
    false,
  );
  expect(
    specialistEvidenceMatches(
      {
        ...worker,
        payload: {
          ...worker.payload,
          nativeFileDisclosure: { destination: "gateway_artifacts", executionWorkspaceId: "one" },
        },
      },
      native,
    ),
  ).toBe(false);
  const path = `C:/owned/${"a".repeat(220)}/worker.exe`;
  const reviewed = { ...native, replay: { ...native.replay, nativeRuntimeReview: {
    ...native.replay.nativeRuntimeReview!, imagePath: path, commandLine: `${path} --inspect`,
  } } };
  await act(async () => root.render(<SpecialistApprovalReview approval={worker} evidence={reviewed} />));
  const section = host.querySelector('[aria-label="Native launch details"]')!;
  expect(section.classList.contains("grid-cols-1")).toBe(true);
  expect(section.classList.contains("wrap-anywhere")).toBe(true);
  expect(section.textContent).toContain(path);
  expect(section.querySelector("pre")?.textContent).toBe(`${path} --inspect`);
  expect(section.textContent).toContain("1 MiB");
  expect(section.textContent).toContain("1 cores");
  expect(section.textContent).toContain("1 seconds");
});

function observed(value: SpecialistEvidence, stamp: string): SpecialistEvidence {
  return {
    ...value,
    replay: {
      ...value.replay,
      events: [...value.replay.events, { eventId: stamp, approvalId: value.replay.approval.approvalId, eventType: "replayed", actorId: "operator", timestamp: stamp, payload: { status: "pending" } }],
      effects: [...value.replay.effects, { effectId: stamp, effectKind: "approval_observability", status: "completed", updatedAt: stamp } as ApprovalEffectRecord],
    },
    source: value.source ? { ...value.source, verifiedAt: stamp } : undefined,
  };
}
it("approves once after real replay-read event and observability additions without changing the reviewed source", async () => {
  const fresh = observed(evidence, "second-read");
  api.replay.mockResolvedValue(fresh.replay);
  await render(); await click("Review approval"); await click("Approve once");
  expect(api.decide).toHaveBeenCalledExactlyOnceWith("code-approval", "approve");
  expect(fresh.replay.events).toHaveLength(1); // Comparison never mutates audit evidence.
});
it("keeps nuclear confirmation input through an observation-only background refresh", async () => {
  const nuclear = { ...approval, riskLevel: "nuclear" as const };
  const reviewed = { ...evidence, replay: { ...evidence.replay, approval: nuclear } };
  api.read.mockResolvedValue(nuclear); api.replay.mockResolvedValue(observed(reviewed, "fresh").replay);
  api.decide.mockResolvedValue({ approval: { ...nuclear, status: "approved" }, effects: [] });
  await render(reviewed, nuclear); await click("Review approval");
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "approve");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render(observed(reviewed, "background"), nuclear);
  expect(document.querySelector('[role="dialog"] input')).toBe(input);
  expect(input.value).toBe("approve");
  await click("Approve once"); expect(api.decide).toHaveBeenCalledTimes(1);
});
it("retains an in-flight preflight across an observation-only refresh", async () => {
  let release!: (value: SpecialistEvidence["replay"]) => void;
  api.replay.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await render(); await click("Review approval"); await click("Approve once");
  await render(observed(evidence, "background"));
  await act(async () => release(observed(evidence, "preflight").replay));
  expect(api.decide).toHaveBeenCalledTimes(1);
});
it("cancels before dispatch if the caller changes during specialist preflight", async () => {
  let release!: (value: SpecialistEvidence["replay"]) => void;
  api.replay.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await render(); await click("Review approval"); await click("Approve once");
  await act(async () => notifyGatewayAccessChanged());
  await act(async () => release(observed(evidence, "fresh").replay));
  expect(api.decide).not.toHaveBeenCalled();
});
it("keeps an uncertain decision locked through observation refresh and a review remount", async () => {
  api.decide.mockRejectedValue(new Error("response lost"));
  await render(); await click("Review approval"); await click("Approve once");
  await act(async () => root.render(null));
  await render(observed(evidence, "later"));
  expect(host.textContent).toContain("Decision outcome is uncertain");
  expect([...host.querySelectorAll('button')].find(b => b.textContent === 'Review approval')?.disabled).toBe(true);
  expect(api.decide).toHaveBeenCalledTimes(1);
});
it.each([
  ["source content", (v: SpecialistEvidence) => ({ ...v, source: { ...source, content: "return 2;" } })],
  ["wrapper manifest", (v: SpecialistEvidence) => ({ ...v, code: { ...code, wrapperManifestHash: "changed" } })],
  ["policy snapshot", (v: SpecialistEvidence) => ({ ...v, code: { ...code, policySnapshotHash: "changed" } })],
  ["permission profile", (v: SpecialistEvidence) => ({ ...v, code: { ...code, permissionProfileId: "changed" } })],
  ["workspace", (v: SpecialistEvidence) => ({ ...v, code: { ...code, workspaceId: "foreign" } })],
  ["expiry", (v: SpecialistEvidence) => ({ ...v, replay: { ...v.replay, approval: { ...approval, expiresAt: "2000-01-01T00:00:00Z" } } })],
  ["input", (v: SpecialistEvidence) => ({ ...v, code: { ...code, codeModeInputHash: "changed" } })],
  ["code status", (v: SpecialistEvidence) => ({ ...v, code: { ...code, status: "running" as const } })],
  ["pending action", (v: SpecialistEvidence) => ({ ...v, replay: { ...v.replay, pendingAction: { approvalId: approval.approvalId, actionType: "code_mode.run" as const, request: { changed: true }, createdAt: "now" } } })],
  ["execution effect", (v: SpecialistEvidence) => ({ ...v, replay: { ...v.replay, effects: [{ effectKind: "pending_action_execute", status: "running" } as ApprovalEffectRecord] } })],
  ["refusal event", (v: SpecialistEvidence) => ({ ...v, replay: { ...v.replay, events: [{ eventId: "refusal", approvalId: approval.approvalId, eventType: "pending_action_refused" as const, actorId: "system", timestamp: "now", payload: {} }] } })],
  ["durable mapping", (v: SpecialistEvidence) => ({ ...v, replay: { ...v.replay, durableRunId: "changed" } })],
])("refuses changed %s with zero decisions", async (_name, change) => {
  const fresh = change(evidence);
  api.replay.mockResolvedValue(fresh.replay); api.code.mockResolvedValue(fresh.code); api.source.mockResolvedValue(fresh.source);
  await render(); await click("Review approval"); await click("Approve once");
  expect(api.decide).not.toHaveBeenCalled(); expect(host.textContent).toContain("Specialist evidence changed");
});
it("refuses unreadable source without dispatch", async () => {
  api.source.mockRejectedValue(new Error("immutable artifact verification failed"));
  await render(); await click("Review approval"); await click("Approve once");
  expect(api.decide).not.toHaveBeenCalled(); expect(host.textContent).toContain("Could not check the current approval");
});

function workerEvidence(): SpecialistEvidence {
  const worker = { ...approval, kind: "remote_worker.native_runtime", payload: { nativeRuntime: { expectation: { requestSha256: "request" } } } };
  return { replay: { approval: worker, events: [], effects: [], nativeRuntimeReview: { requestSha256: "request", imagePath: "worker.exe", commandLine: "worker.exe --owned", workingDirectory: "C:/owned", environment: {}, limits: { processLimit: 1, memoryBytes: 1048576, cpuMilli: 1000, wallMs: 1000, rawOutputBytes: 100, diagnosticBytes: 100, inputBytes: 100 } } } };
}
it("permits unchanged governed worker review despite replay observations", async () => {
  const value=workerEvidence(); api.read.mockResolvedValue(value.replay.approval); api.replay.mockResolvedValue(observed(value,"later").replay);
  api.decide.mockResolvedValue({approval:{...value.replay.approval,status:"approved"},effects:[]});
  await render(value,value.replay.approval); await click("Review approval"); await click("Approve once"); expect(api.decide).toHaveBeenCalledTimes(1);
});
it.each(["limits", "environment", "imagePath", "commandLine", "workingDirectory", "requestSha256", "fileStaging", "fileDisclosure"])("refuses changed worker %s with zero dispatch", async key => {
  const value=workerEvidence();
  const review = value.replay.nativeRuntimeReview!;
  const changed={...review,[key]:key==='limits'?{...review.limits,wallMs:2000}:key==='environment'?{CHANGED:'yes'}:key==='fileDisclosure'?{destination:'gateway_artifacts',workspaceId:'one'}:key==='fileStaging'?{changed:true}:'changed'};
  api.read.mockResolvedValue(value.replay.approval);api.replay.mockResolvedValue({...value.replay,nativeRuntimeReview:changed});
  await render(value,value.replay.approval);await click("Review approval");await click("Approve once");expect(api.decide).not.toHaveBeenCalled();expect(host.textContent).toContain("Specialist evidence changed");
});
