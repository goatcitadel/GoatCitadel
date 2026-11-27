import type { AsyncStorage } from "@goatcitadel/storage";

interface TestSetting<T> {
  key: string;
  value: T;
  updatedAt: string;
}

export function createSkillImportSettings(): Pick<AsyncStorage["systemSettings"], "get" | "compareAndSet"> {
  const records = new Map<string, TestSetting<unknown>>();
  return {
    async get<T>(key: string) {
      return records.get(key) as TestSetting<T> | undefined;
    },
    async compareAndSet<T>(key: string, expected: TestSetting<unknown> | undefined, value: T) {
      if (records.get(key) !== expected) return undefined;
      const saved = { key, value, updatedAt: new Date().toISOString() };
      records.set(key, saved);
      return saved;
    },
  };
}
