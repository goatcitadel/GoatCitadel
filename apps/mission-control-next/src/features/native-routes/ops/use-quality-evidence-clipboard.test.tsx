// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQualityEvidenceClipboard } from "./use-quality-evidence-clipboard";

const api = vi.hoisted(() => ({ evaluations: vi.fn(), quality: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({ exportLlmEvalProofRuns: api.evaluations }));
vi.mock("@goatcitadel/mission-control-shared/api/ops-quality", () => ({ exportOpsQualityEvidence: api.quality }));
const payload = (content = "exact evidence") => ({
  content,
  filename: "evidence.json",
  posture: { readOnly: true, sideEffectPosture: "audit_only" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root, container: HTMLDivElement, state: ReturnType<typeof useQualityEvidenceClipboard>;
const clipboard = vi.fn();
const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function Harness({ scope = "a", startOnMount = false }: { scope?: string; startOnMount?: boolean }) {
  state = useQualityEvidenceClipboard({ scopeKey: scope, includeFilename: true });
  useEffect(() => {
    if (startOnMount) void state.copy("evaluations");
  }, [startOnMount]);
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  api.evaluations.mockResolvedValue(payload());
  api.quality.mockResolvedValue(payload("quality"));
  clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("shared Quality clipboard owner", () => {
  it("requires read-only audit-only content before copying", async () => {
    act(() => root.render(<Harness />));
    for (const invalid of [
      { readOnly: false, sideEffectPosture: "audit_only" },
      { readOnly: true, sideEffectPosture: "mutation" },
    ]) {
      api.evaluations.mockResolvedValueOnce({ ...payload(), posture: invalid });
      await act(async () => state.copy("evaluations"));
      expect(state.notice?.error).toBe(true);
    }
    expect(clipboard).not.toHaveBeenCalled();
    await act(async () => state.copy("evaluations"));
    expect(clipboard).toHaveBeenCalledExactlyOnceWith("exact evidence");
    expect(state.notice?.text).toBe("Copied eval proof export evidence.json.");
  });
  it("prevents duplicates and does not clear a later request after away/back navigation", async () => {
    const old = deferred<ReturnType<typeof payload>>(),
      later = deferred<ReturnType<typeof payload>>();
    api.evaluations.mockReturnValueOnce(old.promise);
    api.quality.mockReturnValueOnce(later.promise);
    act(() => root.render(<Harness />));
    let first!: Promise<void>, second!: Promise<void>;
    act(() => {
      first = state.copy("evaluations");
      void state.copy("evaluations");
    });
    expect(api.evaluations).toHaveBeenCalledTimes(1);
    act(() => root.render(<Harness scope="b" />));
    act(() => root.render(<Harness scope="a" />));
    act(() => {
      second = state.copy("quality");
    });
    await act(async () => {
      old.resolve(payload("old"));
      await first;
    });
    expect(clipboard).not.toHaveBeenCalled();
    expect(state.pending).toBe("quality");
    await act(async () => {
      later.resolve(payload("new"));
      await second;
    });
    expect(clipboard).toHaveBeenCalledExactlyOnceWith("new");
    expect(state.pending).toBeNull();
  });
  it("rejects the prior StrictMode effect lifetime before its copy side effect", async () => {
    const old = deferred<ReturnType<typeof payload>>(),
      next = deferred<ReturnType<typeof payload>>();
    api.evaluations.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    act(() =>
      root.render(
        <StrictMode>
          <Harness startOnMount />
        </StrictMode>,
      ),
    );
    expect(api.evaluations).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(payload("retired")));
    expect(clipboard).not.toHaveBeenCalled();
    await act(async () => next.resolve(payload("current")));
    expect(clipboard).toHaveBeenCalledExactlyOnceWith("current");
  });
  it("copies a reviewed export path and keeps clipboard failure explicit", async () => {
    act(() => root.render(<Harness />));
    await act(async () => state.copyPath("reports/pack.json", "Pack"));
    expect(clipboard).toHaveBeenLastCalledWith("reports/pack.json");
    clipboard.mockRejectedValueOnce(new Error("Copy denied"));
    await act(async () => state.copy("quality"));
    expect(state.notice).toMatchObject({ error: true });
    expect(state.notice?.text).toContain("Evidence was not copied.");
  });
});
