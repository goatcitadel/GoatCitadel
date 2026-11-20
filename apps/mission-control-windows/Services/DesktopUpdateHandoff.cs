using System.Diagnostics;
using System.Text;
using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

internal static class DesktopUpdateHandoff
{
    private const string ResultName = "last-install-result.txt";
    private const string DesktopExe = "GoatCitadel-Mission-Control-Windows.exe";

    public static string ValidateInstalledHost(string installRoot, string? currentExe)
    {
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(installRoot));
        var expected = Path.Join(root, "app", "desktop", DesktopExe);
        if (!string.Equals(currentExe, expected, StringComparison.OrdinalIgnoreCase) || !File.Exists(expected))
            throw new InvalidOperationException("Open the installed GoatCitadel desktop app to update and restart.");
        DesktopUpdateStore.AssertRegularPath(expected);
        return root;
    }

    public static void Begin(string installRoot, string file, DesktopUpdateRelease release)
    {
        using var host = Process.GetCurrentProcess();
        var start = CreateStartInfo(installRoot, file, release, host);
        using var helper = Process.Start(start)
            ?? throw new InvalidOperationException("The Windows update helper could not start.");
    }

    internal static ProcessStartInfo CreateStartInfo(
        string installRoot, string file, DesktopUpdateRelease release, Process host)
    {
        // The system helper and its working directory stay outside the payload being replaced.
        var system = Environment.SystemDirectory;
        var start = new ProcessStartInfo(Path.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = system,
        };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
            Convert.ToBase64String(Encoding.Unicode.GetBytes(HelperScript)) })
            start.ArgumentList.Add(argument);
        start.Environment["GOAT_UPDATE_ROOT"] = installRoot;
        start.Environment["GOAT_UPDATE_INSTALLER"] = file;
        start.Environment["GOAT_UPDATE_SHA256"] = release.Installer.Sha256;
        start.Environment["GOAT_UPDATE_VERSION"] = release.Version;
        start.Environment["GOAT_UPDATE_COMMIT"] = release.SourceCommit;
        start.Environment["GOAT_UPDATE_PARENT"] = host.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["GOAT_UPDATE_PARENT_START"] =
            host.StartTime.ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return start;
    }

    public static string? TakeResult(string installRoot)
    {
        var path = Path.Join(installRoot, "runtime", "updates", ResultName);
        if (!File.Exists(path)) return null;
        DesktopUpdateStore.AssertRegularPath(path);
        if (new FileInfo(path).Length > 128) throw new IOException("The update result is invalid.");
        var message = File.ReadAllText(path).Trim() switch
        {
            "updated" => "GoatCitadel was updated and reopened.",
            "failed" => "GoatCitadel could not finish the update. Check the installer log in runtime\\updates.",
            _ => "GoatCitadel could not confirm the update result.",
        };
        File.Delete(path);
        return message;
    }

    private const string HelperScript = """
        $ErrorActionPreference = 'Stop'
        $root = $env:GOAT_UPDATE_ROOT
        $updates = Join-Path $root 'runtime\updates'
        $desktop = Join-Path $root 'app\desktop\GoatCitadel-Mission-Control-Windows.exe'
        $receipt = Join-Path $updates 'last-install-result.txt'
        $log = Join-Path $updates ('install-' + [Guid]::NewGuid().ToString('N') + '.log')
        $result = 'failed'
        $restart = $false
        try {
            $parent = Get-Process -Id ([int]$env:GOAT_UPDATE_PARENT) -ErrorAction SilentlyContinue
            if ($null -ne $parent) {
                try {
                    if (!$parent.HasExited -and
                        $parent.StartTime.ToFileTimeUtc() -eq [long]$env:GOAT_UPDATE_PARENT_START -and
                        !$parent.WaitForExit(45000)) {
                        throw 'GoatCitadel did not exit before the upgrade deadline.'
                    }
                } catch [InvalidOperationException] {
                    if (!$parent.HasExited) { throw }
                } finally { $parent.Dispose() }
            }
            $restart = $true
            $installer = $env:GOAT_UPDATE_INSTALLER
            for ($part = $installer; $part; $part = [IO.Path]::GetDirectoryName($part)) {
                if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw 'The installer path changed before handoff.'
                }
            }
            $stream = [IO.File]::Open($installer, 'Open', 'Read', 'Read')
            try {
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
                finally { $sha.Dispose() }
                if ($actual -ine $env:GOAT_UPDATE_SHA256) { throw 'The installer checksum changed before handoff.' }
                $start = New-Object Diagnostics.ProcessStartInfo
                $start.FileName = $installer
                $start.WorkingDirectory = $updates
                $start.UseShellExecute = $false
                $start.Arguments = '/VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /DIR="' + $root + '" /LOG="' + $log + '"'
                $setup = [Diagnostics.Process]::Start($start)
                if ($null -eq $setup) { throw 'Windows did not start the installer.' }
            } finally { $stream.Dispose() }
            try {
                $setup.WaitForExit()
                if ($setup.ExitCode -ne 0) { throw ('Setup exited with code ' + $setup.ExitCode + '.') }
            } finally { $setup.Dispose() }
            $release = Get-Content -LiteralPath (Join-Path $root 'app\release-manifest.json') -Raw | ConvertFrom-Json
            if ($release.version -cne $env:GOAT_UPDATE_VERSION -or $release.sourceCommit -cne $env:GOAT_UPDATE_COMMIT) {
                throw 'Setup exited without installing the selected release.'
            }
            $result = 'updated'
        } catch {
            try { Add-Content -LiteralPath $log -Value $_.Exception.Message -ErrorAction Stop } catch {}
        } finally {
            $tempReceipt = Join-Path $updates ([Guid]::NewGuid().ToString('N') + '.tmp')
            try {
                [IO.File]::WriteAllText($tempReceipt, $result)
                if ([IO.File]::Exists($receipt)) { [IO.File]::Replace($tempReceipt, $receipt, $null) }
                else { [IO.File]::Move($tempReceipt, $receipt) }
            } catch {
                try { Add-Content -LiteralPath $log -Value $_.Exception.Message -ErrorAction Stop } catch {}
            } finally {
                try { [IO.File]::Delete($tempReceipt) } catch {}
            }
            if ($restart) {
                Get-ChildItem Env:GOAT_UPDATE_* | Remove-Item
                try { Start-Process -FilePath $desktop -WorkingDirectory $root }
                catch {
                    try { Add-Content -LiteralPath $log -Value $_.Exception.Message -ErrorAction Stop } catch {}
                    Add-Type -AssemblyName System.Windows.Forms
                    [void][Windows.Forms.MessageBox]::Show(
                        "GoatCitadel could not reopen. Try opening it from the Start menu. Update log: $log",
                        'GoatCitadel update')
                }
            }
        }
        """;
}
