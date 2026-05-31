import fs from "node:fs/promises";
import path from "node:path";
import type { CodeModeSandboxLaunchInput, CodeModeSandboxLaunchSpec } from "./code-mode-sandbox/types.js";
import { rejectUnsafeProfilePath } from "./code-mode-sandbox/types.js";

export const CODE_MODE_DOCKER_CONTAINER_WORKDIR = "/goatcitadel/code-mode-run";
export const CODE_MODE_DOCKER_DEFAULT_COMMAND = "docker";
export const CODE_MODE_DOCKER_DEFAULT_NODE_COMMAND = "node";

export interface CodeModeDockerLaunchOptions {
  image: string;
  dockerCommand?: string;
  nodeCommand?: string;
  hostEnv?: NodeJS.ProcessEnv;
}

export async function prepareCodeModeDockerLaunch(
  input: CodeModeSandboxLaunchInput,
  options: CodeModeDockerLaunchOptions,
): Promise<CodeModeSandboxLaunchSpec> {
  await fs.mkdir(input.runTempRoot, { recursive: true });
  const image = normalizeDockerImageRef(options.image);
  const dockerCommand = normalizeDockerCommand(options.dockerCommand ?? CODE_MODE_DOCKER_DEFAULT_COMMAND);
  const nodeCommand = normalizeContainerCommand(options.nodeCommand ?? CODE_MODE_DOCKER_DEFAULT_NODE_COMMAND);
  const containerHarnessPath = toContainerRunPath(input.runTempRoot, input.harnessPath);
  const mountSpec = buildRunMountSpec(input.runTempRoot);
  const memoryLimit = `${Math.max(64, Math.floor(input.heapMb))}m`;

  return {
    transport: "stdio_jsonrpc",
    executable: dockerCommand,
    args: [
      "run",
      "--rm",
      "--interactive",
      "--network",
      "none",
      "--pull",
      "never",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      memoryLimit,
      "--label",
      `goatcitadel.code-mode.run=${input.runId}`,
      "--mount",
      mountSpec,
      "--workdir",
      CODE_MODE_DOCKER_CONTAINER_WORKDIR,
      "--env",
      "GOATCITADEL_CODE_MODE=1",
      "--env",
      "GOATCITADEL_CODE_MODE_TRANSPORT=stdio_jsonrpc",
      image,
      nodeCommand,
      `--max-old-space-size=${Math.max(64, Math.floor(input.heapMb))}`,
      containerHarnessPath,
    ],
    cwd: input.runTempRoot,
    env: buildDockerClientEnv(options.hostEnv ?? process.env),
    shell: false,
    enforcedWorkspaceRoot: input.runTempRoot,
    generatedArtifacts: [],
    advisoryUnsandboxed: false,
  };
}

export function buildDockerClientEnv(hostEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return copyEnvKeys(hostEnv, [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "XDG_RUNTIME_DIR",
  ]);
}

export function toContainerRunPath(runTempRoot: string, hostPath: string): string {
  rejectUnsafeProfilePath(runTempRoot);
  rejectUnsafeProfilePath(hostPath);
  const relative = path.relative(runTempRoot, hostPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Docker Code Mode harness path must stay inside the run temp root.");
  }
  return path.posix.join(CODE_MODE_DOCKER_CONTAINER_WORKDIR, ...relative.split(path.sep));
}

function buildRunMountSpec(runTempRoot: string): string {
  rejectUnsafeProfilePath(runTempRoot);
  return `type=bind,src=${runTempRoot},dst=${CODE_MODE_DOCKER_CONTAINER_WORKDIR},rw`;
}

function normalizeDockerImageRef(value: string): string {
  const image = value.trim();
  if (!image) {
    throw new Error("Docker Code Mode image is required.");
  }
  if (image.startsWith("-") || /[\s\r\n\0]/.test(image)) {
    throw new Error("Docker Code Mode image contains unsafe characters.");
  }
  return image;
}

function normalizeDockerCommand(value: string): string {
  const command = value.trim();
  if (!command) {
    throw new Error("Docker command is required.");
  }
  rejectUnsafeProfilePath(command);
  return command;
}

function normalizeContainerCommand(value: string): string {
  const command = value.trim();
  if (!command) {
    throw new Error("Docker Code Mode container command is required.");
  }
  if (command.startsWith("-") || /[\r\n\0]/.test(command)) {
    throw new Error("Docker Code Mode container command contains unsafe characters.");
  }
  return command;
}

function copyEnvKeys(hostEnv: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = hostEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
