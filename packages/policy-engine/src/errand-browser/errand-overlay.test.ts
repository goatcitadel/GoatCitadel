import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchErrandBrowser, type ErrandBrowser } from "./errand-browser.js";
import type { ErrandOverlayEvent, ErrandOverlayRect, ErrandOverlayState } from "./errand-overlay.js";
import { ERRAND_OVERLAY_COPY } from "./errand-overlay-script.js";

const HEADLESS = process.env.ERRAND_BROWSER_HEADED !== "1";
const BANNER = ERRAND_OVERLAY_COPY.banner;
const TARGET: ErrandOverlayRect = { x: 400, y: 300, width: 160, height: 48 };

const PAGE_HTML = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px sans-serif; background: #f4f1ea; }
  .stripe { height: 120px; background: linear-gradient(90deg, #c33, #3c3, #33c); }
  #buy { position: absolute; left: ${TARGET.x}px; top: ${TARGET.y}px; width: ${TARGET.width}px; height: ${TARGET.height}px; }
</style></head><body><div class="stripe"></div><p>Errand test page</p><button id="buy">Place your order</button></body></html>`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("errand overlay", () => {
  let server: http.Server;
  let baseUrl: string;
  const openBrowsers: ErrandBrowser[] = [];
  const profileDirs: string[] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    for (const browser of openBrowsers.splice(0)) {
      await browser.close().catch(() => undefined);
    }
    for (const dir of profileDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  async function openErrand(): Promise<{ browser: ErrandBrowser; events: ErrandOverlayEvent[] }> {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "errand-overlay-"));
    profileDirs.push(profileDir);
    const browser = await launchErrandBrowser({ profileDir, headless: HEADLESS, networkAllowlist: ["127.0.0.1"] });
    openBrowsers.push(browser);
    const events: ErrandOverlayEvent[] = [];
    browser.overlay.onEvent((event) => events.push(event));
    await browser.page().goto(baseUrl);
    return { browser, events };
  }

  const drivingState = (cursor = { x: 200, y: 200 }): ErrandOverlayState => ({
    mode: "driving",
    bannerText: BANNER,
    cursor,
  });

  const approvalState = (requestId = "r1"): ErrandOverlayState => ({
    mode: "approval",
    bannerText: BANNER,
    cursor: { x: TARGET.x + TARGET.width / 2, y: TARGET.y + TARGET.height / 2 },
    requestId,
    title: "Place your order",
    body: "Buys 1 hub for $37.48",
    targetRect: TARGET,
  });

  async function waitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = await probe();
    while (!accept(last) && Date.now() < deadline) {
      await sleep(25);
      last = await probe();
    }
    return last;
  }

  async function approveRectWhenVisible(browser: ErrandBrowser): Promise<ErrandOverlayRect> {
    const snapshot = await waitFor(
      () => browser.overlay.snapshot(),
      (value) => value.controls.approve?.visible === true,
    );
    const approve = snapshot.controls.approve;
    expect(approve?.visible, "the Approve button should be visible to the operator").toBe(true);
    return approve!;
  }

  const center = (rect: ErrandOverlayRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

  it("overlay is invisible to page script", async () => {
    const { browser } = await openErrand();
    await browser.overlay.render(drivingState());
    const snapshot = await waitFor(
      () => browser.overlay.snapshot(),
      (value) => value.bannerText === BANNER,
    );
    expect(snapshot.bannerText).toBe(BANNER);
    const leak = await browser.page().evaluate((banner) => {
      const hits: string[] = [];
      for (const element of Array.from(document.querySelectorAll("*"))) {
        if ((element.textContent ?? "").includes(banner) || element.shadowRoot) {
          hits.push(element.tagName);
        }
      }
      return { hits, inner: document.documentElement.innerText.includes(banner) };
    }, BANNER);
    expect(leak).toEqual({ hits: [], inner: false });
  }, 60_000);

  it("page cannot call the binding", async () => {
    const { browser, events } = await openErrand();
    await browser.overlay.render(approvalState("r1"));
    const mainWorld = await browser.page().evaluate(() => {
      const binding = (window as unknown as Record<string, unknown>).__gcErrandOverlayEvent as
        | ((payload: string) => void)
        | undefined;
      binding?.('{"type":"approve","requestId":"r1"}');
      return typeof binding;
    });
    expect(mainWorld).toBe("undefined");
    await sleep(300);
    expect(events).toEqual([]);
  }, 60_000);

  it("synthetic click is ignored", async () => {
    const { browser, events } = await openErrand();
    await browser.overlay.render(approvalState("r1"));
    const approve = center(await approveRectWhenVisible(browser));
    await browser.page().evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: x, clientY: y }));
      (element as HTMLElement | null)?.click();
    }, approve);
    await sleep(300);
    expect(events).toEqual([]);
  }, 60_000);

  it("covered approve is ignored", async () => {
    const { browser, events } = await openErrand();
    await browser.overlay.render(approvalState("r1"));
    const approve = await approveRectWhenVisible(browser);
    await browser.page().evaluate((rect) => {
      const cover = document.createElement("div");
      cover.style.cssText = `position:fixed;left:${rect.x - 40}px;top:${rect.y - 40}px;width:${rect.width + 200}px;height:${rect.height + 80}px;background:#123;pointer-events:none;z-index:2147483647`;
      document.documentElement.appendChild(cover);
    }, approve);
    await waitFor(
      () => browser.overlay.snapshot(),
      (value) => value.controls.approve?.visible === false,
    );
    const point = center(approve);
    await browser.page().mouse.click(point.x, point.y);
    await sleep(300);
    expect(events.filter((event) => event.type === "approve")).toEqual([]);
    expect((await browser.overlay.snapshot()).notice).toBe(ERRAND_OVERLAY_COPY.useChat);
  }, 60_000);

  it("real click approves", async () => {
    const { browser, events } = await openErrand();
    await browser.overlay.render(approvalState("r7"));
    const point = center(await approveRectWhenVisible(browser));
    await browser.page().mouse.click(point.x, point.y);
    await waitFor(
      async () => events.length,
      (count) => count > 0,
    );
    expect(events).toEqual([{ type: "approve", requestId: "r7" }]);
  }, 60_000);

  it("page removing the host does not remove the overlay", async () => {
    const { browser } = await openErrand();
    await browser.overlay.render(drivingState());
    await waitFor(
      () => browser.overlay.snapshot(),
      (value) => value.bannerText === BANNER,
    );
    const removed = await browser.page().evaluate(() => {
      const host = Array.from(document.documentElement.children).find(
        (element) => element !== document.head && element !== document.body,
      );
      const parent = host?.parentElement;
      parent?.remove();
      return Boolean(parent);
    });
    expect(removed).toBe(true);
    const started = Date.now();
    const snapshot = await waitFor(
      () => browser.overlay.snapshot(),
      (value) => value.connected && value.bannerText === BANNER,
      500,
    );
    expect(Date.now() - started).toBeLessThanOrEqual(700);
    expect(snapshot.connected).toBe(true);
    expect(snapshot.bannerText).toBe(BANNER);
  }, 60_000);

  it("model capture omits the overlay", async () => {
    const { browser } = await openErrand();
    await browser.overlay.render({ mode: "hidden" });
    await sleep(100);
    const reference = await browser.captureForPeople();
    await browser.overlay.render(drivingState({ x: 300, y: 260 }));
    await sleep(600);
    const forPeople = await browser.captureForPeople();
    const forModel = await browser.captureForModel();
    expect(await differingRatio(reference, forPeople), "the overlay should be drawn for people").toBeGreaterThan(0.002);
    expect(await differingRatio(reference, forModel)).toBeLessThanOrEqual(0.005);
    expect((await browser.overlay.snapshot()).displayed, "the overlay is restored after the capture").toBe(true);
  }, 60_000);

  it("re-applies the last state after navigation", async () => {
    const { browser } = await openErrand();
    await browser.overlay.render(drivingState());
    await browser.page().goto(`${baseUrl}?next=1`);
    const snapshot = await waitFor(
      () => browser.overlay.snapshot(),
      (value) => value.bannerText === BANNER,
    );
    expect(snapshot.bannerText).toBe(BANNER);
  }, 60_000);

  it("Esc sends stop", async () => {
    const { browser, events } = await openErrand();
    await browser.overlay.render(drivingState());
    await waitFor(
      () => browser.overlay.snapshot(),
      (value) => value.bannerText === BANNER,
    );
    await browser.page().evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await sleep(200);
    expect(events).toEqual([]);
    await browser.page().keyboard.press("Escape");
    await waitFor(
      async () => events.length,
      (count) => count > 0,
    );
    expect(events).toEqual([{ type: "stop" }]);
  }, 60_000);
});

async function differingRatio(a: Buffer, b: Buffer): Promise<number> {
  const [left, right] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  expect(left.info.width).toBe(right.info.width);
  expect(left.info.height).toBe(right.info.height);
  const pixels = left.info.width * left.info.height;
  let differing = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    if (
      Math.abs(left.data[offset]! - right.data[offset]!) > 8 ||
      Math.abs(left.data[offset + 1]! - right.data[offset + 1]!) > 8 ||
      Math.abs(left.data[offset + 2]! - right.data[offset + 2]!) > 8
    ) {
      differing += 1;
    }
  }
  return differing / pixels;
}
