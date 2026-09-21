import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const emptyState = '4cad2cc2e9d8a6b7373cb4e752c9cd94c25003edd4c55a4350d58ad4bc5d8238';
const hex = value => Buffer.from(value).toString('hex');
function save(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

// The prepared request survives uncertain completion. This launcher never retries it.
export async function createFirstKeyset({ api, client, output, ready }) {
  fs.mkdirSync(output); // fixed one-use directory: existing evidence must be reconciled
  let previousPid = await ready();
  const before = await api.inspectWindowsProtectedService(client);
  if (before.custodyPosture !== 'empty' || before.activeGeneration !== 0n ||
      before.highestBurnedGeneration !== 0n || before.committedGenerationCount !== 0 ||
      hex(before.stateSha256) !== emptyState) throw Error('Custody differs from the verified empty state. Stop.');
  const operationId = randomBytes(16);
  save(path.join(output, 'prepared-request.json'), {
    operationId: hex(operationId), expectedStateSha256: emptyState,
    requestedGeneration: '1', predecessorGeneration: '0',
  });
  previousPid = await ready(previousPid);
  const result = await api.createWindowsProtectedKeyset(client, {
    operationId, expectedStateSha256: Buffer.from(emptyState, 'hex'),
    requestedGeneration: 1n, predecessorGeneration: 0n,
  });
  const report = { disposition: result.disposition };
  for (const name of ['operationId', 'expectedStateSha256', 'observedStateSha256',
    'resultingStateSha256', 'keysetReceiptSha256', 'runtimeManifestSpkiSha256',
    'admissionEvidenceSpkiSha256', 'runtimeManifestSpki', 'admissionEvidenceSpki']) {
    report[name] = hex(result[name]);
  }
  report.requestedGeneration = String(result.requestedGeneration);
  report.predecessorGeneration = String(result.predecessorGeneration);
  save(path.join(output, 'creation-result.json'), report);
  if (result.disposition !== 'created') throw Error('Key creation did not return created. Preserve the receipt.');
  await ready(previousPid);
  const after = await api.inspectWindowsProtectedService(client);
  if (after.activeGeneration !== 1n || after.committedGenerationCount !== 1 ||
      hex(after.activeKeysetReceiptSha256) !== report.keysetReceiptSha256 ||
      hex(after.stateSha256) !== report.resultingStateSha256 ||
      hex(after.runtimeManifestSpki) !== report.runtimeManifestSpki ||
      hex(after.admissionEvidenceSpki) !== report.admissionEvidenceSpki) {
    throw Error('Post-creation inspection mismatch. Preserve all evidence; do not retry.');
  }
  const verified = { ...report, inspectionPassed: true, custodyPosture: after.custodyPosture };
  save(path.join(output, 'verified-public-keyset.json'), verified);
  return verified;
}

async function ready(previousPid) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const query = name => execFileSync('C:\\Windows\\System32\\sc.exe', ['queryex', name],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const broker = query('GoatCitadelRemoteWorkerProvisionerAvailability');
    if (!/STATE\s*:\s*4\s+RUNNING/u.test(broker)) throw Error('Availability broker is not running. Stop.');
    const signer = query('GoatCitadelRemoteWorkerProvisioner');
    const pid = Number(signer.match(/PID\s*:\s*(\d+)/u)?.[1]);
    if (/STATE\s*:\s*4\s+RUNNING/u.test(signer) && pid > 0 && pid !== previousPid) return pid;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('No fresh running signer appeared within 20 seconds. Do not retry creation.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.env.COMPUTERNAME !== 'GOATBOX') throw Error('GOATBOX only.');
    const api = await import('file:///C:/worker-candidates/client-token-fixed/payload/app/worker/node_modules/@goatcitadel/remote-worker-provisioner/dist/windows-service-client.js');
    const report = await createFirstKeyset({ api, ready,
      client: 'C:\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\GoatCitadelRemoteWorkerProvisionerClient.exe',
      output: 'C:\\worker-evidence\\first-protected-keyset-v1',
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ passed: false, message: error.message, clientExitCode: error.result?.exitCode }));
    process.exitCode = 1;
  }
}
