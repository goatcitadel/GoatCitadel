import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const [checkoutRoot, configFile, expectedSha256, outputFile] = process.argv.slice(2);
if (
  process.argv.length !== 6 ||
  ![checkoutRoot, configFile, outputFile].every(path.isAbsolute) ||
  !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")
)
  throw new Error("Invalid native approval reviewer startup.");
const bytes = await readFile(configFile);
if (bytes.length > 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
  throw new Error("The approval reviewer configuration changed.");
const config = JSON.parse(bytes.toString("utf8"));
if (
  config.gateway?.bind !== "loopback" ||
  config.gateway?.mode !== "local" ||
  !Number.isInteger(config.gateway?.port) ||
  config.gateway.port < 1024 ||
  config.gateway.port > 65535
)
  throw new Error("The approval reviewer requires its own loopback Gateway.");
// Use the pinned product's public host-aware client in this fresh child home.
// It owns device authentication; no internal process token or UI identity is impersonated.
const { GatewayClient } = await import(pathToFileURL(path.join(checkoutRoot, "dist/plugin-sdk/gateway-runtime.js")));
const log = await open(outputFile, "wx", 0o600);
const redact = (value) =>
  JSON.stringify(value)
    .replaceAll(config.gateway.auth.token, "[approval gateway token]")
    .replaceAll(config.models.providers.comparison.apiKey, "[supervised proxy token]");
let tail = Promise.resolve(),
  size = 0,
  closing = false;
const retain = (event) => {
  const line = `${redact(event)}\n`;
  size += Buffer.byteLength(line);
  if (size > 1024 * 1024) {
    void stop(1);
    return;
  }
  tail = tail.then(async () => {
    await log.write(line);
    await log.sync();
  });
  void tail.catch(() => stop(1));
};
const client = new GatewayClient({
  url: `ws://127.0.0.1:${config.gateway.port}`,
  token: config.gateway.auth.token,
  clientName: "cli",
  clientDisplayName: "GoatCitadel comparison approval reviewer",
  mode: "cli",
  // The native pending CLI also requests operator.admin: cross-requester
  // approvals are hidden from an approvals-only client by the Gateway owner.
  scopes: ["operator.admin"],
  caps: ["exec-approvals"],
  onHelloOk: (hello) => {
    const scopes = hello.auth?.scopes ?? [];
    if (!scopes.includes("operator.approvals") && !scopes.includes("operator.admin")) {
      void stop(1);
      return;
    }
    retain({ kind: "ready", scopes, automaticApprovals: false });
  },
  onEvent: (event) => {
    if (["exec.approval.requested", "exec.approval.resolved"].includes(event.event)) retain(event);
  },
  onConnectError: () => {
    void stop(1);
  },
  onClose: () => {
    void stop(1);
  },
});
async function stop(code) {
  if (closing) return;
  closing = true;
  try {
    await client.stopAndWait();
    await tail;
    await log.close();
  } finally {
    process.exit(code);
  }
}
process.once("SIGTERM", () => void stop(0));
process.once("SIGINT", () => void stop(0));
client.start();
