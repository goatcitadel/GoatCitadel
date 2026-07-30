import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = path.join(repoRoot, "scripts", "packaging", "runtime", "ui-static-server.mjs");

test("packaged Mission Control health exposes the exact managed launcher identity", async (t) => {
  const instanceId = "123e4567-e89b-42d3-a456-426614174000";
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ui-health-"));
  const distDir = path.join(testRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>fixture</title>\n", "utf8");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GOATCITADEL_MANAGED_INSTANCE_ID: instanceId,
      GOATCITADEL_MANAGED_SERVICE: "mission-control",
      GOATCITADEL_UI_DIST_DIR: distDir,
      GOATCITADEL_UI_HOST: "127.0.0.1",
      GOATCITADEL_UI_PORT: "0",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopOwnedChild(child);
    removeOwnedTestRoot(testRoot);
  });

  const baseUrl = await waitForListeningUrl(child);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0, must-revalidate");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "mission-control",
    managedInstanceId: instanceId,
    managedProcessId: child.pid,
  });
});

function waitForListeningUrl(child) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      reject(new Error(`UI static server did not start. ${Buffer.concat(stderr).toString("utf8")}`));
    }, 10000);
    const finish = (error, url) => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) {
        reject(error);
        return;
      }
      resolve(url);
    };
    const onStdout = (chunk) => {
      stdout.push(chunk);
      const match = Buffer.concat(stdout)
        .toString("utf8")
        .match(/listening on (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) {
        finish(undefined, match[1]);
      }
    };
    const onStderr = (chunk) => stderr.push(chunk);
    const onError = (error) => finish(error);
    const onClose = (code) =>
      finish(new Error(`UI static server exited with code ${code}. ${Buffer.concat(stderr).toString("utf8")}`));
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGKILL");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

function removeOwnedTestRoot(root) {
  const resolvedRoot = path.resolve(root);
  const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}goatcitadel-ui-health-`;
  assert.ok(resolvedRoot.startsWith(expectedPrefix));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
