/* global document, window -- evaluated in Chromium by Playwright. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { createRunContext, finalizeRunContext, releaseRunContext } from "./lib/shared.mjs";
import { runAccessibilitySmokeLane } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";

const MODELS = { desktop: "llama-setup-desktop-fixture", narrow: "llama-setup-narrow-fixture" };
const REPLY = "The llama.cpp browser fixture answered Chat.";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url === "/health") {
    response.end(JSON.stringify({ status: "ok", model_alias: MODELS.desktop }));
  } else if (request.method === "GET" && request.url === "/v1/models") {
    response.end(JSON.stringify({ data: Object.values(MODELS).map((id) => ({ id, object: "model" })) }));
  } else if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const model = JSON.parse(body).model;
    response.end(JSON.stringify({ id: "setup-browser-reply", object: "chat.completion", model,
      choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 } }));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Unknown fixture path" }));
  }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

async function prepare(page) {
  const model = page.viewportSize().width < 600 ? MODELS.narrow : MODELS.desktop;
  const setup = page.getByRole("button", { name: "Set up llama.cpp", exact: true });
  await setup.click();
  await page.getByLabel("Server URL").fill(baseUrl);
  await page.getByRole("button", { name: "Check server" }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Model for Chat").selectOption(model);
  await page.getByRole("button", { name: "Finish setup" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Review llama.cpp approval" }).waitFor();
  await page.getByRole("button", { name: "Open approval details" }).click();
  await page.getByRole("button", { name: "Return to llama.cpp setup" }).click();
  await page.getByRole("region", { name: "Review llama.cpp approval" }).waitFor();
  await page.getByRole("button", { name: "Approve and apply" }).click();
  await page.getByText("Completed", { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Send test message" }).click();
  await page.getByText("Chat tested", { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByText(REPLY, { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Start Here", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Set up llama.cpp", exact: true }).click();
  await page.getByText("Completed", { exact: true }).first().waitFor();
  assert.equal(await page.getByLabel("Server URL").inputValue(), baseUrl);
  assert.equal(await page.getByLabel("Model for Chat").inputValue(), model);
  await page.getByRole("button", { name: "Send test message" }).click();
  await page.getByText("Chat tested", { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByText(REPLY, { exact: true }).waitFor();
  const geometry = await page.locator("#llamacpp-setup").evaluate((card) => ({
    right: card.getBoundingClientRect().right,
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(geometry.right <= geometry.viewportWidth + 2, JSON.stringify(geometry));
  assert.ok(geometry.documentWidth <= geometry.viewportWidth + 2, JSON.stringify(geometry));
  return { model, chatReply: REPLY, approvalReturnLink: true, completionSurvivedReload: true, keyboardActions: true, geometry };
}

const context = await createRunContext("accessibility-smoke", { commandSelection: "llamacpp-setup-journey" });
try {
  await runAccessibilitySmokeLane(context, {
    secretEnvKeys: await collectVerificationSecretEnvKeys(path.join(context.repoRoot, "config")),
    scenarios: [
      { id: "llamacpp-setup-desktop", title: "llama.cpp setup desktop journey", href: "/settings/onboarding?view=llamacpp",
        viewport: { width: 1440, height: 1024 }, route: { readyText: "Start Here", expectedArea: "settings", expectedSection: "onboarding" }, prepare },
      { id: "llamacpp-setup-narrow", title: "llama.cpp setup narrow journey", href: "/settings/onboarding?view=llamacpp",
        viewport: { width: 390, height: 844 }, route: { readyText: "Start Here", expectedArea: "settings", expectedSection: "onboarding" }, prepare },
    ],
  });
  const result = await finalizeRunContext(context);
  console.log(`llama.cpp setup browser proof: ${context.artifactRoot}\nStatus: ${result.status}`);
  if (result.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally {
  await releaseRunContext(context);
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
