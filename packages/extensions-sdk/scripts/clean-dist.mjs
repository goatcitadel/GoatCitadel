import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const packageDir = path.resolve(currentDir, "..");

rmSync(path.join(packageDir, "dist"), { recursive: true, force: true });
