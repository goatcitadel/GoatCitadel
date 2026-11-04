import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const preload = path.join(repoRoot, "scripts/verification/lib/scenarios/gateway-chat-fault-clock-preload.mjs");
const provider = pathToFileURL(path.join(repoRoot, "apps/gateway/src/services/llm-provider-fetch.ts")).href;
const helpers = pathToFileURL(path.join(repoRoot, "apps/gateway/src/services/llm-completion-helpers.ts")).href;
const marker = "GC_CLOCK_TRANSPORT_TEST";

async function runClockFixture(mode) {
  const source = `
    import { createServer } from "node:http";
    import { fetchLlmProvider } from ${JSON.stringify(provider)};
    import { getRemainingChatCompletionBudgetMs, hasChatCompletionSecondaryAttemptBudget } from ${JSON.stringify(helpers)};
    const mode = ${JSON.stringify(mode)};
    const marker = ${JSON.stringify(marker)};
    const server = createServer((_request, response) => {
      const headers = { "content-type": "text/event-stream" };
      if (mode !== "unmarked") headers["x-goatcitadel-verification-fault-clock"] = mode === "wrong-marker" ? "OTHER_FIXTURE" : marker;
      response.writeHead(200, headers);
      response.end('data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\\n\\n');
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = "http://127.0.0.1:" + server.address().port + (mode === "wrong-path" ? "/v1/other" : "/v1/responses");
    const deadline = Date.now() + 90_000;
    try {
      const dispatch = async () => {
        const response = await fetchLlmProvider(url, { method: "POST", body: JSON.stringify({ input: marker }) });
        await response.text();
      };
      await dispatch();
      const remaining = getRemainingChatCompletionBudgetMs(deadline);
      const ordinaryRemaining = deadline - Date.now();
      const secondaryAllowed = hasChatCompletionSecondaryAttemptBudget(deadline, 0);
      let expiredRemaining;
      let secondRemaining;
      if (mode === "expiry") {
        await new Promise((resolve) => setTimeout(resolve, 650));
        expiredRemaining = getRemainingChatCompletionBudgetMs(deadline);
        await dispatch();
        secondRemaining = getRemainingChatCompletionBudgetMs(deadline);
      }
      console.log(JSON.stringify({ remaining, ordinaryRemaining, secondaryAllowed, expiredRemaining, secondRemaining }));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  `;
  const env = {
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GOATCITADEL_VERIFY_FAULT_CLOCK_MARKER: marker,
    GOATCITADEL_VERIFY_FAULT_CLOCK_ADVANCE_MS: "85449",
    GOATCITADEL_VERIFY_FAULT_CLOCK_WINDOW_MS: "500",
    GOATCITADEL_VERIFY_FAULT_CLOCK_TARGET_PATH: "/v1/responses",
  };
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preload).href, "--input-type=module", "--eval", source], {
      cwd: repoRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("clock fixture child exceeded 15 seconds")); }, 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`clock fixture exited ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
  });
}

test("near-expiry clock arms through the actual pinned provider transport while ordinary clocks stay real", { timeout: 20_000 }, async () => {
  const result = await runClockFixture("marked");
  assert.ok(result.remaining >= 0 && result.remaining <= 4551, `expected near-expiry budget, got ${result.remaining}`);
  assert.ok(result.ordinaryRemaining > 80_000, "unrelated wall-clock reads must remain real");
  assert.equal(result.secondaryAllowed, false);
});

for (const mode of ["unmarked", "wrong-path", "wrong-marker"]) {
  test(`near-expiry clock ignores ${mode} pinned-provider responses`, { timeout: 20_000 }, async () => {
    const result = await runClockFixture(mode);
    assert.ok(result.remaining > 80_000, `unexpected clock arm for ${mode}: ${result.remaining}`);
    assert.ok(result.ordinaryRemaining > 80_000);
    assert.equal(result.secondaryAllowed, true);
  });
}

test("near-expiry clock expires and cannot be rearmed by another matching provider response", { timeout: 20_000 }, async () => {
  const result = await runClockFixture("expiry");
  assert.ok(result.remaining >= 0 && result.remaining <= 4551, "first matching response must arm");
  assert.ok(result.expiredRemaining > 80_000, "helper clock must return to real time");
  assert.ok(result.secondRemaining > 80_000, "a later response must not rearm the fault");
});
