import { execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
} from "@goatcitadel/contracts";
import { RemoteWorkerAdmissionRepository, type DatabaseClient } from "@goatcitadel/storage";
import type { EnabledRemoteWorkerRuntimeConfig } from "../../src/services/remote-worker-runtime-config.js";

// Public, non-secret test fixtures generated solely for the HX-501 loopback proof.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBeDCCASqgAwIBAgIUZTNs1ByBlRL7pMZAVAYlyN0teqowBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowKDEmMCQGA1UEAwwdR29hdENpdGFkZWwgSFg1
MDEgTGlzdGVuZXIgQ0EwKjAFBgMrZXADIQBSjxcD22J7+xt6LJu4UnOJKaXZhTtc
DNUL0Sc17UIySqNmMGQwHQYDVR0OBBYEFKNuM5RciNLBA4yMy9gbSZJl/TMRMB8G
A1UdIwQYMBaAFKNuM5RciNLBA4yMy9gbSZJl/TMRMBIGA1UdEwEB/wQIMAYBAf8C
AQAwDgYDVR0PAQH/BAQDAgEGMAUGAytlcANBAMQ+p3my9NrSqOm0fF+C0va6qSbw
k9WLzL7qJnU+N2nTjrbotBwiGwx8I9BlDhVNZSY/w3qSBm0+vxWL3+qrvw4=
-----END CERTIFICATE-----
`;
const SERVER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCCAUOgAwIBAgIUMFqWz4nhKmOp4ZrcncR9oaEoiB4wBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MCowBQYD
K2VwAyEApw4nkG7WgBmO2bN73r98GKsDjA9bngBJLAI1WBISBXyjgZIwgY8wGgYD
VR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/
BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBSZDRm2hCmy2yT3
1vE/ppFeanKi0zAfBgNVHSMEGDAWgBSjbjOUXIjSwQOMjMvYG0mSZf0zETAFBgMr
ZXADQQD1b9ZjFapMTW6dOndRfXTl6Md06NKtSLgQFmwCxc3UaAy1VWQESaosmrRO
9Hf/jfKiVRt4jgexXOuD67sB0BoH
-----END CERTIFICATE-----
`;
const SERVER_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB81SweGGRtBMfQh+I7Wo37pzfi5OH82CMinGgKsCCWQ
-----END PRIVATE KEY-----
`;
const CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBdTCCASegAwIBAgIUMFqWz4nhKmOp4ZrcncR9oaEoiB8wBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowFjEUMBIGA1UEAwwLd29ya2VyLXRlc3QwKjAF
BgMrZXADIQD2T1jzXgcwp1PO5oB4g11yGDpKYg0rJ9UJHurdPyLLA6N1MHMwDAYD
VR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwIw
HQYDVR0OBBYEFCu/5nk7wPmPf105JYKUIoPMY3NuMB8GA1UdIwQYMBaAFKNuM5Rc
iNLBA4yMy9gbSZJl/TMRMAUGAytlcANBAPpVSsCZqAookqSqgB3fZnpH59824/M3
4wkMWAKzgxgJIFP7uq0mJDI7UqXoQyjdWVcACP+8igEU/xboG1WNMQU=
-----END CERTIFICATE-----
`;
const CLIENT_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIP7oQh0GClRqd2Tb5kfT1Cbdc78LOylrcLyeqYoBNyo1
-----END PRIVATE KEY-----
`;

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const workerEntry = join(repoRoot, "apps", "remote-worker", "src", "main.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

export function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
}

export function portOf(address: string | undefined): number {
  const port = Number(address?.slice((address.lastIndexOf(":") ?? -1) + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error("Listener did not expose a bound port.");
  return port;
}

/**
 * Write the loopback trust material and lock the directory to this operator, as
 * the listener's own no-follow trust loader requires on Windows.
 */
export async function tlsConfig(root: string): Promise<{
  readonly config: EnabledRemoteWorkerRuntimeConfig;
  readonly manifestSignerKeyId: string;
  readonly signManifestPayload: (payload: object) => string;
  readonly paths: Readonly<Record<"cert" | "key" | "ca" | "signer" | "clientCert" | "clientKey", string>>;
}> {
  const systemRoot = process.env.SystemRoot as string;
  const { stdout } = await execFileAsync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[0-9-]+)"/u.exec(stdout)?.[1];
  if (sid === undefined) throw new Error("Unable to resolve the Windows test operator SID.");
  await execFileAsync(join(systemRoot, "System32", "icacls.exe"), [
    root,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
  const paths = Object.freeze({
    cert: join(root, "server.crt"),
    key: join(root, "server.key"),
    ca: join(root, "client-ca.crt"),
    signer: join(root, "signer.pub"),
    clientCert: join(root, "client.crt"),
    clientKey: join(root, "client.key"),
  });
  const manifestSigner = generateKeyPairSync("ed25519");
  const signerSpkiDer = manifestSigner.publicKey.export({ format: "der", type: "spki" });
  const signerPublicPem = manifestSigner.publicKey.export({ format: "pem", type: "spki" });
  if (!Buffer.isBuffer(signerSpkiDer) || typeof signerPublicPem !== "string") {
    throw new Error("Unable to create the connected-worker manifest signer fixture.");
  }
  writeFileSync(paths.cert, SERVER_CERT_PEM, "utf8");
  writeFileSync(paths.key, SERVER_KEY_PEM, "utf8");
  writeFileSync(paths.ca, CA_PEM, "utf8");
  writeFileSync(paths.signer, signerPublicPem, "utf8");
  writeFileSync(paths.clientCert, CLIENT_CERT_PEM, "utf8");
  writeFileSync(paths.clientKey, CLIENT_KEY_PEM, "utf8");
  return {
    paths,
    manifestSignerKeyId: "connected-worker-e2e",
    signManifestPayload: (payload) =>
      sign(null, Buffer.from(canonicalJsonString(payload), "utf8"), manifestSigner.privateKey).toString("base64url"),
    config: Object.freeze({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      tls: Object.freeze({
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: true,
        serverCertificateFile: paths.cert,
        serverKeyFile: paths.key,
        clientCaFile: paths.ca,
        clientCaSha256: sha256(new X509Certificate(CA_PEM).raw),
      }),
      manifestSigner: Object.freeze({
        keyId: "connected-worker-e2e",
        publicKeyFile: paths.signer,
        spkiSha256: sha256(signerSpkiDer),
      }),
      bootstrapTtlSeconds: 600,
      credentialTtlSeconds: 900,
    }),
  };
}

interface HarnessBootstrap {
  readonly bootstrapSecret: string;
  readonly ticket: Record<string, unknown>;
}

/**
 * Create the bootstrap record an operator would provision, pinned to a real
 * protected admission signer. The single-host harness holds that signer key as
 * a PEM (production keeps it in the platform's protected key store); everything
 * else — the manifest signature, the ceilings, the TLS identity — is real.
 */
export function seedBootstrap(
  db: DatabaseClient,
  tls: Awaited<ReturnType<typeof tlsConfig>>,
  evidenceSignerSpkiDer: Buffer,
  evidenceSignerPrivateKeyPem: string,
  execution = false,
  governedTools = false,
): HarnessBootstrap {
  const runtimePayload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: sha256("connected-worker-bundle"),
    dependencyLockSha256: sha256("connected-worker-lock"),
    vendorTreeSha256: sha256("connected-worker-vendor"),
    launcherSha256: sha256("connected-worker-launcher"),
    installedTreeManifestSha256: sha256("connected-worker-tree"),
    installedTreeFileCount: 7,
    platform: "windows",
    architecture: "x64",
  } as const;
  const runtimeManifest = {
    payload: runtimePayload,
    payloadSha256: sha256(canonicalJsonString(runtimePayload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: tls.manifestSignerKeyId,
    signatureBase64Url: tls.signManifestPayload(runtimePayload),
  } as const;
  const keysetReceiptSha256 = sha256("connected-worker-keyset-receipt");
  const bootstrapSecret = randomBytes(32).toString("base64url");
  const bootstrap = new RemoteWorkerAdmissionRepository(db).createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: "Connected worker",
    platform: "windows",
    architecture: "x64",
    runtimeManifest,
    allowedWorkspaceIds: ["default"],
    capabilityClasses: execution
      ? ["artifact_stage", "durable_compute", "gateway_inference", ...(governedTools ? ["governed_tool" as const] : [])]
      : ["durable_compute", "gateway_inference"],
    protectedAdmissionSignerPin: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
      signatureAlgorithm: "ed25519",
      keysetGeneration: 1,
      keysetReceiptSha256,
      signerSpkiSha256: sha256(evidenceSignerSpkiDer),
      signerSpkiBase64Url: evidenceSignerSpkiDer.toString("base64url"),
    },
    expiresInSeconds: 600,
    createdByActorId: "operator-a",
    idempotencyKey: "bootstrap:connected-worker",
    bootstrapSecretSha256: sha256(bootstrapSecret),
  }).record;
  return {
    bootstrapSecret,
    ticket: {
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      executionWorkspaceId: "default",
      bootstrapId: bootstrap.bootstrapId,
      workerId: bootstrap.workerId,
      nodeId: bootstrap.nodeId,
      targetWorkerGeneration: bootstrap.targetWorkerGeneration,
      platform: bootstrap.platform,
      architecture: bootstrap.architecture,
      runtimeManifestSha256: sha256(canonicalJsonString(bootstrap.runtimeManifest)),
      runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
      workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
      keysetReceiptSha256,
      protectedSignerPrivateKeyPem: evidenceSignerPrivateKeyPem,
      bootstrapSecret,
      downloadVerificationReceiptSha256: sha256("connected-worker-download-receipt"),
      installedTreeAttestationSha256: sha256("connected-worker-installed-tree"),
      installedTreeVerificationReceiptSha256: sha256("connected-worker-installed-receipt"),
    },
  };
}

interface WorkerRun {
  readonly report: Record<string, unknown>;
  readonly exitCode: number | null;
  readonly stderr: string;
}

/** Copy built stock JS into an isolated fixture beside its fixed native images. */
export async function prepareStockWorkerWithNativeFiles(root: string): Promise<string> {
  const worker = join(root, "stock-worker");
  await mkdir(worker);
  await cp(join(repoRoot, "apps", "remote-worker", "dist"), join(worker, "dist"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(join(worker, "package.json"), JSON.stringify({ type: "module" }), { flag: "wx" });
  await symlink(join(repoRoot, "apps", "remote-worker", "node_modules"), join(worker, "node_modules"), "junction");
  await execFileAsync(
    process.execPath,
    [
      join(repoRoot, "scripts", "packaging", "build-remote-worker-windows-tls.mjs"),
      "--target",
      "windows-x64",
      "--output-dir",
      join(worker, "native"),
    ],
    { windowsHide: true, timeout: 180_000 },
  );
  return join(worker, "dist", "main.js");
}

export async function runWorkerProcess(input: {
  readonly root: string;
  readonly port: number;
  readonly paths: Readonly<Record<string, string>>;
  readonly ticketFile: string;
  readonly stateDir: string;
  readonly runId: string;
  readonly stopAfter: string;
  readonly executionMode?: "gateway_inference" | "protocol_probe";
  readonly runMode?: "once" | "continuous";
  /** Controlled destination owner used only by the full mesh Chat proof. */
  readonly meshManifestFile?: string;
  /** Real stock destination tools, loaded from built worker output. */
  readonly meshRegistry?: { readonly file: string; readonly sha256: string };
  /** Isolated stock copy with freshly built native images; test composition only. */
  readonly stockWorkerEntrypoint?: string;
  /** Stop this exact child after it has published the requested retained state. */
  readonly stopWhenReport?: (report: Readonly<Record<string, unknown>>) => boolean;
}): Promise<WorkerRun> {
  const reportFile = join(input.root, `report-${input.runId}.json`);
  const entry = input.meshManifestFile
    ? fileURLToPath(new URL("./mesh-destination-worker.ts", import.meta.url))
    : workerEntry;
  const launch = input.meshRegistry
    ? [input.stockWorkerEntrypoint ?? join(repoRoot, "apps", "remote-worker", "dist", "main.js")]
    : [tsxCli, entry];
  const child = spawn(process.execPath, launch, {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GOATCITADEL_CONNECTED_WORKER_HOST: "127.0.0.1",
      GOATCITADEL_CONNECTED_WORKER_PORT: String(input.port),
      GOATCITADEL_CONNECTED_WORKER_CLIENT_CERT_FILE: input.paths.clientCert!,
      GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE: input.paths.clientKey!,
      GOATCITADEL_CONNECTED_WORKER_CA_FILE: input.paths.ca!,
      GOATCITADEL_CONNECTED_WORKER_TICKET_FILE: input.ticketFile,
      GOATCITADEL_CONNECTED_WORKER_STATE_DIR: input.stateDir,
      GOATCITADEL_CONNECTED_WORKER_REPORT_FILE: reportFile,
      GOATCITADEL_CONNECTED_WORKER_RUN_ID: input.runId,
      GOATCITADEL_CONNECTED_WORKER_STOP_AFTER: input.stopAfter,
      GOATCITADEL_CONNECTED_WORKER_EXECUTION_MODE: input.executionMode ?? "protocol_probe",
      GOATCITADEL_CONNECTED_WORKER_RUN_MODE: input.runMode ?? "once",
      ...(input.meshRegistry
        ? {
            GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_FILE: input.meshRegistry.file,
            GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_SHA256: input.meshRegistry.sha256,
          }
        : {}),
      ...(input.meshManifestFile
        ? {
            GOATCITADEL_TEST_MESH_MANIFEST_FILE: input.meshManifestFile,
            GOATCITADEL_TEST_MESH_EFFECT_FILE: join(dirname(input.meshManifestFile), "mesh-effect.jsonl"),
          }
        : {}),
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdout.on("data", () => undefined);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const reportPoll = input.stopWhenReport
      ? setInterval(() => {
          let report: Record<string, unknown>;
          try {
            report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
          } catch {
            return; // Atomic publication has not happened yet.
          }
          if (input.stopWhenReport!(report)) child.kill("SIGKILL");
        }, 50)
      : undefined;
    const timer = setTimeout(() => {
      clearInterval(reportPoll);
      child.kill("SIGKILL");
      reject(new Error(`Connected worker run ${input.runId} exceeded its budget.`));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearInterval(reportPoll);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearInterval(reportPoll);
      resolve(code);
    });
  });
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
  } catch {
    report = { outcome: "missing_report" };
  }
  return { report, exitCode, stderr };
}
