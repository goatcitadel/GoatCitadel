import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeComputerActions, type ComputerAction } from "./computer-actions.js";
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
  let baseUrl: string;
  const openBrowsers: ErrandBrowser[] = [];
  const profileDirs: string[] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
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

  async function launch(): Promise<ErrandBrowser> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errand-actions-"));
    profileDirs.push(dir);
    const browser = await launchErrandBrowser({
      profileDir: dir,
      headless: HEADLESS,
      networkAllowlist: ["127.0.0.1"],
    });
    openBrowsers.push(browser);
    await browser.page().goto(baseUrl);
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
