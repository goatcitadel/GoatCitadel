import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { sha256 } from "./agent-comparison.mjs";
import { writeNativeComparisonJson } from "./agent-comparison-native-driver.mjs";

const [checkout, configFile, configurationSha256, promptFile, outputFile] = process.argv.slice(2);
if (
  process.argv.length !== 7 ||
  ![checkout, configFile, promptFile, outputFile].every(path.isAbsolute) ||
  configFile !== process.env.OPENCLAW_CONFIG_PATH ||
  !/^[a-f0-9]{64}$/u.test(configurationSha256)
)
  throw new Error("Invalid owned native web launch.");
const config = await readComparisonJson(configFile);
if (sha256(config) !== configurationSha256 || config.gateway.bind !== "loopback" || config.gateway.mode !== "local")
  throw new Error("Native web configuration changed.");
const { GatewayClient } = await import(pathToFileURL(path.join(checkout, "dist/plugin-sdk/gateway-runtime.js")));
const abort = new AbortController(),
  signal = abort.signal;
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
let resolveReady, rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const client = new GatewayClient({
  url: `ws://127.0.0.1:${config.gateway.port}`,
  token: config.gateway.auth.token,
  clientName: "cli",
  clientDisplayName: "Feature acceptance",
  mode: "cli",
  scopes: ["operator.admin"],
  onHelloOk: (hello) =>
    hello.auth?.scopes?.includes("operator.admin")
      ? resolveReady()
      : rejectReady(new Error("Native operator scope denied.")),
  onConnectError: () => rejectReady(new Error("Native web Gateway connection failed.")),
});
const cancelled = () => rejectReady(new Error("Native web cancelled."));
signal.addEventListener("abort", cancelled, { once: true });
try {
  client.start();
  await ready;
  const sessionKey = `agent:main:feature-${randomUUID()}`,
    prompt = await readFile(promptFile, "utf8");
  const model = config.models.providers.comparison.models[0].id;
  const result = await client.request(
    "agent",
    {
      message: prompt,
      agentId: "main",
      sessionKey,
      model: `comparison/${model}`,
      thinking: config.agents.defaults.thinkingDefault,
      deliver: false,
      idempotencyKey: randomUUID(),
    },
    { expectFinal: true, signal, timeoutMs: 600000 },
  );
  const history = await client.request("chat.history", { sessionKey, limit: 500 }, { signal, timeoutMs: 15000 });
  const redact = (value) =>
    String(value)
      .replaceAll(config.gateway.auth.token, "[operator credential]")
      .replaceAll(config.models.providers.comparison.apiKey, "[proxy credential]");
  await writeNativeComparisonJson(outputFile, JSON.parse(redact(JSON.stringify({ sessionKey, result, history }))));
} finally {
  signal.removeEventListener("abort", cancelled);
  await client.stopAndWait();
}
