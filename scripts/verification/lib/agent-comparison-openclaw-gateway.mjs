import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bindNativeComparisonConfig, NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { sha256 } from "./agent-comparison.mjs";

const execute = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else resolve({ stdout, stderr });
    });
    // CLI bootstrap can inspect piped stdin. No input belongs to these fixed
    // argument-only commands, so deliver EOF instead of leaving that pipe open.
    child.stdin?.end();
  });
export const OPENCLAW_APPROVAL_GATEWAY_VERSION = "goatcitadel.agent-comparison.approval-gateway.v1";

export function validateNativeOpenclawDecision(input) {
  if (
    !input ||
    Object.keys(input).some((key) => !["approvalId", "decision"].includes(key)) ||
    !["allow-once", "deny"].includes(input.decision) ||
    typeof input.approvalId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,255}$/u.test(input.approvalId)
  )
    throw new Error("Select an exact native approval and either allow-once or deny.");
}

export async function startNativeOpenclawApprovalReviewer({ control, outputFile, signal, superviseProcess }) {
  const bytes = await readFile(control.configFile);
  if (sha256(JSON.parse(bytes.toString("utf8"))) !== control.configurationSha256)
    throw new Error("The approval reviewer configuration changed.");
  const child = superviseProcess({
    executablePath: control.executablePath,
    args: [
      fileURLToPath(new URL("./agent-comparison-openclaw-reviewer.mjs", import.meta.url)),
      control.checkoutRoot,
      control.configFile,
      createHash("sha256").update(bytes).digest("hex"),
      outputFile,
    ],
    cwd: control.workspace,
    environment: control.environment,
    signal,
  });
  let terminal = false;
  void child.finished.then(() => {
    terminal = true;
  });
  const ready = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  try {
    while (!terminal) {
      ready.throwIfAborted();
      try {
        const bytes = await readFile(outputFile, "utf8");
        const newline = bytes.indexOf("\n");
        if (newline >= 0 && JSON.parse(bytes.slice(0, newline)).kind === "ready" && !terminal) return child;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(100, undefined, { signal: ready });
    }
    throw new Error("The native approval reviewer stopped before becoming ready.");
  } catch (error) {
    await child.stop("reviewer_setup_failed");
    throw error;
  }
}

/** Only the product's native approval owner may decide a pending request. This
 * command adapter never invents an approval or installs a standing grant. */
export async function callNativeOpenclawApproval(control, action, input = {}, signal) {
  if (
    control.schemaVersion !== OPENCLAW_APPROVAL_GATEWAY_VERSION ||
    control.revision !== NATIVE_COMPARISON_PINS.openclaw ||
    !["pending", "resolve"].includes(action) ||
    !Number.isInteger(control.port) ||
    control.port < 1024 ||
    control.port > 65535 ||
    ![control.executablePath, control.checkoutRoot, control.configFile, control.workspace].every(path.isAbsolute)
  )
    throw new Error("Invalid supervised native approval control.");
  const config = await readComparisonJson(control.configFile);
  if (
    sha256(config) !== control.configurationSha256 ||
    config.gateway?.port !== control.port ||
    config.gateway?.bind !== "loopback" ||
    config.gateway?.mode !== "local"
  )
    throw new Error("The reviewed approval Gateway configuration changed.");
  // The pinned approvals CLI has no --port option. Its exact config supplies the
  // local target; no ambient URL or alternate personal Gateway is selected.
  const args = [path.join(control.checkoutRoot, "openclaw.mjs"), "approvals", action, "--timeout", "4000", "--json"];
  if (action === "resolve") {
    validateNativeOpenclawDecision(input);
    args.push(input.approvalId, input.decision);
  }
  const redact = (value) =>
    String(value)
      .replaceAll(config.gateway.auth.token, "[approval gateway token]")
      .replaceAll(config.models.providers.comparison.apiKey, "[supervised proxy token]");
  try {
    const result = await execute(control.executablePath, args, {
      cwd: control.workspace,
      env: { ...control.environment, OPENCLAW_CONFIG_PATH: control.configFile },
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      signal,
    });
    return JSON.parse(redact(result.stdout));
  } catch (error) {
    // execFile errors can carry raw command output. Keep only bounded, redacted
    // diagnostics, including when the native CLI fails after a decision.
    // eslint-disable-next-line preserve-caught-error -- Raw transport causes can contain credentials; retain only the redacted diagnostic.
    throw new Error(`Native approval ${action} failed: ${redact(error.stderr || error.message).slice(-2000)}`);
  }
}

/** Start only a fresh, source-pinned approval Gateway. Its token is independent
 * of the model proxy. The returned handle owns the one process it started. */
export async function startNativeOpenclawApprovalGateway({
  plan,
  connection,
  workspace,
  configFile,
  environment,
  checkoutRoot,
  executablePath,
  signal,
  superviseProcess,
}) {
  if (plan.product !== "openclaw" || plan.revision !== NATIVE_COMPARISON_PINS.openclaw || plan.approvalGateway !== true)
    throw new Error("Review an OpenClaw launch with an approval Gateway before starting it.");
  signal?.throwIfAborted();
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  let child,
    terminal = false,
    readinessError = "";
  const token = randomBytes(32).toString("hex");
  const port = reservation.address().port;
  const redact = (value) =>
    value.replaceAll(token, "[approval gateway token]").replaceAll(connection.apiKey, "[supervised proxy token]");
  try {
    const config = bindNativeComparisonConfig(plan, connection, workspace, { port, token });
    const handle = await open(configFile, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const gatewayEnvironment = {
      ...environment,
      OPENCLAW_CONFIG_PATH: configFile,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_DISABLE_BONJOUR: "1",
    };
    await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    signal?.throwIfAborted();
    child = superviseProcess({
      executablePath,
      args: [path.join(checkoutRoot, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"],
      cwd: workspace,
      environment: gatewayEnvironment,
      signal,
    });
    void child.finished.then(() => {
      terminal = true;
    });
    const control = {
      schemaVersion: OPENCLAW_APPROVAL_GATEWAY_VERSION,
      revision: plan.revision,
      port,
      configFile,
      configurationSha256: sha256(config),
      workspace,
      checkoutRoot,
      executablePath,
      environment: gatewayEnvironment,
    };
    const ready = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    while (!terminal) {
      ready.throwIfAborted();
      try {
        const pending = await callNativeOpenclawApproval(control, "pending", {}, ready);
        if (terminal) break;
        if (!Array.isArray(pending.approvals) || pending.approvals.length !== 0)
          throw new Error("The fresh approval Gateway did not start with an empty queue.");
        return {
          control,
          redact,
          finished: child.finished,
          stop: child.stop,
          environment: gatewayEnvironment,
          evidence: {
            schemaVersion: OPENCLAW_APPROVAL_GATEWAY_VERSION,
            revision: plan.revision,
            nativeProfileSha256: plan.planSha256,
            port,
            ready: true,
            initialPendingApprovals: 0,
            authority: "native_operator_cli",
            automaticApprovals: false,
          },
        };
      } catch (error) {
        readinessError = (
          readinessError +
          "\n" +
          redact(
            JSON.stringify({
              message: error.message,
              stderr: error.stderr,
              stdout: error.stdout,
              code: error.code,
              signal: error.signal,
            }),
          )
        ).slice(-3000);
        if (terminal) break;
        await delay(200, undefined, { signal: ready });
      }
    }
    const result = await child.finished;
    throw new Error(`The isolated approval Gateway stopped before readiness: ${redact(result.stderr).slice(-1500)}`);
  } catch (error) {
    await child?.stop("approval_gateway_setup_failed");
    if (child) {
      const result = await child.finished;
      // eslint-disable-next-line preserve-caught-error -- Startup output and nested native causes can contain ephemeral credentials.
      throw new Error(
        `The isolated approval Gateway was not ready: ${readinessError}; ${redact(result.stdout + result.stderr).slice(-3500)}`,
      );
    }
    throw error;
  } finally {
    if (reservation.listening) await new Promise((resolve) => reservation.close(resolve));
  }
}
