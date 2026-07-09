import assert from "node:assert/strict";
import { test } from "node:test";
import { countHostMemberAccesses } from "./architecture-metrics.mjs";

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
