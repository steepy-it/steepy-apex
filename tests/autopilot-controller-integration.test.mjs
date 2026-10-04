// End-to-end matrix for Gear-3 controller protocol 2, its legacy predecessor,
// and recovery between them, driven only through the public CLIs
// (`scripts/autopilot.mjs`, `scripts/autopilot-recovery.mjs`). The conductor's
// real descriptor runner spawns `tests/fixtures/autopilot-controller/fake-harness.mjs`
// through PATH shims in an isolated HOME/XDG/Git sandbox; dispatches are counted
// by the fake's own invocation ledger, never by parsing conductor logs.
//
// Crashes are real process deaths in two forms: the fake SIGKILLs its conductor
// while it is in flight, or an inline host runs the same `main` with an injected
// crash service that SIGKILLs the host at a named controller boundary. Every
// resume is a fresh public CLI process. This is synthetic behavioral evidence of
// the controller runtime; it never certifies a provider, a model, or a skill.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTOPILOT = join(ENGINE, 'scripts', 'autopilot.mjs');
const RECOVERY = join(ENGINE, 'scripts', 'autopilot-recovery.mjs');
const FIXTURES = join(ENGINE, 'tests', 'fixtures', 'autopilot-controller');
const FAKE = join(FIXTURES, 'fake-harness.mjs');
const SPEC = '.apex/work/specs/topic.md';
const PLAN = '.apex/work/plans/topic.md';
const DIR = '.apex/work/tasks/topic';
const NEW_SPEC = '.apex/work/specs/topic-recovery.md';
const NEW_PLAN = '.apex/work/plans/topic-recovery.md';
const NEW_DIR = '.apex/work/tasks/topic-recovery';
const INPUT = `${NEW_DIR}/recovery-input.json`;
const ROUTING = '# Hub\n\n| Surface | Min docs | Specialist agent | Applicable skill |\n|---|---|---|---|\n| `scripts` | [standards/scripts.md](standards/scripts.md) | `scripts-agent` | — |\n';
const RUN_TIMEOUT = 60_000;
// Rows are independent sandboxes; a few run at once to bound the suite's wall time.
const CONCURRENCY = 4;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const specText = (harness) => `<!-- verdict: GAP | gear: 3
drive: autopilot
branch: gear3-topic
commit-auth: per-task
harness: ${harness}
blast-radius: branch-only, no-push, stop-before-PR
-->

# Topic spec

- **Owning surface:** \`scripts\`
- **Feature complexity:** \`integration\`

## Success criteria

1. SC1 — The first value is updated.
2. SC2 — The second value is updated.
`;

function taskSection(id, { command = '`npm test`' } = {}) {
  return `## Task ${id} — update value ${id}

- **Requirements and deliverables:** Set value ${id} to its next number.
- **Relevant global constraints:** Node built-ins only.
- **Surface:** \`scripts\`
- **Specialist agent:** \`scripts-agent\`
- **Exact paths:** \`src/value-${id}.mjs\`
- **Test command:** ${command}
- **Dependencies:** ${id === 1 ? 'none' : 'Task 1'}
- **Complexity:** integration
- **Success criteria:** SC${id}
`;
}

const planText = (tasks, status = 'DRAFT') => `<!-- steepy-workflow: v1
phase: plan
status: ${status}
next: implement
source: ${SPEC}
consumed-by: none
-->
# Plan

${tasks.join('\n')}`;
const ONE_TASK = planText([taskSection(1)]);
const TWO_TASKS = planText([taskSection(1), taskSection(2)]);

// One hermetic sandbox: a sacrificial repository, isolated HOME/XDG/Git
// configuration, a minimal PATH whose first entry holds the fake harness shims,
// and the fake's control directory. Nothing the fake reads or counts lives in the repo.
function sandbox(t, { harness = 'claude', plan = ONE_TASK } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'steepy-controller-cli-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  const control = join(base, 'control');
  for (const dir of [root, home, bin, control]) mkdirSync(dir, { recursive: true });
  // Every supported descriptor name resolves to the fake (which refuses OpenCode's argv), so no real provider can run.
  for (const name of ['claude', 'codex', 'opencode']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const env = {
    PATH: [bin, dirname(gitBin), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    STEEPY_FAKE_CONTROL: control,
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const read = (path) => readFileSync(join(root, path), 'utf8');
  git('init', '-q', '-b', 'gear3-topic');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  put('.gitignore', '.apex/work/\n');
  put('.apex/_INDEX.md', ROUTING);
  put('.apex/standards/scripts.md', '# Scripts\n\n> Owning surface: `scripts`.\n');
  put('.apex/testing-and-checklist.md', '# Tests\n\n`npm test`\n');
  put('.apex/conventions.md', '# Conventions\n');
  for (const id of [1, 2]) put(`src/value-${id}.mjs`, 'export const value = 0;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'baseline');
  put(SPEC, specText(harness));
  const sb = { base, root, home, env, control, git, put, read, exists: (path) => existsSync(join(root, path)) };
  script(sb, { plan });
  return sb;
}

// The fake's script for the next conductor run; its invocation ledger persists.
function script(sb, value) {
  writeFileSync(join(sb.control, 'script.json'), `${JSON.stringify(value)}\n`);
}
const invocations = (sb) => (existsSync(join(sb.control, 'invocations.jsonl'))
  ? readFileSync(join(sb.control, 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const dispatched = (sb) => invocations(sb).map(({ role, task, iteration }) => `${role}${task === null ? '' : `:${task}`}${iteration === null ? '' : `@${iteration}`}`);
const count = (sb, role, task = null) => invocations(sb)
  .filter((item) => item.role === role && (task === null || item.task === String(task))).length;

// A named controller crash runs the same public `main` in an inline host whose
// injected crash service SIGKILLs the host at that boundary; no runner is injected.
const HOST = `const { main } = await import(${JSON.stringify(pathToFileURL(AUTOPILOT).href)});
const target = JSON.parse(process.env.STEEPY_TEST_CRASH);
const code = await main(JSON.parse(process.env.STEEPY_TEST_ARGV), { controllerServices: { crash: (point, detail) => {
  if (point === target.point && Object.entries(target.match).every(([key, value]) => String(detail[key]) === String(value))) process.kill(process.pid, 'SIGKILL');
} } });
process.exit(code);`;

function run(sb, args, { crash } = {}) {
  const [argv, env] = crash === undefined ? [[AUTOPILOT, ...args], sb.env]
    : [['--input-type=module', '-e', HOST], { ...sb.env, STEEPY_TEST_ARGV: JSON.stringify(args), STEEPY_TEST_CRASH: JSON.stringify(crash) }];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: sb.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`conductor exceeded ${RUN_TIMEOUT}ms: ${stderr}`)); }, RUN_TIMEOUT);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}
const START = [SPEC, '--controller-protocol', '2'];
const RESUME = [SPEC];

// The named point was reached: the conductor really died there.
async function crashed(sb, crash, args = START) {
  const result = await run(sb, args, { crash });
  assert.equal(result.signal, 'SIGKILL', `crash point ${JSON.stringify(crash)} was never reached: ${result.stderr}`);
  return result;
}

// A fake whose conductor died ends on its own, within a bound.
async function fakesTerminated(sb) {
  for (const { pid } of invocations(sb)) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      assert.ok(Date.now() < deadline, `fake harness ${pid} did not terminate`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const events = (sb, dir = DIR) => sb.read(`${dir}/autopilot-events.jsonl`).trim().split('\n').map((line) => JSON.parse(line));
const eventNames = (sb, dir = DIR) => events(sb, dir).map(({ event }) => event);
const reservations = (sb, dir = DIR) => events(sb, dir).filter(({ event }) => event === 'ROLE_RESERVED' || event === 'REPAIR_RESERVED');
const accepted = (sb, roleSequence) => events(sb).some((event) => event.event === 'RESULT_ACCEPTED' && event.roleSequence === roleSequence);

function assertCompleted(sb, result, dir = DIR) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /READY_FOR_PR/);
  assert.equal(eventNames(sb, dir).at(-1), 'RUN_COMPLETED');
  assert.match(sb.read(`${dir}/autopilot-status.md`), /^Status: COMPLETED$/m);
  assert.equal(sb.exists('.apex/work/.gear-3-autopilot.lock'), false, 'the lease is released');
}

// A recorded halt: the journal ends in it, the projection shows it, and the
// run never dispatches again.
async function assertHalted(sb, result, reason, { reconciliation }) {
  assert.equal(result.status, 1);
  assert.match(result.stderr, /autopilot: HALTED — /);
  assert.match(result.stderr, reason);
  assert.deepEqual(eventNames(sb).slice(reconciliation ? -2 : -1),
    reconciliation ? ['RECONCILIATION_REQUIRED', 'RUN_HALTED'] : ['RUN_HALTED']);
  assert.match(sb.read(`${DIR}/autopilot-status.md`), /^Status: HALTED$/m);
  const before = invocations(sb).length;
  const again = await run(sb, RESUME);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /controller run halted: /);
  assert.equal(invocations(sb).length, before, 'a halted run never dispatches again');
}

describe('controller protocol 2 through the public CLI', { concurrency: CONCURRENCY }, () => {
  test('a fresh two-task run completes through the real descriptor runner, and a rerun is a no-op', async (t) => {
    const sb = sandbox(t, { plan: TWO_TASKS });
    const result = await run(sb, START);
    assertCompleted(sb, result);
    assert.deepEqual(dispatched(sb), ['plan@1', 'implementer:1@1', 'task-reviewer:1@1', 'implementer:2@1', 'task-reviewer:2@1',
      'final-review@1', 'review@1']);
    assert.equal(reservations(sb).length, invocations(sb).length, 'one reservation per dispatched child');
    for (const record of invocations(sb)) {
      assert.deepEqual([record.harness, record.protocol, record.helpers], ['claude', 2, false]);
      assert.deepEqual(record.env, { HOME: sb.home, XDG_CONFIG_HOME: join(sb.home, '.config'),
        GIT_CONFIG_GLOBAL: sb.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
      assert.equal(record.ppid, invocations(sb)[0].ppid, 'every role is a child of the one conductor');
    }
    for (const reservation of reservations(sb)) {
      const n = reservation.roleSequence;
      const manifest = JSON.parse(sb.read(`${DIR}/context/role-${n}.json`));
      assert.deepEqual([manifest.contract.controllerProtocol, manifest.contract.taskResultProtocol,
        manifest.contract.taskResultIndexProtocol, manifest.contract.reviewerResponseProtocol, manifest.contract.roleSequence], [2, 2, 2, 3, n]);
      // The descriptor applied a concrete model; the synthetic stream's own model claim is never recorded as observed.
      assert.equal(typeof reservation.requestedModel, 'string');
      assert.deepEqual([reservation.descriptorModel, reservation.degradationReason], [reservation.requestedModel, null]);
      assert.equal(invocations(sb)[n - 1].model, reservation.requestedModel, 'the concrete model rides the spawned argv');
      const response = JSON.parse(sb.read(`${DIR}/role-${n}-response.json`));
      assert.equal(response.observedModel, null);
      assert.equal(response.rawDigest, sha(readFileSync(join(sb.root, `${DIR}/role-${n}.raw.jsonl`))), 'the record binds the complete raw capture');
      assert.ok(sb.exists(`${DIR}/role-${n}.log`), 'a readable capture accompanies the raw one');
    }
    assert.match(sb.git('log', '--format=%s'),
      /^steepy autopilot: Task 2 execution 1 \(run [^)]+ role 4\)\nsteepy autopilot: Task 1 execution 1 \(run [^)]+ role 2\)\nbaseline\n$/);
    assert.equal(sb.git('status', '--porcelain'), '');
    const journal = sb.read(`${DIR}/autopilot-events.jsonl`);
    const again = await run(sb, RESUME);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(invocations(sb).length, 7, 'a completed run dispatches nothing');
    assert.equal(sb.read(`${DIR}/autopilot-events.jsonl`), journal);
  });

  test('the Codex descriptor drives the same run through its JSONL transport', async (t) => {
    const sb = sandbox(t, { harness: 'codex' });
    assertCompleted(sb, await run(sb, START));
    assert.deepEqual(dispatched(sb), ['plan@1', 'implementer:1@1', 'task-reviewer:1@1', 'final-review@1', 'review@1']);
    assert.ok(invocations(sb).every((record) => record.harness === 'codex' && typeof record.model === 'string'));
    assert.equal(JSON.parse(sb.read(`${DIR}/role-2-response.json`)).sessionId, 'fake-implementer-2');
  });

  test('(m-5) an inner-backtick test command reaches every task and review role exactly and its fresh evidence is accepted', async (t) => {
    const command = 'X=`echo a_b` npm test';
    const sb = sandbox(t, { plan: planText([taskSection(1, { command })]) });
    assertCompleted(sb, await run(sb, START));
    const manifests = Object.fromEntries(reservations(sb)
      .map(({ role, roleSequence }) => [role, JSON.parse(sb.read(`${DIR}/context/role-${roleSequence}.json`))]));
    for (const role of ['implementer', 'task-reviewer', 'final-review', 'review']) assert.equal(manifests[role].testCommand, command, role);
    assert.ok(sb.read(`${DIR}/evidence-report.md`).includes(`\nCommand JSON: ${JSON.stringify(command)}\n`));
  });
});

describe('crash and resume through a fresh conductor process', { concurrency: CONCURRENCY }, () => {
  for (const [label, crash, continues] of [
    ['before the writer reservation', { point: 'phase-reserved', match: { phase: 'implement' } }, true],
    ['after the writer reservation', { point: 'role-reserved', match: { role: 'implementer' } }, false],
    ['after the writer manifest', { point: 'manifest-published', match: { role: 'implementer' } }, false],
    ['at the writer process return', { point: 'runner-returned', match: { role: 'implementer' } }, false],
    ['after the writer response capture', { point: 'response-captured', match: { role: 'implementer' } }, true],
    ['after the writer receipt', { point: 'task-recorded', match: { role: 'implementer' } }, true],
    ['after the writer acceptance event', { point: 'result-accepted', match: { role: 'implementer' } }, true],
    ['after the reviewer receipt', { point: 'review-checked', match: { role: 'task-reviewer' } }, true],
  ]) {
    test(`a conductor killed ${label} ${continues ? 'resumes without redispatch' : 'halts without redispatch'}`, async (t) => {
      const sb = sandbox(t);
      await crashed(sb, crash);
      const writers = count(sb, 'implementer');
      const result = await run(sb, RESUME);
      assert.match(result.stdout, /autopilot: LOCK_RECOVERED quarantine=\S+ pid=\d+/, 'the dead conductor lease is recovered');
      if (continues) {
        assertCompleted(sb, result);
        assert.deepEqual(dispatched(sb), ['plan@1', 'implementer:1@1', 'task-reviewer:1@1', 'final-review@1', 'review@1'],
          'each role ran once across both processes');
      } else {
        await assertHalted(sb, result, /role 2 implementer Task 1 iteration 1 was reserved without a captured response; refusing to dispatch it again/,
          { reconciliation: true });
        assert.equal(count(sb, 'implementer'), writers, 'the reserved writer is never dispatched again');
        assert.equal(accepted(sb, 2), false, 'an ambiguous writer is never accepted');
        assert.equal(sb.exists(`${DIR}/task-1-execution-1-result.json`), false);
      }
    });
  }

  test('a conductor killed by its in-flight writer halts on resume, and the orphaned child ends on its own', async (t) => {
    const sb = sandbox(t);
    script(sb, { plan: ONE_TASK, steps: { implementer: [{ crash: 'kill-conductor' }] } });
    const first = await run(sb, START);
    assert.equal(first.signal, 'SIGKILL');
    await fakesTerminated(sb);
    const result = await run(sb, RESUME);
    assert.match(result.stdout, /autopilot: LOCK_RECOVERED /);
    await assertHalted(sb, result, /role 2 implementer Task 1 iteration 1 was reserved without a captured response/, { reconciliation: true });
    assert.equal(count(sb, 'implementer'), 1);
    assert.equal(accepted(sb, 2), false);
  });

  test('a proven Task 1 is never redispatched when the conductor dies after Task 2 is captured', async (t) => {
    const sb = sandbox(t, { plan: TWO_TASKS });
    await crashed(sb, { point: 'response-captured', match: { role: 'implementer', roleSequence: 4 } });
    assertCompleted(sb, await run(sb, RESUME));
    assert.deepEqual([count(sb, 'implementer', 1), count(sb, 'implementer', 2), count(sb, 'task-reviewer', 1)], [1, 1, 1]);
  });

  const FENCED = '```text\nstatus: APPROVED\nsignals: none\n```';
  test('a correction reserved without a response halts and is never dispatched', async (t) => {
    const sb = sandbox(t);
    script(sb, { plan: ONE_TASK, steps: { 'task-reviewer': [{ payload: FENCED }] } });
    await crashed(sb, { point: 'role-reserved', match: { role: 'task-review-correction' } });
    const result = await run(sb, RESUME);
    await assertHalted(sb, result, /role 4 task-review-correction Task 1 iteration 1 was reserved without a captured response/, { reconciliation: true });
    assert.deepEqual([count(sb, 'task-reviewer'), count(sb, 'task-review-correction')], [1, 0]);
    assert.equal(reservations(sb).at(-1).event, 'REPAIR_RESERVED');
  });

  test('a corrected response captured before its event is adopted from durable capture without another dispatch', async (t) => {
    const sb = sandbox(t);
    script(sb, { plan: ONE_TASK, steps: { 'task-reviewer': [{ payload: FENCED }] } });
    await crashed(sb, { point: 'response-captured', match: { role: 'task-review-correction' } });
    // The capture file is durable; the event that records it is cut back to the known prefix.
    const lines = sb.read(`${DIR}/autopilot-events.jsonl`).split('\n').filter(Boolean);
    assert.equal(JSON.parse(lines.at(-1)).event, 'RESPONSE_CAPTURED');
    sb.put(`${DIR}/autopilot-events.jsonl`, `${lines.slice(0, -1).join('\n')}\n`);
    assertCompleted(sb, await run(sb, RESUME));
    assert.deepEqual([count(sb, 'task-reviewer'), count(sb, 'task-review-correction')], [1, 1]);
    assert.match(sb.read(`${DIR}/task-result-index.md`), /^Reviewer gate Task 1: \S+task-1-review-guard-attempt-1-iteration-1$/m);
  });
});

describe('a child cannot complete a task without evidence', { concurrency: CONCURRENCY }, () => {
  const STATUS_FORGERY = '# Autopilot status\n\nRun: forged\nStatus: COMPLETED\n2026-10-01T00:00:00.000Z — implement — DONE — run-id=forged attempt=1\n';
  for (const [label, steps, role, reason, reconciliation] of [
    ['a writer that exits 0 after writing only DONE', { implementer: [{ default: false, payload: 'DONE' }] }, 2,
      /role 2 implementer Task 1 iteration 1 response rejected: missing or empty task report/, false],
    ['a writer that rewrites autopilot-status.md instead of producing evidence',
      { implementer: [{ default: false, payload: 'DONE', write: [{ path: `${DIR}/autopilot-status.md`, text: STATUS_FORGERY }] }] }, 2,
      /role 2 implementer Task 1 iteration 1 response rejected: missing or empty task report/, false],
    ['a well-formed writer response whose artifact was never written',
      { implementer: [{ default: false, payload: `status: DONE\nartifact: ${DIR}/task-1-report.md\nsignals: tdd:red-green`,
        write: [{ path: 'src/value-1.mjs', text: 'export const value = 5;\n' }] }] }, 2,
      /role 2 implementer Task 1 iteration 1 response rejected: missing or empty task report/, false],
    ['a reviewer approval without its review report', { 'task-reviewer': [{ default: false, payload: 'status: APPROVED\nsignals: none' }] }, 3,
      /role 3 task-reviewer Task 1 iteration 1 blocked by the reviewer gate: missing or empty review report/, false],
    ['a writer that authors the controller capture itself', { implementer: [{ forgeCapture: true, exit: 1, terminal: 'none' }] }, 2,
      /role 2 implementer Task 1 iteration 1: the child wrote controller capture \.apex\/work\/tasks\/topic\/role-2-response\.json; no terminal response \(missing-terminal\); child exited 1/, true],
    ['(m-4) evidence whose exit codes are all 0 but which records All commands passed: false', { review: [{ evidence: { passed: false } }] }, 5,
      /review evidence rejected: evidence collection did not record all commands passing/, true],
  ]) {
    test(`${label} halts with no acceptance`, async (t) => {
      const sb = sandbox(t);
      script(sb, { plan: ONE_TASK, steps });
      const result = await run(sb, START);
      await assertHalted(sb, result, reason, { reconciliation });
      assert.equal(accepted(sb, role), false);
      assert.equal(eventNames(sb).includes('RUN_COMPLETED'), false);
      assert.doesNotMatch(sb.read(`${DIR}/autopilot-status.md`), /forged|Status: COMPLETED/, 'the projection is regenerated from events');
    });
  }
});

describe('corrupted durable state is refused, never repaired or accepted', { concurrency: CONCURRENCY }, () => {
  const ACCEPTED_WRITER = { point: 'result-accepted', match: { role: 'implementer' } };
  const journalPath = `${DIR}/autopilot-events.jsonl`;
  for (const [label, corrupt, reason] of [
    ['a truncated journal', (sb) => sb.put(journalPath, sb.read(journalPath).slice(0, -40)),
      /autopilot: autopilot state: journal is empty or missing final newline/],
    ['a journal line substituted against its captured evidence', (sb) => {
      const lines = sb.read(journalPath).split('\n').filter(Boolean);
      const index = lines.findIndex((line) => JSON.parse(line).event === 'RESPONSE_CAPTURED');
      lines[index] = JSON.stringify({ ...JSON.parse(lines[index]), responseDigest: 'f'.repeat(64) });
      sb.put(journalPath, `${lines.join('\n')}\n`);
    }, /autopilot: autopilot state: artifact digest mismatch: \.apex\/work\/tasks\/topic\/role-1-response\.json/],
    ['a journal replaced by an earlier valid prefix', (sb) => sb.put(journalPath, `${sb.read(journalPath).split('\n').slice(0, 3).join('\n')}\n`),
      /autopilot: autopilot state: orphan reservation prefix or identity mismatch/],
  ]) {
    test(`${label} is a refusal that leaves the journal untouched and dispatches nothing`, async (t) => {
      const sb = sandbox(t);
      await crashed(sb, ACCEPTED_WRITER);
      corrupt(sb);
      const journal = sb.read(journalPath);
      const before = invocations(sb).length;
      const result = await run(sb, RESUME);
      assert.equal(result.status, 1);
      assert.match(result.stderr, reason);
      assert.equal(sb.read(journalPath), journal);
      assert.equal(invocations(sb).length, before);
    });
  }

  test('a deleted projection is regenerated from events and the run resumes without redispatch', async (t) => {
    const sb = sandbox(t);
    await crashed(sb, ACCEPTED_WRITER);
    rmSync(join(sb.root, `${DIR}/autopilot-status.md`));
    assertCompleted(sb, await run(sb, RESUME));
    assert.equal(count(sb, 'implementer'), 1);
  });

  for (const [label, corrupt, reason] of [
    ['a task report mutated after acceptance', (sb) => sb.put(`${DIR}/task-1-report.md`, `${sb.read(`${DIR}/task-1-report.md`)}Edited after acceptance.\n`),
      /role 3 task-reviewer preparation: task report drift/],
    ['a HEAD moved by an outside commit', (sb) => { sb.put('src/value-2.mjs', 'export const value = 9;\n'); sb.git('commit', '-qam', 'outside commit'); },
      /role 3 task-reviewer preparation: task source snapshot drift/],
    ['an index changed by an outside stage', (sb) => { sb.put('src/value-2.mjs', 'export const value = 9;\n'); sb.git('add', 'src/value-2.mjs'); },
      /role 3 task-reviewer preparation: task source snapshot drift/],
  ]) {
    test(`${label} halts before the reviewer is dispatched`, async (t) => {
      const sb = sandbox(t);
      await crashed(sb, ACCEPTED_WRITER);
      corrupt(sb);
      const result = await run(sb, RESUME);
      await assertHalted(sb, result, reason, { reconciliation: true });
      assert.deepEqual([count(sb, 'implementer'), count(sb, 'task-reviewer')], [1, 0]);
    });
  }

  test('a foreign task receipt from another run halts as replay mismatch without redispatch', async (t) => {
    const sb = sandbox(t);
    const other = sandbox(t);
    const recorded = { point: 'task-recorded', match: { role: 'implementer' } };
    await crashed(sb, recorded);
    await crashed(other, recorded);
    const receipt = `${DIR}/task-1-execution-1-result.json`;
    assert.notEqual(other.read(receipt), sb.read(receipt));
    sb.put(receipt, other.read(receipt));
    const result = await run(sb, RESUME);
    await assertHalted(sb, result, /role 2 implementer Task 1 iteration 1: task result replay mismatch/, { reconciliation: true });
    assert.equal(count(sb, 'implementer'), 1);
    assert.equal(accepted(sb, 2), false);
  });
});

// The legacy fixture, produced by the real protocol-1 driver: two plan tasks,
// Task 1's first execution recorded through the task-result helpers, no review,
// and an incomplete historical status after the child exits 1. Like the real
// halted session's plan, each task repeats its Requirements bullet, a shape
// only the compact parser accepts; the shared fresh-run plans keep one bullet.
async function legacyFixture(t) {
  const plan = planText([taskSection(1), taskSection(2)], 'READY').replace(
    /^- \*\*Requirements and deliverables:\*\* Set value (\d) to its next number\.\n/gm,
    (line, id) => `${line}- **Requirements and deliverables:** Keep the export of value ${id}.\n- **Requirements and deliverables:** Change no other file.\n`);
  const sb = sandbox(t, { plan });
  script(sb, { plan, steps: { implement: [{ helpers: true, exit: 1 }] } });
  const result = await run(sb, [SPEC, '--controller-protocol', '1']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HALTED — run-id=\S+ phase=implement attempt=1: child exited 1/);
  assert.equal(sb.read(PLAN).match(/^- \*\*Requirements and deliverables:\*\*/gm).length, 6, 'the legacy plan keeps its repeated bullets');
  return sb;
}

// The accepted snapshot is observed by a child process in the sandbox
// environment, the same Git configuration the CLIs that consume it see.
const OBSERVE = `const { observeSource } = await import(${JSON.stringify(pathToFileURL(join(ENGINE, 'scripts', 'source-observation.mjs')).href)});
const { head, digest } = observeSource(process.env.STEEPY_OBSERVE_ROOT);
process.stdout.write(JSON.stringify({ head, digest, home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL }));`;
function observeSandbox(sb) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', OBSERVE], { cwd: sb.root,
    env: { ...sb.env, STEEPY_OBSERVE_ROOT: sb.root }, encoding: 'utf8', timeout: RUN_TIMEOUT, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.deepEqual([observation.home, observation.gitConfig], [sb.home, sb.env.GIT_CONFIG_GLOBAL], 'observed with the sandbox environment');
  return observation;
}

function writeRecoveryInput(sb, { manifest = `${DIR}/context/phase-implement-attempt-1.json` } = {}) {
  const digest = (path) => sha(readFileSync(join(sb.root, path)));
  const observation = observeSandbox(sb);
  const receipt = `${DIR}/task-1-execution-1-result.json`;
  sb.put(INPUT, `${JSON.stringify({
    schemaVersion: 1,
    source: { run: DIR, spec: { path: SPEC, sha256: digest(SPEC) }, plan: { path: PLAN, sha256: digest(PLAN) },
      manifests: [{ path: manifest, sha256: digest(manifest) }], receipts: [{ task: '1', path: receipt, sha256: digest(receipt) }] },
    reuse: ['1'],
    current: { branch: 'gear3-topic', head: observation.head, observation: observation.digest, delta: [] },
    destination: { spec: NEW_SPEC, plan: NEW_PLAN, run: NEW_DIR },
  }, null, 2)}\n`);
}

const recoveryCli = (sb, action) => spawnSync(process.execPath, [RECOVERY, action, '--repo-root', sb.root, '--recovery-input', INPUT],
  { cwd: sb.root, env: sb.env, encoding: 'utf8', timeout: RUN_TIMEOUT, killSignal: 'SIGKILL' });

// Digests of the legacy spec, plan, and every file of the sandbox's legacy run.
const legacyBytes = (sb) => Object.fromEntries([SPEC, PLAN, ...readdirSync(join(sb.root, DIR), { recursive: true }).map((name) => `${DIR}/${name}`)]
  .filter((path) => statSync(join(sb.root, path)).isFile()).map((path) => [path, sha(readFileSync(join(sb.root, path)))]));

async function preparedRecovery(t) {
  const sb = await legacyFixture(t);
  writeRecoveryInput(sb);
  const inspected = recoveryCli(sb, 'inspect');
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout).tasks, [
    { task: '1', class: 'import', review: 'pending', receipt: `${DIR}/task-1-execution-1` },
    { task: '2', class: 'residual', review: null, receipt: null },
  ]);
  const prepared = recoveryCli(sb, 'prepare');
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout).prepared, [NEW_SPEC, NEW_PLAN]);
  assert.match(sb.read(NEW_PLAN),
    /^transformation: lifecycle [^\n]*; Task 1 Requirements and deliverables: 3 bullets merged in order; Task 2 Requirements and deliverables: 3 bullets merged in order$/m);
  return sb;
}
const RECOVER = [NEW_SPEC, '--recovery-input', INPUT];
const recoveryDispatches = (sb) => invocations(sb).filter((item) => item.protocol === 2);

describe('legacy protocol 1 and recovery into protocol 2', { concurrency: CONCURRENCY }, () => {
  test('a lazy child that calls no helper halts under protocol 1 but completes under protocol 2, where the controller owns the helpers', async (t) => {
    const legacy = sandbox(t, { plan: planText([taskSection(1), taskSection(2)], 'READY') });
    const halted = await run(legacy, [SPEC, '--controller-protocol', '1']);
    assert.equal(halted.status, 1);
    assert.match(halted.stderr,
      /HALTED — run-id=\S+ phase=implement attempt=1: reviewer evidence rejected: work path: missing work artifact '\.apex\/work\/tasks\/topic\/task-result-index\.md'/);
    assert.deepEqual(invocations(legacy).map(({ protocol, role, helpers }) => [protocol, role, helpers]), [[1, 'plan', false], [1, 'implement', false]]);
    const status = legacy.read(`${DIR}/autopilot-status.md`);
    assert.match(status, /— CONDUCTOR — STATUS_PROTOCOL — version=1$/m);
    assert.match(status, /— implement — DONE — run-id=/, 'the child claimed completion');
    assert.doesNotMatch(status, /PHASE_ACCEPTED — run-id=\S+ phase=implement/, 'the claim alone never completes the phase');
    assert.equal(legacy.exists(`${DIR}/autopilot-run.json`), false);
    const converted = await run(legacy, START);
    assert.equal(converted.status, 1);
    assert.match(converted.stderr, /the existing run uses controller protocol 1; refusing incompatible controller protocol 2/);
    assert.equal(legacy.read(`${DIR}/autopilot-status.md`), status, 'the legacy run keeps its own path and bytes');
    assert.equal(legacy.exists(`${DIR}/autopilot-run.json`), false, 'the refused start created no run identity');

    const controlled = sandbox(t, { plan: TWO_TASKS });
    assertCompleted(controlled, await run(controlled, START));
    assert.ok(invocations(controlled).every(({ protocol, helpers }) => protocol === 2 && helpers === false));
    for (const task of [1, 2]) {
      assert.ok(controlled.exists(`${DIR}/task-${task}-execution-1-result.json`), 'the controller recorded the receipt');
      assert.ok(controlled.exists(`${DIR}/task-${task}-review-guard-attempt-1-iteration-1-original.json`), 'the controller gated the review');
    }
  });

  test('a recovery run imports the legacy execution, reviews it without a writer, implements only the residual task, and leaves the legacy run intact', async (t) => {
    const sb = await preparedRecovery(t);
    assert.deepEqual(invocations(sb).map(({ protocol, role }) => [protocol, role]), [[1, 'plan'], [1, 'implement']]);
    assert.doesNotMatch(sb.read(`${DIR}/autopilot-status.md`), /PHASE_ACCEPTED — run-id=\S+ phase=implement/, 'the historical status is incomplete');
    assert.equal(sb.exists(`${DIR}/task-2-execution-1-result.json`), false);
    const before = legacyBytes(sb);
    const result = await run(sb, RECOVER);
    assertCompleted(sb, result, NEW_DIR);
    assert.deepEqual(recoveryDispatches(sb).map(({ role, task }) => `${role}${task === null ? '' : `:${task}`}`),
      ['task-reviewer:1', 'implementer:2', 'task-reviewer:2', 'final-review', 'review']);
    assert.deepEqual(eventNames(sb, NEW_DIR).slice(0, 3), ['RUN_STARTED', 'RECOVERY_IMPORTED', 'PHASE_RESERVED']);
    assert.equal(JSON.parse(sb.read(`${NEW_DIR}/autopilot-run.json`)).recovery.sha256, sha(readFileSync(join(sb.root, INPUT))));
    const reviewer = reservations(sb, NEW_DIR).find(({ role }) => role === 'task-reviewer');
    const manifest = JSON.parse(sb.read(`${NEW_DIR}/context/role-${reviewer.roleSequence}.json`));
    assert.deepEqual([manifest.contract.taskResultIndexProtocol, manifest.contract.reviewedEvidence, manifest.contract.recoveryInputDigest],
      [3, 'import', sha(readFileSync(join(sb.root, INPUT)))]);
    const index = sb.read(`${NEW_DIR}/task-result-index.md`);
    assert.match(index, /^<!-- steepy-task-results: v3 -->$/m);
    assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(index)[1]).map(({ task, kind }) => [task, kind]), [['1', 'import'], ['2', 'execution']]);
    assert.deepEqual(legacyBytes(sb), before, 'the legacy fixture is byte-for-byte intact');
  });

  test('a recovery run killed after the residual writer is captured resumes without any writer for the imported task', async (t) => {
    const sb = await preparedRecovery(t);
    await crashed(sb, { point: 'response-captured', match: { role: 'implementer' } }, RECOVER);
    const refused = await run(sb, RECOVER);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--recovery-input starts a new recovery run; the existing run resumes from its journal without it/);
    assertCompleted(sb, await run(sb, [NEW_SPEC]), NEW_DIR);
    const writers = recoveryDispatches(sb).filter(({ role }) => role === 'implementer');
    assert.deepEqual([writers.filter(({ task }) => task === '1').length, writers.filter(({ task }) => task === '2').length], [0, 1]);
    assert.equal(eventNames(sb, NEW_DIR).filter((event) => event === 'RECOVERY_IMPORTED').length, 1);
  });
});

describe('carry-forward boundaries through the public CLIs', { concurrency: CONCURRENCY }, () => {
  const runArtifacts = [`${DIR}/autopilot-run.json`, `${DIR}/autopilot-events.jsonl`, `${DIR}/role-1-reservation.json`];
  const headered = (status) => specText('claude').replace('-->\n\n# Topic spec',
    `-->\n<!-- steepy-workflow: v1\nphase: brainstorm\nstatus: ${status}\nnext: plan\nsource: none\nconsumed-by: none\n-->\n\n# Topic spec`);

  test('a pre-effect refusal creates no run identity, and the corrected start runs from role 1', async (t) => {
    const sb = sandbox(t);
    sb.put('src/extra.mjs', 'export const extra = 1;\n');
    const dirty = await run(sb, START);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /refusing to drive \S+: the working tree has uncommitted changes/);
    rmSync(join(sb.root, 'src/extra.mjs'));
    sb.put(SPEC, headered('DRAFT'));
    const draft = await run(sb, START);
    assert.equal(draft.status, 1);
    assert.match(draft.stderr, /autopilot: refused — spec lifecycle is not a READY brainstorm input/);
    assert.doesNotMatch(draft.stderr, /HALTED/);
    for (const path of runArtifacts) assert.equal(sb.exists(path), false, `${path} after a pre-effect refusal`);
    assert.equal(invocations(sb).length, 0);
    sb.put(SPEC, headered('READY'));
    assertCompleted(sb, await run(sb, START));
    assert.equal(reservations(sb)[0].role, 'plan', 'the refusals spent no role identity');
    assert.equal(reservations(sb)[0].roleSequence, 1);
  });

  test('a pending response file that does not bind the raw capture is refused, never adopted or redispatched', async (t) => {
    const sb = sandbox(t);
    await crashed(sb, { point: 'response-captured', match: { role: 'implementer' } });
    const lines = sb.read(`${DIR}/autopilot-events.jsonl`).split('\n').filter(Boolean);
    assert.equal(JSON.parse(lines.at(-1)).event, 'RESPONSE_CAPTURED');
    sb.put(`${DIR}/autopilot-events.jsonl`, `${lines.slice(0, -1).join('\n')}\n`);
    const record = JSON.parse(sb.read(`${DIR}/role-2-response.json`));
    sb.put(`${DIR}/role-2-response.json`, `${JSON.stringify({ ...record, rawDigest: '0'.repeat(64) })}\n`);
    const result = await run(sb, RESUME);
    await assertHalted(sb, result, /role 2 implementer Task 1 iteration 1 was reserved without a captured response; refusing to adopt an uncorroborated response file or dispatch it again/,
      { reconciliation: true });
    assert.equal(count(sb, 'implementer'), 1);
    assert.equal(accepted(sb, 2), false);
  });

  test('a protocol-2 source run is refused by name by inspect, prepare, and the recovery start', async (t) => {
    const sb = sandbox(t);
    assertCompleted(sb, await run(sb, START));
    writeRecoveryInput(sb, { manifest: `${DIR}/context/role-2.json` });
    const before = invocations(sb).length;
    for (const action of ['inspect', 'prepare']) {
      const refused = recoveryCli(sb, action);
      assert.equal(refused.status, 1, action);
      assert.match(refused.stderr, /autopilot-recovery: controller protocol 2 source runs are not importable/, action);
    }
    assert.equal(sb.exists(NEW_SPEC), false, 'prepare wrote no copy');
    // A hand-made destination spec gets the start past the CLI to the controller, which refuses the source by name too.
    sb.put(NEW_SPEC, sb.read(SPEC));
    const started = await run(sb, RECOVER);
    assert.equal(started.status, 1);
    assert.match(started.stderr, /autopilot: refused — recovery input: controller protocol 2 source runs are not importable/);
    for (const path of [NEW_PLAN, `${NEW_DIR}/autopilot-run.json`, `${NEW_DIR}/autopilot-events.jsonl`, `${NEW_DIR}/task-1-import.json`]) {
      assert.equal(sb.exists(path), false, path);
    }
    assert.equal(invocations(sb).length, before);
  });

  test('an index projection of protocol 3 is refused in a run that was not started from a recovery input', async (t) => {
    const sb = sandbox(t);
    await crashed(sb, { point: 'result-accepted', match: { role: 'implementer' } });
    const index = `${DIR}/task-result-index.md`;
    sb.put(index, `${sb.read(index)}<!-- steepy-task-results: v3 -->\n\`\`\`json\n[]\n\`\`\`\n<!-- /steepy-task-results -->\n`);
    const result = await run(sb, RESUME);
    await assertHalted(sb, result, /task result index protocol 3 does not match required protocol 2/, { reconciliation: true });
    assert.deepEqual([count(sb, 'implementer'), count(sb, 'final-review'), count(sb, 'review')], [1, 0, 0]);
    assert.equal(eventNames(sb).includes('RUN_COMPLETED'), false);
  });

  // The review role resumes a captured response without re-projecting the index,
  // so a planted v2 entry reaches the evidence gate exactly as written.
  test('a v2 index entry of kind import is refused in a run that was not started from a recovery input', async (t) => {
    const sb = sandbox(t);
    await crashed(sb, { point: 'response-captured', match: { role: 'review' } });
    const index = `${DIR}/task-result-index.md`;
    const text = sb.read(index);
    const block = /```json\n([\s\S]*?)\n```/.exec(text);
    const entries = JSON.parse(block[1]);
    entries[0] = { ...entries[0], kind: 'import' };
    sb.put(index, text.replace(block[1], JSON.stringify(entries, null, 2)));
    const before = invocations(sb).length;
    const result = await run(sb, RESUME);
    await assertHalted(sb, result, /review evidence rejected: invalid task result projection entry schema/, { reconciliation: true });
    assert.equal(invocations(sb).length, before, 'no dispatch after the refusal');
    assert.equal(eventNames(sb).includes('RUN_COMPLETED'), false);
    assert.match(sb.read(index), /"kind": "import"/, 'the refused entry is left for reconciliation, never re-projected away');
  });

  test('an import registered in a run that was not started from a recovery input halts without any writer', async (t) => {
    const sb = sandbox(t);
    await crashed(sb, { point: 'phase-reserved', match: { phase: 'implement' } });
    const importPath = `${DIR}/task-1-import.json`;
    sb.put(importPath, '{"kind":"import"}\n');
    const last = events(sb).at(-1);
    const forged = { schemaVersion: 2, sequence: last.sequence + 1, runId: last.runId, timestamp: new Date().toISOString(),
      event: 'RECOVERY_IMPORTED', scope: { phase: 'implement', attempt: 1, task: 1, iteration: 1 }, importPath,
      importDigest: sha(readFileSync(join(sb.root, importPath))) };
    sb.put(`${DIR}/autopilot-events.jsonl`, `${sb.read(`${DIR}/autopilot-events.jsonl`)}${JSON.stringify(forged)}\n`);
    const result = await run(sb, RESUME);
    await assertHalted(sb, result, /recovery imports exist in a run that was not started from a recovery input/, { reconciliation: true });
    assert.equal(count(sb, 'implementer'), 0);
  });

  test('the first fix after an import is execution 2, linked to the import, with no execution-1 writer', async (t) => {
    const sb = await preparedRecovery(t);
    script(sb, { plan: '', steps: { 'task-reviewer': [{ verdict: 'ISSUES_FOUND' }] } });
    assertCompleted(sb, await run(sb, RECOVER), NEW_DIR);
    assert.deepEqual(recoveryDispatches(sb).map(({ role, task, iteration }) => `${role}${task === null ? '' : `:${task}`}@${iteration}`),
      ['task-reviewer:1@1', 'fix:1@2', 'task-reviewer:1@2', 'implementer:2@1', 'task-reviewer:2@1', 'final-review@1', 'review@1']);
    assert.equal(sb.exists(`${NEW_DIR}/task-1-execution-1-result.json`), false, 'the import stands in for execution 1');
    assert.ok(sb.exists(`${NEW_DIR}/task-1-execution-2-result.json`));
    const baseline = JSON.parse(sb.read(`${NEW_DIR}/task-1-execution-2-baseline.json`));
    assert.deepEqual([baseline.config.role, baseline.config.execution, baseline.config.previousImport, baseline.config.previousState],
      ['fix', 2, `${NEW_DIR}/task-1-import.json`, null]);
    assert.equal(baseline.previousDigest, sha(readFileSync(join(sb.root, `${NEW_DIR}/task-1-import.json`))));
    const index = sb.read(`${NEW_DIR}/task-result-index.md`);
    assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(index)[1]).map(({ task, kind }) => [task, kind]), [['1', 'execution'], ['2', 'execution']]);
  });
});

// The driver runs here only in a sandbox: an explicit minimal environment with
// no npm lifecycle, a temporary HOME, and PATH shims that answer `--version`
// and otherwise run the fake harness. No provider binary is reachable.
describe('the opt-in native smoke driver, without any provider', { concurrency: CONCURRENCY }, () => {
  const DRIVER = join(FIXTURES, 'native-smoke.mjs');
  const NATIVE_PLAN = `<!-- steepy-workflow: v1\nphase: plan\nstatus: DRAFT\nnext: implement\nsource: .apex/work/specs/native-smoke.md\nconsumed-by: none\n-->
# Plan

## Task 1 — punctuate the greeting

- **Requirements and deliverables:** greet returns Hello, <name>!.
- **Relevant global constraints:** Node built-ins only.
- **Surface:** \`src\`
- **Specialist agent:** \`src-agent\`
- **Exact paths:** \`src/greeting.mjs\`
- **Test command:** \`npm test\`
- **Dependencies:** none
- **Complexity:** mechanical
- **Success criteria:** SC1
`;

  function driverSandbox(t) {
    const base = mkdtempSync(join(tmpdir(), 'steepy-native-driver-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const [bin, home, control] = ['bin', 'home', 'control'].map((name) => join(base, name));
    for (const dir of [bin, home, control]) mkdirSync(dir, { recursive: true });
    for (const name of ['claude', 'codex', 'opencode']) {
      writeFileSync(join(bin, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo version >> ${JSON.stringify(join(control, 'versions.log'))}; echo "fake-${name} 0.0.0 (synthetic)"; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(control, 'script.json'), `${JSON.stringify({ plan: NATIVE_PLAN })}\n`);
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const env = {
      PATH: [bin, dirname(gitBin), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: tmpdir(),
      GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', STEEPY_FAKE_CONTROL: control,
    };
    writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    const drive = (args, extra = {}, script = DRIVER) => spawnSync(process.execPath, [script, ...args], {
      env: { ...env, ...extra }, encoding: 'utf8', timeout: RUN_TIMEOUT * 2, killSignal: 'SIGKILL' });
    // A payload with only the three files the driver requires before any effect.
    const minimalPayload = () => {
      const payload = join(base, 'payload');
      for (const path of ['scripts/autopilot.mjs', 'scripts/autopilot-runtime.mjs', 'adapters/headless.mjs']) {
        mkdirSync(dirname(join(payload, path)), { recursive: true });
        writeFileSync(join(payload, path), '// stub\n');
      }
      return payload;
    };
    const listing = (dir) => readdirSync(dir, { recursive: true }).sort();
    const harnessCalls = () => (existsSync(join(control, 'versions.log')) ? readFileSync(join(control, 'versions.log'), 'utf8').split('\n').filter(Boolean).length : 0)
      + (existsSync(join(control, 'invocations.jsonl')) ? readFileSync(join(control, 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0);
    return { base, bin, control, drive, minimalPayload, listing, harnessCalls };
  }

  // Node runs the main module from its realpath; a symlinked invocation must still run main.
  test('invoked through a symlinked path it still runs and refuses without --execute', (t) => {
    const sb = driverSandbox(t);
    const link = join(sb.base, 'native-smoke.mjs');
    symlinkSync(DRIVER, link);
    const evidence = join(sb.base, 'evidence');
    const refused = sb.drive(['--engine-root', sb.minimalPayload(), '--evidence', evidence], {}, link);
    assert.equal(refused.status, 2, 'main ran: a skipped main would exit 0 silently');
    assert.match(refused.stderr, /native-smoke: refusing to run without the explicit '--execute' option/);
    assert.equal(existsSync(evidence), false);
    assert.equal(sb.harnessCalls(), 0);
  });

  test('it parses and no suite imports it', () => {
    const checked = spawnSync(process.execPath, ['--check', DRIVER], { encoding: 'utf8', timeout: RUN_TIMEOUT, killSignal: 'SIGKILL' });
    assert.equal(checked.status, 0, checked.stderr);
    for (const name of readdirSync(join(ENGINE, 'tests')).filter((file) => file.endsWith('.test.mjs'))) {
      const suite = readFileSync(join(ENGINE, 'tests', name), 'utf8');
      assert.doesNotMatch(suite, /^\s*import\s[^;]*native-smoke|\bimport\(\s*[^)]*native-smoke/m, `${name} must not import the native smoke driver`);
    }
  });

  for (const [label, args, extra, reason] of [
    ['without --execute', [], {}, /native-smoke: refusing to run without the explicit '--execute' option/],
    ['inside an npm test lifecycle', ['--execute'], { npm_lifecycle_event: 'test' }, /native-smoke: refusing to run inside an npm test lifecycle/],
  ]) {
    test(`${label} it refuses with exit 2 before any effect`, (t) => {
      const sb = driverSandbox(t);
      const evidence = join(sb.base, 'evidence');
      const refused = sb.drive([...args, '--engine-root', sb.minimalPayload(), '--evidence', evidence], extra);
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, reason);
      assert.equal(existsSync(evidence), false, 'no evidence directory');
      assert.equal(sb.harnessCalls(), 0, 'no harness lookup');
    });
  }

  test('an evidence directory inside the payload is refused before it is created', (t) => {
    const sb = driverSandbox(t);
    const payload = sb.minimalPayload();
    const before = sb.listing(payload);
    const refused = sb.drive(['--execute', '--engine-root', payload, '--evidence', join(payload, 'ev', 'nested')]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^native-smoke: evidence directory must be outside the engine root\n$/);
    assert.equal(existsSync(join(payload, 'ev')), false);
    assert.deepEqual(sb.listing(payload), before, 'the frozen payload is untouched');
    assert.equal(sb.harnessCalls(), 0);
  });

  test('a payload holding a symlink is a clean refusal before any evidence', (t) => {
    const sb = driverSandbox(t);
    const payload = sb.minimalPayload();
    symlinkSync('autopilot.mjs', join(payload, 'scripts', 'link.mjs'));
    const evidence = join(sb.base, 'evidence');
    const refused = sb.drive(['--execute', '--engine-root', payload, '--evidence', evidence]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^native-smoke: the frozen payload must hold only ordinary files and directories: scripts\/link\.mjs\n$/);
    assert.doesNotMatch(refused.stderr, /^\s+at /m, 'no stack trace');
    assert.equal(existsSync(evidence), false);
    assert.equal(sb.harnessCalls(), 0);
  });

  test('a substituted harness never yields a native PASS, and response payloads stay out of the evidence', (t) => {
    const sb = driverSandbox(t);
    const payload = join(sb.base, 'frozen');
    for (const entry of ['scripts', 'adapters', 'skills', '.claude-plugin', '.codex-plugin', 'package.json', 'cordis.patch.yml']) {
      cpSync(join(ENGINE, entry), join(payload, entry), { recursive: true });
    }
    const evidence = join(sb.base, 'evidence');
    const result = sb.drive(['--execute', '--engine-root', payload, '--evidence', evidence, '--timeout-ms', String(RUN_TIMEOUT)]);
    assert.equal(result.status, 1, 'only a PASS exits 0');
    const summary = JSON.parse(readFileSync(join(evidence, 'native-smoke.json'), 'utf8'));
    assert.deepEqual([summary.result, summary.observation], ['NOT NATIVE', 'substituted']);
    assert.equal(summary.harnessVersion.path, join(sb.bin, 'codex'));
    assert.deepEqual([summary.run.status, summary.run.fingerprintBound, summary.engine.immutable], ['RUN_COMPLETED', true, true]);
    assert.ok(summary.descriptorShapes && !Object.hasOwn(summary, 'descriptors'), 'descriptor shapes are named as a re-derivation');
    assert.deepEqual(summary.roles.map(({ role, accepted: done }) => [role, done]), [['plan', true], ['implementer', true], ['final-review', true], ['review', true]]);
    for (const role of summary.roles) {
      assert.equal(typeof role.requestedModel, 'string', 'the applied selection comes from the reservation');
      assert.deepEqual(Object.keys(role.response).sort(), ['bytes', 'capturePersisted', 'exit', 'observedModel', 'rawDigest', 'sessionId', 'sha256', 'terminalReason', 'transportError']);
      assert.equal(typeof role.raw.sha256, 'string');
    }
    const copied = sb.listing(evidence);
    assert.ok(copied.includes(join('run', 'autopilot-events.jsonl')) && copied.includes(join('run', 'role-2-reservation.json')));
    assert.deepEqual(copied.filter((path) => /-response\.json$|\.raw\.jsonl$/.test(path)), [], 'payload-bearing captures are recorded by digest only');
    const payloadText = 'status: DONE\nartifact: .apex/work/tasks/native-smoke/task-1-report.md\nsignals: tdd:red-green';
    for (const path of copied.filter((entry) => statSync(join(evidence, entry)).isFile())) {
      const text = readFileSync(join(evidence, path), 'utf8');
      assert.ok(!text.includes(payloadText) && !text.includes(JSON.stringify(payloadText).slice(1, -1)), `${path} must not carry the verbatim writer payload`);
    }
  });
});
