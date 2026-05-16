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

const ALLOWED_DIRS = ["references", "templates"];

export async function resolveSkillSubfiles(skillDir: string): Promise<ResolveSkillSubfilesResult> {
  const files: SkillSubfileEntry[] = [];
  const main = path.join(skillDir, "SKILL.md");
  try {
    const stat = await fs.stat(main);
    if (stat.isFile()) {
      files.push({ relativePath: "SKILL.md", bytes: stat.size });
    }
  } catch {
    /* ignore missing main */
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
