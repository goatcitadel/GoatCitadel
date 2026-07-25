import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const packageDir = path.resolve(currentDir, "..");

rmSync(path.join(packageDir, "dist"), { recursive: true, force: true });

// The build info must go with the outputs. `composite` projects write it beside
// the tsconfig, not into outDir, so removing only `dist` leaves tsc believing
// the project is up to date — it would then emit nothing at all. Clearing both
// is what makes a plain `tsc -b` sufficient here; `tsc -b --force` would also
// rebuild every *referenced* project, which races concurrent sibling builds
// that are reading those shared outputs.
rmSync(path.join(packageDir, "tsconfig.tsbuildinfo"), { force: true });
