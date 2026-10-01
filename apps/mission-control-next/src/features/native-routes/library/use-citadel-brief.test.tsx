// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelBrief } from "@goatcitadel/contracts";
import { useCitadelBrief } from "./use-citadel-brief";
import { overviewBrief } from "./citadel-overview.test-support";
import { buildBriefMarkdown } from "./citadel-brief-format";
const api = vi.hoisted(() => ({ base: "http://gateway-one", fetchCitadelBrief: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
let scope: string, root: Root, container: HTMLDivElement, control: ReturnType<typeof useCitadelBrief>;
function Harness() { control = useCitadelBrief(scope); return <p>{control.state.brief?.citadelName}</p>; }
async function render(next = scope) { scope = next; await act(async () => root.render(<Harness />)); }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(async () => {
  vi.resetAllMocks(); api.base = "http://gateway-one"; scope = "one"; api.fetchCitadelBrief.mockImplementation(async id => ({ ...overviewBrief(), citadelId: id, citadelName: id }));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("shared read-only Citadel brief", () => {
  it("copies the exact owner Markdown and acknowledges only completed clipboard write", async () => {
    const response = deferred<void>(), write = vi.fn((_text: string) => response.promise); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    let pending!: Promise<void>; await act(async () => { pending = control.copy(); }); expect(control.copying).toBe(true); expect(control.copyNotice).toBeNull();
    await act(async () => control.copy()); expect(write).toHaveBeenCalledExactlyOnceWith(buildBriefMarkdown(control.state.brief!));
    await act(async () => { response.resolve(); await pending; }); expect(control.copyNotice?.tone).toBe("success"); expect(control.copying).toBe(false);
  });
  it("reports absent or rejected clipboard without success", async () => {
    await act(async () => control.copy()); expect(control.copyNotice?.tone).toBe("warning");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("Clipboard denied"); }) } });
    await act(async () => control.copy()); expect(control.copyNotice).toEqual({ tone: "warning", message: "Clipboard denied" });
  });
  it.each(["foreign", "partial"])("withholds %s owner evidence", async invalid => {
    api.fetchCitadelBrief.mockResolvedValueOnce(invalid === "foreign" ? { ...overviewBrief(), citadelId: "other" } : { citadelId: "one" });
    await act(async () => control.load()); expect(control.state.brief).toBeNull(); expect(control.state.error).toContain("different or unavailable");
  });
  it("withholds stale scope and earlier refresh results", async () => {
    const response = deferred<CitadelBrief>(); api.fetchCitadelBrief.mockReturnValueOnce(response.promise);
    let pending!: Promise<void>; await act(async () => { pending = control.load(); }); await render("two");
    await act(async () => { response.resolve(overviewBrief()); await pending; }); expect(control.state.brief?.citadelId).toBe("two");
    api.fetchCitadelBrief.mockReturnValueOnce(response.promise); await act(async () => control.load()); expect(control.state.error).toContain("different or unavailable");
  });
  it("a failed refresh clears prior successful owner evidence", async () => {
    expect(control.state.brief?.citadelId).toBe("one"); api.fetchCitadelBrief.mockRejectedValueOnce(new Error("Owner unavailable")); await act(async () => control.load());
    expect(control.state.brief).toBeNull(); expect(control.state.error).toBe("Owner unavailable");
  });
  it("suppresses a late clipboard success after scope changes", async () => {
    const response = deferred<void>(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => response.promise } });
    let pending!: Promise<void>; await act(async () => { pending = control.copy(); }); await render("two"); await act(async () => { response.resolve(); await pending; });
    expect(control.copyNotice).toBeNull(); expect(control.copying).toBe(false); expect(control.state.brief?.citadelId).toBe("two");
  });
  it("invalidates a pending copy on refresh and never acknowledges old Markdown against new evidence", async () => {
    const first = deferred<void>(), second = deferred<void>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    const previous = control.state.brief!; let oldCopy!: Promise<void>, nextCopy!: Promise<void>;
    await act(async () => { oldCopy = control.copy(); });
    api.fetchCitadelBrief.mockResolvedValueOnce({ ...previous, citadelName: "Refreshed Citadel", generatedAt: "2026-09-30T18:00:00Z" });
    await act(async () => control.load()); expect(control.copyNotice).toBeNull(); expect(control.copying).toBe(false);
    await act(async () => { nextCopy = control.copy(); }); expect(control.copying).toBe(true);
    expect(write.mock.calls.map(([markdown]) => markdown)).toEqual([buildBriefMarkdown(previous), buildBriefMarkdown(control.state.brief!)]);
    await act(async () => { first.resolve(); await oldCopy; }); expect(control.copyNotice).toBeNull(); expect(control.copying).toBe(true);
    await act(async () => { second.resolve(); await nextCopy; }); expect(control.copyNotice?.tone).toBe("success"); expect(control.copying).toBe(false);
    await act(async () => control.load()); expect(control.copyNotice).toBeNull();
  });
});
