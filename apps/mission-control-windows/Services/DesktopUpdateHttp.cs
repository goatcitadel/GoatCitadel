using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace GoatCitadel.MissionControl.Windows.Services;

public sealed class DesktopUpdateRateLimitException(DateTimeOffset retryAt)
    : IOException("GitHub update checks are temporarily rate limited. Try again after " + retryAt.ToLocalTime().ToString("t") + ".")
{
    public DateTimeOffset RetryAt { get; } = retryAt;
}

public sealed class DesktopUpdateHttp : IDisposable
{
    private readonly HttpClient _client;
    public DesktopUpdateHttp(HttpMessageHandler? handler = null)
    {
        _client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = Timeout.InfiniteTimeSpan };
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("GoatCitadel-Desktop-Updater/1");
    }

    public async Task<HttpResponseMessage> OpenAsync(string url, string? etag, CancellationToken token)
    {
        var uri = new Uri(url);
        if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length > 0
            || uri.Host is not ("api.github.com" or "github.com"))
            throw new IOException("Update URL is not an allowed GitHub endpoint.");
        for (var redirect = 0; redirect < 5; redirect++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            if (etag is not null) request.Headers.TryAddWithoutValidation("If-None-Match", etag);
            var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
            {
                var location = response.Headers.Location;
                response.Dispose();
                if (location is null) throw new IOException("Update download redirect has no location.");
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
                if (!DesktopUpdatePolicy.IsDownloadRedirect(uri))
                    throw new IOException("Update download redirected outside GitHub release storage.");
                continue;
            }
            if (response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.Forbidden)
            {
                var retry = response.Headers.RetryAfter?.Date
                    ?? DateTimeOffset.UtcNow.Add(response.Headers.RetryAfter?.Delta ?? TimeSpan.FromHours(1));
                if (response.Headers.TryGetValues("X-RateLimit-Reset", out var resets)
                    && long.TryParse(resets.FirstOrDefault(), out var epoch) && epoch is >= 0 and <= 253402300799)
                    retry = DateTimeOffset.FromUnixTimeSeconds(epoch);
                if (retry < DateTimeOffset.UtcNow.AddMinutes(1)) retry = DateTimeOffset.UtcNow.AddMinutes(1);
                response.Dispose();
                throw new DesktopUpdateRateLimitException(retry);
            }
            if (response.StatusCode != HttpStatusCode.NotModified)
            {
                try { response.EnsureSuccessStatusCode(); }
                catch { response.Dispose(); throw; }
            }
            return response;
        }
        throw new IOException("Too many update download redirects.");
    }

    public async Task<string> ReadTextAsync(string url, int maxBytes, CancellationToken token)
    {
        using var response = await OpenAsync(url, null, token);
        return await ReadBoundedAsync(response, maxBytes, token);
    }

    public static async Task<string> ReadBoundedAsync(HttpResponseMessage response, int maxBytes, CancellationToken token)
    {
        if (response.Content.Headers.ContentLength > maxBytes) throw new IOException("Update metadata is too large.");
        await using var input = await response.Content.ReadAsStreamAsync(token);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await input.ReadAsync(buffer, token)) > 0)
        {
            if (output.Length + count > maxBytes) throw new IOException("Update metadata is too large.");
            output.Write(buffer, 0, count);
        }
        return Encoding.UTF8.GetString(output.ToArray());
    }

    public void Dispose() => _client.Dispose();
}
