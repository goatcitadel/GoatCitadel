import type { CheckDef } from "../runner/types";
import { healthChecks } from "./health";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [...healthChecks];
