using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class EventStreamServiceTests
{
    [TestMethod]
    public void BuildsEventStreamUrlWithEncodedToken()
    {
        Assert.AreEqual(
            "http://127.0.0.1:8787/api/v1/events/stream?replay=0&sse_token=abc%20123%2B%2F%3D",
            EventStreamService.BuildEventStreamUrl("http://127.0.0.1:8787/", "abc 123+/="));
    }

    [TestMethod]
    public void ParsesApprovalCreatedNotification()
    {
        var parsed = EventStreamService.TryParseApprovalNotification(
            """{"eventType":"approval_created","payload":{"approvalId":"ap-1","kind":"tool","riskLevel":"medium","status":"pending"}}""",
            out var payload);

        Assert.IsTrue(parsed);
        Assert.AreEqual("ap-1", payload.ApprovalId);
        Assert.AreEqual("tool", payload.Kind);
        Assert.AreEqual("medium", payload.RiskLevel);
        Assert.AreEqual("pending", payload.Status);
    }

    [TestMethod]
    public void ParsesOperatorAttentionNotifications()
    {
        Assert.IsTrue(EventStreamService.TryParseOperatorAttentionNotification(
            """{"eventType":"orchestration_event","payload":{"event":"run_completed","status":"completed"}}""",
            out var completed));
        Assert.AreEqual("GoatCitadel run completed", completed.Title);
        Assert.AreEqual("/ops/activity", completed.RoutePath);

        Assert.IsTrue(EventStreamService.TryParseOperatorAttentionNotification(
            """{"eventType":"provider_failed","payload":{"status":"failed"}}""",
            out var failed));
        Assert.AreEqual("GoatCitadel needs attention", failed.Title);
        Assert.AreEqual("/ops/notifications", failed.RoutePath);

        Assert.IsTrue(EventStreamService.TryParseOperatorAttentionNotification(
            """{"eventType":"orchestration_event","payload":{"event":"run_paused_for_approval"}}""",
            out var waiting));
        Assert.AreEqual("GoatCitadel is waiting", waiting.Title);
        Assert.AreEqual("/ops/approvals", waiting.RoutePath);
    }

    [TestMethod]
    public void IgnoresApprovalEventsForOperatorAttentionParser()
    {
        Assert.IsFalse(EventStreamService.TryParseOperatorAttentionNotification(
            """{"eventType":"approval_created","payload":{"approvalId":"ap-1"}}""",
            out _));
    }
}
