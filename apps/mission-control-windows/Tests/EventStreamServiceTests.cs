using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class EventStreamServiceTests
{
    [TestMethod]
    public void WaitingAttentionPreservesCanonicalApprovalLink()
    {
        Assert.IsTrue(EventStreamService.TryParseOperatorAttentionNotification("""
            {"eventType":"orchestration_event","payload":{"event":"paused_for_approval"},"links":{"approvalId":"a /?","workspaceId":"w /?"}}
            """, out var payload));
        Assert.AreEqual("/inbox?approvalId=a%20%2F%3F&workspaceId=w%20%2F%3F", payload.RoutePath);
    }

    [TestMethod]
    public void ApprovalDestinationsPreserveRecordAndWorkspaceEncoding()
    {
        Assert.IsTrue(EventStreamService.TryParseApprovalNotification("""
            {"eventType":"approval_created","payload":{"approvalId":"a /?","linkage":{"workspaceId":"w /?"}}}
            """, out var payload));
        Assert.AreEqual("/inbox?approvalId=a%20%2F%3F&workspaceId=w%20%2F%3F", payload.RoutePath);
    }

    [TestMethod]
    public void BuildsEventStreamUrlWithEncodedToken()
    {
        Assert.AreEqual(
            "http://127.0.0.1:8787/api/v1/events/stream?replay=0&sse_token=abc%20123%2B%2F%3D",
            EventStreamService.BuildEventStreamUrl("http://127.0.0.1:8787/", "abc 123+/="));
    }

    [TestMethod]
    public void CleanCloseReconnectDelayBacksOffForShortStreamsAndCaps()
    {
        // jitterSample 0.5 is the midpoint, so the delay is exactly the base value.
        Assert.AreEqual(TimeSpan.FromSeconds(1), EventStreamService.ComputeCleanCloseReconnectDelay(0, 0.5));
        Assert.AreEqual(TimeSpan.FromSeconds(1), EventStreamService.ComputeCleanCloseReconnectDelay(1, 0.5));
        Assert.AreEqual(TimeSpan.FromSeconds(2), EventStreamService.ComputeCleanCloseReconnectDelay(2, 0.5));
        Assert.AreEqual(TimeSpan.FromSeconds(16), EventStreamService.ComputeCleanCloseReconnectDelay(5, 0.5));
        Assert.AreEqual(TimeSpan.FromSeconds(30), EventStreamService.ComputeCleanCloseReconnectDelay(6, 0.5));
        Assert.AreEqual(TimeSpan.FromSeconds(30), EventStreamService.ComputeCleanCloseReconnectDelay(500, 0.5));
    }

    [TestMethod]
    public void CleanCloseReconnectDelayJitterStaysWithinTwentyPercent()
    {
        Assert.AreEqual(TimeSpan.FromSeconds(0.8), EventStreamService.ComputeCleanCloseReconnectDelay(1, 0));
        Assert.AreEqual(TimeSpan.FromSeconds(1.2), EventStreamService.ComputeCleanCloseReconnectDelay(1, 1));
        Assert.AreEqual(TimeSpan.FromSeconds(1.2), EventStreamService.ComputeCleanCloseReconnectDelay(1, 7));
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
        Assert.AreEqual("/inbox", waiting.RoutePath);
    }

    [TestMethod]
    public void IgnoresApprovalEventsForOperatorAttentionParser()
    {
        Assert.IsFalse(EventStreamService.TryParseOperatorAttentionNotification(
            """{"eventType":"approval_created","payload":{"approvalId":"ap-1"}}""",
            out _));
    }
}
