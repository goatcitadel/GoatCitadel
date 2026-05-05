process.env.GOATCITADEL_ROOT_DIR = "F:/tmp/smoke-poke/root";
process.env.GOATCITADEL_AUTH_MODE = "none";
process.env.GOATCITADEL_DISABLE_SECRET_STORE = "true";
process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY = "true";
import { buildApp } from "./src/app.js";

interface PreparedDatabase {
  prepare: (query: string) => { all: () => unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPreparedDatabase(value: unknown): value is PreparedDatabase {
  return isRecord(value) && typeof value.prepare === "function";
}

function findDb(obj: unknown, depth = 0, path = ""): { obj: PreparedDatabase; path: string } | null {
  if (!isRecord(obj) || depth > 4) {
    return null;
  }
  if (isPreparedDatabase(obj)) {
    return { obj, path };
  }
  for (const [key, child] of Object.entries(obj)) {
    if (isRecord(child)) {
      const found = findDb(child, depth + 1, `${path}.${key}`);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

const app = await buildApp();
try {
  // The DB is in services.gateway.context (typical fastify decoration on services with .context)
  const services = (app as { services?: unknown }).services;
  const found = findDb(services);
  console.log("db at path:", found?.path);
  if (found) {
    const db = found.obj;
    try {
      const cols = db
        .prepare(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_session_prefs' ORDER BY ordinal_position",
        )
        .all();
      console.log("chat_session_prefs columns:", JSON.stringify(cols));
    } catch (e) {
      console.log("info_schema err:", String(e));
    }
    try {
      const migs = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
      console.log("applied migrations:", JSON.stringify(migs));
    } catch (e) {
      console.log("migrations err:", String(e));
    }
  }
} finally {
  await app.close();
}
