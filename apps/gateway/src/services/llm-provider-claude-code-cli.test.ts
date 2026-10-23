import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { ClaudeCodeCliReadiness } from "./claude-code-cli-readiness.js";
import { LlmService } from "./llm-service.js";

interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
  stdin: () => string;
  systemPromptAtSpawn?: string;
}

type Script = (child: { stdout: PassThrough; stderr: PassThrough; exit: (code: number | null) => void }) => void;

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const textDelta = (text: string) =>
  line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const success = line({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hello world",
  usage: { input_tokens: 7, output_tokens: 2 },
});

const helloScript: Script = ({ stdout, exit }) => {
  stdout.write(line({ type: "system", subtype: "init" }));
  stdout.write(textDelta("hello "));
  stdout.write(textDelta("world"));
  stdout.write(success);
  exit(0);
};

function createHarness(scripts: Script[], options: { loggedIn?: boolean } = {}) {
  const spawns: SpawnRecord[] = [];
  const exitsByPid = new Map<number, (code: number | null) => void>();
  // Like a real tree kill, the killed fake child closes (stdout ends, then "close").
  const killTree = vi.fn((pid: number) => exitsByPid.get(pid)?.(null));
  const spawn = vi.fn((command: string, args: string[], spawnOptions: SpawnOptions) => {
    const emitter = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    Object.assign(emitter, { stdout, stderr, stdin, pid: 9000 + spawns.length, exitCode: null });
    const fileIndex = args.indexOf("--system-prompt-file");
    const systemFile = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
    spawns.push({
      command,
      args,
      options: spawnOptions,
      stdin: () => Buffer.concat(chunks).toString("utf8"),
      systemPromptAtSpawn: systemFile ? readFileSync(systemFile, "utf8") : undefined,
    });
    const script = scripts[spawns.length - 1] ?? helloScript;
    let exited = false;
    const exit = (code: number | null) => {
      if (exited) return;
      exited = true;
      Object.assign(emitter, { exitCode: code });
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit("close", code, null));
    };
    exitsByPid.set(emitter.pid as number, exit);
    setImmediate(() => script({ stdout, stderr, exit }));
    return emitter;
  });
  const readiness = new ClaudeCodeCliReadiness({
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: options.loggedIn ?? true,
        authMethod: options.loggedIn === false ? "none" : "claude.ai",
        apiProvider: "firstParty",
      }),
    }),
  });
  return { spawns, spawn, killTree, readiness };
}

const config: LlmConfigFile = {
  activeProviderId: "claude-code-cli",
  activeModel: "claude-sonnet-5-5",
  providers: [
    {
      providerId: "claude-code-cli",
      label: "Claude Code CLI (local login)",
      baseUrl: "https://api.anthropic.com/v1",
      apiStyle: "claude-code-cli",
      defaultModel: "claude-sonnet-5-5",
    },
    {
      providerId: "claude-code",
      label: "Claude Code (Claude subscription)",
      baseUrl: "https://api.anthropic.com/v1",
      apiStyle: "anthropic-messages",
      defaultModel: "claude-sonnet-5-5",
    },
  ],
};

describe("claude-code-cli provider through LlmService", () => {
  let scratchRoot: string;

  beforeEach(() => {
    scratchRoot = mkdtempSync(path.join(os.tmpdir(), "gc-claude-cli-test-"));
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  function createService(harness: ReturnType<typeof createHarness>) {
    return new LlmService(
      config,
      { ANTHROPIC_API_KEY: "sk-ant-should-not-leak", PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\op" },
      {
        secretStore: createNoopSecretStore(),
        enforceNetworkAllowlist: false,
        claudeCli: {
          spawn: harness.spawn,
          killTree: harness.killTree,
          readiness: harness.readiness,
          resolveInvocation: () => ({ command: "C:\\Users\\op\\.local\\bin\\claude.exe", prefixArgs: [] }),
          scratchRoot,
        },
      },
    );
  }

  it("streams a reply from the CLI as normalized chat chunks with subscription usage", async () => {
    const harness = createHarness([]);
    const service = createService(harness);

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream({
      messages: [
        { role: "system", content: "You are GoatCitadel." },
        { role: "user", content: "say hello 🐐" },
      ],
    })) {
      chunks.push(chunk);
    }

    const text = chunks
      .map((chunk) => (chunk.choices as Array<{ delta?: { content?: string } }>)[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe("hello world");
    expect(chunks.at(-1)).toMatchObject({
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });

    const spawned = harness.spawns[0];
    expect(spawned?.command).toBe("C:\\Users\\op\\.local\\bin\\claude.exe");
    expect(spawned?.options.shell).toBe(false);
    expect(spawned?.args[spawned.args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(spawned?.args[spawned.args.indexOf("--tools") + 1]).toBe("");
    expect(spawned?.args.join(" ")).not.toContain("say hello");
    expect(spawned?.options.env).toEqual({
      PATH: "C:\\Windows",
      USERPROFILE: "C:\\Users\\op",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
    expect(spawned?.systemPromptAtSpawn).toBe("You are GoatCitadel.");
    expect(JSON.parse(spawned?.stdin() ?? "{}")).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "say hello 🐐" }] },
    });
    // The per-run scratch dir (cwd + system prompt file) is removed afterwards.
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("returns the joined text from a non-streaming completion", async () => {
    const harness = createHarness([]);
    const service = createService(harness);
    const response = await service.chatCompletions({ messages: [{ role: "user", content: "hi" }] });
    expect(response.choices?.[0]?.message).toEqual({ role: "assistant", content: "hello world" });
    expect(response.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 2 });
  });

  it("refuses a turn that requires a tool call before spawning the CLI", async () => {
    const harness = createHarness([]);
    const service = createService(harness);
    await expect(
      service.chatCompletions({
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
        tool_choice: "required",
      }),
    ).rejects.toMatchObject({ reasonCode: "claude_cli_tools_unsupported" });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("drops offered tools and answers as plain text", async () => {
    const harness = createHarness([]);
    const service = createService(harness);
    const response = await service.chatCompletions({
      messages: [{ role: "user", content: "maybe use a tool" }],
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
      tool_choice: "auto",
    });
    expect(response.choices?.[0]?.message).toMatchObject({ content: "hello world" });
    expect(harness.spawns[0]?.stdin()).not.toContain("read_file");
  });

  it("fails before spawn when the CLI is logged out", async () => {
    const harness = createHarness([], { loggedIn: false });
    const service = createService(harness);
    await expect(service.chatCompletions({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      reasonCode: "claude_cli_logged_out",
    });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("blocks a CLI tool_use block and removes the scratch dir on error", async () => {
    const harness = createHarness([
      ({ stdout }) => {
        stdout.write(
          line({
            type: "stream_event",
            event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Bash" } },
          }),
        );
      },
    ]);
    const service = createService(harness);
    await expect(service.chatCompletions({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      reasonCode: "claude_cli_tool_use_blocked",
    });
    expect(harness.killTree).toHaveBeenCalledWith(9000);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("kills the CLI and cleans up when the caller aborts mid-stream", async () => {
    const harness = createHarness([({ stdout }) => stdout.write(textDelta("partial"))]);
    const service = createService(harness);
    const controller = new AbortController();
    const stream = service.chatCompletionsStream({
      messages: [{ role: "user", content: "long answer" }],
      signal: controller.signal,
    });
    const first = await stream.next();
    expect(first.value).toMatchObject({ choices: [{ delta: { content: "partial" } }] });
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ reasonCode: "claude_cli_cancelled" });
    expect(harness.killTree).toHaveBeenCalledWith(9000);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("retries once with the system prompt inline when --system-prompt-file is rejected", async () => {
    const harness = createHarness([
      ({ stderr, exit }) => {
        stderr.write("error: unknown option '--system-prompt-file'\n");
        exit(1);
      },
      helloScript,
    ]);
    const service = createService(harness);
    const response = await service.chatCompletions({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
    });
    expect(response.choices?.[0]?.message).toMatchObject({ content: "hello world" });
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]?.args).not.toContain("--system-prompt-file");
    expect(harness.spawns[1]?.stdin()).toContain("[System instructions]\\nBe terse.");
  });

  it("pins the profile baseUrl to the CLI's real egress origin", () => {
    const harness = createHarness([]);
    const service = new LlmService(
      {
        ...config,
        providers: config.providers.map((provider) =>
          provider.providerId === "claude-code-cli"
            ? { ...provider, baseUrl: "https://allowlisted.example/v1" }
            : provider,
        ),
      },
      {},
      { secretStore: createNoopSecretStore(), claudeCli: { readiness: harness.readiness, scratchRoot } },
    );
    expect(service.listProviders().find((provider) => provider.providerId === "claude-code-cli")?.baseUrl).toBe(
      "https://api.anthropic.com/v1",
    );
  });

  it("refuses the claude-code-cli API style on any other provider id", () => {
    expect(
      () =>
        new LlmService(
          {
            activeProviderId: "my-proxy",
            providers: [
              {
                providerId: "my-proxy",
                label: "Proxy",
                baseUrl: "https://proxy.example/v1",
                apiStyle: "claude-code-cli",
                defaultModel: "sonnet",
              },
            ],
          },
          {},
          { secretStore: createNoopSecretStore() },
        ),
    ).toThrow(/only valid for the built-in "claude-code-cli" provider/);
  });

  it("refuses the CLI login auth mode on any other provider id", () => {
    expect(
      () =>
        new LlmService(
          {
            activeProviderId: "anthropic",
            providers: [
              {
                providerId: "anthropic",
                label: "Anthropic",
                baseUrl: "https://api.anthropic.com/v1",
                apiStyle: "anthropic-messages",
                authMode: "claude-code-cli-login",
                defaultModel: "claude-sonnet-5-5",
              },
            ],
          },
          {},
          { secretStore: createNoopSecretStore() },
        ),
    ).toThrow(/authMode "claude-code-cli-login" is only valid/);
  });

  it("keeps Claude model ids selectable on the anthropic and claude-code providers", () => {
    const harness = createHarness([]);
    const service = createService(harness);
    expect(
      service.updateRuntimeConfig({ activeProviderId: "claude-code", activeModel: "claude-sonnet-5-5" }),
    ).toMatchObject({ activeProviderId: "claude-code", activeModel: "claude-sonnet-5-5" });
    expect(
      service.updateRuntimeConfig({ activeProviderId: "claude-code-cli", activeModel: "claude-opus-5-5" }),
    ).toMatchObject({ activeProviderId: "claude-code-cli", activeModel: "claude-opus-5-5" });
  });

  it("warms readiness for listings and probes it for provider advice", async () => {
    const harness = createHarness([]);
    const probe = vi.spyOn(harness.readiness, "check");
    const service = createService(harness);
    service.listProviders();
    expect(probe).not.toHaveBeenCalled();
    service.listProviders({ warmProbedReadiness: true });
    expect(probe).toHaveBeenCalledTimes(1);
    const listed = await service.listProvidersWithProbedReadiness();
    expect(listed.find((provider) => provider.providerId === "claude-code-cli")?.hasApiKey).toBe(true);
  });

  it("probes readiness on demand so a fresh Gateway does not freeze auth-missing evidence", async () => {
    const harness = createHarness([]);
    const service = createService(harness);
    await service.ensureProviderReadiness("claude-code");
    expect(service.listProviders().find((provider) => provider.providerId === "claude-code-cli")?.hasApiKey).toBe(
      false,
    );
    await service.ensureProviderReadiness("claude-code-cli");
    expect(
      service.getRuntimeConfig().providers.find((provider) => provider.providerId === "claude-code-cli"),
    ).toMatchObject({
      hasApiKey: true,
      authReadiness: { status: "ready" },
    });
  });

  it("lists the provider with CLI readiness and text-only capabilities, and keeps claude-code on the token route", async () => {
    const harness = createHarness([]);
    const service = createService(harness);
    const before = service.listProviders().find((provider) => provider.providerId === "claude-code-cli");
    expect(before).toMatchObject({
      authMode: "claude-code-cli-login",
      resolvedApiStyle: "claude-code-cli",
      hasApiKey: false,
      authReadiness: { status: "unknown", reasonCode: "claude_cli_not_probed" },
      capabilities: { toolCalling: false, vision: false },
    });
    await service.refreshClaudeCodeCliReadiness();
    const after = service.listProviders().find((provider) => provider.providerId === "claude-code-cli");
    expect(after).toMatchObject({ hasApiKey: true, authReadiness: { status: "ready", liveVerified: true } });

    const tokenRoute = service.listProviders().find((provider) => provider.providerId === "claude-code");
    expect(tokenRoute).toMatchObject({ authMode: "claude-code-oauth", resolvedApiStyle: "anthropic-messages" });
    expect(existsSync(scratchRoot)).toBe(true);
  });
});
