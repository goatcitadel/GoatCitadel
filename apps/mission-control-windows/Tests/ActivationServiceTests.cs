using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class ActivationServiceTests
{
    [DataTestMethod]
    [DataRow("goatcitadel://bad?route=/ops/activity")]
    [DataRow("https://external.example/private?token=do-not-leak")]
    public void InvalidProtocolActivationQueuesRedactedOperatorDiagnostic(string rawUri)
    {
        var queue = new ActivationDeliveryQueue();
        var routes = new List<string>();
        var diagnostics = new List<string>();

        queue.Enqueue(ActivationRequestResolver.ResolveProtocolUri(new Uri(rawUri)));
        queue.Register(routes.Add, diagnostics.Add);
        queue.FlushPending();

        Assert.AreEqual(0, routes.Count);
        CollectionAssert.AreEqual(
            new[] { ActivationRequestResolver.RejectedActivationMessage },
            diagnostics);
        Assert.IsFalse(diagnostics[0].Contains(rawUri, StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(diagnostics[0].Contains("do-not-leak", StringComparison.OrdinalIgnoreCase));
    }

    [TestMethod]
    public void InvalidRawLaunchGoatcitadelTokenDeliversRedactedOperatorDiagnostic()
    {
        var queue = new ActivationDeliveryQueue();
        var routes = new List<string>();
        var diagnostics = new List<string>();
        queue.Register(routes.Add, diagnostics.Add);

        queue.Enqueue(ActivationRequestResolver.ResolveLaunchArguments(
            "app.exe goatcitadel://open?route=https%3A%2F%2Fexternal.example%2Fprivate%3Ftoken%3Ddo-not-leak"));

        Assert.AreEqual(0, routes.Count);
        CollectionAssert.AreEqual(
            new[] { ActivationRequestResolver.RejectedActivationMessage },
            diagnostics);
        Assert.IsFalse(diagnostics[0].Contains("external.example", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(diagnostics[0].Contains("do-not-leak", StringComparison.OrdinalIgnoreCase));
    }

    [TestMethod]
    public void OrdinaryLaunchDoesNotQueueActivationDiagnostic()
    {
        var queue = new ActivationDeliveryQueue();
        var routes = new List<string>();
        var diagnostics = new List<string>();

        queue.Enqueue(ActivationRequestResolver.ResolveLaunchArguments(
            "app.exe --some-flag https://external.example/help"));
        queue.Register(routes.Add, diagnostics.Add);
        queue.FlushPending();

        Assert.AreEqual(0, routes.Count);
        Assert.AreEqual(0, diagnostics.Count);
    }

    [TestMethod]
    public void ValidProtocolActivationStillQueuesOnlyTheLocalRoute()
    {
        var queue = new ActivationDeliveryQueue();
        var routes = new List<string>();
        var diagnostics = new List<string>();

        queue.Enqueue(ActivationRequestResolver.ResolveProtocolUri(
            new Uri("goatcitadel://open?route=/ops/activity")));
        queue.Register(routes.Add, diagnostics.Add);
        queue.FlushPending();

        CollectionAssert.AreEqual(new[] { "/ops/activity" }, routes);
        Assert.AreEqual(0, diagnostics.Count);
    }

    [TestMethod]
    public void ValidRawLaunchActivationResolvesToOnlyTheLocalRoute()
    {
        var delivery = ActivationRequestResolver.ResolveLaunchArguments(
            "app.exe goatcitadel://open?route=/ops/approvals&approvalId=ap-9");

        Assert.AreEqual("/ops/approvals?approvalId=ap-9", delivery.Route);
        Assert.IsNull(delivery.Diagnostic);
    }

    [TestMethod]
    public void PendingRoutesAndDiagnosticsFlushInOrderExactlyOnce()
    {
        var queue = new ActivationDeliveryQueue();
        var events = new List<string>();

        queue.Enqueue(ActivationDelivery.ForRoute("/ops/activity"));
        queue.Enqueue(ActivationDelivery.ForDiagnostic("diagnostic"));
        queue.Enqueue(ActivationDelivery.ForRoute("/chat"));
        queue.Register(
            route => events.Add($"route:{route}"),
            diagnostic => events.Add($"diagnostic:{diagnostic}"));

        queue.FlushPending();
        queue.FlushPending();

        CollectionAssert.AreEqual(
            new[]
            {
                "route:/ops/activity",
                "diagnostic:diagnostic",
                "route:/chat",
            },
            events);
    }

    [TestMethod]
    public void ColdStartRouteWaitsUntilRuntimeDeliverySucceeds()
    {
        var queue = new DeferredRouteDeliveryQueue();
        var delivered = new List<string>();
        var attempts = 0;

        Assert.IsFalse(queue.Submit("/ops/activity", route =>
        {
            attempts += 1;
            delivered.Add(route);
            return true;
        }));
        Assert.AreEqual(0, attempts);
        Assert.AreEqual("/ops/activity", queue.PendingRoute);

        queue.MarkReady();
        Assert.IsTrue(queue.Flush(route =>
        {
            attempts += 1;
            delivered.Add(route);
            return true;
        }));

        Assert.AreEqual(1, attempts);
        CollectionAssert.AreEqual(new[] { "/ops/activity" }, delivered);
        Assert.IsNull(queue.PendingRoute);
    }

    [TestMethod]
    public void LatestDeferredRouteReplacesOlderIntentAndFailedFlushRetainsIt()
    {
        var queue = new DeferredRouteDeliveryQueue();
        var delivered = new List<string>();

        Assert.IsFalse(queue.Submit("/ops/activity", _ => false));
        Assert.IsFalse(queue.Submit("/ops/approvals?approvalId=ap-2", _ => false));
        queue.MarkReady();
        Assert.IsFalse(queue.Flush(_ => false));
        Assert.AreEqual("/ops/approvals?approvalId=ap-2", queue.PendingRoute);

        Assert.IsTrue(queue.Flush(route =>
        {
            delivered.Add(route);
            return true;
        }));

        CollectionAssert.AreEqual(new[] { "/ops/approvals?approvalId=ap-2" }, delivered);
        Assert.IsNull(queue.PendingRoute);
    }

    [TestMethod]
    public void ImmediateReadyRouteClearsAnOlderDeferredRoute()
    {
        var queue = new DeferredRouteDeliveryQueue();
        Assert.IsFalse(queue.Submit("/ops/activity", _ => false));

        queue.MarkReady();
        Assert.IsTrue(queue.Submit("/chat", _ => true));

        Assert.IsNull(queue.PendingRoute);
        Assert.IsFalse(queue.Flush(_ => true));
    }

    [TestMethod]
    public void RestartTransitionDoesNotDeliverAgainstStaleReadyRuntime()
    {
        var queue = new DeferredRouteDeliveryQueue();
        var delivered = new List<string>();
        queue.MarkReady();
        Assert.IsTrue(queue.Submit("/chat", route =>
        {
            delivered.Add(route);
            return true;
        }));

        queue.MarkUnavailable();
        Assert.IsFalse(queue.Submit("/ops/activity", route =>
        {
            Assert.Fail($"Restart-time route unexpectedly reached stale runtime: {route}");
            return true;
        }));
        Assert.AreEqual("/ops/activity", queue.PendingRoute);

        queue.MarkReady();
        Assert.IsTrue(queue.Flush(route =>
        {
            delivered.Add(route);
            return true;
        }));
        Assert.IsFalse(queue.Flush(_ => true));

        CollectionAssert.AreEqual(new[] { "/chat", "/ops/activity" }, delivered);
    }

    [TestMethod]
    public void StatusFailureRetainsRouteUntilAReadyRefresh()
    {
        var queue = new DeferredRouteDeliveryQueue();
        var delivered = new List<string>();
        queue.MarkReady();

        // A failed status read invalidates delivery even though the window still
        // holds the previous ready runtime snapshot.
        queue.MarkUnavailable();
        Assert.IsFalse(queue.Submit("/ops/activity", route =>
        {
            Assert.Fail($"Status-failure route unexpectedly reached stale runtime: {route}");
            return true;
        }));

        queue.MarkReady();
        Assert.IsTrue(queue.Flush(route =>
        {
            delivered.Add(route);
            return true;
        }));
        Assert.IsFalse(queue.Flush(_ => true));

        CollectionAssert.AreEqual(new[] { "/ops/activity" }, delivered);
    }

    [TestMethod]
    public void ParsesGoatcitadelProtocolRoute()
    {
        var parsed = ActivationRouteParser.TryGetRouteFromProtocolUri(
            new Uri("goatcitadel://open?route=/ops/approvals&approvalId=ap-1"),
            out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?approvalId=ap-1", route);
    }

    [TestMethod]
    public void RejectsNullProtocolRoute()
    {
        var parsed = ActivationRouteParser.TryGetRouteFromProtocolUri(null, out var route);

        Assert.IsFalse(parsed);
        Assert.AreEqual("", route);
    }

    [TestMethod]
    public void IgnoresDuplicateApprovalIdParameterWhenPresentInRoute()
    {
        var parsed = ActivationRouteParser.TryGetRouteFromProtocolUri(
            new Uri("goatcitadel://open?route=/ops/approvals%3FApprovalId%3Dap-1&approvalId=ap-2"),
            out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?ApprovalId=ap-1", route);
    }

    [TestMethod]
    public void DoesNotDuplicateExistingApprovalIdWithDifferentCasingInverse()
    {
        var parsed = ActivationRouteParser.TryGetRouteFromProtocolUri(
            new Uri("goatcitadel://open?route=/ops/approvals%3FapprovalId%3Dap-1&ApprovalId=ap-2"),
            out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?approvalId=ap-1", route);
    }

    [DataTestMethod]
    [DataRow("https://example.com")]
    [DataRow("goatcitadel://bad?route=/ops/activity")]
    [DataRow("goatcitadel://open?route=https%3A%2F%2Fexample.com")]
    [DataRow("goatcitadel://open?route=ops/activity")]
    public void RejectsUnsupportedActivationUris(string raw)
    {
        Assert.IsFalse(ActivationRouteParser.TryGetRouteFromProtocolUri(new Uri(raw), out _));
    }

    [DataTestMethod]
    [DataRow("\"C:\\Program Files\\GoatCitadel\\app.exe\" \"goatcitadel://open?route=/ops/approvals&approvalId=ap-9\"")]
    [DataRow("app.exe goatcitadel://open?route=/ops/approvals&approvalId=ap-9")]
    [DataRow("app.exe goatcitadel://bad?route=/ops/activity goatcitadel://open?route=/ops/approvals&approvalId=ap-9")]
    [DataRow("app.exe goatcitadel://open?route=/ops/approvals&approvalId=ap-9 goatcitadel://open?route=/ops/activity")]
    public void ParsesGoatcitadelRouteFromRawLaunchArguments(string commandLine)
    {
        var parsed = ActivationRouteParser.TryGetRouteFromCommandLineArguments(commandLine, out var route);

        Assert.IsTrue(parsed);
        Assert.AreEqual("/ops/approvals?approvalId=ap-9", route);
    }

    [DataTestMethod]
    [DataRow("")]
    [DataRow("   ")]
    [DataRow("\"C:\\app.exe\"")]
    [DataRow("app.exe --some-flag")]
    [DataRow("app.exe https://example.com")]
    [DataRow("app.exe goatcitadel://open?route=ops/activity")]
    public void RejectsLaunchArgumentsWithoutValidDeepLink(string? commandLine)
    {
        Assert.IsFalse(ActivationRouteParser.TryGetRouteFromCommandLineArguments(commandLine, out var route));
        Assert.AreEqual("", route);
    }
}
