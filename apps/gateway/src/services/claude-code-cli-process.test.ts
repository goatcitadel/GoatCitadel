import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCliError,
  buildClaudeCliArgs,
  buildClaudeCliEnv,
  resolveClaudeCliInvocation,
  runClaudeCli,
  type ClaudeCliSpawn,
} from "./claude-code-cli-process.js";

interface FakeChild {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  stdinChunks: Buffer[];
  exit(code: number | null): void;
}

function createFakeChild(pid = 4242): FakeChild {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const stdinChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk));
  Object.assign(emitter, { stdout, stderr, stdin, pid, exitCode: null, killed: false });
  emitter.kill = vi.fn(() => true) as ChildProcess["kill"];
  return {
    child: emitter,
    stdout,
    stderr,
    stdinChunks,
    exit(code) {
      Object.assign(emitter, { exitCode: code });
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit("close", code, null));
    },
  };
}

function spawnReturning(fake: FakeChild) {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawn: ClaudeCliSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return fake.child;
  };
  return { spawn, calls };
}

const invocation = { command: "C:\\Tools\\claude.exe", prefixArgs: [] };

async function collect(generator: AsyncGenerator<string, unknown>): Promise<{ lines: string[]; result: unknown }> {
  const lines: string[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { lines, result: next.value };
    lines.push(next.value);
  }
}

describe("resolveClaudeCliInvocation", () => {
  const base = { env: {}, platform: "win32" as const, execPath: "C:\\node\\node.exe", fileExists: () => false };

  it("prefers the native .exe over the npm .cmd shim", () => {
    expect(
      resolveClaudeCliInvocation({
        ...base,
        candidates: ["C:\\npm\\claude.cmd", "C:\\Users\\op\\.local\\bin\\claude.exe"],
      }),
    ).toEqual({ command: "C:\\Users\\op\\.local\\bin\\claude.exe", prefixArgs: [] });
  });

  it("maps an npm .cmd shim to node plus the package cli.js", () => {
    const cliJs = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    expect(
      resolveClaudeCliInvocation({
        ...base,
        candidates: ["C:\\npm\\claude.cmd"],
        fileExists: (path) => path === cliJs,
      }),
    ).toEqual({ command: "C:\\node\\node.exe", prefixArgs: [cliJs] });
  });

  it("reports an unsupported shim when the .cmd has no resolvable package entry", () => {
    expect(resolveClaudeCliInvocation({ ...base, candidates: ["C:\\npm\\claude.cmd"] })).toEqual({
      error: "claude_cli_unsupported_shim",
    });
  });

  it("reports missing when nothing is found", () => {
    expect(resolveClaudeCliInvocation({ ...base, candidates: [] })).toEqual({ error: "claude_cli_missing" });
  });

  it("lets GOATCITADEL_CLAUDE_CLI_PATH win", () => {
    expect(
      resolveClaudeCliInvocation({
        ...base,
        env: { GOATCITADEL_CLAUDE_CLI_PATH: "D:\\claude\\claude.exe" },
        candidates: ["C:\\Users\\op\\.local\\bin\\claude.exe"],
        fileExists: (path) => path === "D:\\claude\\claude.exe",
      }),
    ).toEqual({ command: "D:\\claude\\claude.exe", prefixArgs: [] });
  });

  it("accepts an extensionless executable on POSIX hosts", () => {
    expect(resolveClaudeCliInvocation({ ...base, platform: "linux", candidates: ["/usr/local/bin/claude"] })).toEqual({
      command: "/usr/local/bin/claude",
      prefixArgs: [],
    });
  });
});

describe("buildClaudeCliArgs", () => {
  it("disables every CLI tool surface and never carries prompt text", () => {
    const args = buildClaudeCliArgs({ model: "claude-sonnet-5-5", systemPromptFile: "C:\\tmp\\sys.txt" });
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--safe-mode",
        "--disable-slash-commands",
        "--no-session-persistence",
      ]),
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("C:\\tmp\\sys.txt");
  });

  it("omits the system prompt file flag when none is given", () => {
    expect(buildClaudeCliArgs({ model: "sonnet" })).not.toContain("--system-prompt-file");
  });

  it("rejects a model id that could smuggle flags or shell syntax", () => {
    expect(() => buildClaudeCliArgs({ model: "--dangerously-skip-permissions" })).toThrow(ClaudeCliError);
    expect(() => buildClaudeCliArgs({ model: "sonnet & calc" })).toThrow(/claude_cli_model_unavailable|model/i);
  });
});

describe("buildClaudeCliEnv", () => {
  it("drops Anthropic credentials and Gateway secrets but keeps what the CLI needs to find its login", () => {
    const env = buildClaudeCliEnv({
      Path: "C:\\Windows",
      USERPROFILE: "C:\\Users\\op",
      APPDATA: "C:\\Users\\op\\AppData\\Roaming",
      CLAUDE_CONFIG_DIR: "C:\\Users\\op\\.claude",
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_BASE_URL: "https://evil.example",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
      OPENAI_API_KEY: "sk-openai",
      GOATCITADEL_GATEWAY_TOKEN: "gw",
    });
    expect(env).toEqual({
      Path: "C:\\Windows",
      USERPROFILE: "C:\\Users\\op",
      APPDATA: "C:\\Users\\op\\AppData\\Roaming",
      CLAUDE_CONFIG_DIR: "C:\\Users\\op\\.claude",
    });
  });
});

describe("runClaudeCli", () => {
  it("spawns without a shell, writes the payload to stdin as UTF-8 and yields whole stdout lines", async () => {
    const fake = createFakeChild();
    const { spawn, calls } = spawnReturning(fake);
    const payload = '{"text":"héllo 🐐 世界"}\n';
    const generator = runClaudeCli({
      invocation,
      args: ["-p"],
      env: {},
      cwd: "C:\\scratch",
      stdinPayload: payload,
      overallTimeoutMs: 5000,
      idleTimeoutMs: 5000,
      spawn,
      killTree: vi.fn(),
    });
    const pending = collect(generator);
    await new Promise((resolve) => setImmediate(resolve));
    fake.stdout.write('{"a":');
    fake.stdout.write('1}\r\n{"b":2}\n');
    fake.stdout.write('{"c":3}');
    fake.exit(0);
    const { lines, result } = await pending;

    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[0]?.options.windowsHide).toBe(true);
    expect(calls[0]?.args).toEqual(["-p"]);
    expect(Buffer.concat(fake.stdinChunks).toString("utf8")).toBe(payload);
  });

  it("keeps a bounded stderr tail", async () => {
    const fake = createFakeChild();
    const { spawn } = spawnReturning(fake);
    const pending = collect(
      runClaudeCli({
        invocation,
        args: [],
        env: {},
        cwd: ".",
        stdinPayload: "",
        overallTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        spawn,
        killTree: vi.fn(),
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    fake.stderr.write("x".repeat(40_000) + "TAIL");
    fake.exit(1);
    const { result } = await pending;
    const tail = (result as { stderrTail: string }).stderrTail;
    expect(tail.length).toBeLessThanOrEqual(16 * 1024);
    expect(tail.endsWith("TAIL")).toBe(true);
  });

  it("fails a stdout line over 1 MiB and kills the process tree", async () => {
    const fake = createFakeChild();
    const { spawn } = spawnReturning(fake);
    const killTree = vi.fn(() => fake.exit(null));
    const pending = collect(
      runClaudeCli({
        invocation,
        args: [],
        env: {},
        cwd: ".",
        stdinPayload: "",
        overallTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        spawn,
        killTree,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    fake.stdout.write("y".repeat(1024 * 1024 + 10));
    await expect(pending).rejects.toMatchObject({ reasonCode: "claude_cli_failed" });
    expect(killTree).toHaveBeenCalledWith(4242);
  });

  it("kills the process tree once when the caller aborts", async () => {
    const fake = createFakeChild();
    const { spawn } = spawnReturning(fake);
    const killTree = vi.fn(() => fake.exit(null));
    const controller = new AbortController();
    const pending = collect(
      runClaudeCli({
        invocation,
        args: [],
        env: {},
        cwd: ".",
        stdinPayload: "",
        signal: controller.signal,
        overallTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        spawn,
        killTree,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(killTree).toHaveBeenCalledTimes(1);
  });

  it("does not spawn or kill when already aborted", async () => {
    const fake = createFakeChild();
    const { spawn, calls } = spawnReturning(fake);
    const killTree = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        runClaudeCli({
          invocation,
          args: [],
          env: {},
          cwd: ".",
          stdinPayload: "",
          signal: controller.signal,
          overallTimeoutMs: 5000,
          idleTimeoutMs: 5000,
          spawn,
          killTree,
        }),
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(killTree).not.toHaveBeenCalled();
  });

  it("does not kill after a normal exit even if the caller aborts later", async () => {
    const fake = createFakeChild();
    const { spawn } = spawnReturning(fake);
    const killTree = vi.fn();
    const controller = new AbortController();
    const pending = collect(
      runClaudeCli({
        invocation,
        args: [],
        env: {},
        cwd: ".",
        stdinPayload: "",
        signal: controller.signal,
        overallTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        spawn,
        killTree,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    fake.exit(0);
    await pending;
    controller.abort();
    expect(killTree).not.toHaveBeenCalled();
  });

  it("maps an idle stdout stall to claude_cli_timeout", async () => {
    const fake = createFakeChild();
    const { spawn } = spawnReturning(fake);
    const killTree = vi.fn(() => fake.exit(null));
    await expect(
      collect(
        runClaudeCli({
          invocation,
          args: [],
          env: {},
          cwd: ".",
          stdinPayload: "",
          overallTimeoutMs: 5000,
          idleTimeoutMs: 20,
          spawn,
          killTree,
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "claude_cli_timeout" });
    expect(killTree).toHaveBeenCalledWith(4242);
  });

  it("maps a spawn ENOENT to claude_cli_missing", async () => {
    const fake = createFakeChild();
    const { spawn } = spawnReturning(fake);
    const pending = collect(
      runClaudeCli({
        invocation,
        args: [],
        env: {},
        cwd: ".",
        stdinPayload: "",
        overallTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        spawn,
        killTree: vi.fn(),
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    fake.child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    await expect(pending).rejects.toMatchObject({ reasonCode: "claude_cli_missing" });
  });
});
