namespace GoatCitadel.MissionControl.Windows.Models;

public sealed record DesktopUpdateRequest(string RequestId, string Action, string? Channel, string? ReleaseTag);

// Wire names are camelCase. Keep aligned with contracts/src/desktop-updates.ts.
public sealed record DesktopUpdateAsset(string Name, string Url, long SizeBytes, string Sha256);
public sealed record DesktopUpdateRelease(
    string Version, string SourceCommit, long BuildSequence, string Tag, string Channel,
    DateTimeOffset PublishedAt, string ReleaseNotes, DesktopUpdateAsset Installer, bool PublisherSigned);
public sealed record DesktopUpdateStatus
{
    public string Channel { get; init; } = "stable";
    public string Phase { get; init; } = "idle";
    public string InstalledVersion { get; init; } = "unknown";
    public string? InstalledCommit { get; init; }
    public DesktopUpdateRelease? AvailableRelease { get; init; }
    public DateTimeOffset? LastSuccessfulCheck { get; init; }
    public DateTimeOffset? NextCheckAt { get; init; }
    public DateTimeOffset? SnoozedUntil { get; init; }
    public long DownloadedBytes { get; init; }
    public string? DownloadedPath { get; init; }
    public string Message { get; init; } = "Check for updates when you are ready.";
}
