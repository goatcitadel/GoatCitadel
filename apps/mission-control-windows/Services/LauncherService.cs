using System.Collections;
using System.Diagnostics;
using System.Text;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed record LauncherInvocation(
    string Program,
    IReadOnlyList<string> ArgsPrefix,
    string InstallRoot,
    string WorkingDir,
    string? AppDir,
    bool WindowsShell);

public sealed class LauncherEnvironment
{
    public LauncherEnvironment(
        IReadOnlyDictionary<string, string?> variables,
        string? currentExePath = null)
    {
        Variables = variables;
        CurrentExePath = currentExePath;
    }

    public IReadOnlyDictionary<string, string?> Variables { get; }
    public string? CurrentExePath { get; }

    public static LauncherEnvironment FromProcess()
    {
        var variables = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()
                     .Cast<DictionaryEntry>()
                     .Where(entry => entry.Key is string))
        {
            variables[(string)entry.Key] = entry.Value?.ToString();
        }

        return new LauncherEnvironment(variables, Environment.ProcessPath);
    }

    public string? Get(string key) => Variables.TryGetValue(key, out var value) ? value : null;
}

public sealed class LauncherService
{
    private static readonly char[] UnsafeWindowsShellArgChars = { '"', '%', '\r', '\n', '\0' };

    private readonly LauncherEnvironment _environment;

    public LauncherService(LauncherEnvironment? environment = null)
    {
        _environment = environment ?? LauncherEnvironment.FromProcess();
    }

    public LauncherInvocation ResolveLauncher()
    {
        var explicitLauncher = _environment.Get("GOATCITADEL_DESKTOP_LAUNCHER");
        if (!string.IsNullOrWhiteSpace(explicitLauncher) && File.Exists(explicitLauncher))
        {
            return InvocationForLauncher(explicitLauncher, _environment.Get("GOATCITADEL_HOME"));
        }

        var explicitHome = _environment.Get("GOATCITADEL_HOME");
        if (!string.IsNullOrWhiteSpace(explicitHome))
        {
            var explicitAppDir = _environment.Get("GOATCITADEL_APP_DIR");
            if (!string.IsNullOrWhiteSpace(explicitAppDir))
            {
                var isolatedInvocation = InvocationUnderExplicitAppDir(explicitHome, explicitAppDir);
                if (isolatedInvocation is not null)
                {
                    return isolatedInvocation;
                }
            }

            var invocation = InvocationUnderInstallRoot(explicitHome);
            if (invocation is not null)
            {
                return invocation;
            }
        }

        var currentExe = _environment.CurrentExePath;
        if (!string.IsNullOrWhiteSpace(currentExe))
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(currentExe));
            while (!string.IsNullOrWhiteSpace(directory))
            {
                if (File.Exists(Path.Join(directory, "release-manifest.json")) &&
                    Directory.GetParent(directory)?.FullName is { } parentInstallRoot)
                {
                    var invocation = InvocationUnderInstallRoot(parentInstallRoot);
                    if (invocation is not null)
                    {
                        return invocation;
                    }
                }

                var packagedAppDir = Path.Join(directory, "app");
                if (File.Exists(Path.Join(packagedAppDir, "release-manifest.json")))
                {
                    var invocation = InvocationUnderInstallRoot(directory);
                    if (invocation is not null)
                    {
                        return invocation;
                    }
                }

                var sourceLauncher = Path.Join(directory, "bin", "goatcitadel.mjs");
                if (File.Exists(sourceLauncher) && IsSourceCheckoutRoot(directory))
                {
                    return new LauncherInvocation(
                        "node",
                        new[] { sourceLauncher },
                        directory,
                        directory,
                        _environment.Get("GOATCITADEL_APP_DIR"),
                        false);
                }

                directory = Directory.GetParent(directory)?.FullName;
            }
        }

        throw new InvalidOperationException("Unable to locate GoatCitadel launcher from the Windows desktop app location.");
    }

    private static bool IsSourceCheckoutRoot(string directory) =>
        File.Exists(Path.Join(directory, "package.json")) &&
        !File.Exists(Path.Join(directory, "release-manifest.json"));

    public async Task<string> RunAsync(IEnumerable<string> args, CancellationToken cancellationToken = default)
    {
        var launcher = ResolveLauncher();
        var commandArgs = LauncherCommandArgs(launcher, args);
        var startInfo = BuildStartInfo(launcher, commandArgs);
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start GoatCitadel launcher.");
        var stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        var stdoutValue = (await stdout).Trim();
        var stderrValue = (await stderr).Trim();
        if (process.ExitCode != 0)
        {
            var detail = string.IsNullOrWhiteSpace(stderrValue) ? stdoutValue : stderrValue;
            throw new InvalidOperationException($"GoatCitadel launcher exited with {process.ExitCode}: {detail}");
        }

        return stdoutValue;
    }

    private LauncherInvocation? InvocationUnderInstallRoot(string root)
    {
        var packagedNode = Path.Join(root, "app", "runtime", "node", "node.exe");
        var packagedScript = Path.Join(root, "app", "bin", "goatcitadel.mjs");
        if (File.Exists(packagedNode) && File.Exists(packagedScript))
        {
            return new LauncherInvocation(packagedNode, new[] { packagedScript }, root, root, _environment.Get("GOATCITADEL_APP_DIR"), false);
        }

        var cmd = Path.Join(root, "bin", "goatcitadel.cmd");
        if (File.Exists(cmd))
        {
            return InvocationForLauncher(cmd, root);
        }

        var script = Path.Join(root, "app", "bin", "goatcitadel.mjs");
        return File.Exists(script) ? InvocationForLauncher(script, root) : null;
    }

    private static LauncherInvocation? InvocationUnderExplicitAppDir(string runtimeRoot, string appDir)
    {
        var fullRuntimeRoot = Path.GetFullPath(runtimeRoot);
        var fullAppDir = Path.GetFullPath(appDir);
        var manifest = Path.Join(fullAppDir, "release-manifest.json");
        var packagedNode = Path.Join(fullAppDir, "runtime", "node", "node.exe");
        var packagedScript = Path.Join(fullAppDir, "bin", "goatcitadel.mjs");
        if (!File.Exists(manifest) || !File.Exists(packagedNode) || !File.Exists(packagedScript))
        {
            return null;
        }

        return new LauncherInvocation(
            packagedNode,
            new[] { packagedScript },
            fullRuntimeRoot,
            fullRuntimeRoot,
            fullAppDir,
            false);
    }

    private LauncherInvocation InvocationForLauncher(string launcher, string? installRootOverride)
    {
        var fullLauncher = Path.GetFullPath(launcher);
        var installRoot = !string.IsNullOrWhiteSpace(installRootOverride)
            ? Path.GetFullPath(installRootOverride)
            : Path.GetFullPath(Path.Join(Path.GetDirectoryName(fullLauncher) ?? ".", ".."));
        var extension = Path.GetExtension(fullLauncher).ToLowerInvariant();
        if (extension == ".mjs")
        {
            return new LauncherInvocation(
                "node",
                new[] { fullLauncher },
                installRoot,
                installRoot,
                _environment.Get("GOATCITADEL_APP_DIR"),
                false);
        }

        return new LauncherInvocation(
            fullLauncher,
            Array.Empty<string>(),
            installRoot,
            installRoot,
            _environment.Get("GOATCITADEL_APP_DIR"),
            extension is ".cmd" or ".bat");
    }

    private static List<string> LauncherCommandArgs(LauncherInvocation launcher, IEnumerable<string> args)
    {
        var commandArgs = new List<string> { launcher.Program };
        commandArgs.AddRange(launcher.ArgsPrefix);
        commandArgs.AddRange(args);
        return commandArgs;
    }

    private static ProcessStartInfo BuildStartInfo(LauncherInvocation launcher, IReadOnlyList<string> commandArgs)
    {
        ProcessStartInfo startInfo;
        if (launcher.WindowsShell)
        {
            startInfo = new ProcessStartInfo("cmd.exe");
            startInfo.ArgumentList.Add("/d");
            startInfo.ArgumentList.Add("/s");
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(BuildWindowsCommand(commandArgs));
        }
        else
        {
            startInfo = new ProcessStartInfo(launcher.Program);
            foreach (var arg in commandArgs.Skip(1))
            {
                startInfo.ArgumentList.Add(arg);
            }
        }

        startInfo.WorkingDirectory = launcher.WorkingDir;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.Environment["GOATCITADEL_HOME"] = launcher.InstallRoot;
        startInfo.Environment["GOATCITADEL_DESKTOP_HOST"] = "1";
        if (!string.IsNullOrWhiteSpace(launcher.AppDir))
        {
            startInfo.Environment["GOATCITADEL_APP_DIR"] = launcher.AppDir;
        }

        return startInfo;
    }

    public static string BuildWindowsCommand(IEnumerable<string> parts) =>
        string.Join(" ", parts.Select(QuoteWindowsCommandArg));

    public static string QuoteWindowsCommandArg(string value)
    {
        if (value.IndexOfAny(UnsafeWindowsShellArgChars) >= 0)
        {
            throw new ArgumentException(
                "Windows shell command arguments must not contain embedded quotes, percent expansions, or control characters.",
                nameof(value));
        }

        if (value.Length == 0)
        {
            return "\"\"";
        }

        return value.Any(character => char.IsWhiteSpace(character) || "&()^<>|".Contains(character))
            ? $"\"{value}\""
            : value;
    }
}
