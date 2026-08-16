import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildVerificationGatewayCommand,
  buildVerificationProcessEnv,
  buildVerificationProcessLogName,
  buildVerificationUiCommand,
  buildVerificationWorkspaceRefreshCommands,
} from "./runtime.mjs";

test("verification process environments remove inherited secrets while allowing explicit fixtures", () => {
  const env = buildVerificationProcessEnv(
    {
      PATH: "safe-path",
      OPENAI_API_KEY: "personal-secret",
      GITHUB_TOKEN: "personal-token",
    },
    {
      OPENAI_API_KEY: "deterministic-fixture-key",
      GOATCITADEL_ROOT_DIR: "isolated-root",
    },
    ["OPENAI_API_KEY", "GITHUB_TOKEN"],
  );

  assert.equal(env.PATH, "safe-path");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, "deterministic-fixture-key");
  assert.equal(env.GOATCITADEL_ROOT_DIR, "isolated-root");
});

test("verification process log names preserve defaults and isolate prefixed stacks", () => {
  assert.equal(buildVerificationProcessLogName("gateway", undefined), "gateway");
  assert.equal(buildVerificationProcessLogName("ui", ""), "ui");
  assert.equal(buildVerificationProcessLogName("gateway", "External Sources #2"), "external-sources-2-gateway");
  assert.equal(
    buildVerificationProcessLogName("ui-build-package", "External Sources #2"),
    "external-sources-2-ui-build-package",
  );
});

test("verification startup force-refreshes the threaded Chat surface before Chromium", () => {
  const commands = buildVerificationWorkspaceRefreshCommands();
  assert.deepEqual(commands.gateway.slice(-3), ["--filter", "@goatcitadel/gateway...", "build"]);
  assert.deepEqual(commands.threadedSurfaceCore.slice(2), [
    "--filter",
    "@goatcitadel/threaded-surface-core",
    "exec",
    "tsc",
    "-b",
    "tsconfig.json",
    "--force",
  ]);
});

test("verification Gateway launch directly owns the runtime process", () => {
  const command = buildVerificationGatewayCommand();
  assert.equal(command[0], process.execPath);
  assert.match(command[1].replaceAll("\\", "/"), /node_modules\/tsx\/dist\/cli\.mjs$/u);
  assert.match(command[2].replaceAll("\\", "/"), /apps\/gateway\/src\/main\.ts$/u);
});

test("verification dev UI invalidates Vite dependency prebundles while preview stays immutable", () => {
  const devCommand = buildVerificationUiCommand("@goatcitadel/mission-control-next", 5173, undefined);
  const previewCommand = buildVerificationUiCommand("@goatcitadel/mission-control-next", 4173, "preview");
  assert.equal(devCommand[0], process.execPath);
  assert.match(devCommand[1].replaceAll("\\", "/"), /apps\/mission-control-next\/node_modules\/vite\/bin\/vite\.js$/u);
  assert.deepEqual(devCommand.slice(2), ["--force", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  assert.equal(previewCommand[0], process.execPath);
  assert.match(
    previewCommand[1].replaceAll("\\", "/"),
    /apps\/mission-control-next\/node_modules\/vite\/bin\/vite\.js$/u,
  );
  assert.deepEqual(previewCommand.slice(2), ["preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"]);
});
