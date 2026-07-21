#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const pnpm = process.platform === "win32" ? process.execPath : "pnpm";
const pnpmPrefix =
  process.platform === "win32"
    ? [path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js")]
    : [];

const policyAdapterPattern = [
  "sends channel messages through Slack bot API with rendered attachments",
  "covers direct channel suffix routing, Slack webhooks, and unsupported inline webhook attachments",
  "sends Discord webhook messages with inline uploads and URL embeds",
  "sends Telegram URL image attachments through sendPhoto with a caption",
  "sends ntfy outbound notifications and respects dry-run delivery",
  "sends channel messages through Teams webhook adapters",
  "sends Teams webhook attachments as adaptive card content",
  "sends Google Chat webhook attachments as rich cards",
  "sends channel messages through WhatsApp Cloud API adapters",
  "sends channel messages through Signal bridge adapters",
  "sends channel messages through Mattermost bot adapters",
  "sends channel messages through iMessage BlueBubbles adapters",
  "covers iMessage validation and unresolved BlueBubbles chat branches",
  "sends channel messages through Nextcloud Talk bot adapters",
  "sends channel messages through LINE bot adapters using shared target keys",
  "sends channel messages through Zalo Personal zca bridge adapters",
  "sends channel messages through Zalo bot adapters",
].join("|");

const checks = [
  {
    label: "matrix inventory and evidence anchors",
    command: process.execPath,
    args: ["--test", "scripts/verification/lib/channel-parity-matrix.test.mjs"],
  },
  {
    label: "advertised capability and rich-delivery truth",
    command: pnpm,
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/gateway-core",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/channel-core.test.ts",
    ],
  },
  {
    label: "adapter matrix, durable ingress/delivery, restart, signatures, and diagnostics",
    command: pnpm,
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/services/channel-parity-matrix.test.ts",
      "src/services/channel-setup-definitions.test.ts",
      "src/services/channel-bot-live-probes.test.ts",
      "src/services/channel-bot-live-probes.ntfy.test.ts",
      "src/services/channel-webhook-probes.test.ts",
      "src/services/integration-diagnostics-service.contract.test.ts",
      "src/services/integration-diagnostics-service.live-checks.test.ts",
      "src/services/signal-inbound-runtime-service.test.ts",
      "src/services/discord-runtime-service.loop27.test.ts",
      "src/services/discord-runtime-bridge-service.contract.test.ts",
      "src/services/channel-delivery-runtime-service.test.ts",
      "src/services/inbound-channel-event-service.test.ts",
      "src/routes/webhook-handler-factory.test.ts",
      "src/routes/integration-webhooks.security.test.ts",
    ],
  },
  {
    label: "provider adapter sends, attachment fallbacks, and Photon fail-closed boundary",
    command: pnpm,
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/policy-engine",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/tool-executor.test.ts",
      "src/tool-executor-edges.coverage.test.ts",
      "src/tool-executor-channel-failures.coverage.test.ts",
      "--testNamePattern",
      policyAdapterPattern,
    ],
  },
  {
    label: "Gateway typecheck",
    command: pnpm,
    args: [...pnpmPrefix, "--filter", "@goatcitadel/gateway", "typecheck"],
  },
];

for (const [index, check] of checks.entries()) {
  process.stdout.write(`\n[${index + 1}/${checks.length}] ${check.label}\n`);
  const result = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    process.stderr.write(`Channel parity proof failed during: ${check.label}\n`);
    break;
  }
}

if (!process.exitCode) {
  process.stdout.write(
    "\nChannel parity proof passed. External live-provider validation remains explicitly not run.\n",
  );
}
