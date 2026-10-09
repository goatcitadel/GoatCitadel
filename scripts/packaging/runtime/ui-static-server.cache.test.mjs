import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui-static-server.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function withServer(run) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "ui-static-cache-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>t</title>");
  fs.writeFileSync(path.join(dist, "theme-boot.js"), "document.documentElement.dataset.theme='dark';");
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "index-abc123.js"), "export {};");
  const port = await freePort();
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, GOATCITADEL_UI_PORT: String(port), GOATCITADEL_UI_DIST_DIR: dist },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fetch(`${base}/health`);
        break;
      } catch (error) {
        if (attempt > 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await run(base);
  } finally {
    // Wait for the server to exit before removing its directory; on Windows a live process can hold it open.
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

test("the unhashed pre-paint theme boot is never cached as immutable, while hashed assets are", async () => {
  await withServer(async (base) => {
    const boot = await fetch(`${base}/theme-boot.js`);
    assert.equal(boot.status, 200);
    assert.equal(boot.headers.get("cache-control"), "no-store, max-age=0, must-revalidate");
    const hashed = await fetch(`${base}/assets/index-abc123.js`);
    assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const versioned = await fetch(`${base}/theme-boot.js?v=2`);
    assert.equal(versioned.headers.get("cache-control"), "no-store, max-age=0, must-revalidate");
    const page = await fetch(`${base}/chat`);
    assert.equal(page.headers.get("cache-control"), "no-store, max-age=0, must-revalidate");
  });
});
