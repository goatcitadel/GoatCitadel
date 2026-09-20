using System.Text.Json;
using System.Text.RegularExpressions;
using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed record DesktopUpdatePreferences
{
    public string Channel { get; init; } = "stable";
    public DateTimeOffset? SnoozedUntil { get; init; }
    public DateTimeOffset? LastSuccessfulCheck { get; init; }
    public DateTimeOffset? NextCheckAt { get; init; }
    public DateTimeOffset? RateLimitedUntil { get; init; }
    public long HighestPreviewSequence { get; init; }
    public string? Etag { get; init; }
    public DesktopUpdateRelease? CachedRelease { get; init; }
}

public sealed class DesktopUpdateStore
{
    public string InstallRoot { get; }
    public string DirectoryPath { get; }
    private string PreferencesPath => Path.Join(DirectoryPath, "preferences.json");

    public DesktopUpdateStore(string installRoot)
    {
        InstallRoot = Path.GetFullPath(installRoot);
        DirectoryPath = Path.Join(InstallRoot, "runtime", "updates");
    }

    public DesktopUpdatePreferences Read()
    {
        if (!File.Exists(PreferencesPath)) return new();
        AssertRegularPath(PreferencesPath);
        if (new FileInfo(PreferencesPath).Length > 262144) throw new IOException("Update preferences are too large.");
        return JsonSerializer.Deserialize<DesktopUpdatePreferences>(File.ReadAllText(PreferencesPath), DesktopUpdatePolicy.Json)
            ?? new();
    }

    public void Write(DesktopUpdatePreferences preferences)
    {
        AssertRegularPath(DirectoryPath);
        Directory.CreateDirectory(DirectoryPath);
        AssertRegularPath(DirectoryPath);
        var temporary = Path.Join(DirectoryPath, Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(preferences, DesktopUpdatePolicy.Json));
            if (File.Exists(PreferencesPath)) AssertRegularPath(PreferencesPath);
            File.Move(temporary, PreferencesPath, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public (string Version, string? Commit, long Sequence) ReadInstalledIdentity()
    {
        var file = Path.Join(InstallRoot, "app", "release-manifest.json");
        if (!File.Exists(file)) return ("source checkout", null, 0);
        AssertRegularPath(file);
        if (new FileInfo(file).Length > 16 * 1024 * 1024) throw new IOException("Installed release manifest is too large.");
        using var doc = JsonDocument.Parse(File.ReadAllText(file));
        var version = doc.RootElement.GetProperty("version").GetString() ?? "unknown";
        var commit = doc.RootElement.TryGetProperty("sourceCommit", out var sha) ? sha.GetString() : null;
        var match = Regex.Match(version, @"-preview\.(\d+)\.");
        var sequence = match.Success && long.TryParse(match.Groups[1].Value, out var value) ? value : 0;
        return (version, commit, sequence);
    }

    public static void AssertRegularPath(string target)
    {
        for (var current = Path.GetFullPath(target); !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            if ((File.Exists(current) || Directory.Exists(current))
                && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Update storage cannot traverse a symbolic link or junction.");
        }
    }
}
