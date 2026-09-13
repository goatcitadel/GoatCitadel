import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  constants,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RemoteWorkerAdmissionRepository,
  RemoteWorkerAssignmentRepository,
  RemoteWorkerMeshNodeAdmissionRepository,
  RemoteWorkerNonceRepository,
  createDatabase,
} from "@goatcitadel/storage";
import { expect, it } from "vitest";
import { encodeWindowsTlsKeyIdentifier } from "../../../remote-worker-provisioner/src/windows-tls-key-identifier.js";
import { portOf, seedBootstrap, sha256, tlsConfig } from "../../test/fixtures/remote-worker-native.js";
import { createGatewayRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-composition.js";
import { createGatewayRemoteWorkerAssignmentRuntimeComposition } from "./remote-worker-assignment-runtime-composition.js";
import { startRemoteWorkerNativeTlsListener } from "./remote-worker-native-tls-listener.js";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const nativeInputPath = process.env.GOATCITADEL_NATIVE_TLS_ACCEPTANCE_INPUT;

function stageWorker(root: string, native: { engine: string; guardAddon: string }): string {
  const bundle = join(root, "worker-bundle");
  const worker = join(repositoryRoot, "apps/remote-worker");
  mkdirSync(join(bundle, "native"), { recursive: true });
  cpSync(join(worker, "dist"), join(bundle, "dist"), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => !basename(source).includes(".test"),
  });
  for (const image of [native.engine, native.guardAddon])
    copyFileSync(image, join(bundle, "native", basename(image)), constants.COPYFILE_EXCL);
  writeFileSync(join(bundle, "package.json"), JSON.stringify({ type: "module", private: true }), { flag: "wx" });
  // Fixture dependency links exercise built main; this is not a portable installer.
  symlinkSync(join(worker, "node_modules"), join(bundle, "node_modules"), "junction");
  return bundle;
}

async function runPublicKeyWorker(input: {
  readonly bundle: string;
  readonly nodeExecutable?: string;
  readonly launcher?: string;
  readonly caFile: string;
  readonly certFile: string;
  readonly identifierFile: string;
  readonly port: number;
  readonly ticket: Readonly<Record<string, unknown>>;
  readonly stateDir: string;
  readonly runId: string;
  readonly stopAfter: string;
}) {
  const ticketFile = join(dirname(input.stateDir), `${input.runId}-ticket.json`);
  const reportFile = join(dirname(input.stateDir), `${input.runId}-report.json`);
  expect(input.ticket).not.toHaveProperty("protectedSignerPrivateKeyPem");
  expect(JSON.stringify(input.ticket)).not.toContain("PRIVATE KEY");
  writeFileSync(ticketFile, JSON.stringify(input.ticket), { flag: "wx" });
  const command = input.launcher
    ? join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
    : (input.nodeExecutable ?? process.execPath);
  const args = input.launcher
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", input.launcher]
    : [join(input.bundle, "dist/main.js")];
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: input.bundle,
    env: {
      SystemRoot: process.env.SystemRoot,
      ...(input.launcher ? { NODE_OPTIONS: "--invalid-goatcitadel-fixture-option", NODE_PATH: repositoryRoot } : {}),
      GOATCITADEL_TLS_TEST_CANARY: "fixture-parent-only",
      GOATCITADEL_CONNECTED_WORKER_HOST: "127.0.0.1",
      GOATCITADEL_CONNECTED_WORKER_PORT: String(input.port),
      GOATCITADEL_CONNECTED_WORKER_CLIENT_CERT_FILE: input.certFile,
      GOATCITADEL_CONNECTED_WORKER_CA_FILE: input.caFile,
      GOATCITADEL_CONNECTED_WORKER_PROTECTED_KEY_FILE: input.identifierFile,
      GOATCITADEL_CONNECTED_WORKER_TICKET_FILE: ticketFile,
      GOATCITADEL_CONNECTED_WORKER_STATE_DIR: input.stateDir,
      GOATCITADEL_CONNECTED_WORKER_REPORT_FILE: reportFile,
      GOATCITADEL_CONNECTED_WORKER_RUN_ID: input.runId,
      GOATCITADEL_CONNECTED_WORKER_STOP_AFTER: input.stopAfter,
    },
  });
  const closed = once(child, "close");
  const timeout = setTimeout(() => child.kill(), 20000);
  let stderr = "";
  child.stdout!.on("data", () => undefined);
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4096) child.kill();
  });
  try {
    const [code, signal] = await closed;
    expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
    expect(report.outcome).not.toBe("failed");
    return report;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed;
    }
  }
}

it.runIf(process.platform === "win32" && nativeInputPath !== undefined)(
  "admits and reconnects the normal built worker with a guarded public key reference through canonical Gateway owners",
  async () => {
    const native = JSON.parse(readFileSync(nativeInputPath!, "utf8")) as {
      engine: string;
      guardAddon: string;
      workerPackageRoot?: string;
      helperExecutablePath: string;
      helperExecutableSha256: string;
      workerPublicKeySpkiBase64Url: string;
    };
    const root = mkdtempSync(join(dirname(nativeInputPath!), "gateway-worker-"));
    const bundle = native.workerPackageRoot ? join(native.workerPackageRoot, "app/worker") : stageWorker(root, native);
    const tls = await tlsConfig(root);
    const db = createDatabase({ dbPath: join(root, "gateway.sqlite") });
    let listener: Awaited<ReturnType<typeof startRemoteWorkerNativeTlsListener>> | undefined;
    try {
      const bootstrap = seedBootstrap(db, tls, Buffer.from(native.workerPublicKeySpkiBase64Url, "base64url"), "");
      const { protectedSignerPrivateKeyPem: _unused, ...publicTicket } = bootstrap.ticket;
      const ticket = { ...publicTicket, protectedSignerPublicKeySpkiBase64Url: native.workerPublicKeySpkiBase64Url };
      const identifier = encodeWindowsTlsKeyIdentifier({
        keysetGeneration: Number(ticket.targetWorkerGeneration),
        stateSha256: sha256("protected-worker-fixture-state"),
        keysetReceiptSha256: String(ticket.keysetReceiptSha256),
        workerPublicKeySpkiBase64Url: native.workerPublicKeySpkiBase64Url,
        helperExecutablePath: native.helperExecutablePath,
        helperExecutableSha256: native.helperExecutableSha256,
      });
      const identifierFile = join(root, "protected-key.txt");
      writeFileSync(identifierFile, identifier, { flag: "wx" });
      const admissions = new RemoteWorkerAdmissionRepository(db);
      const meshAdmissions = new RemoteWorkerMeshNodeAdmissionRepository(db);
      const assignments = new RemoteWorkerAssignmentRepository(db);
      const runtime = createGatewayRemoteWorkerAssignmentRuntimeComposition({
        admissionStore: admissions,
        meshAdmissions,
        assignments,
        nonceConsumer: new RemoteWorkerNonceRepository(db),
      });
      const handler = await createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: tls.config,
        admissionStore: admissions,
        meshNodeAdmissionStore: meshAdmissions,
        assignmentProtocol: runtime.assignmentProtocol,
        assignmentDispatch: runtime.assignmentDispatch,
        assignmentExecution: {
          assertAvailable: async () => undefined,
          execute: async () => {
            throw new Error("This fixture does not offer execution work.");
          },
        },
        createEvidenceVerifier: () => new RemoteWorkerProtectedAdmissionEvidenceVerifier(),
      });
      if (!handler) throw new Error("Protected worker fixture composition is unavailable.");
      const requests: Array<{
        path: string;
        schemaVersion: unknown;
        authorizationScheme: string | undefined;
        status: number;
      }> = [];
      listener = await startRemoteWorkerNativeTlsListener(tls.config, async (request) => {
        const schemaVersion: unknown = JSON.parse(request.bodyBytes.toString("utf8")).schemaVersion;
        const response = await handler(request);
        requests.push({
          path: request.rawPath,
          schemaVersion,
          authorizationScheme: request.headers.authorization?.split(" ")[0],
          status: response.statusCode,
        });
        return response;
      });
      const common = {
        bundle,
        ...(native.workerPackageRoot
          ? {
              nodeExecutable: join(native.workerPackageRoot, "app/runtime/node.exe"),
              launcher: join(native.workerPackageRoot, "bin/worker.ps1"),
            }
          : {}),
        caFile: tls.paths.ca,
        certFile: tls.paths.clientCert,
        identifierFile,
        port: portOf(listener.address),
        ticket,
        stateDir: join(root, "worker-state"),
      };
      const admitted = await runPublicKeyWorker({ ...common, runId: "admit", stopAfter: "admit" });
      expect(admitted.admitted).toBe("bootstrap_exchange");
      const credentialPath = join(common.stateDir, "runtime-credential.json");
      const credentialBeforeRestart = readFileSync(credentialPath, "utf8");
      const retained = JSON.parse(credentialBeforeRestart) as Record<string, unknown>;
      expect(retained).not.toHaveProperty("signingPrivateKeyPem");
      expect(credentialBeforeRestart).not.toContain("PRIVATE KEY");
      expect(credentialBeforeRestart).not.toContain(bootstrap.bootstrapSecret);
      expect(retained.protectedKey).toMatchObject({ kind: "windows_provisioner", keysetGeneration: 1 });
      const restarted = await runPublicKeyWorker({
        ...common,
        ticket: { ...ticket, bootstrapSecret: "already-consumed" },
        runId: "restart",
        stopAfter: "complete",
      });
      expect(restarted).toMatchObject({ admitted: "retained_credential", awaiting: "assignment_offer" });
      expect(readFileSync(credentialPath, "utf8")).toBe(credentialBeforeRestart);
      expect(requests).toEqual([
        {
          path: "/api/v1/remote-workers/bootstrap-exchanges",
          schemaVersion: "goatcitadel.remote-worker-pop.v2",
          authorizationScheme: "GoatWorkerBootstrap",
          status: 201,
        },
        {
          path: "/api/v1/remote-workers/assignment-offer-polls",
          schemaVersion: "goatcitadel.remote-worker-pop.v2",
          authorizationScheme: "Bearer",
          status: 200,
        },
      ]);
      expect(admissions.findCurrentGeneration("default", String(ticket.workerId))).toMatchObject({
        workerGeneration: 1,
      });
      expect(admissions.findProtectedAdmissionEvidenceRecord("default", String(ticket.workerId), 1)).toBeDefined();
      writeFileSync(
        join(root, "acceptance.json"),
        JSON.stringify(
          {
            requests,
            admitted: admitted.admitted,
            restarted: restarted.admitted,
            retainedPrivateKey: false,
            entrypoint: "normal built main.js; fixed package-relative native guard",
            packaging: native.workerPackageRoot
              ? "copied portable package with embedded Node; no installer proof"
              : "test-only staged bundle with workspace dependency junction; no installer proof",
            signer: "synthetic native helper; authenticated installed service not tested",
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    } finally {
      await listener?.close();
      db.close();
    }
  },
  60000,
);
