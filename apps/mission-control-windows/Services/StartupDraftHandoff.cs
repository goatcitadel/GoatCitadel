using System.Text.Json;

namespace GoatCitadel.MissionControl.Windows.Services;

internal sealed class StartupDraftHandoff
{
    public const string MessageType = "goatcitadel.startup-draft";
    public const int MaxTextLength = 16_384;
    internal sealed record Destination(Guid Context, string Label, bool Automatic);
    internal sealed record Transfer(Destination Destination, Guid Id, string Text, bool Append, bool Focus);

    public Destination? Ready { get; private set; }
    public Transfer? Pending { get; private set; }
    public bool Attempted { get; private set; }

    public static bool IsExpectedOrigin(string? source, string? current, string? approved) =>
        TryOrigin(approved, out var expected) && TryOrigin(source, out var sender)
        && TryOrigin(current, out var page) && expected == sender && expected == page;

    private static bool TryOrigin(string? value, out string origin)
    {
        origin = "";
        if (value is null || !NavigationPolicy.TryValidateBrowserTarget(value, out var uri, out _))
            return false;
        origin = uri.GetLeftPart(UriPartial.Authority);
        return true;
    }

    public void SetReady(Destination destination)
    {
        if (Ready?.Context != destination.Context) Pending = null;
        Ready = destination;
    }

    public void Invalidate()
    {
        Ready = null;
        Pending = null;
    }

    public void Reset()
    {
        Invalidate();
        Attempted = false;
    }

    public Transfer? Offer(string text, bool append, bool focus)
    {
        if (Ready is not { } destination || string.IsNullOrWhiteSpace(text) || text.Length > MaxTextLength)
            return null;
        if (Pending is not null) return append ? Pending : null;
        if (!append && (Attempted || !destination.Automatic)) return null;
        Attempted = true;
        return Pending = new Transfer(destination, Guid.NewGuid(), text, append, focus);
    }

    public bool Acknowledge(Guid context, Guid offer, string? outcome)
    {
        if (Pending is not { } transfer || Ready?.Context != context || transfer.Id != offer ||
            outcome is not ("applied" or "held")) return false;
        Pending = null;
        return outcome == "applied";
    }

    public static bool TryId(JsonElement message, string name, out Guid id)
    {
        id = default;
        return message.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            && Guid.TryParseExact(property.GetString(), "D", out id) && id != Guid.Empty;
    }
}
