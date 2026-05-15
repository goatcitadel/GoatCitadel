import { runSmoke } from "./smoke.js";

// c8 instrumentation can push the prompt-pack smoke path past the generic smoke timeout on Windows.
process.env.GOATCITADEL_SMOKE_STEP_TIMEOUT_MS ??= "120000";

await runSmoke();
