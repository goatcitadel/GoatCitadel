using System.Text.Json;

namespace GoatCitadel.MissionControl.Windows.Services;

/// <summary>
/// Watchdog limits, read from <c>&lt;install&gt;/runtime/desktop/watchdog.json</c> so they can be tuned without a
/// rebuild. Every value has a safe default and is clamped to bounds; a missing, unreadable, or wrong-typed value
/// falls back to its default. Nothing in the file can make the watchdog restart faster or more often than the
/// bounds allow, and only a literal <c>"enabled": false</c> turns it off.
/// </summary>
public sealed record GatewayWatchdogSettings(
    bool Enabled,
    int FailedChecksBeforeRestart,
    IReadOnlyList<TimeSpan> Backoff,
    int MaxRestartsPerWindow,
    TimeSpan Window)
{
    public const int MinFailedChecks = 2;
    public const int MaxFailedChecks = 10;
    public static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(10);
    public const int MaxBackoffSteps = 5;
    public const int MinRestarts = 1;
    public const int MaxRestartsCap = 5;
    public static readonly TimeSpan MinWindow = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan MaxWindow = TimeSpan.FromMinutes(60);
    private const long MaxFileBytes = 64 * 1024;

    public static readonly GatewayWatchdogSettings Defaults = new(
        Enabled: true,
        FailedChecksBeforeRestart: 3,
        Backoff: new[] { TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2) },
        MaxRestartsPerWindow: 3,
        Window: TimeSpan.FromMinutes(10));

    public static string PathFor(string installRoot) => Path.Join(installRoot, "runtime", "desktop", "watchdog.json");

    /// <summary>Reads the settings file. Never throws; <c>Problem</c> says why the defaults were used.</summary>
    public static (GatewayWatchdogSettings Settings, string? Problem) Load(string installRoot)
    {
        var path = PathFor(installRoot);
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists) return (Defaults, null);
            if (file.Length > MaxFileBytes) return (Defaults, "The watchdog settings file is too large, so the defaults are used.");
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return (Defaults, "The watchdog settings file is not a JSON object, so the defaults are used.");
            }
            return (FromJson(document.RootElement), null);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
        {
            return (Defaults, $"The watchdog settings file couldn't be read, so the defaults are used: {error.Message}");
        }
    }

    private static GatewayWatchdogSettings FromJson(JsonElement root)
    {
        var enabled = !(root.TryGetProperty("enabled", out var enabledValue) && enabledValue.ValueKind == JsonValueKind.False);
        var failedChecks = ReadInt(root, "failedChecksBeforeRestart") is { } checks
            ? Math.Clamp(checks, MinFailedChecks, MaxFailedChecks)
            : Defaults.FailedChecksBeforeRestart;
        var maxRestarts = ReadInt(root, "maxRestartsPerWindow") is { } restarts
            ? Math.Clamp(restarts, MinRestarts, MaxRestartsCap)
            : Defaults.MaxRestartsPerWindow;
        var window = ReadInt(root, "windowMinutes") is { } minutes
            ? Clamp(TimeSpan.FromMinutes(minutes), MinWindow, MaxWindow)
            : Defaults.Window;
        return new GatewayWatchdogSettings(enabled, failedChecks, ReadBackoff(root), maxRestarts, window);
    }

    private static IReadOnlyList<TimeSpan> ReadBackoff(JsonElement root)
    {
        if (!root.TryGetProperty("backoffSeconds", out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return Defaults.Backoff;
        }
        var steps = value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out _))
            .Take(MaxBackoffSteps)
            .Select(item => Clamp(TimeSpan.FromSeconds(item.GetInt32()), MinBackoff, MaxBackoff))
            .ToArray();
        return steps.Length > 0 ? steps : Defaults.Backoff;
    }

    private static int? ReadInt(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
            ? number
            : null;

    private static TimeSpan Clamp(TimeSpan value, TimeSpan min, TimeSpan max) =>
        value < min ? min : value > max ? max : value;
}
