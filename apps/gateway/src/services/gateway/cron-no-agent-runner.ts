import { spawn } from "node:child_process";

export interface NoAgentRunInput {
  command: string;
  args?: string[];
  workdir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface NoAgentRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runNoAgentCommand(input: NoAgentRunInput): Promise<NoAgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.workdir,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeoutId =
      input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, input.timeoutMs)
        : undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const settle = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
}
