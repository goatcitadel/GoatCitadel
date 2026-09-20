using System.Diagnostics;
using System.Text.Json;

namespace GoatCitadel.MissionControl.Windows.Services;

/// <summary>Reuses the packaged runtime's pinned Sigstore verifier without starting the Gateway.</summary>
public sealed class DesktopStableReleaseVerifier(string installRoot, DesktopUpdateHttp http)
{
    public async Task<JsonElement?> ReadVerifiedManifestAsync(JsonElement release, CancellationToken token)
    {
        var tag = release.GetProperty("tag_name").GetString()!;
        var assets = release.GetProperty("assets").EnumerateArray().ToArray();
        var certificate = FindAsset(assets, tag, "release-certificate.json");
        var proof = FindAsset(assets, tag, "release-certificate.sigstore.json");
        var node = Path.Join(installRoot, "app", "runtime", "node", "node.exe");
        var script = Path.Join(installRoot, "app", "runtime", "verify-stable-update.mjs");
        if (certificate is null || proof is null || !File.Exists(node) || !File.Exists(script)) return null;
        var certificateText = await http.ReadTextAsync(certificate, 2 * 1024 * 1024, token);
        var proofText = await http.ReadTextAsync(proof, 2 * 1024 * 1024, token);
        var start = new ProcessStartInfo(node)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = installRoot,
        };
        start.ArgumentList.Add(script);
        start.Environment.Remove("NODE_OPTIONS");
        start.Environment.Remove("NODE_PATH");
        using var process = Process.Start(start) ?? throw new IOException("Could not start release verification.");
        try
        {
            // Output is a small, fixed-schema manifest. The helper prints no certificate or credential material.
            var stdout = process.StandardOutput.ReadToEndAsync(token);
            var stderr = process.StandardError.ReadToEndAsync(token);
            await process.StandardInput.WriteAsync(JsonSerializer.Serialize(new { certificateText, proofText }).AsMemory(), token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(token);
            var output = await stdout;
            _ = await stderr;
            if (process.ExitCode != 0 || output.Length > 65536) throw new IOException("Stable release evidence could not be verified.");
            using var parsed = JsonDocument.Parse(output);
            return parsed.RootElement.Clone();
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
    }

    private static string? FindAsset(JsonElement[] assets, string tag, string name)
    {
        var matches = assets.Where(a => a.GetProperty("name").GetString() == name).ToArray();
        if (matches.Length != 1 || matches[0].GetProperty("state").GetString() != "uploaded") return null;
        var url = matches[0].GetProperty("browser_download_url").GetString();
        return DesktopUpdatePolicy.IsAssetUrl(url, tag, name) ? url : null;
    }
}
