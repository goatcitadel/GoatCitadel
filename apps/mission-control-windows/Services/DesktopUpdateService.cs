using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class DesktopUpdateService : IDisposable
{
    private readonly DesktopUpdateStore _store;
    private readonly DesktopUpdateHttp _http;
    private readonly DesktopStableReleaseVerifier _stableVerifier;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Func<DateTimeOffset> _now;
    private readonly string _arch;
    private readonly long _installedSequence;
    private DesktopUpdatePreferences _preferences;
    private bool _checkedThisProcess;
    public DesktopUpdateStatus Status { get; private set; }
    public event Action<DesktopUpdateStatus>? Changed;
    public event Action<DesktopUpdateRelease>? Notification;

    public DesktopUpdateService(string installRoot, DesktopUpdateHttp? http = null,
        Func<DateTimeOffset>? now = null, string? architecture = null)
    {
        _store = new(installRoot);
        _http = http ?? new();
        _stableVerifier = new(installRoot, _http);
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _arch = architecture ?? (RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64");
        _preferences = _store.Read();
        if (_preferences.Channel is not ("stable" or "preview")) _preferences = new();
        var identity = _store.ReadInstalledIdentity();
        _installedSequence = identity.Sequence;
        Status = new()
        {
            InstalledVersion = identity.Version, InstalledCommit = identity.Commit,
            Channel = _preferences.Channel, LastSuccessfulCheck = _preferences.LastSuccessfulCheck,
            NextCheckAt = _preferences.NextCheckAt, SnoozedUntil = _preferences.SnoozedUntil,
        };
    }

    public async Task CheckAsync(bool manual = false, CancellationToken cancellationToken = default)
    {
        if (!await _gate.WaitAsync(0, cancellationToken)) return;
        try
        {
            if (_preferences.RateLimitedUntil > _now())
            {
                SetStatus(Status with { Message = "GitHub checks are rate limited. Try again after "
                    + _preferences.RateLimitedUntil.Value.ToLocalTime().ToString("t") + "." });
                return;
            }
            if (Status.NextCheckAt > _now() && (!manual || Status.Phase == "error")) return;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(60));
            await CheckCoreAsync(deadline.Token);
        }
        catch (Exception error) when (IsExpectedError(error)) { ReportError(error); }
        finally { _gate.Release(); }
    }

    public async Task SetChannelAsync(string channel, CancellationToken token = default)
    {
        if (channel is not ("stable" or "preview")) throw new ArgumentException("Unknown update channel.");
        await _gate.WaitAsync(token);
        try
        {
            _preferences = _preferences with { Channel = channel, Etag = null, CachedRelease = null };
            _store.Write(_preferences);
            _checkedThisProcess = false;
            SetStatus(Status with { Channel = channel, AvailableRelease = null, DownloadedPath = null,
                DownloadedBytes = 0, Phase = "idle", NextCheckAt = null, Message = "Update channel changed." });
        }
        finally { _gate.Release(); }
        await CheckAsync(true, token);
    }

    public async Task SnoozeAsync(CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            SnoozeCore();
            SetStatus(Status with { Message = "Update reminders paused until " + Status.SnoozedUntil!.Value.ToLocalTime().ToString("g") + "." });
        }
        finally { _gate.Release(); }
    }

    private void SnoozeCore()
    {
        _preferences = _preferences with { SnoozedUntil = _now().AddDays(1) };
        _store.Write(_preferences);
        SetStatus(Status with { SnoozedUntil = _preferences.SnoozedUntil });
    }

    private async Task CheckCoreAsync(CancellationToken token)
    {
        SetStatus(Status with { Phase = "checking", Message = "Checking GitHub for updates…" });
        using var response = await _http.OpenAsync(DesktopUpdatePolicy.ReleasesUrl,
            _checkedThisProcess ? _preferences.Etag : null, token);
        DesktopUpdateRelease? candidate = null;
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            candidate = _preferences.CachedRelease;
        }
        else
        {
            var text = await DesktopUpdateHttp.ReadBoundedAsync(response, 2 * 1024 * 1024, token);
            using var document = JsonDocument.Parse(text);
            if (document.RootElement.ValueKind != JsonValueKind.Array) throw new IOException("GitHub returned invalid update metadata.");
            var inspected = 0;
            foreach (var release in document.RootElement.EnumerateArray())
            {
                if (release.GetProperty("draft").GetBoolean()
                    || release.GetProperty("prerelease").GetBoolean() != (Status.Channel == "preview")) continue;
                var tag = release.GetProperty("tag_name").GetString() ?? "";
                if (Status.Channel == "preview" && !tag.StartsWith("preview-", StringComparison.Ordinal)) continue;
                if (++inspected > 8) break;
                JsonElement? manifest;
                if (Status.Channel == "stable")
                {
                    manifest = await _stableVerifier.ReadVerifiedManifestAsync(release, token);
                }
                else
                {
                    var entries = release.GetProperty("assets").EnumerateArray()
                        .Where(a => a.GetProperty("name").GetString() == DesktopUpdatePolicy.ManifestName).ToArray();
                    if (entries.Length != 1 || entries[0].GetProperty("state").GetString() != "uploaded") continue;
                    var url = entries[0].GetProperty("browser_download_url").GetString();
                    if (!DesktopUpdatePolicy.IsAssetUrl(url, tag, DesktopUpdatePolicy.ManifestName)) continue;
                    using var parsed = JsonDocument.Parse(await _http.ReadTextAsync(url!, 65536, token));
                    manifest = parsed.RootElement.Clone();
                }
                if (manifest is null) continue;
                var parsedCandidate = DesktopUpdatePolicy.ReadRelease(release, manifest.Value, Status.Channel, _arch);
                if (parsedCandidate is not null && DesktopUpdatePolicy.IsPreferred(parsedCandidate, candidate))
                    candidate = parsedCandidate;
            }
        }
        if (candidate is not null && candidate.Channel == "preview"
            && candidate.BuildSequence < _preferences.HighestPreviewSequence) candidate = null;
        var available = candidate is not null && DesktopUpdatePolicy.IsNewer(candidate,
            Status.InstalledVersion, Status.InstalledCommit, _installedSequence) ? candidate : null;
        string? downloaded = null;
        if (available is not null)
        {
            var file = Path.Join(_store.DirectoryPath, available.Installer.Sha256, available.Installer.Name);
            if (File.Exists(file))
            {
                try { await VerifyFileAsync(file, available.Installer, token); downloaded = file; }
                catch (IOException) { DesktopUpdateStore.AssertRegularPath(file); }
            }
        }
        _preferences = _preferences with
        {
            LastSuccessfulCheck = _now(), NextCheckAt = _now().AddMinutes(30),
            Etag = response.Headers.ETag?.ToString() ?? _preferences.Etag, CachedRelease = candidate,
            HighestPreviewSequence = Math.Max(_preferences.HighestPreviewSequence,
                candidate?.Channel == "preview" ? candidate.BuildSequence : 0),
        };
        _store.Write(_preferences);
        _checkedThisProcess = true;
        SetStatus(Status with
        {
            Phase = available is null ? "idle" : downloaded is null ? "available" : "downloaded",
            AvailableRelease = available, LastSuccessfulCheck = _preferences.LastSuccessfulCheck,
            NextCheckAt = _preferences.NextCheckAt, DownloadedPath = downloaded,
            DownloadedBytes = downloaded is null ? 0 : available!.Installer.SizeBytes,
            Message = available is not null ? "An update is available. Download and install when you are ready."
                : candidate is null && Status.Channel == "stable" ? "No stable release available."
                : candidate is null ? "No newer complete preview release available." : "You are up to date.",
        });
        if (available is not null && (_preferences.SnoozedUntil is null || _preferences.SnoozedUntil <= _now()))
        {
            SnoozeCore();
            Notification?.Invoke(available);
        }
    }

    public async Task DownloadAsync(string expectedTag, CancellationToken cancellationToken = default)
    {
        if (!await _gate.WaitAsync(0, cancellationToken)) return;
        string? partial = null;
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromMinutes(15));
            var candidate = Status.AvailableRelease ?? throw new IOException("Check for updates first.");
            if (candidate.Tag != expectedTag) throw new IOException("The update offer changed. Review the available version.");
            // The request is bound to the displayed immutable release, never a renderer-supplied URL or path.
            var asset = candidate.Installer;
            if (!DesktopUpdatePolicy.IsAssetUrl(asset.Url, candidate.Tag, asset.Name)
                || asset.Name != $"GoatCitadel-Setup-windows-{_arch}.exe"
                || asset.SizeBytes <= 0 || asset.SizeBytes > DesktopUpdatePolicy.MaxInstallerBytes)
                throw new IOException("Update asset is invalid.");
            var directory = Path.Join(_store.DirectoryPath, asset.Sha256);
            DesktopUpdateStore.AssertRegularPath(directory);
            Directory.CreateDirectory(directory);
            var destination = Path.Join(directory, asset.Name);
            var verifiedExisting = false;
            if (File.Exists(destination))
            {
                try { await VerifyFileAsync(destination, asset, deadline.Token); verifiedExisting = true; }
                catch (IOException)
                {
                    // A damaged task-owned download may be replaced only by a newly verified one.
                    DesktopUpdateStore.AssertRegularPath(destination);
                }
            }
            if (!verifiedExisting)
            {
                partial = Path.Join(directory, Guid.NewGuid().ToString("N") + ".partial");
                SetStatus(Status with { Phase = "downloading", DownloadedBytes = 0, DownloadedPath = null,
                    Message = "Downloading update…" });
                using var response = await _http.OpenAsync(asset.Url, null, deadline.Token);
                if (response.Content.Headers.ContentLength is long length && length != asset.SizeBytes)
                    throw new IOException("Installer size does not match its release manifest.");
                await using (var input = await response.Content.ReadAsStreamAsync(deadline.Token))
                await using (var output = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    65536, FileOptions.Asynchronous))
                {
                    var buffer = new byte[65536];
                    long total = 0, reported = 0;
                    int count;
                    while ((count = await input.ReadAsync(buffer, deadline.Token)) > 0)
                    {
                        total += count;
                        if (total > asset.SizeBytes) throw new IOException("Installer exceeds its declared size.");
                        await output.WriteAsync(buffer.AsMemory(0, count), deadline.Token);
                        if (total - reported > 1024 * 1024 || total == asset.SizeBytes)
                        {
                            reported = total;
                            SetStatus(Status with { DownloadedBytes = total });
                        }
                    }
                }
                await VerifyFileAsync(partial, asset, deadline.Token);
                DesktopUpdateStore.AssertRegularPath(destination);
                File.Move(partial, destination, true);
                partial = null;
            }
            SetStatus(Status with { Phase = "downloaded", DownloadedBytes = asset.SizeBytes, DownloadedPath = destination,
                Message = candidate.PublisherSigned
                    ? "Download verified against signed release evidence. Open the folder to run the installer when ready."
                    : "Checksum verified. This preview is unsigned. Open the folder and run the installer when ready." });
        }
        catch (Exception error) when (IsExpectedError(error)) { ReportError(error); }
        finally
        {
            try { if (partial is not null && File.Exists(partial)) File.Delete(partial); }
            finally { _gate.Release(); }
        }
    }

    public async Task<string> GetVerifiedDownloadAsync(CancellationToken token = default)
    {
        var candidate = Status.AvailableRelease ?? throw new IOException("No downloaded update.");
        var file = Status.DownloadedPath ?? throw new IOException("Download the update first.");
        var expected = Path.Join(_store.DirectoryPath, candidate.Installer.Sha256, candidate.Installer.Name);
        if (!string.Equals(file, expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid download path.");
        await VerifyFileAsync(file, candidate.Installer, token);
        return file;
    }

    public static async Task VerifyFileAsync(string file, DesktopUpdateAsset asset, CancellationToken token)
    {
        DesktopUpdateStore.AssertRegularPath(file);
        await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length != asset.SizeBytes) throw new IOException("Downloaded installer size is incorrect.");
        var hash = Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).ToLowerInvariant();
        if (!string.Equals(hash, asset.Sha256, StringComparison.Ordinal)) throw new IOException("Downloaded installer checksum is incorrect.");
    }

    private void SetStatus(DesktopUpdateStatus value) { Status = value; Changed?.Invoke(value); }
    private void ReportError(Exception error)
    {
        var next = error is DesktopUpdateRateLimitException limited ? limited.RetryAt : _now().AddMinutes(5);
        _preferences = _preferences with { NextCheckAt = next,
            RateLimitedUntil = error is DesktopUpdateRateLimitException ? next : _preferences.RateLimitedUntil };
        string? storageMessage = null;
        try { _store.Write(_preferences); }
        catch (Exception storageError) when (storageError is IOException or UnauthorizedAccessException)
        { storageMessage = " Update preferences could not be saved: " + storageError.Message; }
        SetStatus(Status with { Phase = "error", NextCheckAt = next,
            Message = error is OperationCanceledException ? "Update operation timed out or was cancelled. You can retry."
                : error is HttpRequestException ? "GitHub could not be reached. Your installed app is unchanged."
                : error is JsonException or KeyNotFoundException or InvalidOperationException ? "Update metadata was invalid. Try again later."
                : error.Message + storageMessage });
    }

    private static bool IsExpectedError(Exception error) => error is IOException or HttpRequestException
        or UnauthorizedAccessException or JsonException or KeyNotFoundException or InvalidOperationException or OperationCanceledException;
    public void Dispose() { _http.Dispose(); }
}
