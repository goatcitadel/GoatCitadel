using GoatCitadel.MissionControl.Windows.Services;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace GoatCitadel.MissionControl.Windows.Tests;

[TestClass]
public sealed class StartupDraftHandoffTests
{
    [TestMethod]
    public void OnlyTheApprovedLoopbackOriginCanReceiveDrafts()
    {
        const string approved = "http://127.0.0.1:5173";
        Assert.IsTrue(StartupDraftHandoff.IsExpectedOrigin(approved + "/chat", approved, approved));
        Assert.IsFalse(StartupDraftHandoff.IsExpectedOrigin("http://localhost:5173/chat", approved, approved));
        Assert.IsFalse(StartupDraftHandoff.IsExpectedOrigin("http://127.0.0.1:5174", approved, approved));
        Assert.IsFalse(StartupDraftHandoff.IsExpectedOrigin("https://127.0.0.1:5173", approved, approved));
        Assert.IsFalse(StartupDraftHandoff.IsExpectedOrigin(approved, "https://example.test", approved));
    }

    [TestMethod]
    public void ExistingDraftNeedsAnExplicitOfferAndRetryReusesTheReceipt()
    {
        var context = Guid.NewGuid();
        var handoff = new StartupDraftHandoff();
        handoff.SetReady(new(context, "Existing Chat", false));
        Assert.IsNull(handoff.Offer("early draft", append: false, focus: false));
        var offer = handoff.Offer("early draft", append: true, focus: true)!;
        Assert.IsTrue(offer.Append);
        Assert.AreEqual(offer, handoff.Offer("early draft", append: true, focus: true));
        Assert.IsFalse(handoff.Acknowledge(Guid.NewGuid(), offer.Id, "applied"));
        Assert.IsFalse(handoff.Acknowledge(context, Guid.NewGuid(), "applied"));
        Assert.AreEqual(offer, handoff.Pending);
        Assert.IsTrue(handoff.Acknowledge(context, offer.Id, "applied"));
        Assert.IsNull(handoff.Pending);
    }

    [TestMethod]
    public void NavigationRetiresTheOfferAndKeepsTheNextTransferExplicit()
    {
        var context = Guid.NewGuid();
        var handoff = new StartupDraftHandoff();
        handoff.SetReady(new(context, "New Chat", true));
        var offer = handoff.Offer("early draft", append: false, focus: false)!;
        handoff.Invalidate();
        Assert.IsFalse(handoff.Acknowledge(context, offer.Id, "applied"));
        handoff.SetReady(new(Guid.NewGuid(), "Another Chat", true));
        Assert.IsNull(handoff.Offer("early draft", append: false, focus: false));
        Assert.IsNotNull(handoff.Offer("early draft", append: true, focus: false));
        handoff.Reset();
        Assert.IsFalse(handoff.Attempted);
    }
}
