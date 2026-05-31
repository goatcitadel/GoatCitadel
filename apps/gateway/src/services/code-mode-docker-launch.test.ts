import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_MODE_DOCKER_CONTAINER_WORKDIR,
  buildDockerClientEnv,
  prepareCodeModeDockerLaunch,
  toContainerRunPath,
} from "./code-mode-docker-launch.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("code-mode-docker-launch", () => {
  it("builds a stdio JSON-RPC docker launch spec with deny-by-default container posture", async () => {
    const root = await createTempRoot();
    const harnessPath = path.join(root, "child", "harness.mjs");
    const launch = await prepareCodeModeDockerLaunch(
      {
        runId: "code-run-1",
        nodePath: process.execPath,
        harnessPath,
        runTempRoot: root,
        heapMb: 96,
        env: {
          GOATCITADEL_CODE_MODE: "1",
          OPENAI_API_KEY: "must-not-leak",
        },
      },
      {
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
        hostEnv: {
          PATH: "/usr/bin",
          OPENAI_API_KEY: "also-must-not-leak",
        },
      },
    );

    expect(launch.transport).toBe("stdio_jsonrpc");
    expect(launch.executable).toBe("docker");
    expect(launch.shell).toBe(false);
    expect(launch.cwd).toBe(root);
    expect(launch.enforcedWorkspaceRoot).toBe(root);
    expect(launch.advisoryUnsandboxed).toBe(false);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--interactive",
        "--network",
        "none",
        "--pull",
        "never",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        "96m",
        "--env",
        "GOATCITADEL_CODE_MODE_TRANSPORT=stdio_jsonrpc",
        "ghcr.io/goatcitadel/code-mode-runner:preview",
        "node",
        "--max-old-space-size=96",
        `${CODE_MODE_DOCKER_CONTAINER_WORKDIR}/child/harness.mjs`,
      ]),
    );
    expect(launch.args).toContain(`type=bind,src=${root},dst=${CODE_MODE_DOCKER_CONTAINER_WORKDIR},rw`);
    expect(JSON.stringify(launch.args)).not.toContain("must-not-leak");
    expect(launch.env).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps the harness path inside the mounted run temp root", async () => {
    const root = await createTempRoot();

    expect(toContainerRunPath(root, path.join(root, "harness.mjs"))).toBe(
      `${CODE_MODE_DOCKER_CONTAINER_WORKDIR}/harness.mjs`,
    );
    expect(() => toContainerRunPath(root, path.join(root, "..", "harness.mjs"))).toThrow(
      "Docker Code Mode harness path must stay inside the run temp root.",
    );
  });

  it("rejects unsafe image references before building docker argv", async () => {
    const root = await createTempRoot();
    await expect(
      prepareCodeModeDockerLaunch(launchInput(root), {
        image: "",
      }),
    ).rejects.toThrow("Docker Code Mode image is required.");
    await expect(
      prepareCodeModeDockerLaunch(launchInput(root), {
        image: "--privileged",
      }),
    ).rejects.toThrow("Docker Code Mode image contains unsafe characters.");
    await expect(
      prepareCodeModeDockerLaunch(launchInput(root), {
        image: "goatcitadel/code mode",
      }),
    ).rejects.toThrow("Docker Code Mode image contains unsafe characters.");
  });

  it("copies only Docker client environment needed to reach the daemon", () => {
    expect(
      buildDockerClientEnv({
        PATH: "/usr/bin",
        DOCKER_HOST: "unix:///var/run/docker.sock",
        OPENAI_API_KEY: "must-not-leak",
        GITHUB_TOKEN: "must-not-leak",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
  });
});

function launchInput(root: string) {
  return {
    runId: "code-run-1",
    nodePath: process.execPath,
    harnessPath: path.join(root, "harness.mjs"),
    runTempRoot: root,
    heapMb: 64,
    env: { GOATCITADEL_CODE_MODE: "1" },
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-code-mode-docker-"));
  tempRoots.push(root);
  return root;
}
