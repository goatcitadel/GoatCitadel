using System.Text.Json;
using System.Text.RegularExpressions;
using GoatCitadel.MissionControl.Windows.Models;

namespace GoatCitadel.MissionControl.Windows.Services;

public static class DesktopUpdatePolicy
{
    public const string Repository = "goatcitadel/GoatCitadel";
    public const string ReleasesUrl = "https://api.github.com/repos/" + Repository + "/releases?per_page=100";
    public const string ManifestName = "desktop-update.json";
    public const long MaxInstallerBytes = 2L * 1024 * 1024 * 1024;
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly Regex Sha = new("^[a-f0-9]{40}$", RegexOptions.CultureInvariant);
    private static readonly Regex Hash = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex Tag = new("^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$", RegexOptions.CultureInvariant);
    private static readonly Regex Version = new(@"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$", RegexOptions.CultureInvariant);

    public static bool IsExpectedOrigin(string? source, string? expected)
    {
        return Uri.TryCreate(source, UriKind.Absolute, out var uri)
            && Uri.TryCreate(expected, UriKind.Absolute, out var allowed)
            && allowed.IsLoopback && uri.IsLoopback && uri.Scheme == Uri.UriSchemeHttp
            && uri.UserInfo.Length == 0 && allowed.UserInfo.Length == 0
            && uri.GetLeftPart(UriPartial.Authority) == allowed.GetLeftPart(UriPartial.Authority);
    }

    public static bool IsAssetUrl(string? url, string tag, string name) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.Host == "github.com" && uri.IsDefaultPort
        && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0
        && uri.AbsolutePath == $"/{Repository}/releases/download/{tag}/{name}";

    public static DesktopUpdateRequest? ReadRequest(string source, string? expected, string json)
    {
        if (!IsExpectedOrigin(source, expected) || json.Length > 4096) return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.GetProperty("type").GetString() != "goatcitadel.updates.request"
                || !Guid.TryParse(root.GetProperty("requestId").GetString(), out var id)) return null;
            var action = root.GetProperty("action").GetString();
            if (action is not ("status" or "check" or "download" or "reveal" or "notes" or "snooze" or "channel")) return null;
            var channel = root.TryGetProperty("channel", out var c) ? c.GetString() : null;
            var tag = root.TryGetProperty("releaseTag", out var t) ? t.GetString() : null;
            if (action == "channel" && channel is not ("stable" or "preview")) return null;
            if (action == "download" && (tag is null || !Tag.IsMatch(tag) || tag.Contains("..", StringComparison.Ordinal))) return null;
            // No renderer-supplied download URLs, paths or installer execution are supported.
            if (root.EnumerateObject().Any(p => p.Name is not ("type" or "requestId" or "action" or "channel" or "releaseTag"))) return null;
            return new(id.ToString(), action!, channel, tag);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException)
        { return null; }
    }

    public static bool IsDownloadRedirect(Uri uri) =>
        uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo.Length == 0
        && uri.Fragment.Length == 0 && uri.Host == "release-assets.githubusercontent.com";

    public static DesktopUpdateRelease? ReadRelease(JsonElement release, JsonElement manifest, string channel, string arch)
    {
        try
        {
            var tag = release.GetProperty("tag_name").GetString()!;
            if (!Tag.IsMatch(tag) || tag.Contains("..", StringComparison.Ordinal)
                || release.GetProperty("draft").GetBoolean()
                || release.GetProperty("prerelease").GetBoolean() != (channel == "preview")
                || manifest.GetProperty("schemaVersion").GetInt32() != 1
                || manifest.GetProperty("product").GetString() != "GoatCitadel"
                || manifest.GetProperty("repository").GetString() != Repository
                || manifest.GetProperty("channel").GetString() != channel
                || manifest.GetProperty("tag").GetString() != tag) return null;
            var version = manifest.GetProperty("version").GetString()!;
            var commit = manifest.GetProperty("sourceCommit").GetString()!;
            var sequence = manifest.GetProperty("buildSequence").GetInt64();
            if (!Version.IsMatch(version) || !Sha.IsMatch(commit) || sequence <= 0 || sequence > 9007199254740991) return null;
            if (channel == "preview" && (manifest.GetProperty("publisherSigned").GetBoolean()
                || !tag.StartsWith("preview-", StringComparison.Ordinal))) return null;
            if (channel == "stable" && (!manifest.GetProperty("publisherSigned").GetBoolean()
                || tag != "v" + version || version.Contains('-'))) return null;
            var target = "windows-" + arch;
            var entry = manifest.GetProperty("assets").GetProperty(target);
            var name = entry.GetProperty("name").GetString()!;
            var hash = entry.GetProperty("sha256").GetString()!;
            var size = entry.GetProperty("sizeBytes").GetInt64();
            if (name != $"GoatCitadel-Setup-{target}.exe" || !Hash.IsMatch(hash)
                || size <= 0 || size > MaxInstallerBytes) return null;
            var assets = release.GetProperty("assets").EnumerateArray().ToArray();
            var matches = assets.Where(asset => asset.GetProperty("name").GetString() == name).ToArray();
            if (matches.Length != 1) return null;
            var asset = matches[0];
            var url = asset.GetProperty("browser_download_url").GetString()!;
            if (!IsAssetUrl(url, tag, name) || asset.GetProperty("size").GetInt64() != size
                || asset.GetProperty("state").GetString() != "uploaded") return null;
            // Both architectures and checksums must have been published before advertising this build.
            foreach (var architecture in new[] { "x64", "arm64" })
            {
                var other = manifest.GetProperty("assets").GetProperty("windows-" + architecture);
                var otherName = $"GoatCitadel-Setup-windows-{architecture}.exe";
                var otherSize = other.GetProperty("sizeBytes").GetInt64();
                if (other.GetProperty("name").GetString() != otherName
                    || !Hash.IsMatch(other.GetProperty("sha256").GetString()!)
                    || otherSize <= 0 || otherSize > MaxInstallerBytes) return null;
                foreach (var required in new[] { otherName, otherName + ".sha256" })
                {
                    var found = assets.Where(a => a.GetProperty("name").GetString() == required).ToArray();
                    if (found.Length != 1 || found[0].GetProperty("state").GetString() != "uploaded"
                        || !IsAssetUrl(found[0].GetProperty("browser_download_url").GetString(), tag, required)
                        || (required == otherName && found[0].GetProperty("size").GetInt64() != otherSize)
                        || (required != otherName && found[0].GetProperty("size").GetInt64() is < 65 or > 4096)) return null;
                }
            }
            var published = release.GetProperty("published_at").GetDateTimeOffset();
            var notes = release.TryGetProperty("body", out var body) ? body.GetString() ?? "" : "";
            return new(version, commit, sequence, tag, channel, published, notes[..Math.Min(notes.Length, 16000)],
                new(name, url, size, hash), channel == "stable");
        }
        catch (Exception error) when (error is KeyNotFoundException or InvalidOperationException
            or FormatException or ArgumentException or OverflowException)
        {
            return null;
        }
    }

    public static bool IsNewer(DesktopUpdateRelease candidate, string installedVersion, string? installedCommit, long installedSequence)
    {
        if (candidate.SourceCommit == installedCommit && candidate.Version == installedVersion) return false;
        if (candidate.Channel == "preview") return candidate.BuildSequence > installedSequence;
        return System.Version.TryParse(installedVersion.Split('-')[0], out var current)
            && System.Version.TryParse(candidate.Version, out var next)
            && (next > current || next == current && installedVersion.Contains('-'));
    }

    public static bool IsPreferred(DesktopUpdateRelease candidate, DesktopUpdateRelease? current)
    {
        if (current is null) return true;
        if (candidate.Channel == "stable"
            && System.Version.TryParse(candidate.Version, out var next)
            && System.Version.TryParse(current.Version, out var previous)) return next > previous;
        return candidate.BuildSequence > current.BuildSequence;
    }
}
