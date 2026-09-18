// Fake harness for the autopilot conductor tests: stands in for the real
// headless binary (`claude -p …` / `codex exec …` / `opencode run …`), which the
// suite must never spawn. Invoked as `node fake-harness.mjs <prompt>` through the
// conductor's `opts.commandFor` injection point.
//
// It derives the phase from the prompt (exactly as a real child would read which
// skill it was asked to run) and behaves per env var:
//   FAKE_HARNESS_STATUS        — path to the run's autopilot-status.md (required
//                                for every mode that appends)
//   FAKE_HARNESS_MODE          — default mode for all phases
//   FAKE_HARNESS_MODE_<PHASE>  — per-phase override (PLAN | IMPLEMENT | REVIEW)
//   FAKE_HARNESS_BLOCK_NOTE    — reason written with the BLOCKED line
//   FAKE_HARNESS_SWITCH_BRANCH — after acting, git-switch the repo to this branch
//                                (drives the conductor's per-phase branch guard)
//   FAKE_HARNESS_FORGE_<PHASE> — "<actor>:<EVENT>" — also append that line, standing in
//                                for a child that writes another phase's marker
//   FAKE_HARNESS_STREAM        — claude | codex | opencode structured fixture stream
//   FAKE_HARNESS_DELAY_MS      — delay exit after emitting the structured events
//   FAKE_HARNESS_SIGNAL_CAPTURE — append any unexpected signal before exiting
//   FAKE_HARNESS_SKIP_BRANCH_DIFF — implement leaves the aggregate diff to the conductor
//   FAKE_HARNESS_WORK_FILES       — implement leaves tracked + untracked work in the tree
//   FAKE_HARNESS_STDERR        — emit the message event on stderr
//   FAKE_HARNESS_FRAGMENTED    — fragment the session event across writes
//   FAKE_HARNESS_MULTIPLE      — emit both events in one stdout write
//   FAKE_HARNESS_FINAL_UNTERMINATED — omit the message event's final newline
//   FAKE_HARNESS_TELEMETRY        — phase | actor | both | no-usage
//   FAKE_HARNESS_USAGE_RETRANSMIT — repeat completion events byte-for-byte
//   FAKE_HARNESS_USAGE_HUGE       — emit large (still source-valid) usage counts
// Modes:
//   done     — append the phase's completion marker (review → READY_FOR_PR), exit 0
//   blocked  — append BLOCKED with a reason, exit 1 (a child that gave up)
//   conflict — append CONFLICT, exit 0 (doc-wins conflict, needs a human)
//   fail     — exit 1 without touching the status file (a crashed child)
//   silent   — exit 0 without touching the status file (protocol violation)
//   sleep    — never exit, after spawning a tool subprocess of its own (drives
//              explicit conductor stop paths and proves the process group is killed)
//   stubborn — like sleep, but the tool subprocess ignores SIGTERM (proves the
//              conductor's SIGKILL sweep reaches a descendant that survives the
//              group SIGTERM after the direct child is already gone)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { beginReview, checkReview, reserveRepair, inspectReview, setReviewReference, captureRetainedApproval, verifyImplementReviews } from '../../scripts/reviewer-response.mjs';
import { reviewPhaseContext } from '../../scripts/autopilot-context.mjs';
import { beginTask, recordTaskResult, inspectTaskResult, projectTaskResults, parseTaskResultProjection } from '../../scripts/task-results.mjs';
import { dirname, join } from 'node:path';

const prompt = process.argv[2] ?? '';
const harness = process.env.FAKE_HARNESS_STREAM ?? process.argv[3] ?? 'claude';
const phaseMatch = prompt.match(/steepy-apex '(plan|implement|review)' skill/);
if (!phaseMatch) {
  process.stderr.write(`fake-harness: no steepy-apex '<phase>' skill in prompt: ${prompt}\n`);
  process.exit(64);
}
const phase = phaseMatch[1];
const mode = process.env[`FAKE_HARNESS_MODE_${phase.toUpperCase()}`] ?? process.env.FAKE_HARNESS_MODE ?? 'done';
const statusFile = process.env.FAKE_HARNESS_STATUS;

const streamHarness = process.env.FAKE_HARNESS_STREAM;
const sessionId = `${harness}-${phase}-session`;
const secret = process.env.FAKE_HARNESS_SECRET;
const descriptor = process.argv[4] ? JSON.parse(process.argv[4]) : null;

const signalCapture = process.env.FAKE_HARNESS_SIGNAL_CAPTURE;
if (signalCapture) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      appendFileSync(signalCapture, `${signal}\n`, 'utf8');
      process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal]);
    });
  }
}

function manifestPathFromPrompt() {
  return prompt.match(/Context manifest:\s+([^\s]+)\s+\(authoritative input inventory\)/)?.[1];
}

function captureSpawnEvidence() {
  const capturePath = process.env.FAKE_HARNESS_CAPTURE;
  if (!capturePath) return;
  const manifestPath = manifestPathFromPrompt();
  const specName = prompt.match(/spec at ([^\s]+)\./)?.[1]?.split('/').at(-1)?.replace(/\.md$/, '') ?? 'topic';
  const taskDir = join(process.cwd(), '.apex', 'work', 'tasks', specName);
  const evidence = {
    phase,
    prompt,
    spawnArgs: process.argv.slice(2),
    statusAtSpawn: statusFile && existsSync(statusFile) ? readFileSync(statusFile, 'utf8') : '',
    descriptor,
    manifestPath,
    manifestExists: Boolean(manifestPath && existsSync(join(process.cwd(), manifestPath))),
    planExists: existsSync(join(process.cwd(), '.apex', 'work', 'plans', `${specName}.md`)),
    ledgerExists: existsSync(join(taskDir, 'ledger.md')),
    resultIndexExists: existsSync(join(taskDir, 'task-result-index.md')),
    branchDiffExists: existsSync(join(taskDir, 'branch-diff.txt')),
  };
  appendFileSync(capturePath, `${JSON.stringify(evidence)}\n`, 'utf8');
}

function materializePhaseArtifacts() {
  const manifestPath = manifestPathFromPrompt();
  if (!manifestPath) return;
  const manifest = JSON.parse(readFileSync(join(process.cwd(), manifestPath), 'utf8'));
  const specPath = manifest.required.find((entry) => entry.purpose === 'approved specification')?.path
    ?? manifest.onDemand.find((entry) => entry.purpose === 'upstream context if the task brief is insufficient')?.path;
  const specName = specPath?.split('/').at(-1)?.replace(/\.md$/, '') ?? 'topic';
  const taskDir = join(process.cwd(), '.apex', 'work', 'tasks', specName);
  if (phase === 'plan') {
    const planPath = join(process.cwd(), manifest.outputs[0]);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, process.env.FAKE_HARNESS_PLAN_TEXT ?? `# Plan\n\nPLAN_BODY_SENTINEL_MUST_NOT_BE_IN_PROMPT\n\n## Task 1 — wire integration\n\n- **Surface:** \`scripts\`\n- **Test command:** \`npm test\`\n- **Complexity:** \`integration\`\n- **Success criteria:** SC1\n\n## Task 2 — review architecture\n\n- **Surface:** \`scripts\`\n- **Test command:** \`npm test\`\n- **Complexity:** \`design\`\n- **Success criteria:** SC2\n`);
  } else if (phase === 'implement') {
    mkdirSync(taskDir, { recursive: true });
    appendFileSync(join(taskDir, 'ledger.md'), 'Task 1: complete\nTask 2: complete\n', 'utf8');
    const planPath = manifest.required.find((entry) => entry.purpose === 'approved implementation plan')?.path;
    const planText = planPath ? readFileSync(join(process.cwd(), planPath), 'utf8') : '';
    const taskIds = [...planText.matchAll(/^#{2,}\s+Task\s+([A-Za-z0-9]+)\b/gim)].map((match) => match[1]);
    const resultIndex = `# Results\n\n${taskIds.map((id) => `- Task ${id}: DONE; artifact: .apex/work/tasks/${specName}/task-${id}-report.md; changed-paths: none; signals: tdd:red-green`).join('\n')}\n`;
    writeFileSync(
      join(taskDir, 'task-result-index.md'),
      process.env.FAKE_HARNESS_RESULT_INDEX_TEXT ?? resultIndex,
    );
    if (manifest.contract?.taskResultProtocol === 2 && !process.env.FAKE_HARNESS_RESULT_INDEX_TEXT) {
      const states = [];
      for (const id of taskIds) {
        const state = `.apex/work/tasks/${specName}/task-${id}-execution-1`;
        if (!existsSync(`${state}-baseline.json`)) {
          beginTask(process.cwd(), state, { runId: manifest.runId, attempt: manifest.attempt, task: id,
            execution: 1, role: 'implementer', report: `.apex/work/tasks/${specName}/task-${id}-report.md`, planPath,
            parentState: states.at(-1) ?? null });
          if (id === taskIds[0] && process.env.FAKE_HARNESS_WORK_FILES === '1') {
            writeFileSync('tracked.txt', 'implemented\n'); writeFileSync('brand-new.txt', 'created by the implementer\n');
          }
          const report = `.apex/work/tasks/${specName}/task-${id}-report.md`;
          writeFileSync(report, 'Synthetic implementation report.\n');
          const result = recordTaskResult(process.cwd(), state, `status: DONE\nartifact: ${report}\nsignals: tdd:red-green\n`);
          if (!result.accepted) throw new Error(`synthetic task result rejected: ${result.reason}`);
        }
        states.push(state);
      }
      projectTaskResults(process.cwd(), { indexPath: `.apex/work/tasks/${specName}/task-result-index.md`, states });
    } else if (process.env.FAKE_HARNESS_WORK_FILES === '1') {
      writeFileSync(join(process.cwd(), 'tracked.txt'), 'implemented\n');
      writeFileSync(join(process.cwd(), 'brand-new.txt'), 'created by the implementer\n');
    }
    if (process.env.FAKE_HARNESS_SKIP_BRANCH_DIFF !== '1') {
      writeFileSync(join(taskDir, 'branch-diff.txt'), 'diff --git a/a b/a\n+fake implementation\n');
    }
    materializeReviewGates(manifest, specName);
  }
}

captureSpawnEvidence();

function eventLines() {
  const summary = `fake ${phase} message pid=${process.pid}${secret ? ` token=${secret}` : ''}`;
  if (harness === 'codex') {
    return [
      JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
      JSON.stringify({ type: 'item.completed', thread_id: sessionId, item: { type: 'agent_message', text: summary } }),
    ];
  }
  if (harness === 'opencode') {
    return [
      JSON.stringify({ type: 'step_start', sessionID: sessionId, part: { type: 'step-start', sessionID: sessionId } }),
      JSON.stringify({ type: 'text', sessionID: sessionId, part: { type: 'text', sessionID: sessionId, text: summary } }),
    ];
  }
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    JSON.stringify({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: summary }] } }),
  ];
}

function completionEventLines() {
  const mode = process.env.FAKE_HARNESS_TELEMETRY;
  if (!mode) return [];
  const multiplier = { plan: 1, implement: 2, review: 3 }[phase];
  const inputTokens = process.env.FAKE_HARNESS_USAGE_HUGE === '1'
    ? Number.MAX_SAFE_INTEGER
    : 10 * multiplier;
  const phaseUsage = {
    input_tokens: inputTokens,
    output_tokens: 2 * multiplier,
    total_tokens: process.env.FAKE_HARNESS_USAGE_PARTIAL === '1' ? undefined : 12 * multiplier,
  };
  const actorUsage = { input_tokens: 3 * multiplier };
  const completion = (usage, actorId = null) => {
    if (harness === 'codex') {
      return JSON.stringify({
        type: 'turn.completed', thread_id: sessionId,
        ...(actorId === null ? {} : { agent_id: actorId, parent_actor_id: `${phase}-controller` }),
        ...(usage === null ? {} : { usage }),
      });
    }
    if (harness === 'opencode') {
      // `opencode run --format json` completes with a step_finish whose `tokens`
      // ledger carries the session's cumulative totals (`total`, `cache.read`)
      // and per-step deltas (`input`, `output`). No usage means a bare stop
      // marker: the conductor reports the missing-usage degradation, never zero.
      if (usage === null) {
        return JSON.stringify({ type: 'step_finish', sessionID: sessionId, part: { type: 'step-finish', reason: 'stop', sessionID: sessionId } });
      }
      const tokens = {
        total: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        reasoning: 0,
        cache: { write: 0, read: 5 * multiplier },
      };
      return JSON.stringify({ type: 'step_finish', sessionID: sessionId, part: { type: 'step-finish', reason: 'stop', sessionID: sessionId, tokens } });
    }
    return JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId,
      ...(actorId === null ? {} : { agent_id: actorId, parent_actor_id: `${phase}-controller` }),
      ...(usage === null ? {} : { usage }),
    });
  };
  const lines = [];
  if (mode === 'phase' || mode === 'both') lines.push(completion(phaseUsage));
  if (mode === 'actor' || mode === 'both') lines.push(completion(actorUsage, `${phase}-worker`));
  if (mode === 'no-usage') lines.push(completion(null));
  if (process.env.FAKE_HARNESS_USAGE_SECOND === '1' && (mode === 'phase' || mode === 'both')) {
    lines.push(completion({ ...phaseUsage, input_tokens: inputTokens + 1 }));
  }
  return process.env.FAKE_HARNESS_USAGE_RETRANSMIT === '1' ? lines.flatMap((line) => [line, line]) : lines;
}

async function emitHarnessOutput() {
  if (!streamHarness) {
    process.stdout.write(`fake-harness: phase=${phase} mode=${mode} pid=${process.pid}\n`);
    process.stdout.write(`fake-harness: prompt=${prompt}\n`);
    return;
  }
  const [session, message] = eventLines();
  if (process.env.FAKE_HARNESS_MULTIPLE === '1') {
    process.stdout.write(`${session}\n${message}${process.env.FAKE_HARNESS_FINAL_UNTERMINATED === '1' ? '' : '\n'}`);
  } else if (process.env.FAKE_HARNESS_FRAGMENTED === '1') {
    const split = Math.max(1, Math.floor(session.length / 2));
    process.stdout.write(session.slice(0, split));
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.stdout.write(`${session.slice(split)}\n`);
  } else {
    process.stdout.write(`${session}\n`);
  }
  if (process.env.FAKE_HARNESS_MULTIPLE !== '1') {
    const destination = process.env.FAKE_HARNESS_STDERR === '1' ? process.stderr : process.stdout;
    destination.write(`${message}${process.env.FAKE_HARNESS_FINAL_UNTERMINATED === '1' ? '' : '\n'}`);
  }
  if (process.env.FAKE_HARNESS_EDGE_EVENTS === '1') {
    if (harness === 'claude') {
      const taskStarted = JSON.stringify({
        type: 'system', subtype: 'task_started', session_id: sessionId,
        task_id: 'edge-task-1', subagent_type: 'edge-worker', description: 'run the edge suite',
      });
      const taskProgress = JSON.stringify({
        type: 'system', subtype: 'task_progress', session_id: sessionId,
        task_id: 'edge-task-1', subagent_type: 'edge-worker',
      });
      const taskNotification = JSON.stringify({
        type: 'system', subtype: 'task_notification', session_id: sessionId,
        task_id: 'edge-task-1', subagent_type: 'edge-worker',
        status: 'completed', summary: 'edge suite passed',
      });
      process.stdout.write(`${taskStarted}\n${taskProgress}\n${taskNotification}\n`);
    }
    const reasoning = JSON.stringify({
      type: 'assistant', session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'reasoning', reasoning: 'private-thought-edge' }] },
    });
    const unknown = JSON.stringify({ type: 'future.event', reasoning: 'private-thought-unknown' });
    process.stdout.write(`${unknown}\n${unknown}\n`);
    process.stderr.write('{"type":"broken","reasoning":"private-thought-malformed"\n');
    process.stderr.write('{"type":"broken","reasoning":"private-thought-malformed"\n');
    process.stdout.write(`${reasoning}\n`);
  }
  for (const completion of completionEventLines()) process.stdout.write(`${completion}\n`);
  const delay = Number(process.env.FAKE_HARNESS_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

await emitHarnessOutput();

function append(actor, event, note) {
  const timestamp = new Date().toISOString();
  const statusTimestamp = process.env.FAKE_HARNESS_SECONDS_TIMESTAMP === '1'
    ? timestamp.replace(/\.\d{3}Z$/, 'Z') : timestamp;
  appendFileSync(statusFile, `${statusTimestamp} — ${actor} — ${event} — ${note}\n`, 'utf8');
}

function correlated(note) {
  const runId = prompt.match(/run-id `([^`]+)`/)?.[1];
  const attempt = prompt.match(/attempt `(\d+)`/)?.[1];
  // Literal contract shipped by plan/implement/review: the protocol actor is
  // already the phase, so only run-id and attempt are echoed in the note.
  return runId && attempt ? `run-id=${runId} attempt=${attempt} ${note}` : note;
}

// Stands in for a child that writes a marker it has no business writing — e.g. a
// phase-1 session appending `review — READY_FOR_PR`.
function forgeIfAsked() {
  const forged = process.env[`FAKE_HARNESS_FORGE_${phase.toUpperCase()}`];
  if (!forged) return;
  const [actor, event] = forged.split(':');
  append(actor, event, 'forged by another phase');
}

function switchBranchIfAsked() {
  const branch = process.env.FAKE_HARNESS_SWITCH_BRANCH;
  if (branch) execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: process.cwd() });
}

// Synthetic skill behavior: exercises the real conductor's resume capability boundary,
// not native reviewer compliance or a production task-state reducer.
function taskResumeScenario() {
  const manifest = JSON.parse(readFileSync(manifestPathFromPrompt(), 'utf8'));
  const resultPath = '.apex/work/tasks/topic/task-result-index.md';
  const ledgerPath = '.apex/work/tasks/topic/ledger.md';
  for (const path of [ledgerPath, resultPath]) {
    if (!manifest.onDemand.some((entry) => entry.path === path && entry.available === existsSync(path))) {
      throw new Error(`missing explicit resume capability: ${path}`);
    }
  }
  const taskDir = dirname(resultPath);
  const tracePath = join(taskDir, 'scenario-trace.txt');
  const result = (id) => `- Task ${id}: DONE; artifact: ${taskDir}/task-${id}-report.md; changed-paths: none; signals: none\n`;
  if (!existsSync(ledgerPath)) {
    writeFileSync(ledgerPath, 'Task 1: complete\nTask 2: complete\n');
    writeFileSync(resultPath, `<!-- steepy-workflow: v1\nphase: implement\nstatus: DRAFT\nnext: review\nsource: .apex/work/plans/topic.md\nconsumed-by: none\n-->\n# Results\n${result(1)}${result(2)}`);
    writeFileSync(tracePath, 'implement:1\nreview:1:APPROVED\nimplement:2\nreview:2:APPROVED\nimplement:3\nreview:3:ISSUES_FOUND\n');
    writeFileSync(join(taskDir, 'task-3-issues.md'), 'T3-001: replace operational details control\n');
    writeFileSync(join(taskDir, 'task-3-review.md'), 'Issues Found: task-3-issues.md\n');
    append(phase, 'BLOCKED', correlated('malformed reviewer envelope for Task 3: ISSUES_FOUND artifact must be task-3-issues.md'));
    return 1;
  }
  const ledger = readFileSync(ledgerPath, 'utf8');
  const index = readFileSync(resultPath, 'utf8');
  if (!/status: DRAFT/.test(index) || !ledger.includes('Task 2: complete') || ledger.includes('Task 3: complete')) {
    throw new Error('unexpected resume state');
  }
  appendFileSync(tracePath, 'fix:3\nreview:3:APPROVED\n');
  appendFileSync(ledgerPath, 'Task 3: complete\n');
  writeFileSync(resultPath, index.replace('status: DRAFT', 'status: READY') + result(3));
  materializeReviewGates(manifest, 'topic');
  append(phase, 'DONE', correlated('corrected and reviewed Task 3'));
  return 0;
}

function reviewEnvelope(config, paths = 'none', status = 'APPROVED') {
  return `status: ${status}\nartifact: ${status === 'ISSUES_FOUND' ? config.issues : config.report}\nchanged-paths: ${paths}\nsignals: ${status === 'ISSUES_FOUND' ? 'review:critical' : 'review:clean'}\n`;
}
function reviewConfig(manifest, dir, task, iteration = 1) {
  const scope = task === 'final' ? 'final' : `task-${task}`;
  const entry = task === 'final' || manifest.contract?.taskResultProtocol !== 2 ? null
    : parseTaskResultProjection(readFileSync(`${dir}/task-result-index.md`, 'utf8'))?.find((item) => item.task === task);
  return { runId: manifest.runId, attempt: manifest.attempt, iteration, task,
    report: `${dir}/${scope}-review.md`, issues: `${dir}/${task === 'final' ? 'final-review' : scope}-issues.md`,
    ...(entry ? { execution: entry.receipt } : {}) };
}
function reviewState(dir, config) {
  return `${dir}/${config.task === 'final' ? 'final' : `task-${config.task}`}-review-guard-attempt-${config.attempt}-iteration-${config.iteration}`;
}
function approveTask(manifest, dir, task, iteration = 1) {
  const config = reviewConfig(manifest, dir, task, iteration);
  const state = reviewState(dir, config);
  beginReview(process.cwd(), state, config);
  writeFileSync(config.report, '# Review\n**Approved** — synthetic reviewer evidence.\n');
  if (!checkReview(process.cwd(), state, reviewEnvelope(config)).accepted) throw new Error('synthetic task gate rejected');
  return state;
}
function materializeReviewGates(manifest, specName) {
  if (process.env.FAKE_HARNESS_SKIP_REVIEW_GATE === '1') return;
  const dir = `.apex/work/tasks/${specName}`;
  const plan = `.apex/work/plans/${specName}.md`, indexPath = `${dir}/task-result-index.md`;
  let index = readFileSync(indexPath, 'utf8');
  let route;
  try { route = reviewPhaseContext(readFileSync(plan, 'utf8'), index); }
  catch { return; } // Malformed-index fixtures are rejected by the real conductor.
  for (const task of route.tasks) {
    if (index.includes(`Reviewer gate Task ${task.task}: `) || task.complexity === 'mechanical') continue;
    index += `Reviewer gate Task ${task.task}: ${approveTask(manifest, dir, task.task)}\n`;
  }
  let config = { ...reviewConfig(manifest, dir, 'final'), plan, index: indexPath };
  let state = reviewState(dir, config);
  writeFileSync(indexPath, index);
  setReviewReference(process.cwd(), { indexPath, state });
  beginReview(process.cwd(), state, config);
  if (process.env.FAKE_HARNESS_FINAL_ISSUES === '1') {
    writeFileSync(config.report, 'Issues found in branch integration.\n');
    writeFileSync(config.issues, 'Fix branch ordering.\n');
    if (checkReview(process.cwd(), state, reviewEnvelope(config, 'none', 'ISSUES_FOUND')).status !== 'ISSUES_FOUND') throw new Error('expected final issues');
    const previousState = state;
    const previousBytes = readFileSync(`${state}-original.json`);
    if (manifest.contract?.taskResultProtocol === 2) {
      const entries = parseTaskResultProjection(readFileSync(indexPath, 'utf8'));
      const first = entries[0];
      const execution = `${dir}/task-${first.task}-execution-2`;
      beginTask(process.cwd(), execution, { runId: manifest.runId, attempt: manifest.attempt, task: first.task,
        execution: 2, role: 'fix', report: first.artifact, planPath: plan, previousState: first.receipt,
        parentState: entries.at(-1).receipt });
      writeFileSync('branch-fix.js', 'branch ordering corrected\n');
      writeFileSync(first.artifact, 'Synthetic final-review fix.\n');
      recordTaskResult(process.cwd(), execution, `status: DONE\nartifact: ${first.artifact}\nsignals: none\n`);
      projectTaskResults(process.cwd(), { indexPath, states: entries.map((entry) => entry.task === first.task ? execution : entry.receipt) });
      const previousReview = readFileSync(indexPath, 'utf8').match(new RegExp(`^Reviewer gate Task ${first.task}: (\\S+)$`, 'm'))?.[1];
      const nextReview = approveTask(manifest, dir, first.task, 2);
      setReviewReference(process.cwd(), { indexPath, state: nextReview, previousState: previousReview ?? null });
    } else writeFileSync('branch-fix.js', 'branch ordering corrected\n');
    config = { ...config, iteration: 2 }; state = reviewState(dir, config);
    setReviewReference(process.cwd(), { indexPath, state, previousState });
    beginReview(process.cwd(), state, config);
    if (!readFileSync(`${previousState}-original.json`).equals(previousBytes)) throw new Error('previous review evidence overwritten');
  }
  index = readFileSync(indexPath, 'utf8');
  writeFileSync(config.report, '## Verdict\nApproved; all task receipts checked.\n');
  if (!checkReview(process.cwd(), state, reviewEnvelope(config)).accepted) throw new Error('synthetic final gate rejected');
  const mutation = process.env.FAKE_HARNESS_GATE_MUTATION;
  if (mutation === 'drop-task') writeFileSync(indexPath, index.replace(/^Reviewer gate Task 1:.*\n/m, ''));
  if (mutation === 'change-handoff') writeFileSync(indexPath, index.replace(/tdd:red-green/, 'changed-signal'));
  if (mutation === 'change-code') writeFileSync('unapproved.js', 'changed after final review\n');
  if (mutation === 'corrupt-receipt') {
    const recordPath = `${state}-original.json`;
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.envelope.status = 'ISSUES_FOUND';
    writeFileSync(recordPath, JSON.stringify(record));
  }

}

function finalApprovedResumeScenario() {
  const manifest = JSON.parse(readFileSync(manifestPathFromPrompt(), 'utf8'));
  const dir = '.apex/work/tasks/topic', trace = `${dir}/final-resume-trace.txt`;
  if (!existsSync(trace)) {
    materializePhaseArtifacts();
    writeFileSync(trace, 'implementation-and-final-review\n');
    append(phase, 'BLOCKED', correlated('synthetic interruption after final approval, before DONE'));
    return 1;
  }
  const options = { planPath: '.apex/work/plans/topic.md', indexPath: `${dir}/task-result-index.md`, runId: manifest.runId, attempt: manifest.attempt };
  const retainedApproval = captureRetainedApproval(process.cwd(), options);
  if (process.env.FAKE_HARNESS_FINAL_RESUME_MUTATION === '1') writeFileSync('post-approval.js', 'unexpected code change\n');
  // Deliberate malformed-child mode leaves the real conductor to refuse the change.
  if (process.env.FAKE_HARNESS_FINAL_RESUME_MUTATION !== '1') verifyImplementReviews(process.cwd(), { ...options, retainedApproval });
  appendFileSync(trace, 'resume-existing-approval\n');
  append(phase, 'DONE', correlated('retained final approval; no new implementation or review'));
  return 0;
}

// Real gate + real conductor, synthetic reviewer transport. Attempt 1 pauses
// after a malformed approval; attempt 2 corrects only that response and advances.
function reviewerRecoveryScenario() {
  const manifest = JSON.parse(readFileSync(manifestPathFromPrompt(), 'utf8'));
  const dir = '.apex/work/tasks/topic';
  const ledger = `${dir}/ledger.md`, index = `${dir}/task-result-index.md`, trace = `${dir}/scenario-trace.txt`;
  const resultLine = (id) => `- Task ${id}: DONE; artifact: ${dir}/task-${id}-report.md; changed-paths: none; signals: none\n`;
  if (!existsSync(ledger)) {
    writeFileSync(ledger, ''); writeFileSync(index, '# Results\n'); writeFileSync(trace, '');
    for (const id of ['1', '2', '3']) {
      appendFileSync(trace, `implement:${id}\n`);
      const state = approveTask(manifest, dir, id);
      appendFileSync(index, resultLine(id) + `Reviewer gate Task ${id}: ${state}\n`);
      appendFileSync(ledger, `Task ${id}: complete\n`);
    }
    appendFileSync(trace, 'implement:4\n');
    writeFileSync('tracked.txt', 'task 4 implementation\n');
    let config = reviewConfig(manifest, dir, '4');
    let state = reviewState(dir, config);
    beginReview(process.cwd(), state, config);
    writeFileSync(config.report, '# Review\nIssues found.\n'); writeFileSync(config.issues, 'Fix order and test order.\n');
    if (checkReview(process.cwd(), state, reviewEnvelope(config, 'none', 'ISSUES_FOUND')).status !== 'ISSUES_FOUND') throw new Error('expected issues');
    appendFileSync(trace, 'review:4:ISSUES_FOUND\nfix:4\n');
    writeFileSync('tracked.txt', 'task 4 corrected\n');
    config = reviewConfig(manifest, dir, '4', 2); state = reviewState(dir, config);
    beginReview(process.cwd(), state, config);
    writeFileSync(config.report, '# Review\n**Approved**; order tests passed.\n');
    const response = reviewEnvelope(config, config.report);
    if (checkReview(process.cwd(), state, response).status !== 'REPAIRABLE') throw new Error('expected recoverable envelope');
    appendFileSync(trace, 'review:4:malformed-approval\n');
    appendFileSync(ledger, `Pending reviewer gate: ${state}\n`);
    append(phase, 'BLOCKED', correlated('synthetic interruption before response correction reservation'));
    return 1;
  }
  const state = readFileSync(ledger, 'utf8').match(/^Pending reviewer gate: (\S+)$/m)?.[1];
  const before = inspectReview(process.cwd(), state);
  if (before.status !== 'REPAIRABLE') throw new Error('unexpected pending gate');
  reserveRepair(process.cwd(), state);
  if (process.env.FAKE_HARNESS_REVIEW_MUTATION === '1') writeFileSync('tracked.txt', 'unauthorized reviewer mutation\n');
  const paths = process.env.FAKE_HARNESS_BAD_CORRECTION === '1' ? before.config.report : 'none';
  const repaired = checkReview(process.cwd(), state, reviewEnvelope(before.config, paths), true);
  appendFileSync(trace, 'response-only:4\n');
  if (!repaired.accepted) { append(phase, 'BLOCKED', correlated(repaired.reason)); return 1; }
  appendFileSync(ledger, 'Task 4: complete\n');
  appendFileSync(index, resultLine('4') + `Reviewer gate Task 4: ${state}\n`);
  appendFileSync(trace, 'implement:5\n');
  const next = approveTask(manifest, dir, '5');
  appendFileSync(ledger, 'Task 5: complete\n');
  appendFileSync(index, resultLine('5') + `Reviewer gate Task 5: ${next}\n`);
  materializeReviewGates(manifest, 'topic');
  append(phase, 'DONE', correlated('response recovered and task 5 completed'));
  return 0;
}

// Paths and the rejected abbreviation reproduce steepysite e425507. Source
// bodies and reviewer decisions are synthetic; no product files are executed.
function steepysiteReceiptScenario() {
  const manifest = JSON.parse(readFileSync(manifestPathFromPrompt(), 'utf8'));
  const dir = '.apex/work/tasks/topic', state = `${dir}/task-1-execution-1`;
  const indexPath = `${dir}/task-result-index.md`, report = `${dir}/task-1-report.md`;
  const trace = `${dir}/receipt-trace.txt`;
  const paths = ['generation', 'issues'].flatMap((route) => ['page.tsx', 'page.test.tsx']
    .map((file) => `apps/web/app/admin/(protected)/${route}/[id]/${file}`));
  if (!existsSync(`${state}-baseline.json`)) {
    beginTask(process.cwd(), state, { runId: manifest.runId, attempt: manifest.attempt, task: '1',
      execution: 1, role: 'implementer', report, planPath: '.apex/work/plans/topic.md' });
    appendFileSync(trace, 'implement:1\n');
    for (const path of paths) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'corrected decision context\n'); }
    execFileSync('git', ['add', '--', ...paths]); execFileSync('git', ['commit', '-qm', 'fix decision context']);
    writeFileSync(report, '# Implementation\nSynthetic test evidence; independent review pending.\n');
    const raw = `status: DONE\nartifact: ${report}\nchanged-paths: apps/web/app/admin/(protected)/generation/[id]/{page.tsx,page.test.tsx}, apps/web/app/admin/(protected)/issues/[id]/{page.tsx,page.test.tsx}\nsignals: tdd:red-green\n`;
    if (!recordTaskResult(process.cwd(), state, raw).accepted) throw new Error('abbreviated legacy transport blocked observed execution');
    append(phase, 'BLOCKED', correlated('simulated interruption after durable task result, before projection and review'));
    return 1;
  }
  const result = inspectTaskResult(process.cwd(), state);
  if (!result.accepted) throw new Error('execution has no durable completion');
  appendFileSync(trace, 'resume:review-pending\n');
  if (!existsSync(indexPath)) writeFileSync(indexPath, '# Results\n');
  projectTaskResults(process.cwd(), { indexPath, states: [state] });
  if (/^## Task 2\b/m.test(readFileSync('.apex/work/plans/topic.md', 'utf8'))) {
    const taskReview = approveTask(manifest, dir, '1');
    setReviewReference(process.cwd(), { indexPath, state: taskReview });
    const nextState = `${dir}/task-2-execution-1`, nextReport = `${dir}/task-2-report.md`;
    beginTask(process.cwd(), nextState, { runId: manifest.runId, attempt: manifest.attempt, task: '2',
      execution: 1, role: 'implementer', report: nextReport, planPath: '.apex/work/plans/topic.md', parentState: state });
    appendFileSync(trace, 'implement:2\n'); writeFileSync('next-task.ts', 'next task\n');
    writeFileSync(nextReport, 'Synthetic next task report.\n');
    recordTaskResult(process.cwd(), nextState, `status: DONE\nartifact: ${nextReport}\nsignals: none\n`);
    projectTaskResults(process.cwd(), { indexPath, states: [state, nextState] });
  }
  materializeReviewGates(manifest, 'topic');
  appendFileSync(trace, 'review:1:APPROVED\nreview:final:APPROVED\n');
  append(phase, 'DONE', correlated('saved implementation reviewed, no redispatch'));
  return 0;
}

function receiptContinuationScenario() {
  const manifest = JSON.parse(readFileSync(manifestPathFromPrompt(), 'utf8'));
  const dir = '.apex/work/tasks/topic', first = `${dir}/task-1-execution-1`;
  const report = `${dir}/task-1-report.md`, planPath = '.apex/work/plans/topic.md';
  const indexPath = `${dir}/task-result-index.md`, trace = `${dir}/continuation-trace.txt`;
  const badAncestor = mode === 'receipt-wrong-ancestor';
  if (!existsSync(`${first}-baseline.json`)) {
    beginTask(process.cwd(), first, { runId: badAncestor ? 'wrong-original-run' : manifest.runId,
      attempt: manifest.attempt, task: '1', execution: 1, role: 'implementer', report, planPath });
    writeFileSync('partial.txt', 'partial task work preserved\n');
    writeFileSync(report, badAncestor ? 'Synthetic implementation.\n' : 'Need the parent to supply the task configuration.\n');
    const result = recordTaskResult(process.cwd(), first,
      `status: ${badAncestor ? 'DONE' : 'NEEDS_CONTEXT'}\nartifact: ${report}\nsignals: none\n`);
    if (result.status !== (badAncestor ? 'DONE' : 'NEEDS_CONTEXT')) throw new Error('unexpected captured outcome');
    writeFileSync(trace, 'dispatch:1\n');
    append(phase, 'BLOCKED', correlated('simulated interruption after captured writer response'));
    return 1;
  }
  inspectTaskResult(process.cwd(), first);
  const next = `${dir}/task-1-execution-2`;
  beginTask(process.cwd(), next, { runId: manifest.runId, attempt: manifest.attempt, task: '1',
    execution: 2, role: badAncestor ? 'fix' : 'retry', report, planPath, previousState: first, parentState: first });
  appendFileSync(trace, badAncestor ? 'fix:2\n' : 'context:supplied\nretry:2\n');
  writeFileSync('completed.txt', 'completed with supplied configuration\n');
  writeFileSync(report, 'Synthetic complete implementation after explicit remedy.\n');
  if (!recordTaskResult(process.cwd(), next, `status: DONE\nartifact: ${report}\nsignals: none\n`).accepted) throw new Error('continuation did not complete');
  writeFileSync(indexPath, '# Results\n');
  projectTaskResults(process.cwd(), { indexPath, states: [next] });
  materializeReviewGates(manifest, 'topic');
  appendFileSync(trace, 'review:task:APPROVED\nreview:final:APPROVED\n');
  append(phase, 'DONE', correlated('synthetic continuation and independent reviews completed'));
  return 0;
}

switch (mode) {
  case 'receipt-needs-context':
  case 'receipt-wrong-ancestor':
    process.exit(receiptContinuationScenario());
    break;
  case 'steepysite-receipt':
    process.exit(steepysiteReceiptScenario());
    break;
  case 'final-approved-resume':
    process.exit(finalApprovedResumeScenario());
    break;
  case 'reviewer-recovery':
    process.exit(reviewerRecoveryScenario());
    break;
  case 'task-resume':
    process.exit(taskResumeScenario());
    break;
  case 'done':
    materializePhaseArtifacts();
    append(phase, phase === 'review' ? 'READY_FOR_PR' : 'DONE', correlated(`fake harness completed ${phase}`));
    forgeIfAsked();
    switchBranchIfAsked();
    process.exit(0);
    break;
  case 'blocked':
    append(phase, 'BLOCKED', process.env.FAKE_HARNESS_BLOCK_NOTE ?? 'fake harness is blocked');
    process.exit(1);
    break;
  case 'conflict':
    append(phase, 'CONFLICT', 'doc-wins conflict discovered mid-run');
    process.exit(0);
    break;
  case 'fail':
    process.stderr.write('fake-harness: crashing without a status line\n');
    process.exit(1);
    break;
  case 'silent':
    process.exit(0);
    break;
  case 'sleep':
  case 'stubborn': {
    // A real harness spawns tool subprocesses; this one outlives its parent unless
    // the conductor kills the whole process group. It self-exits after 30s so a
    // regression leaks nothing beyond the run. The stubborn variant also ignores
    // SIGTERM, so only the conductor's SIGKILL sweep can reach it.
    const guard = mode === 'stubborn' ? 'process.on("SIGTERM", () => {}); ' : '';
    const postHaltSentinel = process.env.FAKE_HARNESS_POST_HALT_SENTINEL;
    const postHaltWatch = mode === 'stubborn' && postHaltSentinel && statusFile
      ? `const {readFileSync,appendFileSync}=require("node:fs");setInterval(()=>{try{if(readFileSync(${JSON.stringify(statusFile)},"utf8").includes(" — HALTED — "))appendFileSync(${JSON.stringify(postHaltSentinel)},"write-after-halt\\n")}catch{}},1);`
      : '';
    const subprocess = spawn(
      process.execPath,
      ['-e', `${guard}${postHaltWatch}setTimeout(() => {}, 30000)`],
      {
        stdio: 'ignore',
      },
    );
    if (streamHarness) {
      const message = harness === 'claude'
        ? JSON.stringify({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `subprocess=${subprocess.pid}` }] } })
        : JSON.stringify({ type: 'item.completed', thread_id: sessionId, item: { type: 'agent_message', text: `subprocess=${subprocess.pid}` } });
      process.stdout.write(`${message}\n`);
    } else {
      process.stdout.write(`fake-harness: subprocess=${subprocess.pid}\n`);
    }
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`fake-harness: unknown mode "${mode}"\n`);
    process.exit(64);
}
