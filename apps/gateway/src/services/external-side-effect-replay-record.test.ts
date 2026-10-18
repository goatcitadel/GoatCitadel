import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createExternalSideEffectReplayKeyResolver,
  createExternalSideEffectReplayRecords,
  resolveExternalSideEffectReplayKey,
  sharedExternalSideEffectReplayKeyResolver,
  sharedExternalSideEffectReplayKeyResolverOrThrow,
} from "./external-side-effect-replay-record.js";

function createRuns() {
  const records = new Map<string, string>();
  return {
    records,
    attachReplayRecord(runId: string, json: string): boolean {
      if (records.has(runId)) {
        return false;
      }
      records.set(runId, json);
      return true;
    },
    getReplayRecord(runId: string): string | undefined {
      return records.get(runId);
    },
  };
}

describe("external-side-effect replay records", () => {
  const key = randomBytes(32);

  it("round-trips a sealed payload for the same run", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => key, runs });
    const payload = { to: "a@example.com", nested: { n: 1 } };
    expect(await records.seal({ runId: "run-1", payloadHash: "hash-1", payload })).toBe(true);
    expect(runs.records.get("run-1")).not.toContain("a@example.com");
    expect(await records.open({ runId: "run-1", payloadHash: "hash-1" })).toEqual({ payload });
  });

  it("refuses a tampered ciphertext", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => key, runs });
    await records.seal({ runId: "run-1", payloadHash: "hash-1", payload: { a: 1 } });
    const parsed = JSON.parse(runs.records.get("run-1") as string);
    const bytes = Buffer.from(parsed.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    runs.records.set("run-1", JSON.stringify({ ...parsed, ciphertext: bytes.toString("base64") }));
    expect(await records.open({ runId: "run-1", payloadHash: "hash-1" })).toBeUndefined();
  });

  it("refuses a truncated tag or wrong-size iv", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => key, runs });
    await records.seal({ runId: "run-1", payloadHash: "hash-1", payload: { a: 1 } });
    const parsed = JSON.parse(runs.records.get("run-1") as string);
    const shortTag = Buffer.from(parsed.tag, "base64").subarray(0, 4).toString("base64");
    runs.records.set("run-1", JSON.stringify({ ...parsed, tag: shortTag }));
    expect(await records.open({ runId: "run-1", payloadHash: "hash-1" })).toBeUndefined();
    const shortIv = Buffer.from(parsed.iv, "base64").subarray(0, 8).toString("base64");
    runs.records.set("run-1", JSON.stringify({ ...parsed, iv: shortIv }));
    expect(await records.open({ runId: "run-1", payloadHash: "hash-1" })).toBeUndefined();
  });

  it("refuses a record sealed for a different run", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => key, runs });
    await records.seal({ runId: "run-1", payloadHash: "hash-1", payload: { a: 1 } });
    runs.records.set("run-2", runs.records.get("run-1") as string);
    expect(await records.open({ runId: "run-2", payloadHash: "hash-1" })).toBeUndefined();
  });

  it("refuses a record sealed under a different payload hash", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => key, runs });
    await records.seal({ runId: "run-1", payloadHash: "hash-1", payload: { a: 1 } });
    expect(await records.open({ runId: "run-1", payloadHash: "hash-other" })).toBeUndefined();
  });

  it("open returns undefined for missing, malformed or keyless records", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => key, runs });
    expect(await records.open({ runId: "none", payloadHash: "h" })).toBeUndefined();
    runs.records.set("bad", "{not json");
    expect(await records.open({ runId: "bad", payloadHash: "h" })).toBeUndefined();
    await records.seal({ runId: "run-1", payloadHash: "h", payload: 1 });
    const keyless = createExternalSideEffectReplayRecords({ resolveKey: () => undefined, runs });
    expect(await keyless.open({ runId: "run-1", payloadHash: "h" })).toBeUndefined();
  });

  it("seal reports false without a key and writes nothing", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => undefined, runs });
    expect(await records.seal({ runId: "run-1", payloadHash: "h", payload: { a: 1 } })).toBe(false);
    expect(runs.records.size).toBe(0);
  });

  it("seal reports false when the write throws", async () => {
    const records = createExternalSideEffectReplayRecords({
      resolveKey: () => key,
      runs: {
        attachReplayRecord: () => {
          throw new Error("disk full");
        },
        getReplayRecord: () => undefined,
      },
    });
    expect(await records.seal({ runId: "r", payloadHash: "h", payload: {} })).toBe(false);
  });

  const noRecords = { hasReplayRecords: () => false };

  it("resolveExternalSideEffectReplayKey generates once and reuses the stored key", async () => {
    const stored = new Map<string, string>();
    let sets = 0;
    const store = {
      isAvailable: () => true,
      getSecret: (account: string) => stored.get(account),
      setSecret: (account: string, value: string) => {
        sets += 1;
        stored.set(account, value);
      },
    };
    const first = await resolveExternalSideEffectReplayKey(store, noRecords);
    const second = await resolveExternalSideEffectReplayKey(store, noRecords);
    expect(first?.length).toBe(32);
    expect(second?.equals(first as Buffer)).toBe(true);
    expect(sets).toBe(1);
    expect([...stored.keys()]).toEqual(["external-side-effect-replay:master_key"]);
  });

  it("does not replace a missing key while sealed records exist", async () => {
    let sets = 0;
    const store = {
      isAvailable: () => true,
      getSecret: () => undefined,
      setSecret: () => {
        sets += 1;
      },
    };
    expect(await resolveExternalSideEffectReplayKey(store, { hasReplayRecords: async () => true })).toBeUndefined();
    expect(await resolveExternalSideEffectReplayKey(store)).toBeUndefined();
    expect(
      await resolveExternalSideEffectReplayKey(store, {
        hasReplayRecords: () => {
          throw new Error("storage unavailable");
        },
      }),
    ).toBeUndefined();
    expect(sets).toBe(0);
  });

  it("resolveExternalSideEffectReplayKey returns undefined when the store is unavailable", async () => {
    expect(await resolveExternalSideEffectReplayKey(undefined, noRecords)).toBeUndefined();
    expect(
      await resolveExternalSideEffectReplayKey(
        { isAvailable: () => false, getSecret: () => undefined, setSecret: () => undefined },
        noRecords,
      ),
    ).toBeUndefined();
    expect(
      await resolveExternalSideEffectReplayKey(
        {
          isAvailable: () => true,
          getSecret: () => {
            throw new Error("boom");
          },
          setSecret: () => undefined,
        },
        noRecords,
      ),
    ).toBeUndefined();
  });

  it("memoizes the resolved key so seal and open hit the keychain once", async () => {
    const stored = new Map<string, string>([["external-side-effect-replay:master_key", key.toString("base64")]]);
    let gets = 0;
    const store = {
      isAvailable: () => true,
      getSecret: (account: string) => {
        gets += 1;
        return stored.get(account);
      },
      setSecret: () => {
        throw new Error("must not write");
      },
    };
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({
      resolveKey: createExternalSideEffectReplayKeyResolver(store, noRecords),
      runs,
    });
    expect(await records.seal({ runId: "r1", payloadHash: "h1", payload: { a: 1 } })).toBe(true);
    expect(await records.open({ runId: "r1", payloadHash: "h1" })).toEqual({ payload: { a: 1 } });
    expect(gets).toBe(1);
  });

  it("never regenerates the key after an initial success even if later lookups miss", async () => {
    const stored = new Map<string, string>();
    let sets = 0;
    let lookupsMiss = false;
    const store = {
      isAvailable: () => true,
      getSecret: (account: string) => (lookupsMiss ? undefined : stored.get(account)),
      setSecret: (account: string, value: string) => {
        sets += 1;
        stored.set(account, value);
      },
    };
    const resolve = createExternalSideEffectReplayKeyResolver(store, noRecords);
    const first = await resolve();
    lookupsMiss = true;
    const second = await resolve();
    expect(first?.length).toBe(32);
    expect(second?.equals(first as Buffer)).toBe(true);
    expect(sets).toBe(1);
  });

  it("shares one memoized resolver per secret store across hosts", async () => {
    let gets = 0;
    const store = {
      isAvailable: () => true,
      getSecret: () => {
        gets += 1;
        return key.toString("base64");
      },
      setSecret: () => undefined,
    };
    await sharedExternalSideEffectReplayKeyResolver(store, noRecords)();
    await sharedExternalSideEffectReplayKeyResolver(store, noRecords)();
    expect(gets).toBe(1);
    expect(await sharedExternalSideEffectReplayKeyResolver(undefined, noRecords)()).toBeUndefined();
  });

  it("the throwing shared resolver surfaces key-store and guard failures and shares the memoized key", async () => {
    let gets = 0;
    let locked = true;
    const store = {
      isAvailable: () => true,
      getSecret: () => {
        gets += 1;
        if (locked) throw new Error("keychain locked");
        return key.toString("base64");
      },
      setSecret: () => undefined,
    };
    const strict = sharedExternalSideEffectReplayKeyResolverOrThrow(store, noRecords);
    await expect(strict()).rejects.toThrow("keychain locked");
    // The swallowing resolver over the same store still reports the failure as no key.
    expect(await sharedExternalSideEffectReplayKeyResolver(store, noRecords)()).toBeUndefined();
    locked = false;
    expect((await strict())?.equals(key)).toBe(true);
    // Both share one memoized key per store: no further keychain lookup.
    expect((await sharedExternalSideEffectReplayKeyResolver(store, noRecords)())?.equals(key)).toBe(true);
    expect(gets).toBe(3);

    const guardDown = { isAvailable: () => true, getSecret: () => undefined, setSecret: () => undefined };
    await expect(
      sharedExternalSideEffectReplayKeyResolverOrThrow(guardDown, {
        hasReplayRecords: () => {
          throw new Error("storage offline");
        },
      })(),
    ).rejects.toThrow("storage offline");
    // A plain miss (no store, unavailable store, a miss while sealed records exist) is not a failure.
    expect(await sharedExternalSideEffectReplayKeyResolverOrThrow(undefined, noRecords)()).toBeUndefined();
    const unavailable = { isAvailable: () => false, getSecret: () => undefined, setSecret: () => undefined };
    expect(await sharedExternalSideEffectReplayKeyResolverOrThrow(unavailable, noRecords)()).toBeUndefined();
    const sealedMiss = { isAvailable: () => true, getSecret: () => undefined, setSecret: () => undefined };
    expect(
      await sharedExternalSideEffectReplayKeyResolverOrThrow(sealedMiss, { hasReplayRecords: () => true })(),
    ).toBeUndefined();
  });

  it("does not generate a key when secret-store write custody is unsafe", async () => {
    let sets = 0;
    const store = {
      isAvailable: () => true,
      isWriteCustodySafe: () => false,
      getSecret: () => undefined,
      setSecret: () => {
        sets += 1;
      },
    };
    expect(await resolveExternalSideEffectReplayKey(store, noRecords)).toBeUndefined();
    expect(await createExternalSideEffectReplayKeyResolver(store, noRecords)()).toBeUndefined();
    expect(sets).toBe(0);
    const existing = { ...store, getSecret: () => key.toString("base64") };
    expect((await resolveExternalSideEffectReplayKey(existing, noRecords))?.equals(key)).toBe(true);
  });

  it("refuses a decrypted envelope without a payload field", async () => {
    const runs = createRuns();
    const records = createExternalSideEffectReplayRecords({ resolveKey: () => key, runs });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from("goatcitadel:external-side-effect-replay:v1\0r-legacy\0h-legacy", "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ other: 1 }), "utf8"), cipher.final()]);
    await runs.attachReplayRecord(
      "r-legacy",
      JSON.stringify({
        v: 1,
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      }),
    );
    expect(await records.open({ runId: "r-legacy", payloadHash: "h-legacy" })).toBeUndefined();
  });
});
