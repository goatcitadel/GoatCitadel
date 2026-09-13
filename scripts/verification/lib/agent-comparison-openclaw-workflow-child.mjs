import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { sha256 } from "./agent-comparison.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";
import { createNativeComparisonReviewConsole } from "./agent-comparison-native-approval-console.mjs";
import { executeOpenclawComparisonSkillWorkflow } from "./agent-comparison-openclaw-workflow.mjs";

const [checkoutRoot, configFile, configurationSha256, workspace, evidenceDirectory] = process.argv.slice(2);
if (
  process.argv.length !== 7 ||
  ![checkoutRoot, configFile, workspace, evidenceDirectory].every(path.isAbsolute) ||
  !process.stdin.isTTY ||
  path.resolve(workspace) !== process.cwd() ||
  configFile !== process.env.OPENCLAW_CONFIG_PATH ||
  !/^[a-f0-9]{64}$/u.test(configurationSha256 ?? "")
)
  throw new Error("Invalid supervised OpenClaw workflow launch.");
const config = await readComparisonJson(configFile);
const start = await readComparisonJson(path.join(evidenceDirectory, "session-start.json"));
if (
  sha256(config) !== configurationSha256 ||
  start.revision !== NATIVE_COMPARISON_PINS.openclaw ||
  config.gateway?.bind !== "loopback" ||
  config.gateway.mode !== "local" ||
  !Number.isInteger(config.gateway.port) ||
  config.gateway.port < 1024 ||
  config.gateway.port > 65535 ||
  path.dirname(workspace) !== path.dirname(evidenceDirectory) ||
  sha256(config.agents?.defaults?.skills) !== sha256(["release-note"]) ||
  config.skills?.workshop?.autonomous?.mode !== "off" ||
  config.skills.workshop.approvalPolicy !== "pending"
)
  throw new Error("The OpenClaw workflow config, scope, or source pin changed.");
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(start.profile.maxTaskMs)]);
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const redact = (value) =>
  String(value)
    .replaceAll(config.gateway.auth.token, "[approval gateway token]")
    .replaceAll(config.models.providers.comparison.apiKey, "[supervised proxy token]");
const rawDirectory = path.join(evidenceDirectory, "openclaw");
await mkdir(rawDirectory);
const retain = async (name, value) => {
  const bytes = redact(JSON.stringify(value, null, 2)) + "\n";
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Native workflow evidence exceeds its byte bound.");
  const file = await open(path.join(rawDirectory, `${name}.json`), "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
};
// The pinned public client owns device authentication. The fresh child home is
// established before this import; no private process or UI identity is used.
const { GatewayClient } = await import(pathToFileURL(path.join(checkoutRoot, "dist/plugin-sdk/gateway-runtime.js")));
let readyResolve,
  readyReject,
  closing = false;
const ready = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
const client = new GatewayClient({
  url: `ws://127.0.0.1:${config.gateway.port}`,
  token: config.gateway.auth.token,
  clientName: "cli",
  clientDisplayName: "GoatCitadel comparison skill workflow",
  mode: "cli",
  scopes: ["operator.admin"],
  onHelloOk: (hello) => {
    if (hello.auth?.scopes?.includes("operator.admin")) readyResolve();
    else readyReject(new Error("The native workflow client lacks operator scope."));
  },
  onConnectError: () => readyReject(new Error("The native workflow Gateway connection failed.")),
  onClose: () => {
    if (!closing) {
      readyReject(new Error("The native workflow Gateway closed."));
      interrupt();
    }
  },
});
const onAbort = () => readyReject(new globalThis.DOMException("Native workflow cancelled.", "AbortError"));
signal.addEventListener("abort", onAbort, { once: true });
const output = new PassThrough();
output.isTTY = true;
output.columns = 100;
output.pipe(process.stdout, { end: false });
let reviews;
try {
  signal.throwIfAborted();
  client.start();
  await ready;
  reviews = createNativeComparisonReviewConsole({ output, signal });
  const result = await executeOpenclawComparisonSkillWorkflow({
    workspace,
    cellDirectory: path.dirname(workspace),
    profile: start.profile,
    retain,
    signal,
    onReview: (value) => reviews.review(value),
    request: async (method, params, options) => {
      const value = await client.request(method, params, {
        ...options,
        signal,
        timeoutMs: options.expectFinal ? start.profile.maxTaskMs : 15_000,
      });
      const encoded = redact(JSON.stringify(value));
      if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error("Native RPC output exceeds its byte bound.");
      return JSON.parse(encoded);
    },
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(redact(error.stack ?? error.message) + "\n");
  process.exitCode = signal.aborted || error.name === "AbortError" ? 130 : 1;
} finally {
  closing = true;
  reviews?.stop();
  output.end();
  signal.removeEventListener("abort", onAbort);
  await client.stopAndWait();
}
