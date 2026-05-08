import { describe, expect, it, vi } from "vitest";
import { DatabaseCutoverService } from "./database-cutover-service.js";

describe("DatabaseCutoverService", () => {
  it("blocks execute cutover when the runtime has already been flipped to Postgres", async () => {
    const createBackup = vi.fn();
    const service = new DatabaseCutoverService({
      config: {
        assistant: {
          database: {
            driver: "postgres",
          },
        },
      } as never,
      createBackup,
    });

    await expect(service.runCutover({ profile: "local", execute: true, confirm: true })).rejects.toThrow(
      "Database cutover already applied",
    );
    expect(createBackup).not.toHaveBeenCalled();
  });
});
