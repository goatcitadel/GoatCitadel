import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const generator = `
const { buildPackagedSqliteSchemaReference } = await import(process.argv[1]);
process.stdout.write(JSON.stringify(buildPackagedSqliteSchemaReference()));
`;

export function stageSqliteSchemaReference(gatewayDirectory, nodeExecutable) {
  const gatewayRoot = fs.realpathSync(gatewayDirectory);
  const storage = path.join(gatewayRoot, "node_modules", "@goatcitadel", "storage", "dist");
  const referenceDirectory = path.join(storage, "sqlite");
  if (!fs.existsSync(path.join(referenceDirectory, "schema-reference.js"))) return false;
  const sqliteModule = path.join(storage, "sqlite.js");
  if (fs.realpathSync(referenceDirectory) !== referenceDirectory || fs.realpathSync(sqliteModule) !== sqliteModule) {
    throw new Error("SQLite schema generator and reference directory must be in the staged bundle.");
  }

  const result = spawnSync(nodeExecutable, ["--input-type=module", "--eval", generator, pathToFileURL(sqliteModule).href], {
    cwd: gatewayRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^NODE_(?:OPTIONS|PATH)$/iu.test(key))),
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Staged SQLite schema reference generation failed.", { cause: result.error ?? result.stderr.trim() });
  }
  const reference = JSON.parse(result.stdout);
  if (!Array.isArray(reference?.shape?.entries) || reference.shape.entries.length === 0 ||
      !/^[a-f0-9]{64}$/u.test(reference.compatibilityKey) || !/^[a-f0-9]{64}$/u.test(reference.shapeSha256)) {
    throw new Error("Staged SQLite schema reference generation returned an invalid reference.");
  }
  fs.writeFileSync(path.join(referenceDirectory, "packaged-schema-reference.json"), result.stdout + "\n", { flag: "wx" });
  return true;
}
