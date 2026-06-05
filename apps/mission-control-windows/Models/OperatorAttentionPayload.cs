namespace GoatCitadel.MissionControl.Windows.Models;

public sealed class OperatorAttentionPayload
{
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public string? RoutePath { get; set; }
}
