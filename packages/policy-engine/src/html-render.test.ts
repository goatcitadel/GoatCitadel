import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./playwright-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./playwright-runtime.js")>();
  return { ...actual, loadPlaywright: vi.fn(actual.loadPlaywright) };
});

import { loadPlaywright } from "./playwright-runtime.js";
import {
  HTML_RENDER_DEFAULT_VIEWPORTS,
  HTML_RENDER_MAX_BYTES,
  injectContentSecurityPolicy,
  MISSION_CONTROL_BASELINE_CSP,
  renderHtmlSnapshot,
} from "./html-render.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const loadPlaywrightMock = vi.mocked(loadPlaywright);

type FakeRoute = {
  request: () => { url: () => string };
  continue: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
};

function makeFakeRoute(url: string): FakeRoute {
  return {
    request: () => ({ url: () => url }),
    continue: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
}

let jailRoot = "";

beforeEach(async () => {
  jailRoot = await mkdtemp(path.join(tmpdir(), "html-render-"));
  loadPlaywrightMock.mockClear();
});

afterEach(async () => {
  await rm(jailRoot, { recursive: true, force: true });
});

describe("renderHtmlSnapshot", () => {
  it("rejects an output directory outside the write jail before touching the browser", async () => {
    const outsideDir = path.join(path.dirname(jailRoot), `html-render-outside-${process.pid}`);
    await expect(
      renderHtmlSnapshot({ html: "<html></html>", outputDir: outsideDir, writeJailRoots: [jailRoot] }),
    ).rejects.toThrow(/write jail/);
    expect(loadPlaywrightMock).not.toHaveBeenCalled();
  });

  it("refuses HTML above the size cap without launching", async () => {
    const html = `<html><body>${"x".repeat(HTML_RENDER_MAX_BYTES)}</body></html>`;
    await expect(
      renderHtmlSnapshot({ html, outputDir: path.join(jailRoot, "renders"), writeJailRoots: [jailRoot] }),
    ).rejects.toThrow(/html_render_too_large/);
    expect(loadPlaywrightMock).not.toHaveBeenCalled();
  });

  it("surfaces the manual-install diagnostic when Chromium is missing", async () => {
    loadPlaywrightMock.mockResolvedValueOnce({
      chromium: {
        launch: async () => {
          throw new Error("browserType.launch: Executable doesn't exist at /nowhere/chrome");
        },
      },
    });
    await expect(
      renderHtmlSnapshot({
        html: "<html></html>",
        outputDir: path.join(jailRoot, "renders"),
        writeJailRoots: [jailRoot],
      }),
    ).rejects.toThrow(/browser_chromium_manual_install_required/);
  });

  it("aborts every non-data, non-about request at the route layer and records it", async () => {
    let routeHandler: ((route: FakeRoute) => Promise<void> | void) | undefined;
    const outputDir = path.join(jailRoot, "renders");
    const blocked = makeFakeRoute("https://example.test/style.css");
    const inlineData = makeFakeRoute("data:image/png;base64,AAAA");
    const aboutBlank = makeFakeRoute("about:blank");
    const fakePage = {
      on: vi.fn(),
      // The browser issues subresource requests while the document loads.
      setContent: vi.fn(async (_html: string) => {
        for (const route of [blocked, inlineData, aboutBlank]) await routeHandler?.(route);
      }),
      title: vi.fn(async () => "fake"),
      screenshot: vi.fn(async ({ path: target }: { path: string }) => {
        await writeFile(target, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8), Buffer.alloc(4), Buffer.alloc(4)]));
      }),
    };
    const fakeContext = {
      route: vi.fn(async (_pattern: string, handler: (route: FakeRoute) => Promise<void> | void) => {
        routeHandler = handler;
      }),
      newPage: vi.fn(async () => fakePage),
      close: vi.fn(async () => undefined),
    };
    const fakeBrowser = { newContext: vi.fn(async () => fakeContext), close: vi.fn(async () => undefined) };
    loadPlaywrightMock.mockResolvedValueOnce({ chromium: { launch: async () => fakeBrowser } });

    const result = await renderHtmlSnapshot({
      html: "<html><body>x</body></html>",
      outputDir,
      writeJailRoots: [jailRoot],
      viewports: [{ name: "desktop", width: 1440, height: 900 }],
    });

    expect(fakeContext.route).toHaveBeenCalledWith("**/*", expect.any(Function));

    expect(blocked.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(blocked.continue).not.toHaveBeenCalled();
    expect(inlineData.continue).toHaveBeenCalled();
    expect(aboutBlank.continue).toHaveBeenCalled();
    expect(result.renders[0]?.blockedRequests).toEqual(["https://example.test/style.css"]);
    expect(fakeBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ javaScriptEnabled: false, offline: true, viewport: { width: 1440, height: 900 } }),
    );
    const document = fakePage.setContent.mock.calls[0]?.[0] ?? "";
    expect(document).toContain(`<head><meta http-equiv="Content-Security-Policy" content="`);
    expect(document).toContain("font-src 'self' data:");
    expect(document).not.toContain("frame-ancestors");
  });

  it("renders offline PNG snapshots with scripts disabled and remote requests blocked", async () => {
    const html = [
      "<!doctype html><html><head><title>authored</title></head><body>",
      '<h1>Hello</h1><img src="https://example.test/x.png" alt="remote">',
      '<script>document.title="js"</script>',
      "</body></html>",
    ].join("");
    const outputDir = path.join(jailRoot, "renders");

    const result = await renderHtmlSnapshot({ html, outputDir, writeJailRoots: [jailRoot] });

    expect(result.contentSecurityPolicy).toBe(MISSION_CONTROL_BASELINE_CSP);
    expect(result.renders.map((render) => render.viewport)).toEqual(HTML_RENDER_DEFAULT_VIEWPORTS.map((v) => v.name));
    const desktop = result.renders.find((render) => render.viewport === "desktop");
    expect(desktop).toBeDefined();
    expect(desktop?.width).toBe(1440);
    expect(desktop?.height).toBe(900);
    expect(desktop?.title).toBe("authored");
    // The injected CSP refuses the remote image before any request is issued; the refusal is recorded.
    expect(desktop?.blockedRequests).toEqual(["https://example.test/x.png"]);
    expect(desktop?.sha256).toMatch(/^[0-9a-f]{64}$/);

    for (const render of result.renders) {
      expect(path.dirname(render.path)).toBe(outputDir);
      const bytes = await readFile(render.path);
      expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(bytes.readUInt32BE(16)).toBe(render.width);
      expect(render.bytes).toBe(bytes.byteLength);
    }
  }, 60_000);
});

describe("injectContentSecurityPolicy", () => {
  it("ignores a <head> that only appears inside a leading comment", () => {
    const html = "<!-- <head> --><!doctype html><html><head><title>t</title></head><body></body></html>";

    const out = injectContentSecurityPolicy(html);

    const meta = out.indexOf('<meta http-equiv="Content-Security-Policy"');
    expect(meta).toBe(out.indexOf("<html><head>") + "<html><head>".length);
    expect(out.slice(0, out.indexOf("-->"))).not.toContain("Content-Security-Policy");
  });

  it("ignores an <html> tag inside a comment when synthesizing a head", () => {
    const out = injectContentSecurityPolicy("<!-- <html> --><html><body></body></html>");

    expect(out.indexOf("<html><head><meta http-equiv=")).toBe(out.indexOf("-->") + 3);
  });
});
