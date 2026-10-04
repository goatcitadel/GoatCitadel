import {
  fetchCapabilityCatalog,
  fetchCapabilityCatalogDriftMetrics,
} from "@goatcitadel/mission-control-shared/api/capabilities";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";

const INACTIVE_KINDS: ReadonlySet<string> = new Set(["candidate_skill", "proposal"]);

export const capabilityChecks: readonly CheckDef[] = [
  {
    id: "capabilities.callable-invariants",
    kind: "journey",
    domain: "capabilities",
    title: "Callable catalog invariants",
    tier: "read",
    routes: ["GET /api/v1/capabilities/catalog", "GET /api/v1/capabilities/catalog-metrics"],
    steps: ["Read callable catalog", "Read inspectable catalog", "Read drift metrics"],
    async run(ctx) {
      const callable = await ctx.step("Read callable catalog", () => fetchCapabilityCatalog("callable"));
      const inspectable = await ctx.step("Read inspectable catalog", () => fetchCapabilityCatalog("inspectable"));
      const metrics = await ctx.step("Read drift metrics", () => fetchCapabilityCatalogDriftMetrics());
      const notCallable = callable.items.filter((item) => item.callable !== true).map((item) => item.capabilityId);
      ensure(
        notCallable.length === 0,
        `The callable catalog lists entries marked not callable: ${notCallable.join(", ")}.`,
        notCallable,
      );
      const inactive = callable.items.filter((item) => INACTIVE_KINDS.has(item.kind)).map((item) => item.capabilityId);
      ensure(inactive.length === 0, `Inactive candidates or proposals are callable: ${inactive.join(", ")}.`, inactive);
      const inspectableIds = new Set(inspectable.items.map((item) => item.capabilityId));
      const orphans = callable.items
        .filter((item) => !inspectableIds.has(item.capabilityId))
        .map((item) => item.capabilityId);
      ensure(
        orphans.length === 0,
        `Callable entries are missing from the inspectable catalog: ${orphans.join(", ")}.`,
        orphans,
      );
      ensure(
        metrics.callableSubsetValid,
        "The drift metrics report the callable catalog is not a valid subset.",
        metrics,
      );
      ensure(
        metrics.orphanCallableCapabilityIds.length === 0,
        "The drift metrics report orphan callable capabilities.",
        metrics,
      );
      return pass(
        `${callable.items.length} callable of ${inspectable.items.length} inspectable; no inactive entry is callable.`,
      );
    },
  },
];
