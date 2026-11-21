import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_CREDENTIAL_READER_NAME = "GoatCitadel-Credential-Read.exe";

export function buildWindowsCredentialReader(outDir) {
  const programFiles = process.env["ProgramFiles(x86)"];
  if (process.platform !== "win32" || !programFiles) {
    throw new Error("The Windows credential reader requires an x64 MSVC toolchain and Windows SDK.");
  }
  const vswhere = path.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installation = spawnSync(vswhere, [
    "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ], { encoding: "utf8", windowsHide: true });
  if (installation.status !== 0 || !installation.stdout.trim()) throw new Error("x64 MSVC tools were not found.");
  const tools = newestVersion(path.join(installation.stdout.trim(), "VC", "Tools", "MSVC"), (dir) =>
    fs.existsSync(path.join(dir, "bin", "Hostx64", "x64", "cl.exe")));
  const kit = path.join(programFiles, "Windows Kits", "10");
  const include = newestVersion(path.join(kit, "Include"), (dir) =>
    fs.existsSync(path.join(dir, "cppwinrt", "winrt", "Windows.Security.Credentials.h"))
    && fs.existsSync(path.join(kit, "Lib", path.basename(dir), "um", "x64", "windowsapp.lib")));
  if (!tools || !include) throw new Error("The MSVC compiler or Windows SDK C++/WinRT headers were not found.");

  const sdkLib = path.join(kit, "Lib", path.basename(include));
  const compiler = path.join(tools, "bin", "Hostx64", "x64", "cl.exe");
  const source = fileURLToPath(new URL("../../../apps/mission-control-windows/Native/credential_read.cpp", import.meta.url));
  const output = path.join(path.resolve(outDir), WINDOWS_CREDENTIAL_READER_NAME);
  fs.mkdirSync(outDir, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(path.resolve(outDir), ".credential-reader-"));
  try {
    const result = spawnSync(compiler, [
      "/nologo", "/std:c++20", "/EHsc", "/MT", "/O2", "/W4", "/WX",
      "/I" + path.join(tools, "include"),
      ...["cppwinrt", "ucrt", "shared", "um"].map((folder) => "/I" + path.join(include, folder)),
      source, "/Fo" + path.join(scratch, "reader.obj"), "/Fe" + output,
      "/link", "/LIBPATH:" + path.join(tools, "lib", "x64"),
      ...["um", "ucrt"].map((folder) => "/LIBPATH:" + path.join(sdkLib, folder, "x64")),
      "windowsapp.lib",
    ], { cwd: scratch, stdio: "inherit", windowsHide: true });
    if (result.status !== 0) throw new Error("Building the Windows credential reader failed.", { cause: result.error });
  } finally {
    const objectFile = path.join(scratch, "reader.obj");
    fs.rmSync(objectFile, { force: true });
    fs.rmdirSync(scratch);
  }
  return output;
}

function newestVersion(root, supported) {
  return fs.readdirSync(root, { withFileTypes: true, throwIfNoEntry: false })
    ?.filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/u.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => right.localeCompare(left, "en", { numeric: true }))
    .find(supported);
}
