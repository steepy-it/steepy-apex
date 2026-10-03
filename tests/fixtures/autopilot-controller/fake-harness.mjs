// Controllable stand-in for a headless harness binary in the controller
// integration matrix. A test places `claude` and `codex` shims
// (`exec node fake-harness.mjs "$@"`) first on PATH, so the conductor's real
// descriptor and managed runner spawn this file instead of a provider. It is
// synthetic: nothing it does is native evidence of a provider or model.
//
// Control lives outside the repository, in the directory named by
// STEEPY_FAKE_CONTROL:
//   script.json       written by the test before each conductor run
//   invocations.jsonl appended (and fsynced) here before any effect, one record
//                     per invocation: the dispatch counter, independent of logs
//
// script.json:
//   plan              plan text the default plan role (or legacy plan phase) writes
//   steps             { "<role>": [step, ...] } — the Nth invocation of a role
//                     takes step N-1 (counted from invocations.jsonl); absent
//                     steps use the role's default behavior
// A step may set:
//   default: false    skip the role's default effects
//   payload           string terminal response, or null for no terminal event
//   evidence          review evidence overrides { command, surfaceExit, hubExit, passed }
//   write             [{ path, text }] extra repository-relative writes
//   terminal          'success' (default) | 'none'
//   exit              process exit code (default 0)
//   crash             'kill-conductor' — SIGKILL the conductor after the
//                     effects, before any terminal event, then exit at once
//   forgeCapture      write the controller's role-N-response.json itself
//   helpers           legacy implement only, see below
// Controller roles never call a task-result or reviewer helper: the controller
// owns them. Legacy phase prompts (controller protocol 1) get a deliberately
// lazy child too: it writes its artifacts and the phase completion marker but
// calls no helper, unless the step sets `helpers: true` for an implement phase
// (which then records Task 1 through the real helpers, standing in for a
// diligent child interrupted before any review).
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const control = process.env.STEEPY_FAKE_CONTROL;
if (!control) {
  process.stderr.write('fake-harness: STEEPY_FAKE_CONTROL is required\n');
  process.exit(64);
}
const argv = process.argv.slice(2);
const harness = argv.includes('-p') ? 'claude' : argv.includes('exec') ? 'codex' : null;
if (harness === null) {
  process.stderr.write(`fake-harness: unrecognized argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
const prompt = harness === 'claude' ? argv[argv.indexOf('-p') + 1] : argv.at(-1);
const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null;
const cwd = process.cwd();
const script = JSON.parse(readFileSync(join(control, 'script.json'), 'utf8'));
const ledger = join(control, 'invocations.jsonl');

const controller = /^Steepy controller protocol 2 role ([a-z-]+): run-id `([^`]+)`, role-sequence `(\d+)`/.exec(prompt);
const legacy = /Invoke the steepy-apex '(plan|implement|review)' skill/.exec(prompt);
const manifestPath = /Context manifest: (\S+) \(authoritative input inventory\)/.exec(prompt)?.[1] ?? null;
if ((!controller && !legacy) || manifestPath === null) {
  process.stderr.write('fake-harness: prompt names no controller role or legacy phase with a manifest\n');
  process.exit(64);
}
const manifest = JSON.parse(readFileSync(join(cwd, manifestPath), 'utf8'));
const role = controller ? controller[1] : legacy[1];
const roleSequence = controller ? Number(controller[3]) : null;
const runId = controller ? controller[2] : /run-id `([^`]+)`/.exec(prompt)?.[1];
const task = manifest.scope?.task === undefined || manifest.scope.task === null ? null : String(manifest.scope.task);
const iteration = /iteration `(\d+)`/.exec(prompt)?.[1] ?? null;

const prior = existsSync(ledger)
  ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const step = script.steps?.[role]?.[prior.filter((record) => record.role === role).length] ?? {};

// The dispatch counter is durable before any effect, so a crash mid-effect counts.
const record = {
  pid: process.pid, ppid: process.ppid, harness, protocol: controller ? 2 : 1, role, roleSequence, task,
  iteration: iteration === null ? null : Number(iteration), model, runId, helpers: step.helpers === true,
  env: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((name) => [name, process.env[name] ?? null])),
};
const fd = openSync(ledger, 'a');
try {
  writeSync(fd, `${JSON.stringify(record)}\n`);
  fsyncSync(fd);
} finally {
  closeSync(fd);
}

const put = (path, text) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const runDir = manifestPath.slice(0, manifestPath.indexOf('/context/'));
const specName = runDir.split('/').at(-1);
const outputs = manifest.outputs ?? [];

// capture-review-evidence.mjs layout for the manifest's exact test command. This
// is a fourth copy of the builder in the autopilot, autopilot-controller, and
// autopilot-recovery suites; it is flagged, not extracted, in this task.
function evidenceReport({ command = manifest.testCommand ?? script.testCommand ?? 'npm test', surfaceExit = 0, hubExit = 0, passed } = {}) {
  const started = new Date().toISOString();
  const section = (label, display, exit) => {
    const output = `${label} output\n`;
    return `\n## ${label}\n\nCommand JSON: ${JSON.stringify(display)}\nStarted: ${started}\n\n--- combined stdout/stderr begin ---\n${output}`
      + `\n--- combined stdout/stderr end ---\n\nExit code: ${exit}\nSignal: none\nSpawn error: none\nOutput bytes: ${Buffer.byteLength(output)}\n`
      + `Output lines: 1\nOutput SHA-256: ${sha(output)}\nFinished: ${started}\n`;
  };
  return `# Review evidence\n\nRun started: ${started}\nCapture: combined stdout/stderr bytes are persisted in arrival order.\n`
    + section('surface-test', command, surfaceExit) + section('validate-hub', '"node" "scripts/validate-hub.mjs" .', hubExit)
    + `## Collection result\n\nRun finished: ${started}\nAll commands passed: ${passed ?? (surfaceExit === 0 && hubExit === 0)}\n`;
}

// The task brief is the first required input of a writer manifest.
const exactPath = () => {
  const brief = readFileSync(join(cwd, manifest.required[0].path), 'utf8');
  return /^- \*\*Exact paths:\*\* `([^`]+)`/m.exec(brief)[1];
};
const invocationNumber = prior.length + 1;

const DEFAULTS = {
  plan: () => { put(outputs[0], script.plan); return 'status: DONE\nsignals: none'; },
  implementer: () => {
    put(exactPath(), `export const value = ${invocationNumber};\n`);
    put(outputs[0], `# Task ${task} report\n\nInvocation ${invocationNumber}: RED then GREEN.\n`);
    return `status: DONE\nartifact: ${outputs[0]}\nsignals: tdd:red-green`;
  },
  'task-reviewer': () => { put(outputs[0], `# Task ${task} review\n\nApproved.\n`); return 'status: APPROVED\nsignals: none'; },
  'final-review': () => { put(outputs[0], '# Final review\n\nApproved.\n'); return 'status: APPROVED\nsignals: none'; },
  review: () => {
    put(outputs[0], evidenceReport(step.evidence));
    put(outputs[1], `<!-- steepy-workflow: v1\nphase: review\nstatus: DRAFT\nnext: none\nsource: ${runDir}/task-result-index.md\nconsumed-by: none\n-->\n# Review report\n\nEvery criterion is met.\n`);
    return 'status: READY_FOR_PR\nsignals: none';
  },
  'task-review-correction': () => 'status: APPROVED\nsignals: none',
  'final-review-correction': () => 'status: APPROVED\nsignals: none',
};
DEFAULTS.fix = DEFAULTS.implementer;

// Legacy phases: the lazy child writes artifacts and its own completion marker.
function marker(phase, event) {
  const status = `${runDir}/autopilot-status.md`;
  appendFileSync(join(cwd, status), `${new Date().toISOString()} — ${phase} — ${event} — run-id=${runId} attempt=${manifest.attempt}\n`);
}
async function legacyPhase() {
  if (role === 'plan') {
    put(outputs[0], script.plan);
    marker('plan', 'DONE');
    return;
  }
  if (role === 'implement') {
    const planText = readFileSync(join(cwd, `.apex/work/plans/${specName}.md`), 'utf8');
    const tasks = [...planText.matchAll(/^## Task (\d+) — /gm)].map((match) => match[1]);
    if (step.helpers) {
      // A diligent child interrupted after Task 1: one recorded execution, no review.
      const { beginTask, recordTaskResult } = await import(new URL('../../../scripts/task-results.mjs', import.meta.url));
      const state = `${runDir}/task-1-execution-1`;
      const report = `${runDir}/task-1-report.md`;
      beginTask(cwd, state, { runId, attempt: manifest.attempt, task: '1', execution: 1, role: 'implementer', report,
        planPath: `.apex/work/plans/${specName}.md`, parentState: null });
      put('src/value-1.mjs', 'export const value = 1;\n');
      put(report, '# Task 1 report\n\nRED then GREEN.\n');
      git('add', '-A', '--', '.');
      git('commit', '-q', '-m', 'legacy task 1');
      const result = recordTaskResult(cwd, state, `status: DONE\nartifact: ${report}\nsignals: tdd:red-green`);
      if (!result.accepted) throw new Error(`fake-harness: legacy receipt rejected: ${result.reason}`);
      return;
    }
    for (const id of tasks) {
      put(`src/value-${id}.mjs`, `export const value = ${invocationNumber};\n`);
      put(`${runDir}/task-${id}-report.md`, `# Task ${id} report\n\nDone.\n`);
    }
    git('add', '-A', '--', '.');
    git('commit', '-q', '-m', 'lazy legacy implement');
    marker('implement', 'DONE');
    return;
  }
  throw new Error(`fake-harness: the legacy ${role} phase is outside this matrix`);
}

let payload = null;
if (legacy) {
  await legacyPhase();
} else {
  if (step.default !== false) payload = DEFAULTS[role]();
  if (Object.hasOwn(step, 'payload')) payload = step.payload;
}
for (const { path, text } of step.write ?? []) put(path, text);
if (step.forgeCapture) {
  put(`${runDir}/role-${roleSequence}-response.json`, `${JSON.stringify({ schemaVersion: 1, roleSequence, role, payload,
    terminalReason: null, sessionId: null, exit: { status: 0, signal: null }, transportError: null, capturePersisted: true,
    observedModel: null, rawDigest: null })}\n`);
}
if (step.crash === 'kill-conductor') {
  // The conductor dies with this child in flight; the child then ends at once.
  process.kill(process.ppid, 'SIGKILL');
  process.exit(0);
}

const session = `fake-${role}-${roleSequence ?? 'legacy'}`;
const lines = [];
const terminal = step.terminal ?? (payload === null && !legacy ? 'none' : 'success');
const text = payload ?? 'legacy phase finished';
if (harness === 'codex') {
  lines.push({ type: 'thread.started', thread_id: session });
  if (terminal !== 'none') {
    lines.push({ type: 'item.completed', thread_id: session, item: { type: 'agent_message', text } });
    lines.push({ type: 'turn.completed', thread_id: session });
  }
} else {
  lines.push({ type: 'system', subtype: 'init', session_id: session, model });
  if (terminal !== 'none') lines.push({ type: 'result', subtype: 'success', result: text, session_id: session });
}
process.stdout.write(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), () => process.exit(step.exit ?? 0));
