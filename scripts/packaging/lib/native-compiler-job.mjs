import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const source = path.join(import.meta.dirname, "NativeCompilerJob.cs");
const bridge = path.join(import.meta.dirname, "native-compiler-job.ps1");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function plain(file, directory = false, singleLink = true) {
  const stat = fs.lstatSync(file);
  assert(directory ? stat.isDirectory() : stat.isFile());
  assert(!stat.isSymbolicLink() && same(fs.realpathSync.native(file), file));
  if (!directory && singleLink) assert.equal(stat.nlink, 1);
  return stat;
}
function failure(code, ownership = {}, stdout = "", stderr = "") {
  return {
    status: null,
    signal: null,
    stdout,
    stderr,
    error: Object.assign(new Error("Owned native compiler invocation failed."), { code }),
    ownership,
  };
}
let callerIdentity;
function caller(powerShell, env, remaining) {
  if (callerIdentity) return callerIdentity;
  // Numeric PID and fixed script only. No environment values, paths or compiler
  // arguments are interpolated into a shell expression.
  const script =
    "[Console]::OutputEncoding=New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false;$p=[Diagnostics.Process]::GetProcessById(" +
    process.pid +
    ");try{@{pid=$p.Id;creation=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();image=$p.MainModule.FileName}|ConvertTo-Json -Compress}finally{$p.Dispose()}";
  const result = spawnSync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env,
    windowsHide: true,
    encoding: "utf8",
    timeout: Math.max(1, Math.min(5000, remaining)),
    maxBuffer: 8192,
  });
  if (result.error || result.status !== 0)
    throw Object.assign(new Error("Caller identity query failed."), {
      code: result.error?.code ?? "ECOMPILERBOOTSTRAP",
    });
  const identity = JSON.parse(result.stdout.replace(/^\uFEFF/u, "").trim());
  assert.equal(identity.pid, process.pid);
  assert.match(identity.creation, /^[0-9]{16,20}$/u);
  assert(same(identity.image, process.execPath));
  callerIdentity = identity;
  return identity;
}

/** Packaging-only synchronous compiler lifecycle; caller supplies a closed env. */
export function runOwnedWindowsCompilerSync(command, args, options) {
  assert.equal(process.platform, "win32");
  assert(path.isAbsolute(command) && Array.isArray(args) && args.length <= 1024);
  assert(args.every((arg) => typeof arg === "string" && !/[\0\r\n]/u.test(arg)));
  assert(options && options.windowsHide === true && options.encoding === "utf8");
  assert(Number.isInteger(options.timeout) && options.timeout > 0 && options.timeout <= 600000);
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  assert(Number.isInteger(maxBuffer) && maxBuffer > 0 && maxBuffer <= 8 * 1024 * 1024);
  const deadlineUnixMs = Date.now() + options.timeout;
  const scratch = path.resolve(options.scratch),
    cwd = path.resolve(options.cwd);
  plain(scratch, true);
  plain(cwd, true);
  assert(options.env && Object.getPrototypeOf(options.env) === Object.prototype);
  const environment = { ...options.env };
  assert(
    Object.keys(environment).length <= 128 &&
      Object.entries(environment).every(
        ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof value === "string" && !value.includes("\0"),
      ),
  );
  assert(typeof environment.SystemRoot === "string" && path.isAbsolute(environment.SystemRoot));
  const powerShell = path.join(environment.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  // Windows-serviced system executables legitimately have WinSxS hardlinks.
  // Request/result/helper files retain the single-link requirement.
  plain(powerShell, false, false);
  plain(source);
  plain(bridge);
  const sourceSha256 = hash(fs.readFileSync(source)),
    bridgeSha256 = hash(fs.readFileSync(bridge));
  const bootstrapEnv = {
    SystemRoot: environment.SystemRoot,
    TEMP: scratch,
    TMP: scratch,
    PSModuleAnalysisCachePath: path.join(scratch, "powershell-module-analysis-cache"),
  };
  let identity;
  try {
    identity = caller(powerShell, bootstrapEnv, deadlineUnixMs - Date.now());
  } catch (error) {
    return failure(error?.code ?? "ECOMPILERBOOTSTRAP", { bootstrapInsideCompilerJob: false });
  }
  const nonce = randomBytes(8).toString("hex");
  const requestPath = path.join(scratch, "native-compiler-request-" + process.pid + "-" + nonce + ".json");
  const resultPath = path.join(scratch, "native-compiler-result-" + process.pid + "-" + nonce + ".json");
  const request = {
    command,
    arguments: args,
    cwd,
    environment,
    resultPath,
    sourceSha256,
    callerPid: identity.pid,
    callerCreation: identity.creation,
    callerImage: identity.image,
    deadlineUnixMs,
    maxBuffer,
  };
  const bytes = Buffer.from(JSON.stringify(request));
  assert(bytes.length <= 1024 * 1024);
  fs.writeFileSync(requestPath, bytes, { flag: "wx" });
  const requestIdentity = fs.lstatSync(requestPath);
  try {
    const remaining = Math.max(1, deadlineUnixMs - Date.now());
    // Execution deadline is enforced inside the retained-HANDLE supervisor.
    // The additional bound is teardown only, not more compiler execution time.
    const child = spawnSync(
      powerShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bridge, "-RequestPath", requestPath],
      {
        cwd,
        env: bootstrapEnv,
        windowsHide: true,
        detached: false,
        encoding: "utf8",
        timeout: remaining + 7000,
        maxBuffer: 65536,
      },
    );
    assert.equal(hash(fs.readFileSync(source)), sourceSha256);
    assert.equal(hash(fs.readFileSync(bridge)), bridgeSha256);
    if (!fs.existsSync(resultPath))
      return failure(child.error?.code ?? "ECOMPILERBOOTSTRAP", { bootstrapInsideCompilerJob: false, jobEmpty: false });
    const stat = plain(resultPath);
    assert(stat.size <= Math.ceil((maxBuffer * 8) / 3) + 65536);
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert(
      typeof result.JobEmpty === "boolean" &&
        typeof result.RootExited === "boolean" &&
        typeof result.AtomicMembership === "boolean",
    );
    assert(typeof result.StdoutBase64 === "string" && typeof result.StderrBase64 === "string");
    const stdout = Buffer.from(result.StdoutBase64, "base64"),
      stderr = Buffer.from(result.StderrBase64, "base64");
    assert(stdout.length <= maxBuffer && stderr.length <= maxBuffer);
    const ownership = {
      jobEmpty: result.JobEmpty,
      rootExited: result.RootExited,
      rootExitCode: result.ExitCode,
      atomicMembership: result.AtomicMembership,
      descendantsRetired: result.DescendantsRetired,
      callerVerified: result.CallerVerified,
      invocationErrorCode: result.ErrorCode || null,
      deadline: result.Deadline,
      parentExited: result.ParentExited,
      bootstrapComplete: result.BootstrapComplete,
      bootstrapInsideCompilerJob: false,
    };
    const code = !result.JobEmpty ? "ECOMPILERCLEANUP" : result.ErrorCode || child.error?.code;
    if (code) return failure(code, ownership, stdout.toString("utf8"), stderr.toString("utf8"));
    if (
      !result.RootExited ||
      !result.AtomicMembership ||
      !result.CallerVerified ||
      child.status !== 0 ||
      !Number.isInteger(result.ExitCode)
    )
      return failure("ECOMPILEROWNER", ownership, stdout.toString("utf8"), stderr.toString("utf8"));
    return {
      status: result.ExitCode,
      signal: null,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      ownership,
    };
  } catch {
    return failure("ECOMPILEROWNER", { bootstrapInsideCompilerJob: false, jobEmpty: false });
  } finally {
    // Request remains on parent death for diagnosis. Never delete a replaced file.
    const current = fs.lstatSync(requestPath);
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === requestIdentity.dev &&
      current.ino === requestIdentity.ino
    )
      fs.unlinkSync(requestPath);
  }
}
