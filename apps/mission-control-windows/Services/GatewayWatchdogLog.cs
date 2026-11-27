using System.Text.Json;

namespace GoatCitadel.MissionControl.Windows.Services;

/// <summary>
/// A small, bounded record of what the watchdog did, at <c>&lt;install&gt;/runtime/logs/desktop-watchdog.jsonl</c>,
/// one JSON object per line. It is host-owned evidence the Gateway can read after it starts again; it never holds
/// credentials, URLs, or process command lines. Writing it never throws: losing a log line must not stop a restart.
/// </summary>
public sealed class GatewayWatchdogLog
{
    public const int MaxEntries = 200;
    public const int MaxReasonLength = 300;
    private const int SchemaVersion = 1;

    private readonly string _path;
    private readonly object _gate = new();

    public GatewayWatchdogLog(string installRoot)
    {
        _path = PathFor(installRoot);
    }

    public static string PathFor(string installRoot) => Path.Join(installRoot, "runtime", "logs", "desktop-watchdog.jsonl");

    public void Record(DateTimeOffset at, WatchdogDecision decision)
    {
        if (decision.Action == WatchdogAction.None) return;
        var line = JsonSerializer.Serialize(new
        {
            schemaVersion = SchemaVersion,
            at = at.ToString("O"),
            action = decision.Action == WatchdogAction.Restart ? "restart" : "give_up",
            reason = Bound(decision.Reason),
            attempt = decision.Attempt,
            maxAttempts = decision.MaxAttempts,
            hostProcessId = Environment.ProcessId,
        });
        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                var lines = File.Exists(_path) ? File.ReadAllLines(_path).ToList() : new List<string>();
                lines.Add(line);
                var kept = lines.Skip(Math.Max(0, lines.Count - MaxEntries)).ToArray();
                var temporary = _path + ".tmp";
                File.WriteAllLines(temporary, kept);
                File.Move(temporary, _path, overwrite: true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                // The log is evidence, not control: a failed write is dropped so the watchdog keeps working.
            }
        }
    }

    private static string Bound(string reason)
    {
        var flattened = reason.ReplaceLineEndings(" ").Trim();
        return flattened.Length <= MaxReasonLength ? flattened : flattened[..(MaxReasonLength - 1)] + "…";
    }
}
