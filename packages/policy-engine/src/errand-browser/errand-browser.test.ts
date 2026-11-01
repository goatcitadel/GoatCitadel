import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchErrandBrowser, ErrandBrowserLaunchError, type ErrandBrowser } from "./errand-browser.js";

const HEADLESS = process.env.ERRAND_BROWSER_HEADED !== "1";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("errand browser launcher", () => {
  let server: http.Server;
  let baseUrl: string;
  const openBrowsers: ErrandBrowser[] = [];
  const profileDirs: string[] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body><h1>errand</h1></body></html>");
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

  function makeProfileDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errand-profile-"));
    profileDirs.push(dir);
    return dir;
  }

  async function launch(profileDir: string): Promise<ErrandBrowser> {
    const browser = await launchErrandBrowser({
      profileDir,
      headless: HEADLESS,
      networkAllowlist: ["127.0.0.1"],
    });
    openBrowsers.push(browser);
    return browser;
  }

  it("launches with a 1280x800 viewport and persists localStorage across relaunch", async () => {
    const profileDir = makeProfileDir();
    const first = await launch(profileDir);
    await first.page().goto(baseUrl);
    const size = await first.page().evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    expect(size).toEqual({ w: 1280, h: 800 });
    await first.page().evaluate(() => localStorage.setItem("k", "v"));
    await first.close();

    const second = await launch(profileDir);
    await second.page().goto(baseUrl);
    expect(await second.page().evaluate(() => localStorage.getItem("k"))).toBe("v");
  }, 90_000);

  it("blocks a private LAN address", async () => {
    const browser = await launch(makeProfileDir());
    await expect(browser.page().goto("http://10.0.0.1/", { timeout: 10_000 })).rejects.toThrow();
  }, 60_000);

  it("blocks private addresses by policy even with a wildcard allowlist", async () => {
    const browser = await launchErrandBrowser({
      profileDir: makeProfileDir(),
      headless: HEADLESS,
      networkAllowlist: ["*"],
    });
    openBrowsers.push(browser);
    for (const target of ["http://10.0.0.1/", baseUrl]) {
      const failure = await browser
        .page()
        .goto(target, { timeout: 8_000 })
        .then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      expect(failure, `${target} should be refused`).toBeDefined();
      expect(failure).not.toMatch(/timeout/i);
    }
  }, 60_000);

  it("reclaims a stale lock whose pid is alive but was not refreshed", async () => {
    const profileDir = makeProfileDir();
    const lockPath = path.join(profileDir, ".goatcitadel-errand.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    const browser = await launch(profileDir);
    expect(browser.isClosed()).toBe(false);
  }, 60_000);

  it("allows an immediate relaunch after close", async () => {
    const profileDir = makeProfileDir();
    const first = await launch(profileDir);
    await first.close();
    await launch(profileDir);
  }, 60_000);

  it("reports profile_locked when the profile is already open", async () => {
    const profileDir = makeProfileDir();
    await launch(profileDir);
    const second = launchErrandBrowser({ profileDir, headless: HEADLESS, networkAllowlist: ["127.0.0.1"] });
    await expect(second).rejects.toBeInstanceOf(ErrandBrowserLaunchError);
    await expect(second).rejects.toMatchObject({ code: "profile_locked" });
  }, 60_000);

  it("fires onClosed when the page is closed by the user", async () => {
    const browser = await launch(makeProfileDir());
    let calls = 0;
    browser.onClosed(() => {
      calls += 1;
    });
    expect(browser.isClosed()).toBe(false);
    await browser.page().close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls).toBe(1);
    expect(browser.isClosed()).toBe(true);
  }, 60_000);

  it("captures a PNG for the model and for people", async () => {
    const browser = await launch(makeProfileDir());
    await browser.page().goto(baseUrl);
    const forModel = await browser.captureForModel();
    const forPeople = await browser.captureForPeople();
    expect(forModel.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(forPeople.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  }, 60_000);

  it.skipIf(HEADLESS)(
    "restores a minimized window before capturing",
    async () => {
      const browser = await launch(makeProfileDir());
      await browser.page().goto(baseUrl);
      const cdp = await browser.page().context().newCDPSession(browser.page());
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      const png = await browser.captureForModel();
      expect(png.length).toBeGreaterThan(0);
      expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
      const after = await cdp.send("Browser.getWindowForTarget");
      expect(after.bounds.windowState).toBe("normal");
    },
    60_000,
  );
});
