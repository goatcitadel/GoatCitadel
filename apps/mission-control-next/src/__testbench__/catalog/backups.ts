import { createBackup, listBackups } from "@goatcitadel/mission-control-shared/api/system";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";

export const backupChecks: readonly CheckDef[] = [
  {
    id: "admin.backup",
    kind: "journey",
    domain: "admin",
    title: "Create and list a backup",
    tier: "mutate",
    description: "Writes a backup file into the sandbox backup folder.",
    routes: ["POST /api/v1/admin/backups/create", "GET /api/v1/admin/backups"],
    steps: ["Create backup", "Backup is listed"],
    async run(ctx) {
      // Belt and braces: the launcher points GOATCITADEL_BACKUP_DIR into the sandbox root,
      // but on a real Gateway a backup would land in the operator's own backup folder.
      ensure(ctx.target.kind === "sandbox", "Backups only run against the verified sandbox.");
      const created = await ctx.step("Create backup", () => createBackup({ name: "testbench" }));
      ensure(created.bytes > 0, "The backup is empty.", created);
      const listed = await ctx.step("Backup is listed", () => listBackups(50));
      ensure(
        listed.items.some((backup) => backup.backupId === created.backupId),
        "The new backup is not listed.",
        listed,
      );
      return pass(`Backup ${created.backupId} (${created.bytes} bytes) is listed.`);
    },
  },
];
