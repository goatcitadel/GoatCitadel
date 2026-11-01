import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeComputerActions, type ComputerAction } from "./computer-actions.js";
import { loadPlaywright } from "../playwright-runtime.js";
import { createErrandOverlay } from "./errand-overlay.js";
import { launchErrandBrowser, type ErrandBrowser } from "./errand-browser.js";

const HEADLESS = process.env.ERRAND_BROWSER_HEADED !== "1";

const PAGE = `<html><body style="margin:0">
<input id="pw" type="password" style="position:absolute;left:20px;top:20px;width:200px;height:30px">
<input id="otp" name="verification_code" autocomplete="one-time-code" style="position:absolute;left:20px;top:70px;width:200px;height:30px">
<form onsubmit="return false" style="position:absolute;left:20px;top:120px">
  <input id="plain" style="width:200px;height:30px"><button id="buy" type="submit" style="width:200px;height:40px">Place your order</button>
</form>
<input id="keys" style="position:absolute;left:20px;top:250px;width:200px;height:30px">
<script>
window.__keys = [];
document.addEventListener("keydown", function (e) { window.__keys.push(e.key); }, true);
</script>
</body></html>`;

const SHADOW_PAGE = `<html><body style="margin:0">
<div id="host" style="position:absolute;left:20px;top:300px;width:220px;height:40px"></div>
<script>
var root = document.getElementById("host").attachShadow({ mode: "open" });
root.innerHTML = '<input class="sp" type="password" style="width:200px;height:30px;margin:0">';
</script>
</body></html>`;

const CLOSED_PAGE = `<html><body style="margin:0">
<div id="closed" style="position:absolute;left:20px;top:300px;width:220px;height:40px"></div>
<fancy-box id="fancy" style="position:absolute;left:20px;top:360px;width:220px;height:60px;display:block"><span>slotted</span></fancy-box>
<script>
var a = document.getElementById("closed").attachShadow({ mode: "closed" });
a.innerHTML = '<input type="password" style="width:200px;height:30px;margin:0">';
var b = document.getElementById("fancy").attachShadow({ mode: "closed" });
b.innerHTML = '<input type="password" style="width:200px;height:30px;margin:0;display:block"><slot></slot>';
</script>
</body></html>`;

const INNER_CLOSED_PAGE = `<html><body style="margin:0">
<div id="h" style="width:220px;height:40px"></div>
<script>
document.getElementById("h").attachShadow({ mode: "closed" }).innerHTML = '<input type="password" style="width:200px;height:30px;margin:0">';
</script>
</body></html>`;

const FRAME_CLOSED_PAGE = `<html><body style="margin:0">
<iframe id="f" src="/innerclosed" style="position:absolute;left:20px;top:400px;width:300px;height:100px;border:0"></iframe>
</body></html>`;

const INNER_PAGE = `<html><body style="margin:0"><input id="ipw" type="password" style="width:200px;height:30px;margin:0"></body></html>`;

const FRAME_PAGE = `<html><body style="margin:0">
<iframe id="f" src="/inner" style="position:absolute;left:20px;top:400px;width:300px;height:100px;border:0"></iframe>
</body></html>`;

function crossOriginPage(otherOrigin: string): string {
  return `<html><body style="margin:0">
<iframe id="x" src="${otherOrigin}inner" style="position:absolute;left:20px;top:400px;width:300px;height:100px;border:0"></iframe>
</body></html>`;
}

describe("normalizeComputerActions", () => {
  it("ignores irrelevant fields", () => {
    const result = normalizeComputerActions([
      { type: "click", x: 10, y: 20, button: "left", text: "", keys: [], scroll_x: 0, path: [] },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.actions).toEqual([{ type: "click", x: 10, y: 20, button: "left" }]);
  });

  it("rejects out-of-range coordinates", () => {
    const result = normalizeComputerActions([{ type: "click", x: 1400, y: 20 }]);
    expect(result.actions).toEqual([]);
    expect(result.errors[0]).toContain("action 1");
    expect(result.errors[0]).toContain("outside the 1280x800 screen");
  });

  it("drops unknown types, maps wheel to middle and reads OpenAI scroll fields", () => {
    const result = normalizeComputerActions([
      { type: "teleport" },
      { type: "click", x: 1, y: 2, button: "wheel" },
      { type: "scroll", x: 5, y: 6, scroll_x: 0, scroll_y: 300 },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("action 1");
    expect(result.actions).toEqual([
      { type: "click", x: 1, y: 2, button: "middle" },
      { type: "scroll", x: 5, y: 6, scrollX: 0, scrollY: 300 },
    ]);
  });
});

describe("errand browser computer actions", () => {
  let server: http.Server;
  let otherServer: http.Server;
  let baseUrl: string;
  let otherUrl: string;
  const openBrowsers: ErrandBrowser[] = [];
  const profileDirs: string[] = [];

  beforeAll(async () => {
    otherServer = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(INNER_PAGE);
    });
    await new Promise<void>((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
    otherUrl = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}/`;
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      const route = req.url ?? "/";
      if (route.startsWith("/innerclosed")) res.end(INNER_CLOSED_PAGE);
      else if (route.startsWith("/framec")) res.end(FRAME_CLOSED_PAGE);
      else if (route.startsWith("/closed")) res.end(CLOSED_PAGE);
      else if (route.startsWith("/shadow")) res.end(SHADOW_PAGE);
      else if (route.startsWith("/inner")) res.end(INNER_PAGE);
      else if (route.startsWith("/frame")) res.end(FRAME_PAGE);
      else if (route.startsWith("/xorigin")) res.end(crossOriginPage(otherUrl));
      else res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => otherServer.close(() => resolve()));
  });

  afterEach(async () => {
    for (const browser of openBrowsers.splice(0)) {
      await browser.close().catch(() => undefined);
    }
    for (const dir of profileDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  async function launch(route = ""): Promise<ErrandBrowser> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errand-actions-"));
    profileDirs.push(dir);
    const browser = await launchErrandBrowser({
      profileDir: dir,
      headless: HEADLESS,
      networkAllowlist: ["127.0.0.1"],
    });
    openBrowsers.push(browser);
    await browser.page().goto(baseUrl + route);
    return browser;
  }

  it("maps keys", async () => {
    const browser = await launch();
    const { actions } = normalizeComputerActions([
      { type: "click", x: 30, y: 260, button: "left" },
      { type: "keypress", keys: ["CTRL", "a"] },
    ]);
    await browser.runActions(actions, async () => "proceed");
    const keys = await browser.page().evaluate(() => (window as unknown as { __keys: string[] }).__keys);
    expect(keys).toEqual(["Control", "a"]);
  }, 60_000);

  it("describeTarget finds a password field", async () => {
    const browser = await launch();
    const info = await browser.describeTarget(30, 30);
    expect(info?.isPasswordLike).toBe(true);
    expect(info?.isOneTimeCode).toBe(false);
    expect(info?.tagName).toBe("input");
  }, 60_000);

  it("describeTarget finds a one-time-code field", async () => {
    const browser = await launch();
    const info = await browser.describeTarget(30, 80);
    expect(info?.isOneTimeCode).toBe(true);
    expect(info?.isPasswordLike).toBe(false);
  }, 60_000);

  it("describeTarget finds the submit button text", async () => {
    const browser = await launch();
    const info = await browser.describeTarget(320, 140);
    expect(info?.tagName).toBe("button");
    expect(info?.text).toBe("Place your order");
    const field = await browser.describeTarget(30, 130);
    expect(field?.formSubmitText).toBe("Place your order");
  }, 60_000);

  it("describeTarget is not fooled by page script overriding elementFromPoint", async () => {
    const browser = await launch();
    await browser.page().evaluate(() => {
      document.elementFromPoint = () => document.getElementById("plain");
    });
    const info = await browser.describeTarget(30, 30);
    expect(info?.isPasswordLike).toBe(true);
  }, 60_000);

  it("describeFocused describes the focused element", async () => {
    const browser = await launch();
    await browser.page().focus("#pw");
    const info = await browser.describeFocused();
    expect(info?.isPasswordLike).toBe(true);
  }, 60_000);

  it("describeTarget and describeFocused see a password field inside an open shadow root", async () => {
    const browser = await launch("shadow");
    const byPoint = await browser.describeTarget(30, 310);
    expect(byPoint?.isPasswordLike).toBe(true);
    expect(byPoint?.isOpaque).toBe(false);
    await browser.page().evaluate(() => {
      (document.getElementById("host")!.shadowRoot!.querySelector("input") as HTMLInputElement).focus();
    });
    const focused = await browser.describeFocused();
    expect(focused?.isPasswordLike).toBe(true);
    expect(focused?.rect.y).toBe(300);
  }, 60_000);

  it("describeTarget and describeFocused see a password field inside a same-origin iframe", async () => {
    const browser = await launch("frame");
    await browser.page().waitForLoadState("load");
    const byPoint = await browser.describeTarget(30, 410);
    expect(byPoint?.isPasswordLike).toBe(true);
    expect(byPoint?.isOpaque).toBe(false);
    await browser.page().frames()[1]!.focus("#ipw");
    const focused = await browser.describeFocused();
    expect(focused?.isPasswordLike).toBe(true);
    expect(focused?.rect).toMatchObject({ x: 20, y: 400 });
  }, 60_000);

  it("flags a cross-origin iframe as opaque", async () => {
    const browser = await launch("xorigin");
    await browser.page().waitForLoadState("load");
    const byPoint = await browser.describeTarget(30, 410);
    expect(byPoint?.tagName).toBe("iframe");
    expect(byPoint?.isOpaque).toBe(true);
    await browser.page().evaluate(() => document.getElementById("x")!.focus());
    const focused = await browser.describeFocused();
    expect(focused?.tagName).toBe("iframe");
    expect(focused?.isOpaque).toBe(true);
  }, 60_000);

  it("sees a password field inside a closed shadow root on a div host", async () => {
    const browser = await launch("closed");
    const byPoint = await browser.describeTarget(30, 310);
    expect(byPoint?.isPasswordLike).toBe(true);
    await browser.page().mouse.click(30, 310);
    const focused = await browser.describeFocused();
    expect(focused?.isPasswordLike).toBe(true);
  }, 60_000);

  it("sees a password field inside a closed root of a custom element with slotted children", async () => {
    const browser = await launch("closed");
    const byPoint = await browser.describeTarget(30, 370);
    expect(byPoint?.isPasswordLike).toBe(true);
    await browser.page().mouse.click(30, 370);
    const focused = await browser.describeFocused();
    expect(focused?.isPasswordLike).toBe(true);
  }, 60_000);

  it("sees a password field in a closed shadow root inside a same-origin iframe", async () => {
    const browser = await launch("framec");
    await browser.page().waitForLoadState("load");
    const byPoint = await browser.describeTarget(30, 410);
    expect(byPoint?.isPasswordLike).toBe(true);
    expect(byPoint?.rect.y).toBe(400);
    await browser.page().mouse.click(30, 410);
    const focused = await browser.describeFocused();
    expect(focused?.isPasswordLike).toBe(true);
  }, 60_000);

  it("unwinds the automation depth when the overlay cannot be reached", async () => {
    const playwright = await loadPlaywright<typeof import("playwright")>();
    const chromium = await playwright.chromium.launch({ headless: true });
    try {
      const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(baseUrl);
      let broken = false;
      const overlay = createErrandOverlay(() => {
        if (broken) throw new Error("page unavailable");
        return page;
      });
      await overlay.attach(page);
      const events: string[] = [];
      overlay.onEvent((event) => events.push(event.type));
      await overlay.render({ mode: "driving", bannerText: "Working", cursor: { x: 5, y: 5 } });
      broken = true;
      await expect(overlay.withAutomationInput(async () => undefined)).rejects.toThrow("page unavailable");
      broken = false;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await page.keyboard.press("Escape");
      await expect.poll(() => events, { timeout: 5_000 }).toEqual(["stop"]);
    } finally {
      await chromium.close().catch(() => undefined);
    }
  }, 60_000);

  it("restores operator input after an automation callback throws", async () => {
    const browser = await launch();
    const events: string[] = [];
    browser.overlay.onEvent((event) => events.push(event.type));
    await browser.overlay.render({ mode: "driving", bannerText: "Working", cursor: { x: 5, y: 5 } });
    await expect(
      browser.overlay.withAutomationInput(async () => {
        throw new Error("dispatch failed");
      }),
    ).rejects.toThrow("dispatch failed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await browser.page().keyboard.press("Escape");
    await expect.poll(() => events, { timeout: 5_000 }).toEqual(["stop"]);
  }, 60_000);

  it("accepts case-insensitive named keys", async () => {
    const browser = await launch();
    const { actions } = normalizeComputerActions([{ type: "keypress", keys: ["arrowdown"] }]);
    const result = await browser.runActions(actions, async () => "proceed");
    expect(result).toEqual({ ran: 1, halted: false });
    const keys = await browser.page().evaluate(() => (window as unknown as { __keys: string[] }).__keys);
    expect(keys).toEqual(["ArrowDown"]);
  }, 60_000);

  it("returns a dispatch error instead of throwing and stops at the bad action", async () => {
    const browser = await launch();
    const actions: ComputerAction[] = [
      { type: "move", x: 10, y: 10 },
      { type: "keypress", keys: ["NotAKey"] },
      { type: "move", x: 20, y: 20 },
    ];
    const result = await browser.runActions(actions, async () => "proceed");
    expect(result.ran).toBe(1);
    expect(result.halted).toBe(false);
    expect(result.error).toContain("action 2");
  }, 60_000);

  it("runActions halts before the second action", async () => {
    const browser = await launch();
    const actions: ComputerAction[] = [
      { type: "move", x: 10, y: 10 },
      { type: "move", x: 20, y: 20 },
    ];
    const seen: number[] = [];
    const result = await browser.runActions(actions, async (_action, index) => {
      seen.push(index);
      return index === 1 ? "halt" : "proceed";
    });
    expect(result).toEqual({ ran: 1, halted: true });
    expect(seen).toEqual([0, 1]);
  }, 60_000);
});
