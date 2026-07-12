import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  assertArchitectureMetricsCaptureClean,
  compareArchitectureMetrics,
  countDependencyMemberAccesses,
  countHostMemberAccesses,
  createArchitectureMetricsBaseline,
  validateArchitectureMetricsBaseline,
} from "./architecture-metrics.mjs";

const architectureBaselineFixture = JSON.parse(
  fs.readFileSync(new URL("../baselines/architecture-metrics.json", import.meta.url), "utf8"),
);

test("host callback metric counts typed host member access and ignores lexical lookalikes", () => {
  const source = String.raw`
    interface DemoHost {
      storage: unknown;
      invoke(): void;
    }

    class Runtime {
      constructor(private readonly host: DemoHost) {}

      run(hosts: string[], url: URL) {
        // host.commentOnly must not count.
        const text = "host.stringOnly";
        const trimmed = hosts.map((host) => host.trim());
        const hostname = url.host;
        this.host.invoke();
        return { text, trimmed, hostname };
      }
    }

    function read(host: DemoHost) {
      return host.storage;
    }
  `;

  assert.equal(countHostMemberAccesses(source, "runtime.ts"), 2);
});

test("host callback metric counts destructuring, string element access, and const aliases", () => {
  const source = String.raw`
    interface DemoHost {
      storage: unknown;
      invoke(): void;
      publish(): void;
    }

    class Runtime {
      constructor(private readonly host: DemoHost) {}

      run() {
        const runtime = this.host;
        const chainedRuntime = runtime;
        const bracketRuntime = this["host"];
        const { storage, publish: publishResult } = chainedRuntime;
        runtime.invoke();
        chainedRuntime["publish"]();
        bracketRuntime.invoke();
        this["host"].storage;
        this["host"]["publish"]();
        this.host["storage"];
        return { storage, publishResult };
      }
    }

    function read(host: DemoHost) {
      const runtime = host;
      const { storage, invoke: call } = host;
      runtime["invoke"]();
      host["storage"];
      return { storage, call };
    }
  `;

  assert.equal(countHostMemberAccesses(source, "runtime.ts"), 12);
  assert.equal(countDependencyMemberAccesses(source, "runtime.ts"), 12);
});

test("host callback metric counts mutable aliases and dynamic elements but rejects shadowed lookalikes", () => {
  const source = String.raw`
    interface DemoHost {
      storage: unknown;
    }

    function read(host: DemoHost, key: string) {
      let mutableRuntime = host;
      mutableRuntime.storage;
      host[key];

      const runtime = host;
      {
        const runtime = { storage: "shadowed" };
        runtime.storage;
      }

      const unrelated = { storage: "local" };
      unrelated.storage;
      return runtime.storage;
    }

    function lexical(host: string) {
      const runtime = host;
      return runtime.length;
    }
  `;

  assert.equal(countHostMemberAccesses(source, "runtime.ts"), 3);
});

test("dependency metrics count typed destructured parameters including nested member traversal", () => {
  const source = String.raw`
    interface NestedHost {
      storage: { read(): void };
      publish(): void;
    }

    interface DemoDeps {
      read(): void;
      write(): void;
    }

    function runHost({ storage: { read }, publish }: NestedHost) {
      read();
      publish();
    }

    const runDeps = ({ read, write }: DemoDeps) => {
      read();
      write();
    };

    function assignHost(host: NestedHost) {
      let read;
      let publish;
      ({ storage: { read }, publish } = host);
      read();
      publish();
    }
  `;

  assert.equal(countHostMemberAccesses(source, "runtime.ts"), 6);
  assert.equal(countDependencyMemberAccesses(source, "runtime.ts"), 8);
});

test("dependency metric counts conventionally named containers and dependency-shaped members", () => {
  const source = String.raw`
    interface StoragePort {
      read(): void;
    }

    interface EffectDependencies {
      storage: StoragePort;
      publish(): void;
    }

    interface RuntimeCompositionInput {
      storage: StoragePort;
      publish(): void;
    }

    class Runtime {
      constructor(private readonly deps: EffectDependencies) {}

      run() {
        this.deps.storage;
        this.deps.publish();
        const alias = this.deps;
        alias.publish();
        const { storage, publish } = alias;
        let assigned;
        assigned = alias;
        assigned.publish();
        return { storage, publish };
      }
    }

    function compose(input: RuntimeCompositionInput) {
      input.storage;
      input.publish();
      const alias = input;
      alias.publish();
      let assigned;
      assigned = input;
      return assigned.storage;
    }
  `;

  assert.equal(countHostMemberAccesses(source, "runtime.ts"), 0);
  assert.equal(countDependencyMemberAccesses(source, "runtime.ts"), 10);
});

test("dependency metric rejects domain inputs, primitive hosts, URL.host, and inferred shadow bags", () => {
  const source = String.raw`
    interface DomainInput {
      effect: string;
      validate(): boolean;
      mergePatch(): void;
    }

    interface Wiring {
      read(): void;
      write(): void;
    }

    interface UserReview {
      rating: number;
      comment: string;
      summarize(): string;
    }

    interface PaymentProvider {
      id: string;
      label: string;
    }

    interface GeneratedService {
      id: string;
      tags: string[];
    }

    interface ClientRecord {
      id: string;
      displayName: string;
    }

    function execute(input: DomainInput) {
      input.effect;
      input.validate();
      input.mergePatch();
    }

    function executeUnconventionalContainer(ctx: Wiring) {
      ctx.read();
      ctx.write();
    }

    function inspectDomain(review: UserReview, provider: PaymentProvider) {
      return [review.rating, review.comment, review.summarize(), provider.id, provider.label];
    }

    function inspectCatalog(service: GeneratedService, client: ClientRecord) {
      return [service.id, service.tags, client.id, client.displayName];
    }

    function lexical(host: string) {
      host.length;
    }

    function shadowed() {
      const deps = {
        storage: "local",
        publish() {},
      };
      deps.storage;
      deps.publish();
    }

    declare const url: URL;
    url.host;
  `;

  assert.equal(countDependencyMemberAccesses(source, "runtime.ts"), 0);
});

test("dependency metric counts unresolved imported ports and direct storage or service roots", () => {
  const source = String.raw`
    import type { ExternalPort, Storage, WorkerService } from "./external.js";

    function run(port: ExternalPort, storage: Storage, service: WorkerService) {
      port.invoke();
      storage.read();
      service.execute();
    }
  `;

  assert.equal(countHostMemberAccesses(source, "runtime.ts"), 0);
  assert.equal(countDependencyMemberAccesses(source, "runtime.ts"), 3);
});

test("dependency metric unwraps utility and indexed-access types without classifying domain summaries", () => {
  const source = String.raw`
    interface TraceRepository {
      get(): void;
    }

    interface Storage {
      read(): void;
      chatTurnTraces: TraceRepository;
    }

    interface WorkerService {
      execute(): void;
    }

    interface LlmProviderSummary {
      providerId: string;
      label: string;
    }

    type NarrowStorage = Pick<Storage, "read">;

    function run(
      ctx: Pick<Storage, "read">,
      narrow: NarrowStorage,
      wrapped: Readonly<WorkerService>,
      repository: Pick<Storage["chatTurnTraces"], "get">,
      provider: Pick<LlmProviderSummary, "providerId" | "label">,
    ) {
      ctx.read();
      narrow.read();
      wrapped.execute();
      repository.get();
      provider.providerId;
      provider.label;
    }
  `;

  assert.equal(countDependencyMemberAccesses(source, "runtime.ts"), 4);
});

test("architecture comparison rejects offsetting host callback shifts between services", () => {
  const baseline = {
    ...structuredClone(architectureBaselineFixture),
    totalHostCallbacks: 10,
    hostCallbacksByFile: {
      "apps/gateway/src/services/alpha-service.ts": 5,
      "apps/gateway/src/services/beta-service.ts": 5,
    },
    totalDependencyMemberAccesses: 10,
    dependencyMemberAccessesByFile: {
      "apps/gateway/src/services/alpha-service.ts": 5,
      "apps/gateway/src/services/beta-service.ts": 5,
    },
    settingsHostCallbackCount: 0,
    chatHostCallbackCount: 0,
  };
  const metrics = {
    ...baseline,
    largeServiceDebt: [],
    hostCallbacksByFile: {
      "apps/gateway/src/services/alpha-service.ts": 6,
      "apps/gateway/src/services/beta-service.ts": 4,
    },
    dependencyMemberAccessesByFile: {
      "apps/gateway/src/services/alpha-service.ts": 6,
      "apps/gateway/src/services/beta-service.ts": 4,
    },
  };

  const comparison = compareArchitectureMetrics(metrics, baseline);

  assert.equal(comparison.status, "failed");
  assert.ok(
    comparison.regressions.includes(
      "Extracted-service typed host callbacks increased in apps/gateway/src/services/alpha-service.ts from 5 to 6",
    ),
  );
  assert.ok(
    comparison.improvements.includes(
      "Extracted-service typed host callbacks decreased in apps/gateway/src/services/beta-service.ts from 5 to 4",
    ),
  );
  assert.ok(
    comparison.regressions.includes(
      "Extracted-service typed dependency member accesses increased in apps/gateway/src/services/alpha-service.ts from 5 to 6",
    ),
  );
});

test("architecture baseline validation fails closed on missing, null, or forged guard truth", () => {
  assert.doesNotThrow(() => validateArchitectureMetricsBaseline(structuredClone(architectureBaselineFixture)));

  const cases = [
    {
      label: "missing schema",
      mutate: (baseline) => delete baseline.schemaVersion,
      expected: /schemaVersion must be 1/i,
    },
    {
      label: "null guarded scalar",
      mutate: (baseline) => {
        baseline.gatewayLineCount = null;
      },
      expected: /gatewayLineCount must be a non-negative safe integer/i,
    },
    {
      label: "forged revision",
      mutate: (baseline) => {
        baseline.dependencyMemberSourceRevision = "deadbeef";
      },
      expected: /full lowercase Git revision/i,
    },
    {
      label: "forged map total",
      mutate: (baseline) => {
        baseline.totalHostCallbacks += 1;
      },
      expected: /does not match its derived total/i,
    },
    {
      label: "negative map entry",
      mutate: (baseline) => {
        baseline.hostCallbacksByFile["apps/gateway/src/services/forged.ts"] = -1;
      },
      expected: /must be a non-negative safe integer/i,
    },
  ];

  for (const testCase of cases) {
    const baseline = structuredClone(architectureBaselineFixture);
    testCase.mutate(baseline);
    assert.throws(() => validateArchitectureMetricsBaseline(baseline), testCase.expected, testCase.label);
  }
});

test("architecture baseline capture refuses dirty measured source and binds clean metrics to a revision", () => {
  assert.doesNotThrow(() => assertArchitectureMetricsCaptureClean(""));
  assert.throws(
    () => assertArchitectureMetricsCaptureClean(" M apps/gateway/src/services/gateway-service.ts\0"),
    /refuses to snapshot dirty measured source/i,
  );

  const metrics = structuredClone(architectureBaselineFixture);
  delete metrics.schemaVersion;
  delete metrics.hostCallbackCollectorCorrectedAt;
  delete metrics.hostCallbackSourceRevision;
  delete metrics.dependencyMemberCollectorCapturedAt;
  delete metrics.dependencyMemberSourceRevision;
  const sourceRevision = "a".repeat(40);
  const baseline = createArchitectureMetricsBaseline(metrics, sourceRevision);

  assert.equal(baseline.hostCallbackSourceRevision, sourceRevision);
  assert.equal(baseline.dependencyMemberSourceRevision, sourceRevision);
  assert.equal(baseline.gatewayLineCount, metrics.gatewayLineCount);
  assert.doesNotThrow(() => validateArchitectureMetricsBaseline(baseline));
  assert.throws(() => createArchitectureMetricsBaseline(metrics, "deadbeef"), /full lowercase Git revision/i);
});
