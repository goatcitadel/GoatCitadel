import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicCompareAndPublishJson, readManagedStateFile } from "./managed-runtime-lifecycle.mjs";

const BACKUP_LIMIT = 3;
const PROFILE_ID_FILE = ".desktop-profile-id";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function readDesktopProfileId(profileRoot) {
  const file = path.join(profileRoot, PROFILE_ID_FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size !== 36) throw new Error("The Windows profile identifier is invalid.");
  const id = fs.readFileSync(file, "utf8");
  if (!ID.test(id)) throw new Error("The Windows profile identifier is invalid.");
  return id;
}

export function desktopCredentialResource(installRoot, profileId) {
  if (!ID.test(profileId)) throw new Error("The Windows profile identifier is invalid.");
  const installId = createHash("sha256").update(path.resolve(installRoot).toLowerCase()).digest("hex");
  return `goatcitadel.desktop.${installId}.${profileId}`;
}

// Called only under the installed launcher's profile lock. All directory moves
// stay on the install volume and restore the profile at its original path.
export function installedProfileRecovery(installRoot) {
  const active = path.join(installRoot, "runtime-root");
  const recovery = path.join(installRoot, "profile-recovery");
  const backups = path.join(recovery, "backups");
  const retired = path.join(recovery, "retired");
  const browsers = path.join(recovery, "browser");
  const pending = path.join(recovery, "pending.json");

  function checkPaths() {
    assertDirectoryAncestors(installRoot);
    for (const dir of [active, recovery, backups, retired, browsers]) directoryExists(dir);
  }

  function readBackups() {
    return foldersWithIds(backups).flatMap((id) => {
      const folder = path.join(backups, id);
      if (!directoryExists(path.join(folder, "profile"))) return [];
      const { createdAt, reason, sequence } = readReceipt(path.join(folder, "receipt.json"));
      if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || !["reset", "restore"].includes(reason)
        || !Number.isSafeInteger(sequence) || sequence < 1 || sequence === Number.MAX_SAFE_INTEGER) {
        throw new Error("A profile backup has an invalid recovery record.");
      }
      return [{ id, createdAt, reason, sequence }];
    }).sort((left, right) => right.sequence - left.sequence);
  }

  function list() {
    checkPaths();
    return {
      limit: BACKUP_LIMIT,
      backups: readBackups().slice(0, BACKUP_LIMIT).map(({ id, createdAt, reason }) => ({ id, createdAt, reason })),
    };
  }

  function finish(plan) {
    const outgoing = path.join(backups, plan.outgoing);
    const backup = path.join(outgoing, "profile");
    const incoming = plan.selected
      ? path.join(backups, plan.selected, "profile")
      : path.join(outgoing, "fresh");
    if (!directoryExists(outgoing) || (plan.selected && !directoryExists(path.join(backups, plan.selected)))) {
      throw new Error("The interrupted profile change is missing a backup folder. Open the install folder to recover it.");
    }
    const hasActive = directoryExists(active);
    const hasBackup = directoryExists(backup);
    const hasIncoming = directoryExists(incoming);
    if (hasActive && hasBackup && !hasIncoming) {
      fs.unlinkSync(pending);
      return true;
    }
    if (!hasIncoming || hasActive === hasBackup) {
      throw new Error("The interrupted profile change needs recovery. Open the install folder to inspect the backups.");
    }
    try {
      if (hasActive) fs.renameSync(active, backup);
      fs.renameSync(incoming, active);
    } catch (error) {
      // If either move fails, put the previous profile back. Keep the journal
      // if rollback is interrupted so a later process can complete recovery.
      if (!directoryExists(active) && directoryExists(backup)) fs.renameSync(backup, active);
      fs.unlinkSync(pending);
      throw error;
    }
    fs.unlinkSync(pending);
    return true;
  }

  function recoverIfInterrupted() {
    if (!fs.lstatSync(pending, { throwIfNoEntry: false })) return undefined;
    checkPaths();
    const plan = readReceipt(pending);
    if (!ID.test(plan.outgoing) || (plan.selected !== null && (!ID.test(plan.selected) || plan.selected === plan.outgoing))) {
      throw new Error("The profile recovery journal is invalid. Open the install folder to inspect the backups.");
    }
    return finish(plan);
  }

  function switchProfile(selected) {
    checkPaths();
    const history = readBackups();
    if (selected !== null && !history.slice(0, BACKUP_LIMIT).some((backup) => backup.id === selected)) {
      throw new Error("That backup is no longer available. Reopen Reset and restore and select another backup.");
    }
    readDesktopProfileId(active);
    if (selected) readDesktopProfileId(path.join(backups, selected, "profile"));
    if (!directoryExists(active)) fs.mkdirSync(active);

    const outgoing = randomUUID();
    const folder = path.join(backups, outgoing);
    fs.mkdirSync(backups, { recursive: true });
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "receipt.json"), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      reason: selected ? "restore" : "reset",
      sequence: (history[0]?.sequence ?? 0) + 1,
    }), { flag: "wx", flush: true });
    if (!selected) {
      const fresh = path.join(folder, "fresh");
      fs.mkdirSync(fresh);
      fs.writeFileSync(path.join(fresh, PROFILE_ID_FILE), randomUUID(), { flag: "wx", flush: true });
    }
    const published = atomicCompareAndPublishJson({
      filePath: pending, expectedFingerprint: null, value: { version: 1, outgoing, selected },
    });
    if (!published.published) throw new Error("Could not save the profile recovery journal. Retry from Reset and restore.");
    finish({ outgoing, selected });
    return outgoing;
  }

  function prune(retireCredentials) {
    checkPaths();
    const entries = readBackups();
    const retainedProfiles = new Set([
      readDesktopProfileId(active),
      ...entries.slice(0, BACKUP_LIMIT).map(({ id }) => readDesktopProfileId(path.join(backups, id, "profile"))),
    ]);
    // Restored backups have an empty receipt folder after their profile becomes active.
    for (const id of foldersWithIds(backups)) {
      const folder = path.join(backups, id);
      if (fs.readdirSync(folder).join() === "receipt.json") {
        fs.unlinkSync(path.join(folder, "receipt.json"));
        fs.rmdirSync(folder);
      }
    }
    for (const { id } of entries.slice(BACKUP_LIMIT)) {
      fs.mkdirSync(retired, { recursive: true });
      // Hide the entire expired backup before removing any part of it.
      const from = path.join(backups, id);
      const to = path.join(retired, id);
      if (directoryExists(to)) throw new Error("An expired backup needs cleanup.");
      fs.renameSync(from, to);
    }
    for (const id of foldersWithIds(retired)) {
      const folder = path.join(retired, id);
      const profile = path.join(folder, "profile");
      if (directoryExists(profile)) {
        const scope = readDesktopProfileId(profile);
        if (scope && !retainedProfiles.has(scope)) {
          const browser = path.join(browsers, scope);
          if (directoryExists(browser)) fs.rmSync(browser, { recursive: true, force: true });
          retireCredentials(desktopCredentialResource(installRoot, scope));
        }
      }
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  return { list, recoverIfInterrupted, switchProfile, prune };
}

function foldersWithIds(root) {
  if (!directoryExists(root)) return [];
  return fs.readdirSync(root).filter((name) => ID.test(name) && directoryExists(path.join(root, name)));
}

export function directoryExists(dir) {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isDirectory()) throw new Error("Profile recovery needs regular folders. Check the install for links or junctions.");
  return true;
}

function assertDirectoryAncestors(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (!directoryExists(current)) throw new Error("Could not find the installed GoatCitadel folder.");
    if (path.dirname(current) === current) break;
  }
}

function readReceipt(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error("A profile backup is missing its recovery record.");
  const record = readManagedStateFile(file, 4096);
  let receipt;
  try {
    if (typeof record.raw === "string" && !record.oversized) receipt = JSON.parse(record.raw);
  } catch {
    // Report damaged metadata without echoing any file contents.
  }
  if (receipt?.version !== 1) throw new Error("A profile backup has an invalid recovery record.");
  return receipt;
}
