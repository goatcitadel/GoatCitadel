import { pathToFileURL } from "node:url";
import path from "node:path";
import { open } from "node:fs/promises";

const [checkout, state, readyFile] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  ![checkout, state, readyFile].every(path.isAbsolute) ||
  state !== process.env.GOATCITADEL_ROOT_DIR ||
  path.dirname(readyFile) !== state ||
  !process.env.GOATCITADEL_AUTH_TOKEN
)
  throw new Error("Invalid owned acceptance Gateway launch.");
// Normal production constructor; no provider, approval or effect test hooks.
const { buildApp } = await import(pathToFileURL(path.join(checkout, "apps/gateway/dist/app.js")));
const app = await buildApp();
let stopping;
const stop = () =>
  (stopping ??= app.close().finally(() => {
    process.exitCode = 0;
  }));
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const file = await open(readyFile, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ baseUrl: address }));
    await file.sync();
  } finally {
    await file.close();
  }
} catch (error) {
  await app.close();
  throw error;
}
