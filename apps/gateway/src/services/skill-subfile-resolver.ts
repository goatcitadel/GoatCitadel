import fs from "node:fs/promises";
import path from "node:path";

export interface SkillSubfileEntry {
  relativePath: string;
  bytes: number;
}

export interface ResolveSkillSubfilesResult {
  files: SkillSubfileEntry[];
  totalBytes: number;
}

const ROOT_FILES = ["SKILL.md", "goatcitadel.skill-bundle.json"];
const ALLOWED_DIRS = ["references", "templates", "scripts"];

export async function resolveSkillSubfiles(skillDir: string): Promise<ResolveSkillSubfilesResult> {
  const files: SkillSubfileEntry[] = [];
  for (const file of ROOT_FILES) {
    const fullPath = path.join(skillDir, file);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        files.push({ relativePath: file, bytes: stat.size });
      }
    } catch {
      /* ignore missing root files */
    }
  }
  for (const sub of ALLOWED_DIRS) {
    const dir = path.join(skillDir, sub);
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry);
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          files.push({ relativePath: path.join(sub, entry), bytes: stat.size });
        }
      }
    } catch {
      /* dir missing or unreadable — ignore */
    }
  }
  return { files, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}
