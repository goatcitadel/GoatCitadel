#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const defaultAppPath = "/Applications/GoatCitadel Mission Control.app";
const defaultLogDir = path.join(os.homedir(), "Library", "Application Support", "GoatCitadel", "runtime", "logs");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const appPath = path.resolve(args.app || defaultAppPath);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(args.out || path.join(repoRoot, "artifacts", "macos-desktop-evidence", timestamp));
const rawDir = path.join(outDir, "raw");
const tailLines = Number.parseInt(args.tailLines || "160", 10);

fs.mkdirSync(rawDir, { recursive: true });

const commands = [];
const notes = [];

record("sw_vers", "sw_vers", []);
record("uname", "uname", ["-m"]);
record("app_ls", "ls", ["-ld", appPath]);
record("app_size", "du", ["-sh", appPath]);
record("app_info_plist", "plutil", ["-p", path.join(appPath, "Contents", "Info.plist")]);
record("app_codesign_verify", "codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
record("app_codesign_details", "codesign", ["-dv", "--verbose=4", appPath]);
record("app_spctl_assessment", "spctl", ["-a", "-vv", "--type", "execute", appPath]);
record("app_xattrs", "xattr", ["-l", appPath]);

if (args.dmg) {
  const dmgPath = path.resolve(args.dmg);
  record("dmg_sha256", "shasum", ["-a", "256", dmgPath]);
  record("dmg_verify", "hdiutil", ["verify", dmgPath], { timeoutMs: 120_000 });
}

const launcherPath = path.join(appPath, "Contents", "Resources", "goatcitadel", "bin", "goatcitadel");
let statusJson = null;
if (fs.existsSync(launcherPath)) {
  const status = record("goatcitadel_status_json", launcherPath, ["status", "--json"], { timeoutMs: 20_000 });
  statusJson = parseJson(status.stdout);
} else {
  notes.push(`Packaged launcher not found at ${launcherPath}`);
}

const gatewayUrl = args.gatewayUrl || statusJson?.gatewayUrl || "http://127.0.0.1:8787";
const uiUrl = args.uiUrl || statusJson?.uiUrl || "http://127.0.0.1:5173";

record("gateway_health", "curl", ["-fsS", `${gatewayUrl}/health`], { timeoutMs: 10_000 });
record("ui_health", "curl", ["-fsS", `${uiUrl}/health`], { timeoutMs: 10_000 });
const sse = record(
  "gateway_sse_stream",
  "curl",
  ["-i", "--max-time", "3", `${gatewayUrl}/api/v1/events/stream?replay=0`],
  {
    timeoutMs: 8_000,
  },
);
const sseReceivedReady = /HTTP\/[0-9.]+ 200 OK/.test(sse.stdout) && /event: stream-ready/.test(sse.stdout);

record("goatcitadel_processes", "pgrep", ["-fl", "GoatCitadel|goatcitadel|mission-control"], { timeoutMs: 10_000 });

const logFiles = logFilesFromStatus(statusJson);
const logSummaries = collectLogTails(logFiles);

const reportPath = path.join(outDir, "macos-desktop-evidence.md");
fs.writeFileSync(reportPath, renderReport({ logFiles, logSummaries, sseReceivedReady, statusJson }), "utf8");

console.log(`Wrote macOS desktop evidence report: ${reportPath}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    }
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (value === "--app") {
      parsed.app = requireValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === "--dmg") {
      parsed.dmg = requireValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === "--out") {
      parsed.out = requireValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === "--gateway-url") {
      parsed.gatewayUrl = requireValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === "--ui-url") {
      parsed.uiUrl = requireValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === "--tail-lines") {
      parsed.tailLines = requireValue(argv, index, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/packaging/collect-macos-desktop-evidence.mjs [options]",
      "",
      "Collects redacted evidence from an already installed/running macOS GoatCitadel desktop app.",
      "It does not launch the app, remove quarantine, approve requests, or mutate runtime state.",
      "",
      "Options:",
      "  --app <path>          App bundle path. Defaults to /Applications/GoatCitadel Mission Control.app",
      "  --dmg <path>          Optional DMG path to checksum and verify",
      "  --out <dir>           Output directory. Defaults to artifacts/macos-desktop-evidence/<timestamp>",
      "  --gateway-url <url>   Gateway URL fallback when status JSON is unavailable",
      "  --ui-url <url>        Mission Control URL fallback when status JSON is unavailable",
      "  --tail-lines <count>  Log tail lines per file. Defaults to 160",
    ].join("\n"),
  );
}

function record(id, command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: options.timeoutMs || 30_000,
  });
  const entry = {
    id,
    command: formatCommand(command, commandArgs),
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: redact(result.stdout || ""),
    stderr: redact(result.stderr || ""),
  };
  commands.push(entry);
  fs.writeFileSync(
    path.join(rawDir, `${id}.txt`),
    [
      `$ ${entry.command}`,
      `status: ${entry.status ?? "n/a"}`,
      entry.signal ? `signal: ${entry.signal}` : "",
      entry.error ? `error: ${entry.error}` : "",
      "",
      "stdout:",
      entry.stdout,
      "",
      "stderr:",
      entry.stderr,
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    "utf8",
  );
  return entry;
}

function parseJson(value) {
  if (!value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    notes.push(`Unable to parse status JSON: ${error.message}`);
    return null;
  }
}

function logFilesFromStatus(statusJson) {
  const files = statusJson?.logFiles || {};
  const statusFiles = Object.values(files).filter((value) => typeof value === "string");
  if (statusFiles.length > 0) {
    return statusFiles;
  }
  return [
    path.join(defaultLogDir, "gateway.stdout.log"),
    path.join(defaultLogDir, "gateway.stderr.log"),
    path.join(defaultLogDir, "mission-control.stdout.log"),
    path.join(defaultLogDir, "mission-control.stderr.log"),
  ];
}

function collectLogTails(logFiles) {
  return logFiles.map((logFile) => {
    if (!fs.existsSync(logFile)) {
      return { path: logFile, exists: false, authTokenWarnings: 0, tailPath: null };
    }
    const content = fs.readFileSync(logFile, "utf8");
    const redacted = redact(tail(content, tailLines));
    const authTokenWarnings = (content.match(/\/api\/v1\/auth\/sse-token/g) || []).length;
    const tailPath = path.join(rawDir, `${safeFileName(path.basename(logFile))}.tail.txt`);
    fs.writeFileSync(tailPath, redacted, "utf8");
    return {
      path: logFile,
      exists: true,
      bytes: Buffer.byteLength(content),
      authTokenWarnings,
      tailPath,
    };
  });
}

function tail(content, lineCount) {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join("\n");
}

function renderReport({ logFiles, logSummaries, sseReceivedReady, statusJson }) {
  const checkedAt = new Date().toISOString();
  const commandRows = commands
    .map((entry) => {
      const outcome = commandOutcome(entry, sseReceivedReady);
      return `| \`${entry.id}\` | ${outcome} | \`${entry.command}\` |`;
    })
    .join("\n");
  const logRows = logSummaries
    .map((log) => {
      const exists = log.exists ? "yes" : "no";
      const bytes = log.exists ? String(log.bytes) : "n/a";
      return `| \`${log.path}\` | ${exists} | ${bytes} | ${log.authTokenWarnings} |`;
    })
    .join("\n");
  const statusExcerpt = statusJson
    ? JSON.stringify(
        {
          status: statusJson.status,
          gatewayUrl: statusJson.gatewayUrl,
          uiUrl: statusJson.uiUrl,
          packaged: statusJson.packaged,
          pids: statusJson.pids,
          desktopEventStream: statusJson.desktopEventStream,
          readiness: statusJson.readiness,
        },
        null,
        2,
      )
    : "Status JSON was not available.";

  return `${[
    "# macOS Desktop Evidence",
    "",
    `Collected: ${checkedAt}`,
    "",
    "This report is intended for PR review when the reviewer does not have a Mac. It records local runtime evidence from an already installed/running macOS desktop app. It does not launch GoatCitadel, remove quarantine, approve requests, or mutate runtime state.",
    "",
    "## App",
    "",
    `- App path: \`${appPath}\``,
    `- Gateway URL checked: \`${gatewayUrl}\``,
    `- UI URL checked: \`${uiUrl}\``,
    `- SSE stream-ready received: \`${sseReceivedReady}\``,
    "",
    "## Packaged Status Excerpt",
    "",
    "```json",
    redact(statusExcerpt),
    "```",
    "",
    "## Command Results",
    "",
    "| Check | Result | Command |",
    "| --- | --- | --- |",
    commandRows,
    "",
    "## Runtime Logs",
    "",
    "| Log file | Exists | Bytes | /auth/sse-token mentions |",
    "| --- | --- | ---: | ---: |",
    logRows,
    "",
    `Raw redacted command output and log tails are under \`${rawDir}\`.`,
    "",
    "## Reviewer Checklist",
    "",
    "- Confirm `codesign --verify` passed for the exact app bundle.",
    "- Treat `spctl` rejection as expected only for ad-hoc, non-notarized experimental builds.",
    "- Confirm gateway and UI health checks pass.",
    "- Confirm packaged status `desktopEventStream.authMode` matches watcher behavior.",
    "- Confirm `/api/v1/events/stream?replay=0` reaches `stream-ready` without requiring an unavailable token in `authMode: none` builds.",
    "- Confirm approval modals are visually present and clickable in the packaged app before treating approval UX as fixed.",
    "",
    notes.length > 0 ? "## Notes" : "",
    ...notes.map((note) => `- ${note}`),
    "",
  ].join("\n")}\n`;
}

function redact(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "<redacted-token>")
    .replace(
      /(("?(?:token|apiKey|api_key|password|secret|authorization)"?\s*[:=]\s*))("[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
      "$1<redacted>",
    );
}

function commandOutcome(entry, sseReceivedReady) {
  if (entry.id === "gateway_sse_stream" && sseReceivedReady) {
    return "pass (stream-ready; curl timeout expected)";
  }
  return entry.status === 0 ? "pass" : `exit ${entry.status ?? "n/a"}`;
}

function formatCommand(command, commandArgs) {
  return [command, ...commandArgs].map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}
