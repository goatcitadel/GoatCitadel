import { isDeepStrictEqual } from "node:util";

// Exact reviewed schema-runtime graph. Its upstream package manifests declare
// ranges and one optional peer; packaging resolves only these pinned versions.
// Other packages retain the existing exact-dependency/no-peer policy.
const schemaRuntime = {
  ajv: {
    version: "8.20.0",
    dependencies: { "fast-deep-equal": "^3.1.3", "fast-uri": "^3.0.1",
      "json-schema-traverse": "^1.0.0", "require-from-string": "^2.0.2" },
    resolved: { "fast-deep-equal": "3.1.3", "fast-uri": "3.1.5",
      "json-schema-traverse": "1.0.0", "require-from-string": "2.0.2" },
  },
  "ajv-formats": {
    version: "3.0.1",
    dependencies: { ajv: "^8.0.0" },
    resolved: { ajv: "8.20.0" },
    peerDependencies: { ajv: "^8.0.0" },
    peerDependenciesMeta: { ajv: { optional: true } },
  },
  "fast-deep-equal": { version: "3.1.3", dependencies: {}, resolved: {} },
  "fast-uri": { version: "3.1.5", dependencies: {}, resolved: {} },
  "json-schema-traverse": { version: "1.0.0", dependencies: {}, resolved: {} },
  "require-from-string": { version: "2.0.2", dependencies: {}, resolved: {} },
};

export function resolveWorkerDependencyPins(metadata) {
  const reviewed = Object.hasOwn(schemaRuntime, metadata.name) ? schemaRuntime[metadata.name] : undefined;
  if (Object.keys(metadata.optionalDependencies ?? {}).length ||
    (!reviewed && (Object.keys(metadata.peerDependencies ?? {}).length || Object.keys(metadata.peerDependenciesMeta ?? {}).length)))
    throw new Error("Worker package optional/peer dependencies require an explicit packaging policy.");
  if (!reviewed) return {};
  if (metadata.version !== reviewed.version ||
    !isDeepStrictEqual(metadata.dependencies ?? {}, reviewed.dependencies) ||
    !isDeepStrictEqual(metadata.peerDependencies ?? {}, reviewed.peerDependencies ?? {}) ||
    !isDeepStrictEqual(metadata.peerDependenciesMeta ?? {}, reviewed.peerDependenciesMeta ?? {}))
    throw new Error("Worker schema runtime dependency metadata differs from its reviewed graph.");
  return Object.freeze({ ...reviewed.resolved });
}
