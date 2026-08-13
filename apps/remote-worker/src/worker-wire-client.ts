import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { canonicalJsonString } from "@goatcitadel/contracts";

/**
 * The connected worker's native mTLS transport.
 *
 * Every request opens a FRESH TLS 1.3 connection, exports its own keying
 * material, and binds that exporter into the proof it signs, so a captured
 * request can never be replayed on another channel. One connection per request
 * is deliberate: it is exactly what a reconnecting worker does, and it keeps
 * the exporter binding unambiguous.
 *
 * The client owns no authority. It never reads, stores, or derives a
 * credential; the caller supplies the exact `Authorization` header value and a
 * signer callback that receives the channel-bound material.
 */

/** Exporter label/length pinned by the Gateway listener; both sides must agree exactly. */
export const WORKER_TLS_EXPORTER_LABEL = "EXPORTER-GoatCitadel-Remote-Worker-v1";
export const WORKER_TLS_EXPORTER_BYTES = 32;
export const WORKER_WIRE_MAX_RESPONSE_BYTES = 1024 * 1024;
export const WORKER_WIRE_ABSOLUTE_TIMEOUT_MS = 45_000;

export const WORKER_PROTOCOL_HEADERS = Object.freeze({
  authorization: "authorization",
  timestamp: "x-goatcitadel-worker-timestamp",
  nonce: "x-goatcitadel-worker-nonce",
  operation: "x-goatcitadel-worker-operation",
  proof: "x-goatcitadel-worker-proof",
  idempotencyKey: "idempotency-key",
} as const);

export interface WorkerTransportMaterial {
  readonly host: string;
  readonly port: number;
  readonly clientCertificatePem: string;
  readonly clientPrivateKeyPem: string;
  readonly trustAnchorPem: string;
}

/** Channel-bound material handed to the signer once the TLS handshake completes. */
export interface WorkerRequestSigningMaterial {
  readonly rawPath: string;
  readonly operation: string;
  readonly bodySha256: string;
  readonly tlsExporterSha256: string;
  readonly nonce: string;
  readonly timestamp: string;
  readonly idempotencyKey: string;
}

export interface WorkerWireRequest {
  readonly rawPath: string;
  readonly operation: string;
  readonly authorization: string;
  readonly idempotencyKey: string;
  /**
   * Builds the canonical protocol body AFTER the handshake, so bodies that bind
   * the channel (the admission evidence envelope) can commit to this exact
   * connection's exporter.
   */
  readonly buildBody: (channel: {
    readonly tlsExporterSha256: string;
    readonly nonce: string;
    readonly timestamp: string;
  }) => Readonly<Record<string, unknown>>;
  /** Returns the base64url Ed25519 proof over the channel-bound preimage. */
  readonly sign: (material: WorkerRequestSigningMaterial) => string;
  /**
   * Additional transport headers the route requires (route 7 carries the raw
   * mesh join credential out of band so it never enters the signed body). Names
   * must already be lowercase and must be on the listener's allowlist.
   */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly nonce?: string;
  readonly timestamp?: string;
}

export interface WorkerWireResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export class WorkerWireClientError extends Error {
  readonly code = "REMOTE_WORKER_WIRE_CLIENT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "WorkerWireClientError";
  }
}

export interface WorkerTransportIdentityDigests {
  readonly clientCertificateSha256: string;
  readonly publicKeySpkiSha256: string;
  readonly publicKeySpkiBase64Url: string;
  readonly trustAnchorSha256: string;
}

/** Digests of the worker's own transport identity, derived from its PEM material. */
export function workerTransportIdentityDigests(material: WorkerTransportMaterial): WorkerTransportIdentityDigests {
  const certificate = new X509Certificate(material.clientCertificatePem);
  const spkiDer = certificate.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(spkiDer)) throw new WorkerWireClientError("Worker client key is not exportable as DER SPKI.");
  return Object.freeze({
    clientCertificateSha256: sha256(certificate.raw),
    publicKeySpkiSha256: sha256(spkiDer),
    publicKeySpkiBase64Url: spkiDer.toString("base64url"),
    trustAnchorSha256: sha256(new X509Certificate(material.trustAnchorPem).raw),
  });
}

export class WorkerWireClient {
  public constructor(private readonly material: WorkerTransportMaterial) {}

  public identity(): WorkerTransportIdentityDigests {
    return workerTransportIdentityDigests(this.material);
  }

  public async post(request: WorkerWireRequest): Promise<WorkerWireResponse> {
    return await new Promise<WorkerWireResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      let settled = false;
      const socket: TLSSocket = tlsConnect({
        host: this.material.host,
        port: this.material.port,
        cert: this.material.clientCertificatePem,
        key: this.material.clientPrivateKeyPem,
        ca: this.material.trustAnchorPem,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
      });
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (absoluteTimeout) clearTimeout(absoluteTimeout);
        socket.destroy();
        if (error !== undefined) {
          reject(error);
          return;
        }
        try {
          resolve(parseHttpResponse(Buffer.concat(chunks)));
        } catch (parseError) {
          reject(parseError instanceof Error ? parseError : new WorkerWireClientError(String(parseError)));
        }
      };
      const absoluteTimeout = setTimeout(
        () => finish(new WorkerWireClientError("Worker request exceeded its absolute deadline.")),
        WORKER_WIRE_ABSOLUTE_TIMEOUT_MS,
      );
      socket.setTimeout(30_000, () => finish(new WorkerWireClientError("Worker request timed out.")));
      socket.on("data", (chunk: Buffer) => {
        try {
          responseBytes = appendBoundedResponseChunk(chunks, chunk, responseBytes);
        } catch (error) {
          finish(error instanceof Error ? error : new WorkerWireClientError(String(error)));
        }
      });
      socket.once("end", () => finish());
      socket.once("close", () => finish());
      socket.once("error", (error) => finish(error));
      socket.once("secureConnect", () => {
        let exporter: Buffer | undefined;
        try {
          exporter = socket.exportKeyingMaterial(WORKER_TLS_EXPORTER_BYTES, WORKER_TLS_EXPORTER_LABEL, Buffer.alloc(0));
          const tlsExporterSha256 = sha256(exporter);
          const timestamp = request.timestamp ?? new Date().toISOString();
          const nonce = request.nonce ?? randomNonce();
          const encodedBody = Buffer.from(
            canonicalJsonString(request.buildBody({ tlsExporterSha256, nonce, timestamp })),
            "utf8",
          );
          const bodySha256 = sha256(encodedBody);
          const proof = request.sign({
            rawPath: request.rawPath,
            operation: request.operation,
            bodySha256,
            tlsExporterSha256,
            nonce,
            timestamp,
            idempotencyKey: request.idempotencyKey,
          });
          socket.write(
            Buffer.concat([
              Buffer.from(
                requestHead({
                  rawPath: request.rawPath,
                  host: `${this.material.host}:${String(this.material.port)}`,
                  contentLength: encodedBody.byteLength,
                  authorization: request.authorization,
                  idempotencyKey: request.idempotencyKey,
                  timestamp,
                  nonce,
                  operation: request.operation,
                  proof,
                  extraHeaders: request.extraHeaders ?? {},
                }),
                "ascii",
              ),
              encodedBody,
            ]),
          );
        } catch (error) {
          finish(error instanceof Error ? error : new WorkerWireClientError(String(error)));
        } finally {
          exporter?.fill(0);
        }
      });
    });
  }
}

function requestHead(input: {
  readonly rawPath: string;
  readonly host: string;
  readonly contentLength: number;
  readonly authorization: string;
  readonly idempotencyKey: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly operation: string;
  readonly proof: string;
  readonly extraHeaders: Readonly<Record<string, string>>;
}): string {
  return [
    `POST ${input.rawPath} HTTP/1.1`,
    `Host: ${input.host}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${String(input.contentLength)}`,
    `${WORKER_PROTOCOL_HEADERS.authorization}: ${input.authorization}`,
    `${WORKER_PROTOCOL_HEADERS.idempotencyKey}: ${input.idempotencyKey}`,
    `${WORKER_PROTOCOL_HEADERS.timestamp}: ${input.timestamp}`,
    `${WORKER_PROTOCOL_HEADERS.nonce}: ${input.nonce}`,
    `${WORKER_PROTOCOL_HEADERS.operation}: ${input.operation}`,
    `${WORKER_PROTOCOL_HEADERS.proof}: ${input.proof}`,
    ...Object.entries(input.extraHeaders).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
}

function parseHttpResponse(response: Buffer): WorkerWireResponse {
  const headerEnd = response.indexOf("\r\n\r\n");
  if (headerEnd < 1) throw new WorkerWireClientError("Worker response carried no HTTP headers.");
  const head = response.subarray(0, headerEnd).toString("ascii");
  const status = Number(/^HTTP\/1\.1 ([0-9]{3}) /u.exec(head)?.[1]);
  if (!Number.isInteger(status)) throw new WorkerWireClientError("Worker response status was invalid.");
  const raw = response.subarray(headerEnd + 4).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new WorkerWireClientError(`Worker response body was not JSON (status ${String(status)}).`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkerWireClientError("Worker response body was not a JSON object.");
  }
  return Object.freeze({ status, body: Object.freeze(parsed as Record<string, unknown>) });
}

function appendBoundedResponseChunk(chunks: Buffer[], chunk: Buffer, currentBytes: number): number {
  const nextBytes = currentBytes + chunk.byteLength;
  if (!Number.isSafeInteger(nextBytes) || nextBytes > WORKER_WIRE_MAX_RESPONSE_BYTES) {
    throw new WorkerWireClientError("Worker response exceeded the maximum allowed size.");
  }
  chunks.push(Buffer.from(chunk));
  return nextBytes;
}

function randomNonce(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: Buffer | Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
}

export const __internal = {
  appendBoundedResponseChunk,
  parseHttpResponse,
};
