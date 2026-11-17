// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DistortionWaveOptions } from "distortion-wave";
import { GalleryDistortionWave } from "./GalleryDistortionWave";

const wave = vi.hoisted(() =>
  vi.fn((_target: Element, _update: () => void, _options: DistortionWaveOptions) => ({
    ready: Promise.resolve(),
    covered: Promise.resolve(),
    updateCallbackDone: Promise.resolve(),
    finished: new Promise<void>(() => {}),
    skip: vi.fn(),
  })),
);
vi.mock("distortion-wave", () => ({ distortionWave: wave, warmupWave: vi.fn(() => true) }));

it("scopes waves to their controls and applies rapid switch activations in order", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<GalleryDistortionWave />);
    });
    await act(async () => {
      await import("distortion-wave");
    });
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => {
      toggle.click();
    });
    expect(wave).toHaveBeenCalledOnce();
    expect(wave.mock.calls[0]?.[0]).toBe(toggle.closest("[data-wave-target]"));
    expect(wave.mock.calls[0]?.[2]).not.toHaveProperty("duration");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    const filter = host.querySelector<HTMLButtonElement>('[data-demo-filter="Skills"]')!;
    const pointer = new PointerEvent("pointerdown", { bubbles: true, clientX: 30, clientY: 20 });
    await act(async () => {
      filter.dispatchEvent(pointer);
      filter.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(wave).toHaveBeenCalledTimes(2);
    expect(wave.mock.calls[1]?.[0]).toBe(filter);
    expect(wave.mock.calls[1]?.[2]?.source === filter).toBe(true);
    expect(wave.mock.calls[1]?.[2]?.focus === pointer).toBe(true);

    for (const [resultId, label] of [
      ["gallery-send-result", "Send sample"],
      ["gallery-install-result", "Simulate install"],
    ]) {
      const button = host.querySelector<HTMLButtonElement>('button[aria-describedby="' + resultId + '"]')!;
      const result = host.querySelector<HTMLElement>("#" + resultId)!;
      expect(button.textContent?.trim()).toBe(label);
      expect(button.classList.contains("whitespace-nowrap")).toBe(true);
      expect(result.classList.contains("min-h-5")).toBe(true);
      await act(async () => {
        button.click();
      });
      const call = wave.mock.lastCall;
      expect(call?.[0]).toBe(result);
      expect(call?.[2]?.intensity).toBe(0);
      expect(call?.[2]?.blur).toBe(0);
      await act(async () => {
        call?.[1]();
      });
      expect(result.textContent).toBe(resultId === "gallery-send-result" ? "Sample messages sent: 1" : "Installed.");
    }

    const tab = host.querySelector<HTMLElement>('[data-demo-tab="results"]')!;
    await act(async () => {
      tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(wave.mock.lastCall?.[0]).toBe(host.querySelector("[data-demo-tab-panel]"));
    expect(wave.mock.lastCall?.[2]?.intensity).toBe(0);
    await act(async () => {
      wave.mock.lastCall?.[1]();
    });
    expect(tab.getAttribute("aria-selected")).toBe("true");

    const summary = host.querySelector<HTMLElement>("summary")!;
    await act(async () => {
      summary.click();
    });
    expect(wave.mock.lastCall?.[0]).toBe(summary);
    expect(wave.mock.lastCall?.[2]?.intensity).toBe(0);
    await act(async () => {
      wave.mock.lastCall?.[1]();
    });
    expect(summary.closest("details")?.open).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
