using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public class DesktopUpdateTests
{
    private string _root = "";
    private static readonly byte[] Installer = Encoding.UTF8.GetBytes("test installer payload");

    [TestInitialize]
    public void Setup()
    {
        _root = Path.Join(Path.GetTempPath(), "goatcitadel-updates-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Join(_root, "app"));
        File.WriteAllText(Path.Join(_root, "app", "release-manifest.json"),
            JsonSerializer.Serialize(new { version = "0.1.0-rc.1", sourceCommit = new string('a', 40) }));
        new DesktopUpdateStore(_root).Write(new() { Channel = "preview" });
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_root, true);

    [TestMethod]
    public void BridgeRequiresExactManagedOrigin()
    {
        Assert.IsTrue(DesktopUpdatePolicy.IsExpectedOrigin("http://127.0.0.1:5175/settings/general", "http://127.0.0.1:5175"));
        foreach (var source in new[] { "http://127.0.0.1:5173", "http://localhost:5175", "https://127.0.0.1:5175",
            "http://user@127.0.0.1:5175", "https://example.com" })
            Assert.IsFalse(DesktopUpdatePolicy.IsExpectedOrigin(source, "http://127.0.0.1:5175"), source);
    }

    [TestMethod]
    public void SameVersionDifferentCommitIsOfferedButOlderPreviewIsNot()
    {
        using var release = JsonDocument.Parse(Release());
        using var manifest = JsonDocument.Parse(Manifest());
        var candidate = DesktopUpdatePolicy.ReadRelease(release.RootElement, manifest.RootElement, "preview", "x64")!;
        Assert.IsTrue(DesktopUpdatePolicy.IsNewer(candidate, candidate.Version, new string('a', 40), 1));
        Assert.IsFalse(DesktopUpdatePolicy.IsNewer(candidate, candidate.Version, candidate.SourceCommit, 1));
        Assert.IsFalse(DesktopUpdatePolicy.IsNewer(candidate, "0.1.0-preview.9.1", new string('a', 40), 9));
    }

    [TestMethod]
    public void RejectsIncompleteReleaseWrongChannelAndArchitecture()
    {
        using var release = JsonDocument.Parse(Release(includeArm: false));
        using var manifest = JsonDocument.Parse(Manifest());
        Assert.IsNull(DesktopUpdatePolicy.ReadRelease(release.RootElement, manifest.RootElement, "preview", "x64"));
        using var full = JsonDocument.Parse(Release());
        Assert.IsNull(DesktopUpdatePolicy.ReadRelease(full.RootElement, manifest.RootElement, "stable", "x64"));
        Assert.IsNull(DesktopUpdatePolicy.ReadRelease(full.RootElement, manifest.RootElement, "preview", "x86"));
        Assert.IsFalse(DesktopUpdatePolicy.IsDownloadRedirect(new Uri("https://example.com/file.exe")));
        Assert.IsFalse(DesktopUpdatePolicy.IsAssetUrl("http://github.com/file", "preview-2-1", "file"));
    }

    [TestMethod]
    public async Task CheckDownloadAndRecheckPreserveVerifiedDownload()
    {
        using var service = CreateService();
        await service.CheckAsync(true);
        Assert.AreEqual("available", service.Status.Phase);
        await service.DownloadAsync("preview-2-1");
        Assert.AreEqual("downloaded", service.Status.Phase);
        var downloaded = await service.GetVerifiedDownloadAsync();
        CollectionAssert.AreEqual(Installer, File.ReadAllBytes(downloaded));
        await service.CheckAsync(true);
        Assert.AreEqual("downloaded", service.Status.Phase);
        File.WriteAllText(downloaded, "tampered");
        await Assert.ThrowsExceptionAsync<IOException>(() => service.GetVerifiedDownloadAsync());
        await service.CheckAsync(true);
        Assert.AreEqual("available", service.Status.Phase);
        await service.DownloadAsync("preview-2-1");
        CollectionAssert.AreEqual(Installer, File.ReadAllBytes(await service.GetVerifiedDownloadAsync()));
    }

    [TestMethod]
    public async Task SnoozeSurvivesRestartAndNewBuild()
    {
        var now = DateTimeOffset.UtcNow;
        using (var first = CreateService(now: () => now))
        {
            var notices = 0;
            first.Notification += _ => notices++;
            await first.CheckAsync(true);
            Assert.AreEqual(1, notices);
            await first.SnoozeAsync();
        }
        using var second = CreateService(sequence: 3, now: () => now.AddHours(1));
        var repeats = 0;
        second.Notification += _ => repeats++;
        await second.CheckAsync(true);
        Assert.AreEqual(0, repeats);
        Assert.AreEqual(3L, second.Status.AvailableRelease!.BuildSequence);
        now = now.AddDays(2);
        await second.CheckAsync(true);
        Assert.AreEqual(1, repeats);
    }

    [TestMethod]
    public async Task RateLimitPreventsRepeatedManualRequests()
    {
        var requests = 0;
        using var http = new DesktopUpdateHttp(new Handler(_ =>
        {
            requests++;
            var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new(System.TimeSpan.FromHours(1));
            return response;
        }));
        using var service = new DesktopUpdateService(_root, http, architecture: "x64");
        await service.CheckAsync(true);
        await service.CheckAsync(true);
        Assert.AreEqual(1, requests);
        Assert.AreEqual("error", service.Status.Phase);
        Assert.IsNull(service.Status.LastSuccessfulCheck);
    }

    [TestMethod]
    public async Task ConditionalChecksReuseValidatedMetadataAndRespectTheAutomaticInterval()
    {
        var apiCalls = 0;
        var metadataCalls = 0;
        using var http = new DesktopUpdateHttp(new Handler(request =>
        {
            if (request.RequestUri!.Host != "api.github.com") { metadataCalls++; return Json(Manifest()); }
            apiCalls++;
            if (apiCalls > 1)
            {
                Assert.AreEqual("\"release-list\"", request.Headers.IfNoneMatch.Single().Tag);
                return new(HttpStatusCode.NotModified);
            }
            var response = Json("[" + Release() + "]");
            response.Headers.ETag = new("\"release-list\"");
            return response;
        }));
        using var service = new DesktopUpdateService(_root, http, architecture: "x64");
        await service.CheckAsync(true);
        await service.CheckAsync();
        Assert.AreEqual(1, apiCalls);
        await service.CheckAsync(true);
        Assert.AreEqual(2, apiCalls);
        Assert.AreEqual(1, metadataCalls);
        Assert.AreEqual("available", service.Status.Phase);
        Assert.IsNotNull(service.Status.LastSuccessfulCheck);
    }

    [TestMethod]
    public async Task ChecksumMismatchAndWrongOfferNeverPublishAnInstaller()
    {
        using var service = CreateService(installer: Encoding.UTF8.GetBytes(new string('x', Installer.Length)));
        await service.CheckAsync(true);
        await service.DownloadAsync("preview-stale");
        await service.DownloadAsync("preview-2-1");
        Assert.AreEqual("error", service.Status.Phase);
        Assert.IsNull(service.Status.DownloadedPath);
        Assert.AreEqual(0, Directory.GetFiles(Path.Join(_root, "runtime", "updates"), "*.partial", SearchOption.AllDirectories).Length);
        Assert.AreEqual(0, Directory.GetFiles(Path.Join(_root, "runtime", "updates"), "*.exe", SearchOption.AllDirectories).Length);
    }

    [TestMethod]
    public async Task OlderPublishedBuildCannotReplacePreviouslySeenPreview()
    {
        using (var newer = CreateService(sequence: 5)) await newer.CheckAsync(true);
        using var older = CreateService(sequence: 4);
        await older.CheckAsync(true);
        Assert.IsNull(older.Status.AvailableRelease);
    }

    [TestMethod]
    public async Task OfflineChecksDoNotClaimSuccessAndStableRequiresEvidence()
    {
        using var http = new DesktopUpdateHttp(new Handler(_ => throw new HttpRequestException("offline")));
        using var offline = new DesktopUpdateService(_root, http, architecture: "x64");
        await offline.CheckAsync(true);
        Assert.AreEqual("error", offline.Status.Phase);
        Assert.IsNull(offline.Status.LastSuccessfulCheck);
        using var stable = CreateService();
        await stable.SetChannelAsync("stable");
        Assert.AreEqual("No stable release available.", stable.Status.Message);
    }

    [TestMethod]
    public void BridgeRejectsUnknownActionsAndRendererSuppliedPaths()
    {
        var origin = "http://127.0.0.1:5175";
        string Request(object action) => JsonSerializer.Serialize(new {
            type = "goatcitadel.updates.request", requestId = Guid.NewGuid().ToString(), action });
        Assert.IsNotNull(DesktopUpdatePolicy.ReadRequest(origin, origin, Request("check")));
        foreach (var action in new object[] { "install", "execute", 123, false })
            Assert.IsNull(DesktopUpdatePolicy.ReadRequest(origin, origin, Request(action)));
        Assert.IsNull(DesktopUpdatePolicy.ReadRequest(origin, origin,
            Request("check").Replace("}", ",\"url\":\"https://example.com/setup.exe\"}")));
        Assert.IsNull(DesktopUpdatePolicy.ReadRequest("http://localhost:5175", origin, Request("check")));
        Assert.IsNull(DesktopUpdatePolicy.ReadRequest(origin, origin, new string('x', 4097)));
    }

    [TestMethod]
    public async Task ChoosesHighestSequenceEvenWhenGitHubReturnsOlderReleaseFirst()
    {
        using var http = new DesktopUpdateHttp(new Handler(request =>
        {
            if (request.RequestUri!.Host == "api.github.com") return Json("[" + Release(2) + "," + Release(8) + "]");
            return Json(Manifest(request.RequestUri.AbsolutePath.Contains("preview-8-", StringComparison.Ordinal) ? 8 : 2));
        }));
        using var service = new DesktopUpdateService(_root, http, architecture: "x64");
        await service.CheckAsync(true);
        Assert.AreEqual(8L, service.Status.AvailableRelease!.BuildSequence);
    }

    [TestMethod]
    public async Task InterruptedDownloadLeavesNoInstallerAndCanBeRetried()
    {
        using var service = CreateService();
        await service.CheckAsync(true);
        using var cancel = new CancellationTokenSource();
        service.Changed += status => { if (status.Phase == "downloading" && status.DownloadedBytes > 0) cancel.Cancel(); };
        await service.DownloadAsync("preview-2-1", cancel.Token);
        Assert.AreEqual("error", service.Status.Phase);
        Assert.IsNull(service.Status.DownloadedPath);
        Assert.AreEqual(0, Directory.GetFiles(Path.Join(_root, "runtime", "updates"), "*.partial", SearchOption.AllDirectories).Length);
        await service.DownloadAsync("preview-2-1");
        Assert.AreEqual("downloaded", service.Status.Phase);
        using var restarted = CreateService();
        await restarted.CheckAsync(true);
        Assert.AreEqual("downloaded", restarted.Status.Phase);
    }

    [TestMethod]
    public async Task PersistedRateLimitAppliesAfterRestartAndChannelChanges()
    {
        var requests = 0;
        HttpResponseMessage Limited(HttpRequestMessage request)
        {
            requests++;
            var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new(TimeSpan.FromHours(1));
            return response;
        }
        using (var first = new DesktopUpdateService(_root, new DesktopUpdateHttp(new Handler(Limited)), architecture: "x64"))
            await first.CheckAsync(true);
        using var restarted = new DesktopUpdateService(_root, new DesktopUpdateHttp(new Handler(Limited)), architecture: "x64");
        await restarted.CheckAsync(true);
        await restarted.SetChannelAsync("stable");
        Assert.AreEqual(1, requests);
    }

    private DesktopUpdateService CreateService(long sequence = 2, byte[]? installer = null, Func<DateTimeOffset>? now = null)
    {
        var http = new DesktopUpdateHttp(new Handler(request =>
        {
            if (request.RequestUri!.Host == "api.github.com") return Json("[" + Release(sequence) + "]");
            if (request.RequestUri.AbsolutePath.EndsWith("desktop-update.json", StringComparison.Ordinal)) return Json(Manifest(sequence));
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(installer ?? Installer) };
        }));
        return new(_root, http, now, "x64");
    }

    private static string Release(long sequence = 2, bool includeArm = true)
    {
        var tag = $"preview-{sequence}-1";
        var names = new List<string> { "desktop-update.json", "GoatCitadel-Setup-windows-x64.exe", "GoatCitadel-Setup-windows-x64.exe.sha256" };
        if (includeArm) names.AddRange(new[] { "GoatCitadel-Setup-windows-arm64.exe", "GoatCitadel-Setup-windows-arm64.exe.sha256" });
        return JsonSerializer.Serialize(new
        {
            tag_name = tag, draft = false, prerelease = true, published_at = "2026-09-19T00:00:00Z", body = "A bug fix.",
            assets = names.Select(name => new { name, state = "uploaded", size = name.EndsWith(".exe", StringComparison.Ordinal) ? Installer.Length : 128,
                browser_download_url = $"https://github.com/{DesktopUpdatePolicy.Repository}/releases/download/{tag}/{name}" }),
        });
    }

    private static string Manifest(long sequence = 2)
    {
        var assets = new Dictionary<string, object>();
        foreach (var arch in new[] { "x64", "arm64" })
            assets["windows-" + arch] = new { name = $"GoatCitadel-Setup-windows-{arch}.exe", sizeBytes = Installer.Length,
                sha256 = Convert.ToHexString(SHA256.HashData(Installer)).ToLowerInvariant() };
        return JsonSerializer.Serialize(new { schemaVersion = 1, product = "GoatCitadel", repository = DesktopUpdatePolicy.Repository,
            version = $"0.1.0-preview.{sequence}.1", sourceCommit = new string('b', 40), buildSequence = sequence,
            tag = $"preview-{sequence}-1", channel = "preview", publisherSigned = false, assets });
    }

    private static HttpResponseMessage Json(string value) => new(HttpStatusCode.OK)
        { Content = new StringContent(value, Encoding.UTF8, "application/json") };

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(respond(request));
    }
}
