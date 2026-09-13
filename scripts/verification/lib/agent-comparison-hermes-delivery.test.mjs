import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { it } from "node:test";
import {
  readHermesComparisonDeliveryState,
  projectHermesComparisonSchedule,
  projectHermesComparisonDelivery,
} from "./agent-comparison-hermes-delivery.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-delivery-evidence-"));
  await mkdir(path.join(root, "cron"));
  return root;
}
function executionDatabase(root, count = 1) {
  const database = new DatabaseSync(path.join(root, "cron", "executions.db"));
  try {
    database.exec("CREATE TABLE executions(id TEXT PRIMARY KEY,job_id TEXT,claimed_at TEXT,status TEXT)");
    const insert = database.prepare("INSERT INTO executions VALUES(?,?,?,?)");
    for (let index = 0; index < count; index++)
      insert.run(String(index), "native-job", "2026-09-12T10:00:00Z", "completed");
  } finally {
    database.close();
  }
}

it("reports absent native stores without creating or repairing them", async () => {
  const root = await fixture();
  assert.deepEqual(await readHermesComparisonDeliveryState(root), {
    jobs: null,
    executions: { status: "missing" },
    queue: { status: "missing" },
  });
  assert.deepEqual(await readdir(path.join(root, "cron")), []);
});

it("reads the original schedule and execution bytes without mutating native state", async () => {
  const root = await fixture(),
    jobs = { jobs: [{ id: "native-job", enabled: false, state: "completed" }] };
  await writeFile(path.join(root, "cron", "jobs.json"), JSON.stringify(jobs));
  executionDatabase(root);
  const filename = path.join(root, "cron", "executions.db"),
    before = await readFile(filename);
  const state = await readHermesComparisonDeliveryState(root);
  assert.deepEqual(state.jobs, jobs);
  assert.equal(state.executions.executions[0].job_id, "native-job");
  assert.deepEqual(await readFile(filename), before);
});

it("retains queued delivery and tombstone evidence independently of executions", async () => {
  const root = await fixture(),
    database = new DatabaseSync(path.join(root, "cron", "deliveries.db"));
  try {
    database.exec(
      "CREATE TABLE deliveries(execution_id TEXT PRIMARY KEY,created_at TEXT,status TEXT); CREATE TABLE delivery_tombstones(execution_id TEXT PRIMARY KEY,terminal_status TEXT)",
    );
    database
      .prepare("INSERT INTO deliveries VALUES(?,?,?)")
      .run("pending-attempt", "2026-09-12T10:00:00Z", "delivering");
    database.prepare("INSERT INTO delivery_tombstones VALUES(?,?)").run("old-attempt", "unknown");
  } finally {
    database.close();
  }
  const state = await readHermesComparisonDeliveryState(root);
  assert.equal(state.queue.deliveries[0].status, "delivering");
  assert.equal(state.queue.tombstones[0].terminal_status, "unknown");
});

it("rejects a truncated execution inventory", async () => {
  const root = await fixture();
  executionDatabase(root, 201);
  await assert.rejects(readHermesComparisonDeliveryState(root), /inventory is incomplete/u);
});

it("waits through a native SQLite writer and returns an unchanged committed snapshot", async () => {
  const root = await fixture();
  executionDatabase(root);
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);
    db.exec('BEGIN EXCLUSIVE');parentPort.postMessage('locked');
    setTimeout(()=>{db.exec('ROLLBACK');db.close();},400);`,
    { eval: true, workerData: path.join(root, "cron", "executions.db") },
  );
  const finished = new Promise((resolve, reject) => {
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("Writer failed."))));
    worker.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  try {
    const state = await readHermesComparisonDeliveryState(root);
    assert.equal(state.executions.executions[0].status, "completed");
    assert.equal(state.executions.executions[0].job_id, "native-job");
  } finally {
    await finished;
  }
});

it("rejects corrupted schedule data instead of repairing it", async () => {
  const root = await fixture(),
    filename = path.join(root, "cron", "jobs.json");
  await writeFile(filename, "{broken");
  await assert.rejects(readHermesComparisonDeliveryState(root), SyntaxError);
  assert.equal(await readFile(filename, "utf8"), "{broken");
});

it("rejects an oversized schedule before parsing", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "cron", "jobs.json"), " ".repeat(1024 * 1024 + 1));
  await assert.rejects(readHermesComparisonDeliveryState(root), /bounded file/u);
});

it("rejects a redirected runtime home", async () => {
  const root = await fixture(),
    parent = await mkdtemp(path.join(os.tmpdir(), "hermes-delivery-link-")),
    link = path.join(parent, "home");
  await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readHermesComparisonDeliveryState(link), /canonical Hermes/u);
});

function deliveryFixture() {
  const due = "2026-09-12T10:00:00.000Z",
    claimed = "2026-09-12T10:00:01.000Z",
    started = "2026-09-12T10:00:02.000Z",
    ack = "2026-09-12T10:00:04.000Z";
  const job = {
    id: "reminder1",
    name: "Controlled reminder",
    prompt: "HARBOR PILOT CHECK",
    skills: [],
    skill: null,
    model: null,
    provider: null,
    provider_snapshot: "custom",
    model_snapshot: "fixture-model",
    base_url: null,
    script: null,
    no_agent: false,
    monitor_script: null,
    monitor_url: null,
    context_from: null,
    schedule: { kind: "once", run_at: due },
    repeat: { times: 1, completed: 0 },
    enabled: true,
    state: "scheduled",
    created_at: "2026-09-12T09:59:00.000Z",
    next_run_at: due,
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_delivery_error: null,
    last_delivery_unverified: null,
    deliver: "telegram:-123456",
    origin: null,
    enabled_toolsets: ["cronjob", "no_mcp"],
    workdir: null,
    attach_to_session: false,
  };
  const created = {
    jobs: { jobs: [job] },
    executions: { status: "retained", executions: [] },
    queue: { status: "missing" },
  };
  const execution = {
    id: "execution1",
    job_id: job.id,
    source: "builtin",
    process_id: "process1",
    pid: 100,
    process_started_at: 999,
    status: "running",
    handoff_pending: 0,
    handoff_started_at: null,
    claimed_at: claimed,
    started_at: started,
    finished_at: null,
    error: null,
    delivery_outcome: null,
    scheduled_instant: due,
  };
  const nativeDispatch = structuredClone(created);
  nativeDispatch.executions.executions.push(execution);
  Object.assign(nativeDispatch.jobs.jobs[0], {
    repeat: { times: 1, completed: 1 },
    run_claim: { at: claimed, by: "fixture-host:100" },
    fire_claim: { at: "2026-09-12T10:00:03.000Z", by: "fixture-host:100:0123456789abcdef0123456789abcdef" },
  });
  const state = structuredClone(created);
  Object.assign(state.jobs.jobs[0], {
    enabled: false,
    state: "completed",
    repeat: { times: 1, completed: 1 },
    next_run_at: null,
    last_run_at: "2026-09-12T10:00:05.000Z",
    last_status: "ok",
    run_claim: null,
    fire_claim: null,
  });
  state.executions.executions.push({
    ...execution,
    status: "completed",
    delivery_outcome: "delivered",
    finished_at: "2026-09-12T10:00:06.000Z",
  });
  return {
    created,
    state,
    authorization: { accountId: "default", target: "-123456", scheduledFor: due },
    model: "fixture-model",
    gatewayIdentity: { pid: 100, start_time: 999 },
    receipts: [
      {
        fixtureOnly: true,
        providerMessageId: "9300",
        accountId: "default",
        destination: "telegram:-123456",
        message: "HARBOR PILOT CHECK",
        nativeDispatch,
        acknowledgedAt: ack,
      },
    ],
  };
}

it("binds a scheduled reminder to its active fire claim, original execution and wire acknowledgement", () => {
  const value = deliveryFixture();
  assert.equal(
    projectHermesComparisonSchedule({ state: value.created, authorization: value.authorization, model: value.model })
      .scheduleId,
    "reminder1",
  );
  assert.deepEqual(projectHermesComparisonDelivery(value), {
    scheduleId: "reminder1",
    executionId: "execution1",
    providerMessageId: "9300",
  });
});

for (const [name, mutate, pattern] of [
  [
    "manual execution",
    (f) => {
      f.state.executions.executions[0].source = "manual";
    },
    /exact scheduled occurrence/u,
  ],
  [
    "foreign process",
    (f) => {
      f.gatewayIdentity.pid = 200;
    },
    /owned process/u,
  ],
  [
    "reused process identifier",
    (f) => {
      f.gatewayIdentity.start_time = 1000;
    },
    /owned process/u,
  ],
  [
    "changed occurrence",
    (f) => {
      f.state.executions.executions[0].scheduled_instant = "2026-09-12T10:00:01.000Z";
    },
    /exact scheduled occurrence/u,
  ],
  [
    "multiple executions",
    (f) => {
      f.state.executions.executions.push({ ...f.state.executions.executions[0], id: "second" });
    },
    /exactly one complete/u,
  ],
  [
    "duplicate acknowledgement",
    (f) => {
      f.receipts.push({ ...f.receipts[0], providerMessageId: "9301" });
    },
    /exactly one independently/u,
  ],
  [
    "changed destination",
    (f) => {
      f.state.jobs.jobs[0].deliver = "telegram:-654321";
    },
    /definition changed/u,
  ],
  [
    "changed send recipient",
    (f) => {
      f.receipts[0].destination = "telegram:-654321";
    },
    /acknowledgement does not match/u,
  ],
  [
    "unverified live receipt",
    (f) => {
      f.receipts[0].fixtureOnly = false;
    },
    /acknowledgement does not match/u,
  ],
  [
    "unknown delivery",
    (f) => {
      f.state.executions.executions[0].delivery_outcome = "unknown";
    },
    /exact scheduled occurrence/u,
  ],
  [
    "queued substitute",
    (f) => {
      f.state.queue = { status: "retained", deliveries: [{ status: "delivered" }] };
    },
    /queued or uncertain/u,
  ],
  [
    "missing fire custody",
    (f) => {
      f.receipts[0].nativeDispatch.jobs.jobs[0].fire_claim = null;
    },
    /active native fire claim/u,
  ],
  [
    "foreign fire claim",
    (f) => {
      f.receipts[0].nativeDispatch.jobs.jobs[0].run_claim.by = "fixture-host:200";
    },
    /active native fire claim/u,
  ],
  [
    "unrelated active execution",
    (f) => {
      f.receipts[0].nativeDispatch.executions.executions[0].id = "unrelated";
    },
    /different native execution/u,
  ],
  [
    "post-completion acknowledgement",
    (f) => {
      f.receipts[0].acknowledgedAt = "2026-09-12T10:00:07.000Z";
    },
    /acknowledgement does not match/u,
  ],
  [
    "rearmed schedule",
    (f) => {
      f.state.jobs.jobs[0].enabled = true;
    },
    /not settled/u,
  ],
  [
    "pre-existing execution",
    (f) => {
      f.created.executions.executions.push({ id: "earlier" });
    },
    /earlier execution/u,
  ],
  [
    "unreviewed script",
    (f) => {
      f.created.jobs.jobs[0].script = "unexpected.py";
    },
    /fresh, bounded/u,
  ],
])
  it(`rejects ${name}`, () => {
    const value = deliveryFixture();
    mutate(value);
    assert.throws(() => projectHermesComparisonDelivery(value), pattern);
  });
