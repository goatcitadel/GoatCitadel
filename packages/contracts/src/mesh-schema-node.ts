import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { canonicalJsonString } from "./canonical-json.js";
import type { MeshCapabilityDescriptor } from "./mesh-capability-publication.js";

const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_VALUE_BYTES = 512 * 1024;
const VALIDATION_TIMEOUT_MS = 5_000;
const MAX_VALIDATIONS = 4;
const require = createRequire(import.meta.url);
let activeValidations = 0;

/** Content-free: neither schema fragments, values nor validator diagnostics leave the worker. */
export class MeshSchemaValidationError extends Error {
  constructor(readonly reason: "invalid" | "unavailable") {
    super("Mesh capability schema validation " + reason + ".");
    this.name = "MeshSchemaValidationError";
  }
}

// Compilation and regex evaluation can both be expensive. Keep them off the
// Gateway/worker event loop, bound the isolate, and join termination on every
// exit. This is resource containment for schema validation, not a code sandbox.
// Module paths are resolved from this installed package, never from a schema.
const VALIDATOR_SOURCE = [
  'const { parentPort, workerData } = require("node:worker_threads");',
  'function bounded(value, maxNodes) {',
  '  const pending = [[value, 0]]; let nodes = 0;',
  '  while (pending.length) {',
  '    const [item, depth] = pending.pop();',
  '    if (++nodes > maxNodes || depth > 32) throw new Error();',
  '    if (item === null || typeof item !== "object") continue;',
  '    for (const child of Object.values(item)) pending.push([child, depth + 1]);',
  '  }',
  '}',
  'function offlineSchemas(root) {',
  '  const pending = [root];',
  '  while (pending.length) {',
  '    const schema = pending.pop();',
  '    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;',
  '    if (Object.hasOwn(schema, "$async")) throw new Error();',
  '    for (const key of ["$ref", "$dynamicRef", "$recursiveRef"])',
  '      if (Object.hasOwn(schema, key) && (typeof schema[key] !== "string" || !schema[key].startsWith("#"))) throw new Error();',
  '    for (const key of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"])',
  '      if (schema[key] && typeof schema[key] === "object") pending.push(...Object.values(schema[key]));',
  '    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"])',
  '      if (Array.isArray(schema[key])) pending.push(...schema[key]);',
  '    for (const key of ["items", "additionalProperties", "unevaluatedItems", "unevaluatedProperties",',
  '      "propertyNames", "contains", "not", "if", "then", "else", "contentSchema"]) pending.push(schema[key]);',
  '  }',
  '}',
  'try {',
  '  const schema = JSON.parse(workerData.schemaJson);',
  '  const value = JSON.parse(workerData.valueJson);',
  '  if (!schema || typeof schema !== "object" || Array.isArray(schema) ||',
  '    (schema.$schema !== undefined && schema.$schema !== "https://json-schema.org/draft/2020-12/schema")) throw new Error();',
  '  bounded(schema, 10000); bounded(value, 100000); offlineSchemas(schema);',
  '  const Ajv = require(workerData.ajvModule).default;',
  '  const formats = require(workerData.formatsModule).default;',
  '  const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, strictRequired: false,',
  '    allErrors: false, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false,',
  '    logger: false, loopRequired: 32, loopEnum: 32, code: { optimize: false } });',
  '  formats(ajv);',
  '  const validate = ajv.compile(schema);',
  '  parentPort.postMessage(validate(value) === true);',
  '} catch { parentPort.postMessage(false); }',
].join("\n");

/** JSON strings preserve approved bytes and cannot execute getters while crossing into the isolate. */
export async function validateMeshCapabilityJson(schemaJson: string, valueJson: string, signal?: AbortSignal): Promise<void> {
  if (typeof schemaJson !== "string" || typeof valueJson !== "string" ||
    schemaJson.length > MAX_SCHEMA_BYTES || valueJson.length > MAX_VALUE_BYTES ||
    Buffer.byteLength(schemaJson, "utf8") > MAX_SCHEMA_BYTES || Buffer.byteLength(valueJson, "utf8") > MAX_VALUE_BYTES)
    throw new MeshSchemaValidationError("invalid");
  if (signal?.aborted || activeValidations >= MAX_VALIDATIONS) throw new MeshSchemaValidationError("unavailable");
  const startedAt = performance.now();
  activeValidations += 1;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let failure: MeshSchemaValidationError | undefined;
  try {
    worker = new Worker(VALIDATOR_SOURCE, {
      eval: true,
      execArgv: [],
      argv: [],
      env: {},
      stdout: true,
      stderr: true,
      workerData: { schemaJson, valueJson, ajvModule: require.resolve("ajv/dist/2020.js"),
        formatsModule: require.resolve("ajv-formats") },
      resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const current = worker;
    const valid = await new Promise<boolean>((resolve, reject) => {
      const unavailable = () => reject(new MeshSchemaValidationError("unavailable"));
      current.once("message", (result: unknown) => resolve(result === true));
      current.once("error", unavailable);
      current.once("exit", unavailable);
      timer = setTimeout(unavailable, VALIDATION_TIMEOUT_MS);
      onAbort = unavailable;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) unavailable();
    });
    if (!valid) throw new MeshSchemaValidationError("invalid");
  } catch (error) {
    failure = error instanceof MeshSchemaValidationError ? error : new MeshSchemaValidationError("unavailable");
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    try { await worker?.terminate(); }
    catch { failure = new MeshSchemaValidationError("unavailable"); }
    finally { activeValidations -= 1; }
  }
  if (failure) throw failure;
  if (signal?.aborted || performance.now() - startedAt >= VALIDATION_TIMEOUT_MS)
    throw new MeshSchemaValidationError("unavailable");
}

/** MCP manifests bind selector names and schema digests; the native owner must validate the selected tool's schema. */
export async function validateMeshCapabilityInput(
  descriptor: MeshCapabilityDescriptor, inputJson: string, signal?: AbortSignal,
): Promise<void> {
  if (descriptor.kind === "skill") throw new MeshSchemaValidationError("invalid");
  const schema = descriptor.kind === "tool" ? descriptor.inputSchema : {
    type: "object",
    properties: { toolName: { type: "string", enum: descriptor.tools.map((tool) => tool.name) },
      arguments: { type: "object" } },
    required: ["toolName", "arguments"],
    additionalProperties: false,
  };
  await validateMeshCapabilityJson(canonicalJsonString(schema), inputJson, signal);
}

export async function validateMeshCapabilityOutput(
  descriptor: MeshCapabilityDescriptor, outputJson: string, signal?: AbortSignal,
): Promise<void> {
  if (descriptor.kind === "skill") throw new MeshSchemaValidationError("invalid");
  // No output schema is published for an MCP server. Do not invent one from a digest.
  if (descriptor.kind === "tool")
    await validateMeshCapabilityJson(canonicalJsonString(descriptor.outputSchema), outputJson, signal);
}
