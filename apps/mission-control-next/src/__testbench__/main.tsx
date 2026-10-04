import { readTestbenchEnv } from "./env";
import { applyGatewayOriginMeta, resolveTargetRequest } from "./gateway-target/resolve-target";

const PRODUCTION_REFUSAL = "The GoatCitadel test bench is a development tool and does not run in production builds.";

const env = readTestbenchEnv();
const container = document.getElementById("testbench-root");

if (container) {
  if (env.isProd) {
    container.textContent = PRODUCTION_REFUSAL;
  } else {
    const targetRequest = resolveTargetRequest(window.location.search, env);
    // The shared client reads this tag once at module load, so it must exist before the app is imported.
    applyGatewayOriginMeta(document, targetRequest.origin);
    void import("./ui/mount").then(({ mountTestbench }) => mountTestbench(container, targetRequest, env));
  }
}
