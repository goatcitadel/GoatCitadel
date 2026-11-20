/* global Event, EventTarget, Headers, MessageEvent, ReadableStream, Request, Response, TextEncoder, URL,
          clearTimeout, crypto, setTimeout, window */

export function createPracticeSession(origin = window.location.origin) {
  let disposed = false;
  let refreshTimer;
  const changes = new EventTarget();
  const now = new Date().toISOString();
  const workspaceId = "default";
  const sessionId = "89f29db6-e101-43fc-8ea4-faf660352f63";
  const turnId = "608a2543-5d25-47c3-b371-b44f6f5db264";
  const approvalId = "869ea945-d2de-49df-bfcb-109e974ae2f6";
  const taskId = "31cc5aba-8c5a-4a3d-b748-6c8a09d232c1";
  const prompt = "Use the offsite planning guide to draft a checklist for our team.";
  const toolName = "docs.search";
  const searchTitle = "Review document search";
  const waitingReply =
    "I can use the offsite planning guide to make the checklist. Review the document search in Chat or Inbox to let me continue.";
  const approvedReply =
    "I found the practice guide and drafted an offsite checklist. Open Library › Artifacts to review it.";
  const deniedReply = "I left the document search blocked. No checklist was generated from the guide.";
  const lesson = "Team offsite";
  const settings = {
    revision: 1,
    toolApprovalMode: "approve_risky",
    budgetMode: "balanced",
    networkAllowlist: [],
    features: { chatThinkingStreamV1Enabled: false },
    auth: { mode: "none", allowLoopbackBypass: false, tokenConfigured: false, basicConfigured: false },
    llm: {
      activeProviderId: "tutorial",
      activeModel: "Practice model",
      providers: [
        {
          providerId: "tutorial",
          label: "Practice model",
          baseUrl: origin,
          apiStyle: "openai-chat-completions",
          defaultModel: "Practice model",
          hasApiKey: false,
          apiKeySource: "none",
          modelProbeState: "ready",
          modelProbeSource: "live",
          modelProbeCheckedAt: now,
        },
      ],
    },
    mesh: {
      enabled: false,
      mode: "lan",
      nodeId: "preview",
      mdns: false,
      staticPeers: [],
      requireMtls: false,
      tailnetEnabled: false,
    },
  };
  const currentAccess = {
    actorId: "tutorial",
    actorSource: "loopback",
    operatorAccess: true,
    readStatusScope: "browser_local",
  };
  const readiness = {
    generatedAt: now,
    profile: "single_user",
    summary: "ready",
    items: [{ id: "provider", title: "Chat model", status: "ready", detail: "Practice model ready" }],
  };
  const workspace = {
    workspaceId,
    revision: 1,
    citadelId: "personal",
    name: "Tutorial workspace",
    slug: "default",
    lifecycleStatus: "active",
    createdAt: now,
    updatedAt: now,
    workspacePrefs: { uiMode: "simple" },
  };
  const citadel = {
    citadelId: "personal",
    revision: "1".repeat(64),
    name: "Personal",
    slug: "personal",
    kind: "personal",
    defaultWorkspaceId: workspaceId,
    lifecycleStatus: "active",
    createdAt: now,
    updatedAt: now,
  };
  const session = {
    sessionId,
    sessionKey: "tutorial:offsite",
    revision: 1,
    workspaceId,
    scope: "mission",
    mode: "chat",
    title: lesson,
    lifecycleStatus: "active",
    status: "active",
    channel: "web",
    account: "tutorial",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    origin: "operator",
    includeInHistory: true,
    providerId: "tutorial",
    model: "Practice model",
    tags: [],
    archived: false,
    pinned: false,
    tokenTotal: 0,
    costUsdTotal: 0,
  };
  const prefs = {
    sessionId,
    revision: 1,
    mode: "chat",
    planningMode: "off",
    providerId: "tutorial",
    model: "Practice model",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "manual",
    orchestrationEnabled: false,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "summary",
    orchestrationProviderPreference: "inherit",
    orchestrationReviewDepth: "balanced",
    orchestrationParallelism: "balanced",
    codeAutoApply: "manual",
  };
  const counts = () => ({
    needs_decision: { known: sample.sent && !sample.decision ? 1 : 0, complete: true },
    proposals: { known: 0, complete: true },
    needs_attention: { known: 0, complete: true },
    updates: { known: 0, complete: true },
  });
  const makeApproval = () => ({
    approvalId,
    kind: toolName,
    riskLevel: "safe",
    status: sample.decision || "pending",
    createdAt: now,
    ...(sample.decision ? { resolvedAt: now, resolvedBy: "tutorial" } : {}),
    explanationStatus: "completed",
    explanation: {
      summary: "Search the tutorial documents for the offsite planning guide.",
      riskExplanation: "The search reads matching passages from the tutorial workspace.",
      generatedAt: now,
    },
    payload: { query: "team offsite planning guide" },
    preview: {
      reviewKind: "knowledge.operation",
      toolName,
      target: "Documents in the tutorial workspace",
      query: "team offsite planning guide",
    },
    linkage: { workspaceId, sessionId, turnId, taskId, originSurface: "chat", actionType: "tool.invoke", toolName },
  });
  const item = {
    id: "approval:" + approvalId,
    kind: "approval",
    group: "needs_decision",
    title: searchTitle,
    summary: "GoatCitadel wants to search the tutorial workspace for the offsite planning guide.",
    createdAt: now,
    riskLevel: "safe",
    source: { workspaceId, sessionId, turnId, approvalId, taskId, toolName },
    href: "/ops/approvals?approvalId=" + approvalId,
  };
  const assistantMessageId = "f579d3fe-5c42-45cf-9177-c6ccda4e04ea";
  const userMessageId = "ae6ef9a0-332f-4e31-8ef3-18a9e0a76861";
  const approvalSummary = {
    approvalId,
    kind: toolName,
    toolName,
    riskLevel: "safe",
    affectedResources: ["Documents in the tutorial workspace"],
    reason: "Find the offsite planning guide.",
    taskId,
  };
  const toolRun = () => ({
    toolRunId: "tutorial-search",
    toolName,
    turnId,
    sessionId,
    startedAt: now,
    status:
      sample.decision === "approved" ? "succeeded" : sample.decision === "rejected" ? "blocked" : "approval_required",
    approvalId,
    input: { query: "team offsite planning guide" },
  });
  function conversation() {
    if (!sample.active || !sample.sent) return { sessionId, turns: [] };
    const waiting = !sample.decision;
    const userMessage = {
      messageId: userMessageId,
      sessionId,
      role: "user",
      content: prompt,
      actorType: "user",
      actorId: "tutorial",
      sourceAuthority: "persisted",
      timestamp: now,
    };
    const assistantMessage = {
      messageId: assistantMessageId,
      sessionId,
      role: "assistant",
      content: waiting ? waitingReply : sample.decision === "approved" ? approvedReply : deniedReply,
      actorType: "agent",
      actorId: "goatherder",
      sourceAuthority: "persisted",
      timestamp: now,
    };
    const trace = {
      turnId,
      sessionId,
      userMessageId,
      assistantMessageId,
      status: waiting ? "waiting_for_approval" : "completed",
      mode: "chat",
      model: "Practice model",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: now,
      ...(waiting ? { pendingApprovalSummary: approvalSummary } : { finishedAt: now }),
      branchKind: "continuation",
      toolRuns: [toolRun()],
      citations: [],
      routing: {},
    };
    return {
      sessionId,
      activeLeafTurnId: turnId,
      selectedTurnId: turnId,
      turns: [
        {
          turnId,
          branchKind: "continuation",
          userMessage,
          assistantMessage,
          trace,
          toolRuns: trace.toolRuns,
          citations: [],
          branch: {
            siblingTurnIds: [turnId],
            activeSiblingIndex: 0,
            siblingCount: 1,
            isSelectedPath: true,
            newestLeafTurnId: turnId,
          },
        },
      ],
    };
  }
  function stream(chunks) {
    const body = chunks
      .map(
        (chunk, index) =>
          "data: " +
          JSON.stringify({ sessionId, turnId, sequence: index + 1, eventId: "tutorial-" + (index + 1), ...chunk }) +
          "\n\n",
      )
      .join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
  const health = {
    generatedAt: now,
    daemonStatus: {
      running: true,
      state: "running",
      supported: false,
      controllable: false,
      host: "Tutorial preview",
      uptimeSeconds: 60,
      controlMessage: "Sample runtime health",
    },
    systemVitals: {
      hostname: "Tutorial preview",
      platform: "Windows",
      release: "Sample",
      uptimeSeconds: 60,
      loadAverage: [0, 0, 0],
      cpuCount: 8,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryUsedBytes: 4 * 1024 ** 3,
      memoryFreeBytes: 12 * 1024 ** 3,
      processRssBytes: 0,
      processHeapUsedBytes: 0,
    },
    backups: { items: [], latest: null },
    daemonLogs: { items: [] },
    costs: {
      summary: { totalCostUsd: 0, totalTokens: 0, items: [] },
      qmd: { totalRuns: 0, compressionPercent: 0, expansionPercent: 0, efficiencyLabel: "neutral" },
    },
  };
  const artifactId = "f5516eff-c559-44fc-99bc-cd96b4429cac";
  const artifactContent =
    "# Offsite checklist\n\n- Confirm the date and venue.\n- Ask about accessibility and dietary needs.\n- Share the agenda and travel details.";
  const artifactHash = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(artifactContent))
    .then((buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  async function artifact() {
    return {
      artifactId,
      workspaceId,
      sessionId,
      turnId,
      providerId: "tutorial",
      model: "Practice model",
      kind: "markdown",
      title: sample.decision === "approved" ? "Offsite checklist" : "Example offsite checklist",
      sourceSurface: "chat",
      version: 1,
      createdAt: now,
      updatedAt: now,
      content: artifactContent,
      contentHash: await artifactHash,
    };
  }
  function task() {
    const approved = sample.decision === "approved";
    return {
      taskId,
      workspaceId,
      revision: sample.decision ? 2 : 1,
      title: "Plan a team offsite",
      description: approved
        ? "The sample guide was searched. The checklist is ready in Library › Artifacts."
        : sample.decision
          ? "Document search was denied. The assistant paused before drafting a checklist."
          : "Waiting for approval to search the offsite planning guide.",
      status: approved ? "done" : sample.decision ? "blocked" : "planning",
      priority: "normal",
      createdBy: "tutorial",
      createdAt: now,
      updatedAt: now,
    };
  }
  const documents = {
    groupId: "knowledge",
    label: "Memory and knowledge",
    description: "Find information saved in the workspace.",
    state: "on",
    risk: "safe",
    tools: [
      {
        toolName,
        description: "Search indexed workspace documents for matching passages.",
        risk: "safe",
        asks: "asks_first",
      },
    ],
  };

  const sample = { active: true, sent: false, decision: null, stage: 0 };
  const eventSources = new Set();
  function notifyInbox() {
    const sequence = Date.now();
    const data = JSON.stringify({
      eventId: "tutorial-inbox-" + sequence,
      sequence,
      timestamp: new Date().toISOString(),
      eventType: "inbox.changed",
      source: "operator_inbox",
      eventAuthority: "retained_stream",
      eventClass: "operational_signal",
      links: { workspaceId },
      payload: { scope: "workspace" },
    });
    for (const source of eventSources) {
      if (source.readyState === 1) source.onmessage?.(new MessageEvent("message", { data }));
    }
  }
  function update(next) {
    if (disposed) return;
    const changedApproval =
      ("sent" in next && next.sent !== sample.sent) || ("decision" in next && next.decision !== sample.decision);
    Object.assign(sample, next);
    changes.dispatchEvent(new Event("change"));
    if (changedApproval) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(notifyInbox, 10);
    }
  }
  function onboarding() {
    return {
      completed: true,
      completedAt: now,
      completedBy: "tutorial",
      currentAccess,
      settings,
      checklist: [],
      setupReadiness: readiness,
      firstTask: { status: "not_observed", checkedAt: now },
    };
  }
  function inbox() {
    return {
      authority: "derived_projection",
      workspaceId,
      generatedAt: now,
      items: sample.active && sample.sent && !sample.decision ? [item] : [],
      coverage: [{ source: "approvals", state: "current" }],
      counts: counts(),
      readStatus: { scope: "browser_local" },
    };
  }
  function json(body, status = 200) {
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
  function list(items = []) {
    return { items, total: items.length };
  }
  async function fetchPractice(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    const route = url.pathname;
    if (disposed) return json({ error: "The practice session ended." }, 410);
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const readBody = () =>
      typeof init?.body === "string" ? JSON.parse(init.body) : input instanceof Request ? input.clone().json() : {};

    if (
      !sample.active &&
      [sessionId, turnId, approvalId, taskId, artifactId].some((id) => route.split("/").includes(id))
    ) {
      return json({ error: "Practice data was cleared." }, 404);
    }

    if (method === "GET") {
      if (route === "/api/v1/startup-reads") {
        const reads = JSON.parse(url.searchParams.get("reads") || "[]");
        return json({
          items: reads.map(() => ({
            status: 200,
            bodyText: "",
            headers: {},
            directReadRequired: true,
          })),
        });
      }
      if (route.startsWith("/health")) return json({ status: "ok", service: "gateway" });
      if (route === "/api/v1/auth/current") return json(currentAccess);
      if (route === "/api/v1/auth/mode") return json({ mode: "none" });
      if (route === "/api/v1/onboarding/startup" || route === "/api/v1/onboarding/state") return json(onboarding());
      if (route === "/api/v1/settings") return json(settings);
      if (route === "/api/v1/observe/health") return json(health);
      if (route === "/api/v1/workspaces")
        return json(list([sample.active ? workspace : { ...workspace, name: "Default workspace" }]));
      if (route === "/api/v1/workspaces/" + workspaceId)
        return json(sample.active ? workspace : { ...workspace, name: "Default workspace" });
      if (route === "/api/v1/citadels") return json(list([citadel]));
      if (route === "/api/v1/citadels/personal") return json(citadel);
      if (route === "/api/v1/citadels/personal/structure")
        return json({
          citadelId: "personal",
          revision: citadel.revision,
          record: citadel,
          charter: null,
          chambers: [],
        });
      if (route === "/api/v1/capabilities/tools")
        return json({
          workspaceId,
          groups: [documents],
          settingsRevision: settings.revision,
          issues: [],
          generatedAt: now,
        });
      if (route === "/api/v1/capabilities/tools/usage")
        return json({
          since: now,
          generatedAt: now,
          tools: [],
          groups: [],
          mostUsed: { kind: "essentials", groupIds: ["knowledge"] },
        });
      if (route === "/api/v1/inbox") return json(inbox());
      if (route === "/api/v1/approvals/" + approvalId) return json(makeApproval());
      if (route === "/api/v1/approvals") return json(list(sample.sent ? [makeApproval()] : []));
      if (route === "/api/v1/tasks") return json(list(sample.active && sample.sent ? [task()] : []));
      if (route === "/api/v1/tasks/" + taskId) return json(task());
      if (route === "/api/v1/chat/generated-artifacts")
        return json(list(sample.active && sample.decision ? [await artifact()] : []));
      if (route === "/api/v1/chat/generated-artifacts/" + artifactId) return json({ item: await artifact() });
      if (route === "/api/v1/chat/sessions") return json(list(sample.active ? [session] : []));
      if (route === "/api/v1/chat/sessions/" + sessionId) return json(session);
      if (route === "/api/v1/chat/sessions/" + sessionId + "/core-state")
        return json({
          sessionId,
          prefs,
          binding: null,
          thread: conversation(),
        });
      if (route === "/api/v1/chat/sessions/" + sessionId + "/thread") return json(conversation());
      if (route === "/api/v1/chat/sessions/" + sessionId + "/status")
        return json({
          schemaVersion: "chat.session-status.v1",
          workspaceId,
          sessionId,
          generatedAt: now,
        });
      if (route === "/api/v1/chat/sessions/" + sessionId + "/messages") {
        const latest = conversation().turns.at(-1)?.assistantMessage;
        return json(list(latest ? [latest] : []));
      }
      if (route === "/api/v1/chat/sessions/" + sessionId + "/prefs") return json(prefs);
      if (route === "/api/v1/chat/tools/approvals")
        return json(list(sample.active && sample.sent && !sample.decision ? [makeApproval()] : []));
      if (route === "/api/v1/llm/config") return json(settings.llm);
      if (route === "/api/v1/llm/models")
        return json({
          providerId: "tutorial",
          source: "live",
          catalogStatus: "fresh",
          items: [{ providerId: "tutorial", id: "Practice model", label: "Practice model" }],
        });
      if (route === "/api/v1/chat/messaging") return json({ items: [], channels: [], connections: [], total: 0 });
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (/\/(?:events|stream)$/.test(route) && /event-stream/.test(headers.get("accept") || "")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": tutorial fixture\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return json(list());
    }

    if (route === "/api/v1/chat/sessions/" + sessionId + "/route-preflight" && method === "POST") {
      const body = await readBody();
      const routing = {
        effectiveProviderId: "tutorial",
        effectiveModel: "Practice model",
        selectionSource: "session",
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        runtimeReachability: "reachable",
        runtimeClass: "local",
      };
      return json({
        ...routing,
        decision: {
          ...routing,
          action: body.action,
          issuedAt: now,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          fingerprint: "tutorial-route",
        },
      });
    }
    const sendRoute = "/api/v1/chat/sessions/" + sessionId + "/agent-send";
    if ((route === sendRoute || route === sendRoute + "/stream") && method === "POST" && sample.active) {
      const body = await readBody();
      if (disposed || sample.sent) return json({ error: "The practice message was already sent." }, 409);
      if (typeof body?.content !== "string" || body.content.trim() !== prompt)
        return json({ error: "Use the example message to continue the tutorial." }, 422);
      update({ sent: true });
      if (route === sendRoute) {
        const { userMessage, assistantMessage, trace } = conversation().turns[0];
        return json({ sessionId, turnId, userMessage, assistantMessage, trace, transport: "llm", model: session.model });
      }
      return stream([
        { type: "message_start", messageId: assistantMessageId, branchKind: "continuation" },
        { type: "delta", messageId: assistantMessageId, delta: waitingReply },
        { type: "approval_required", approval: approvalSummary },
      ]);
    }
    if (route === "/api/v1/approvals/" + approvalId + "/resolve" && method === "POST") {
      const body = await readBody();
      if (
        disposed ||
        !sample.active ||
        !sample.sent ||
        sample.decision ||
        !["approve", "reject"].includes(body.decision)
      ) {
        return json({ error: "The sample request has already been decided." }, 409);
      }
      update({ decision: body.decision === "approve" ? "approved" : "rejected" });
      return json({ approval: makeApproval() });
    }
    if (route === "/api/v1/notifications/presence" && method === "PUT") return json({ published: true });
    return json({ error: "This action is available in your own workspace after the tour." }, 422);
  }

  class PracticeEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = PracticeEventSource.CONNECTING;
    constructor(input) {
      super();
      const url = new URL(input, origin);
      if (disposed || url.pathname !== "/api/v1/events/stream") {
        throw new TypeError("The preview uses only a sample event stream.");
      }
      this.url = url.href;
      this.CONNECTING = PracticeEventSource.CONNECTING;
      this.OPEN = PracticeEventSource.OPEN;
      this.CLOSED = PracticeEventSource.CLOSED;
      eventSources.add(this);
      setTimeout(() => {
        if (this.readyState !== PracticeEventSource.CONNECTING) return;
        this.readyState = PracticeEventSource.OPEN;
        const opened = new Event("open");
        this.onopen?.(opened);
        this.dispatchEvent(opened);
        this.dispatchEvent(new MessageEvent("stream-ready", { data: "{}" }));
      }, 10);
    }
    close() {
      this.readyState = PracticeEventSource.CLOSED;
      eventSources.delete(this);
    }
  }
  return {
    sample,
    update,
    sessionId,
    approvalId,
    taskId,
    prompt,
    changes,
    transport: { fetch: fetchPractice, events: (url) => new PracticeEventSource(url) },
    dispose() {
      disposed = true;
      clearTimeout(refreshTimer);
      Object.assign(sample, { active: false, sent: false, decision: null, stage: 0 });
      for (const source of eventSources) source.close();
    },
  };
}
