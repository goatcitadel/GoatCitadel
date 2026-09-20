using System.Text.Json;

namespace GoatCitadel.MissionControl.Windows.Services;

/// <summary>One bounded snapshot from the native host, independent of the DevTools debug port.</summary>
public sealed class DesktopStartupDiagnostics
{
    private readonly string _path;
    private readonly string _startedAt = DateTimeOffset.UtcNow.ToString("O");
    private string? _browserVersion;

    public DesktopStartupDiagnostics(string runtimeHome)
    {
        _path = Path.Join(runtimeHome, "runtime", "logs", "desktop-startup.json");
        RecordPhase("starting");
    }

    public static DesktopStartupDiagnostics? TryCreate(LauncherService launcher)
    {
        try { return new DesktopStartupDiagnostics(launcher.ResolveLauncher().InstallRoot); }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException)
        { return null; }
    }

    public void RecordPhase(string phase, Exception? error = null, string? browserVersion = null)
    {
        _browserVersion = browserVersion ?? _browserVersion;
        Write(phase, null, null, false, error);
    }

    public void RecordNavigation(string source, string title, bool succeeded)
    {
        // Never persist credentials, query strings, fragments, or off-loopback destinations.
        string? safeUrl = null;
        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) && uri.IsLoopback &&
            uri.Scheme is "http" or "https" && string.IsNullOrEmpty(uri.UserInfo))
        {
            safeUrl = uri.GetLeftPart(UriPartial.Path);
        }
        Write(succeeded ? "navigation-completed" : "navigation-failed", safeUrl,
            safeUrl is null ? null : title[..Math.Min(title.Length, 256)], succeeded && safeUrl is not null, null);
    }

    private void Write(string phase, string? url, string? title, bool navigationSucceeded, Exception? error)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var json = JsonSerializer.Serialize(new
            {
                schemaVersion = 1, processId = Environment.ProcessId, startedAt = _startedAt,
                recordedAt = DateTimeOffset.UtcNow.ToString("O"), phase, url, title, navigationSucceeded,
                browserVersion = _browserVersion, errorType = error?.GetType().Name,
                errorCode = error is null ? null : $"0x{error.HResult:X8}",
            });
            File.WriteAllText(_path + ".tmp", json);
            File.Move(_path + ".tmp", _path, overwrite: true);
        }
        catch (Exception errorWriting) when (errorWriting is IOException or UnauthorizedAccessException)
        {
            // Diagnostic storage must not prevent the application or its recovery UI from starting.
        }
    }
}
