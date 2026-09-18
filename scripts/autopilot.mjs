// Gear-3 autopilot conductor: parses the extended verdict-artifact contract at
// the head of a spec file, checks it against the refusal guards, then drives
// `plan → implement → review` as fresh headless harness sessions — one child per
// phase, each once, halting on anything that needs a human and stopping before
// bump/PR. Contract shape — the HTML comment at the head of `.apex/work/specs/*.md`:
//   <!-- verdict: <text> | gear: <int>
//   drive: autopilot
//   branch: <name>
//   commit-auth: <policy>
//   harness: <id>
//   blast-radius: <text>
//   log-mode: <safe|exact>          (optional; defaults to safe)
//   -->
// A plain (manual-drive) artifact is line 1 only — `drive`/`branch`/etc. parse
// as `undefined`, which is not itself an error (that's what makes it manual).
// The parser is frozen: the contract comment must sit at the head of the file
// (only whitespace before `<!--`), exactly one per artifact; every known key at
// most once, unknown keys rejected. Autopilot policy values are closed enums —
// `drive: autopilot`, `commit-auth: per-task`, `blast-radius: branch-only,
// no-push, stop-before-PR` (single literal), `harness: claude|codex|opencode`,
// `log-mode: safe|exact`, gear 3, non-empty verdict — and an empty, case-
// drifted, or unknown value refuses the run before any spawn or write.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as FS_CONSTANTS,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyImplementReviews, captureRetainedApproval } from './reviewer-response.mjs';
import { headlessCommand } from '../adapters/headless.mjs';
import { decodeHeadlessEvent } from '../adapters/headless-events.mjs';
import { resolveProviderFromModel, tierModelsForProvider } from '../adapters/model-mappings.mjs';
import {
  BoundedMultiDestinationWriter,
  LineFramer,
  RAW_OPEN_OPTIONS,
  classifyBridgeFailure,
  createDegradationTracker,
  deliverDecodedEvent,
  processEventLine,
} from './autopilot-observability.mjs';
import {
  buildImplementManifest,
  buildPlanManifest,
  buildReviewManifest,
  manifestReferencePrompt,
  materializeSuccessCriteria,
  planPhaseContext,
  reviewPhaseContext,
  specPhaseContext,
  standardsBySurfaceFromRouting,
  writeContextManifest,
} from './autopilot-context.mjs';
import { assertSafeLine, assertSafeRelPath } from './sanitize.mjs';
import {
  classifyWorkflowStart,
  nextWorkflowAttempt,
  normalizeWorkflowEnvelope,
  replayPhaseWorkflow,
  selectBaseline,
  workflowScopeCompleted,
} from './workflow-state.mjs';
import {
  appendWorkPath,
  mkdirWorkPath,
  openWorkPathFd,
  parseWorkPath,
  readWorkPath,
  writeWorkPath,
} from './work-paths.mjs';

const KNOWN_KEYS = Object.freeze({
  drive: 'drive',
  branch: 'branch',
  'commit-auth': 'commitAuth',
  harness: 'harness',
  'blast-radius': 'blastRadius',
  'log-mode': 'logMode',
});

// The contract comment is the artifact's single source of truth: a second
// verdict-shaped HTML comment anywhere later in the spec would leave two
// competing contracts, so the parser refuses it outright.
function assertNoLaterContractComment(specText, searchFrom) {
  let commentStart = specText.indexOf('<!--', searchFrom);
  while (commentStart !== -1) {
    const commentEnd = specText.indexOf('-->', commentStart + 4);
    const content = commentEnd === -1
      ? specText.slice(commentStart + 4)
      : specText.slice(commentStart + 4, commentEnd);
    if (content.replace(/^\s+/, '').startsWith('verdict:')) {
      throw new Error('malformed verdict artifact: only one verdict contract comment is allowed per spec');
    }
    if (commentEnd === -1) return;
    commentStart = specText.indexOf('<!--', commentEnd + 3);
  }
}

// Parses the spec-head verdict artifact into a contract object. Throws with a
// clear message on malformed input; never returns a partial/garbage contract.
// The contract comment must sit at the head of the file (only whitespace may
// precede `<!--`), exactly one per artifact, every known key at most once.
export function parseContract(specText) {
  const commentStart = typeof specText === 'string' ? specText.indexOf('<!--') : -1;
  if (commentStart === -1) {
    throw new Error('no verdict artifact: expected an HTML comment starting with `verdict:`');
  }
  if (specText.slice(0, commentStart).trim() !== '') {
    throw new Error(
      'malformed verdict artifact: the contract comment must sit at the head of the spec (only whitespace may precede `<!--`)',
    );
  }
  const commentEnd = specText.indexOf('-->', commentStart + 4);
  if (commentEnd === -1) {
    throw new Error('malformed verdict artifact: HTML comment is never closed with `-->`');
  }

  const content = specText.slice(commentStart + 4, commentEnd);
  if (!content.replace(/^\s+/, '').startsWith('verdict:')) {
    throw new Error('malformed verdict artifact: first comment must start with `verdict:`');
  }
  assertNoLaterContractComment(specText, commentEnd + 3);

  const lines = content.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const [line1, ...rest] = lines;

  const line1Match = line1.match(/^verdict:\s*(.*?)\s*\|\s*gear:\s*(.*)$/);
  if (!line1Match) {
    throw new Error(
      `malformed verdict line: expected "verdict: <text> | gear: <int>", got "${line1}"`,
    );
  }
  const [, verdict, gearRaw] = line1Match;
  if (verdict.length === 0) {
    throw new Error('malformed verdict artifact: verdict text must be non-empty');
  }
  const gear = Number(gearRaw.trim());
  if (!Number.isInteger(gear)) {
    throw new Error(`malformed verdict artifact: gear must be an integer, got "${gearRaw.trim()}"`);
  }

  const contract = {
    verdict,
    gear,
    drive: undefined,
    branch: undefined,
    commitAuth: undefined,
    harness: undefined,
    blastRadius: undefined,
    logMode: 'safe',
  };

  const seenKeys = new Set();
  for (const line of rest) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`malformed verdict artifact: expected "key: value", got "${line}"`);
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!Object.hasOwn(KNOWN_KEYS, key)) {
      throw new Error(`unknown verdict artifact key: "${key}"`);
    }
    const prop = KNOWN_KEYS[key];
    if (seenKeys.has(key)) {
      throw new Error(`duplicate verdict artifact key: "${key}"`);
    }
    seenKeys.add(key);
    contract[prop] = value;
  }

  if (!['safe', 'exact'].includes(contract.logMode)) {
    throw new Error(`malformed verdict artifact: log-mode must be safe or exact, got "${contract.logMode}"`);
  }

  return contract;
}

// Checks a parsed contract against the refusal guards; returns an array of
// human-readable violation strings, empty when the conductor may run.
export function contractViolations(contract, currentBranch) {
  const violations = [];

  if (contract.drive !== 'autopilot') {
    violations.push('no `drive: autopilot` in the contract (manual-drive specs are refused)');
  }
  if (contract.gear !== 3) {
    violations.push(`contract gear is ${contract.gear}, autopilot requires gear 3`);
  }
  if (!contract.branch) {
    violations.push('contract is missing `branch`');
  }
  if (currentBranch !== contract.branch) {
    violations.push(
      `current branch "${currentBranch}" does not match contract branch "${contract.branch}"`,
    );
  }
  if (currentBranch === 'main' || currentBranch === 'master') {
    violations.push(`current branch is "${currentBranch}" — autopilot refuses to drive on ${currentBranch}`);
  }
  if (!contract.harness) {
    violations.push('contract is missing `harness`');
  } else if (headlessCommand(contract.harness, 'probe') === null) {
    violations.push(`autopilot is not offered on harness "${contract.harness}" (no headless mode)`);
  }
  // The contract is the human's pre-authorization for full-permission children:
  // without a commit policy the implement phase would invent one, and without a
  // declared blast radius the run has no stated safety boundary. Both policies
  // are closed enums — an empty, case-drifted, or unknown value refuses the
  // run; the conductor never guesses a policy on the human's behalf.
  if (contract.commitAuth === undefined) {
    violations.push('contract is missing `commit-auth`');
  } else if (contract.commitAuth === '') {
    violations.push('contract `commit-auth` value is empty');
  } else if (contract.commitAuth !== 'per-task') {
    violations.push(`contract commit-auth "${contract.commitAuth}" is not the one allowed policy "per-task"`);
  }
  if (contract.blastRadius === undefined) {
    violations.push('contract is missing `blast-radius`');
  } else if (contract.blastRadius === '') {
    violations.push('contract `blast-radius` value is empty');
  } else if (contract.blastRadius !== 'branch-only, no-push, stop-before-PR') {
    violations.push(
      `contract blast-radius "${contract.blastRadius}" is not the single allowed literal "branch-only, no-push, stop-before-PR"`,
    );
  }

  return violations;
}

// The phase table: each phase runs once, in order, in its own fresh headless
// session. `phase-<n>.log` uses the 1-based index into this table.
export const PHASES = Object.freeze(['plan', 'implement', 'review']);

// The status event that means "this phase is finished". `review` never reports
// DONE: it stops before bump/PR and hands back to the human, so its completion
// marker is READY_FOR_PR.
const COMPLETION_EVENT = Object.freeze({
  plan: 'DONE',
  implement: 'DONE',
  review: 'READY_FOR_PR',
});

const STATUS_FILE_NAME = 'autopilot-status.md';
const LOCK_DIRECTORY_NAME = '.gear-3-autopilot.lock';
const RESOURCE_USAGE_FILE_NAME = 'resource-usage.jsonl';
const FIELD_SEPARATOR = ' — ';
const USAGE_FIELDS = Object.freeze([
  'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
  'reasoningTokens', 'totalTokens', 'cost', 'currency', 'turns',
]);

// Physical generation identities are compared without numeric truncation.
function sameLockIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// Coordination lives outside the typed work-artifact grammar. No-follow reads
// bind both physical identities; malformed or unverifiable owners fail closed.
function readLockGeneration(lockPath) {
  const directory = lstatSync(lockPath, { bigint: true });
  if (!directory.isDirectory()) throw new Error('run lock target is not an ordinary directory');
  const ownerPath = join(lockPath, 'owner.json');
  const owner = lstatSync(ownerPath, { bigint: true });
  if (!owner.isFile() || owner.nlink !== 1n) throw new Error('run lock owner is not a single-link ordinary file');
  const fd = openSync(ownerPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW | FS_CONSTANTS.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameLockIdentity(owner, opened)) throw new Error('run lock owner identity changed');
    const bytes = readFileSync(fd, 'utf8');
    const record = JSON.parse(bytes);
    if (!record || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== 'pid,schemaVersion,token'
      || record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || typeof record.token !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(record.token)) {
      throw new Error('run lock owner has an invalid closed record');
    }
    const after = lstatSync(ownerPath, { bigint: true });
    const directoryAfter = lstatSync(lockPath, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || !sameLockIdentity(owner, after)
      || !directoryAfter.isDirectory() || !sameLockIdentity(directory, directoryAfter)) {
      throw new Error('run lock generation identity changed');
    }
    return { directory, owner, record, bytes };
  } finally {
    closeSync(fd);
  }
}

function assertLockGeneration(lockPath, expected) {
  const actual = readLockGeneration(lockPath);
  if (!sameLockIdentity(expected.directory, actual.directory)
    || !sameLockIdentity(expected.owner, actual.owner)
    || expected.bytes !== actual.bytes
    || expected.record.pid !== actual.record.pid
    || expected.record.token !== actual.record.token) {
    throw new Error('run lock generation identity changed');
  }
}

function requireAbsentLockPath(path) {
  try { lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('run lock transition destination already exists');
}

async function acquireRunLock(lockPath, opts) {
  const token = randomUUID();
  const candidate = `${lockPath}.candidate-${token}`;
  mkdirSync(candidate, { mode: 0o700 });
  let generation;
  let published = false;
  const recovered = [];
  try {
    const fd = openSync(join(candidate, 'owner.json'),
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ schemaVersion: 1, pid: process.pid, token }));
    } finally { closeSync(fd); }
    generation = readLockGeneration(candidate);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let occupied = true;
      try { lstatSync(lockPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        occupied = false;
      }
      if (!occupied) {
        try {
          renameSync(candidate, lockPath);
          published = true;
          assertLockGeneration(lockPath, generation);
          return { acquired: true, generation, recovered };
        } catch (error) {
          if (published || !['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        }
      }
      const observed = readLockGeneration(lockPath);
      try {
        (opts.processProbe ?? ((pid) => process.kill(pid, 0)))(observed.record.pid);
        return { acquired: false, holder: observed.record.pid };
      } catch (error) {
        if (error.code !== 'ESRCH') throw new Error('run lock owner is unverifiable');
      }
      await opts.lockTransition?.('stale-observed');
      const quarantine = `${lockPath}.stale-${observed.record.token}`;
      requireAbsentLockPath(quarantine);
      assertLockGeneration(lockPath, observed);
      await opts.lockTransition?.('before-stale-rename');
      // The retained, nonempty token-bound destination is essential: another
      // stale contender cannot rename a successor over the first quarantine,
      // even if it was suspended immediately after its last identity check.
      renameSync(lockPath, quarantine);
      assertLockGeneration(quarantine, observed);
      recovered.push({ quarantine, pid: observed.record.pid });
    }
    throw new Error('run lock acquisition contention');
  } finally {
    if (!published && generation) {
      assertLockGeneration(candidate, generation);
      unlinkSync(join(candidate, 'owner.json'));
      rmdirSync(candidate);
    }
  }
}

function releaseRunLock(lockPath, generation) {
  assertLockGeneration(lockPath, generation);
  const retired = `${lockPath}.retired-${generation.record.token}`;
  requireAbsentLockPath(retired);
  renameSync(lockPath, retired);
  assertLockGeneration(retired, generation);
  unlinkSync(join(retired, 'owner.json'));
  rmdirSync(retired);
}

// Builds the prompt for a phase's headless child session. The child is a full
// harness main loop, so the prompt only has to name the skill, the spec, and the
// unattended rules — everything else it reads from the contract at the spec head.
export function phasePrompt(phase, specPath, correlation = {}) {
  if (!PHASES.includes(phase)) {
    throw new Error(`unknown phase "${phase}": expected one of ${PHASES.join(', ')}`);
  }
  const identity = correlation.runId === undefined && correlation.attempt === undefined
    ? []
    : [
      `This phase belongs to run-id \`${correlation.runId}\` and attempt \`${correlation.attempt}\`.`,
      'Echo both values in every status marker note that you append.',
    ];
  const manifestReference = correlation.manifestPath === undefined
    ? []
    : manifestReferencePrompt({
      phase,
      manifestPath: correlation.manifestPath,
      skill: `steepy-apex:${phase}`,
      runId: correlation.runId,
      attempt: correlation.attempt,
    }).split('\n');
  if (correlation.manifestPath !== undefined) {
    return [
      ...manifestReference,
      'Unattended autopilot: never ask questions or wait for a human; never push, bump versions, or open PRs.',
      `If unresolvable, append correlated \`BLOCKED\` to \`${STATUS_FILE_NAME}\`; exit non-zero.`,
    ].join(' ');
  }
  return [
    `Invoke the steepy-apex '${phase}' skill the way this harness invokes skills, on the`,
    `spec at ${specPath}.`,
    'This is an unattended gear-3 autopilot run: the contract is the extended verdict',
    'artifact at the head of that spec — read it and obey it.',
    `Follow the ${phase} skill's autopilot branch: never ask a question, never wait for a`,
    'human, and never push, bump a version, or open a PR.',
    'If anything is unresolvable, append a `BLOCKED` line with the reason to the run\'s',
    `\`${STATUS_FILE_NAME}\` (in .apex/work/tasks/<spec-basename>/) and exit non-zero.`,
    ...manifestReference,
    ...identity,
  ].join(' ');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function spawnedIdentity(event) {
  if (event.actor !== 'CONDUCTOR' || event.event !== 'SPAWNED') return null;
  const fields = {};
  for (const match of event.note.matchAll(/(?:^|\s)(run-id|phase|attempt|display-name|readable|raw|session)=([^\s]+)/g)) {
    fields[match[1]] = match[2];
  }
  const attempt = Number(fields.attempt);
  const phaseNumber = PHASES.indexOf(fields.phase) + 1;
  if (
    !UUID_PATTERN.test(fields['run-id'] ?? '')
    || !PHASES.includes(fields.phase)
    || !Number.isSafeInteger(attempt)
    || attempt < 1
    || !fields['display-name']
    || !fields.readable
    || !fields.raw
    || fields.session !== 'pending'
  ) return null;
  const identitySuffix = `-${fields.phase}-a${attempt}-${fields['run-id'].slice(0, 8).toLowerCase()}`;
  if (
    !fields['display-name'].startsWith('steepy-')
    || !fields['display-name'].endsWith(identitySuffix)
    || fields.readable !== `phase-${phaseNumber}-attempt-${attempt}.log`
    || fields.raw !== `phase-${phaseNumber}-attempt-${attempt}.raw.jsonl`
  ) return null;
  return { runId: fields['run-id'], phase: fields.phase, attempt };
}

function correlatedIdentity(note, actorPhase) {
  const fields = {};
  for (const match of String(note ?? '').matchAll(/(?:^|\s)(run-id|phase|attempt)=([^\s]+)/g)) {
    fields[match[1]] = match[2];
  }
  const attempt = Number(fields.attempt);
  if (
    !UUID_PATTERN.test(fields['run-id'] ?? '')
    || !Number.isSafeInteger(attempt)
    || attempt < 1
  ) return null;
  // The status actor is already validated as the phase. Current chain skills
  // therefore echo only run-id + attempt; an optional redundant phase remains
  // accepted only when it agrees, preserving old structured status evidence.
  if (!PHASES.includes(actorPhase)) return null;
  if (fields.phase !== undefined && fields.phase !== actorPhase) return null;
  return { runId: fields['run-id'], phase: actorPhase, attempt };
}

function noteRunId(note) {
  const runId = String(note ?? '').match(/(?:^|\s)run-id=([^\s]+)/)?.[1];
  return UUID_PATTERN.test(runId ?? '') ? runId : null;
}

function statusWorkflowFields(record) {
  const spawn = spawnedIdentity(record);
  const notedPhase = record.note.match(/(?:^|\s)phase=([^\s]+)/)?.[1];
  const conductorIdentity = record.actor === 'CONDUCTOR' && PHASES.includes(notedPhase)
    ? correlatedIdentity(record.note, notedPhase)
    : null;
  const phaseIdentity = PHASES.includes(record.actor)
    ? correlatedIdentity(record.note, record.actor)
    : null;
  const identity = spawn ?? conductorIdentity ?? phaseIdentity;
  const baseline = record.actor === 'CONDUCTOR' && record.event === 'BASELINE'
    ? record.note.match(/(?:^|\s)commit=([0-9a-f]{7,40})(?:\s|$)/)?.[1] ?? null
    : null;

  let kind = 'OBSERVED';
  if (baseline !== null) kind = 'BASELINE';
  else if (spawn !== null) kind = 'ATTEMPT_STARTED';
  else if (record.actor === 'CONDUCTOR' && record.event === 'ATTEMPT_RESERVED' && conductorIdentity !== null) {
    kind = 'ATTEMPT_RESERVED';
  } else if (
    record.actor === 'CONDUCTOR'
    && ['ARTIFACT_FAILED', 'MODEL_ROUTED', 'MODEL_ROUTING_FAILED'].includes(record.event)
    && conductorIdentity !== null
  ) {
    kind = 'ATTEMPT_OBSERVED';
  }

  return {
    runId: identity?.runId ?? noteRunId(record.note),
    kind,
    scope: record.event === 'PHASE_ACCEPTED' && !acceptedIdentity(record)
      ? null : identity?.phase ?? (PHASES.includes(record.actor) ? record.actor : null),
    attempt: identity?.attempt ?? null,
    ...(baseline === null ? {} : { baseline }),
  };
}

const STATUS_PROTOCOL_VERSION = 1;

function acceptedIdentity(record) {
  if (record.actor !== 'CONDUCTOR' || record.event !== 'PHASE_ACCEPTED') return null;
  const match = record.note.match(/^run-id=([^\s]+) phase=(plan|implement|review) attempt=([1-9]\d*) child-event=(DONE|READY_FOR_PR)$/);
  if (!match || match[4] !== COMPLETION_EVENT[match[2]]) return null;
  return correlatedIdentity(record.note, match[2]);
}

function validateStatusProtocol(statusText) {
  if (statusText === '') return;
  // Inspect the event field even when its timestamp is malformed; mentions in
  // notes and human prose are not declarations.
  const declarations = statusText.split('\n').filter((line) => line.split(FIELD_SEPARATOR)[2] === 'STATUS_PROTOCOL');
  const records = normalizeAutopilotStatus(statusText);
  if (declarations.length !== 1 || records[0]?.actor !== 'CONDUCTOR'
    || records[0]?.event !== 'STATUS_PROTOCOL'
    || records[0]?.note !== `version=${STATUS_PROTOCOL_VERSION}`
    || declarations[0] !== statusText.split('\n')[records[0].sourceLine - 1]) {
    throw new Error('unsupported or malformed status protocol: exactly one leading STATUS_PROTOCOL version=1 declaration is required');
  }
}

// Gear-3 keeps its Markdown bytes as the durable public protocol. This adapter
// produces only an in-memory common envelope, retaining every grammar-valid
// source record and assigning deterministic sequence identities for replay.
export function normalizeAutopilotStatus(statusText) {
  const sourceBytes = String(statusText ?? '');
  const envelopes = [];
  let sourceLine = 0;
  for (const line of sourceBytes.split('\n')) {
    sourceLine += 1;
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length < 4) continue;
    const [sourceTimestamp, actor, event, ...noteParts] = fields;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(sourceTimestamp)) continue;
    // Skills may emit UTC seconds. Canonicalize only the in-memory envelope;
    // the shared validator still rejects invalid dates and ledger bytes stay intact.
    const timestamp = sourceTimestamp.length === 20
      ? sourceTimestamp.replace(/Z$/, '.000Z') : sourceTimestamp;
    const note = noteParts.join(FIELD_SEPARATOR);
    const workflow = statusWorkflowFields({ timestamp, actor, event, note });
    try {
      envelopes.push(normalizeWorkflowEnvelope({
        schemaVersion: 1,
        sequence: envelopes.length + 1,
        runId: workflow.runId,
        timestamp,
        event,
        actor,
        note,
        kind: workflow.kind,
        scope: workflow.scope,
        attempt: workflow.attempt,
        sourceLine,
        ...(workflow.baseline === undefined ? {} : { baseline: workflow.baseline }),
      }, { allowUncorrelated: true }));
    } catch {
      // A separator-shaped but non-envelope record remains raw status bytes and
      // has no reduction effect.
    }
  }
  Object.defineProperties(envelopes, {
    sourceBytes: { value: sourceBytes, enumerable: false },
    byteLength: { value: Buffer.byteLength(sourceBytes), enumerable: false },
  });
  return Object.freeze(envelopes);
}

export function replayAutopilotStatus(statusText) {
  const envelopes = normalizeAutopilotStatus(statusText);
  const state = replayPhaseWorkflow(envelopes, {
    scopes: PHASES,
    completionEvents: Object.fromEntries(PHASES.map((phase) => [phase, 'PHASE_ACCEPTED'])),
  });
  return Object.freeze({
    ...state,
    sourceBytes: envelopes.sourceBytes,
    sourceByteLength: envelopes.byteLength,
  });
}

export function nextPhaseAttempt(statusText, phase) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase "${phase}"`);
  return nextWorkflowAttempt(replayAutopilotStatus(statusText), phase);
}

export function phaseDisplayName(specBasename, phase, attempt, runId) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase "${phase}"`);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive integer');
  if (!UUID_PATTERN.test(runId)) throw new TypeError('runId must be a UUID');
  const safeSpec = assertSafeRelPath(specBasename, 'spec name');
  return `steepy-${safeSpec}-${phase}-a${attempt}-${runId.slice(0, 8).toLowerCase()}`;
}

// True when the status file records correlated conductor acceptance —
// the resume check: a completed phase is skipped, never re-spawned.
export function phaseCompleted(statusText, phase, expectedIdentity = null) {
  if (!COMPLETION_EVENT[phase]) return false;
  if (
    expectedIdentity !== null
    && (
      expectedIdentity === undefined
      || !UUID_PATTERN.test(expectedIdentity.runId ?? '')
      || expectedIdentity.phase !== phase
      || !Number.isSafeInteger(expectedIdentity.attempt)
      || expectedIdentity.attempt < 1
    )
  ) return false;
  const normalizedIdentity = expectedIdentity === null ? null : {
    runId: expectedIdentity.runId,
    scope: expectedIdentity.phase,
    attempt: expectedIdentity.attempt,
  };
  return workflowScopeCompleted(replayAutopilotStatus(statusText), phase, normalizedIdentity);
}

// Child evidence is necessary for this attempt, but never resume authority.
function childCompleted(statusText, phase, identity) {
  const records = normalizeAutopilotStatus(statusText);
  const spawnIndex = records.findIndex((record) => {
    const spawn = spawnedIdentity(record);
    return spawn?.runId === identity.runId && spawn.phase === phase && spawn.attempt === identity.attempt;
  });
  return spawnIndex !== -1 && records.slice(spawnIndex + 1).some((record) => {
    const child = correlatedIdentity(record.note, record.actor);
    return record.actor === phase && record.event === COMPLETION_EVENT[phase]
      && child?.runId === identity.runId && child.attempt === identity.attempt;
  });
}

// The confined primitives fail closed on every hostile filesystem state; only
// these two absence signatures mean "the artifact is simply not there yet".
function absentWorkArtifact(error) {
  return error instanceof Error
    && /^work path: missing (?:work artifact|ancestor directory)/.test(error.message);
}

// Appends one protocol line. Fields are collapsed to a single line before the
// sanitize gate so a multi-line reason (a git error, a child's stderr) can never
// forge extra protocol lines. The write rides the confined primitives: the
// first line of a fresh run creates the file atomically; every later line
// appends to the bound ordinary file.
export function appendStatus(repoRoot, statusPath, actor, event, note) {
  const line = [new Date().toISOString(), actor, event, note].map(statusField).join(FIELD_SEPARATOR);
  const payload = `${line}\n`;
  try {
    appendWorkPath(repoRoot, statusPath, payload, { expect: 'work-output', family: 'status' });
  } catch (error) {
    if (!absentWorkArtifact(error)) throw error;
    writeWorkPath(repoRoot, statusPath, payload, { expect: 'work-output', family: 'status' });
  }
  return line;
}

// Control characters (a child's terminal escapes, embedded newlines) are stripped,
// not rejected: recording HALTED must never itself throw. `assertSafeLine` stays as
// defense in depth on the already-clean result.
function statusField(value) {
  const clean = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return assertSafeLine(clean, 'status field');
}

function sourcedField(value) {
  return value === null || value === undefined ? null : value;
}

function usageCorrelationKey(envelope, scope = null) {
  return JSON.stringify([
    envelope.runId, envelope.phase, envelope.attempt, envelope.sessionId,
    envelope.actor, envelope.actorId, envelope.parentActorId, scope,
    envelope.metadata?.observationFingerprint ?? null,
  ]);
}

function usageMetadataObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const PROVIDER_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const PROVIDER_VERSION_TIMEOUT_MS = 250;
const PROVIDER_VERSION_MAX_BUFFER = 4096;

function boundedVersionProbe(command, args, { cwd, timeoutMs, maxBuffer }) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;
    let timer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killProbeGroup = () => {
      if (!child) return;
      if (process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall through to the direct-child boundary if group signalling races exit.
        }
      }
      try { child.kill('SIGKILL'); } catch { /* a concurrent exit is already bounded */ }
    };
    try {
      child = spawn(command, args, {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      settle({ status: null, stdout, error });
      return;
    }
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxBuffer) {
        killProbeGroup();
        settle({ status: null, stdout, error: new Error('provider version output overflow') });
        return;
      }
      stdout += String(chunk);
    });
    child.once('error', (error) => settle({ status: null, stdout, error }));
    child.once('close', (status, signal) => settle({ status, stdout, signal }));
    timer = setTimeout(() => {
      killProbeGroup();
      settle({ status: null, stdout, signal: 'SIGKILL', error: new Error('provider version probe timeout') });
    }, timeoutMs);
  });
}

export async function detectProviderRuntimeVersion(harness, command, cwd, run = boundedVersionProbe) {
  if (harness !== 'opencode') return null;
  try {
    const result = await run(command.cmd, ['--version'], {
      cwd,
      timeoutMs: PROVIDER_VERSION_TIMEOUT_MS,
      maxBuffer: PROVIDER_VERSION_MAX_BUFFER,
    });
    if (result?.status !== 0 || result.signal || result.error || typeof result.stdout !== 'string') return null;
    const version = result.stdout.trim();
    return PROVIDER_VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}

function createUsageObserver({
  repoRoot,
  ledgerPath,
  requestedModelTier,
  resolvedModel,
  modelSelection,
  manifestPath,
  manifestBytes,
  reportDegradation,
  recorded,
  degraded,
  openLedger,
  writeLedger = writeSync,
  closeLedger = closeSync,
  statLedger = fstatSync,
  truncateLedger = ftruncateSync,
  serialize = JSON.stringify,
}) {
  const reportOnce = (envelope, scope, capability, reason) => {
    const correlation = usageCorrelationKey(envelope, scope);
    const key = `${correlation}:${capability}:${reason}`;
    if (degraded.has(key)) return;
    degraded.add(key);
    reportDegradation({
      envelope,
      scope,
      capability,
      reason,
    });
  };

  return (envelope) => {
    if (envelope?.event !== 'completed' && envelope?.event !== 'usage.observed') return;
    const sourceUsage = envelope.usage && typeof envelope.usage === 'object' && !Array.isArray(envelope.usage)
      ? envelope.usage
      : {};
    const usage = {};
    for (const field of USAGE_FIELDS) {
      if (Object.hasOwn(sourceUsage, field)) usage[field] = sourceUsage[field];
    }
    const observationScope = usageMetadataObject(envelope.metadata?.observationScope);
    const measurementScope = usageMetadataObject(envelope.metadata?.measurementScope);
    const providerVersion = typeof envelope.metadata?.providerVersion === 'string'
      ? envelope.metadata.providerVersion
      : null;
    const observationFingerprint = typeof envelope.metadata?.observationFingerprint === 'string'
      ? envelope.metadata.observationFingerprint
      : null;
    const hasUsage = Object.keys(usage).length > 0;
    const hasActorAttribution = observationScope?.kind === 'actor'
      && sourcedField(envelope.actorId) !== null;
    const scopeLabel = typeof observationScope?.kind === 'string' ? observationScope.kind : null;

    if (!hasUsage) {
      reportOnce(envelope, scopeLabel, 'usage', 'missing-usage');
    }
    if (envelope.event === 'completed' && !hasActorAttribution) {
      reportOnce(envelope, scopeLabel, 'actorAttribution', 'missing-actor-attribution');
    }

    const correlation = usageCorrelationKey(envelope, scopeLabel);
    if (recorded.has(correlation)) return;

    const record = {
      schemaVersion: 2,
      runId: envelope.runId,
      phase: envelope.phase,
      attempt: envelope.attempt,
      harness: envelope.harness,
      ...(sourcedField(envelope.sessionId) === null ? {} : { sessionId: envelope.sessionId }),
      ...(sourcedField(envelope.actor) === null ? {} : { actor: envelope.actor }),
      ...(sourcedField(envelope.actorId) === null ? {} : { actorId: envelope.actorId }),
      ...(sourcedField(envelope.parentActorId) === null ? {} : { parentActorId: envelope.parentActorId }),
      ...(observationFingerprint === null ? {} : { observationFingerprint }),
      ...(observationScope === null ? {} : { observationScope }),
      ...(typeof envelope.metadata?.measurementId === 'string'
        ? { measurementId: envelope.metadata.measurementId }
        : {}),
      ...(measurementScope === null ? {} : { measurementScope }),
      ...(providerVersion === null ? {} : { providerVersion }),
      aggregationEligibility: observationScope?.kind === 'actor'
        ? 'nested-actor-detail'
        : (measurementScope === null ? 'unknown' : 'provider-measurement'),
      requestedModelTier,
      ...(resolvedModel === null || resolvedModel === undefined ? {} : { resolvedModel }),
      modelSelection,
      manifestPath,
      manifestBytes,
      ...(hasUsage ? { usage } : {}),
    };

    let serialized;
    try {
      const encoded = serialize(record);
      if (typeof encoded !== 'string') throw new TypeError('usage-ledger serializer must return a string');
      serialized = `${encoded}\n`;
    } catch {
      reportOnce(envelope, scopeLabel, 'ledger', 'ledger-serialization-error');
      return;
    }

    let fd;
    try {
      fd = openLedger === undefined
        ? openWorkPathFd(repoRoot, ledgerPath, {
          expect: 'work-output',
          family: 'ledger',
          disposition: 'append',
          mode: 0o600,
        })
        : openLedger(join(repoRoot, ledgerPath), 'a', 0o600);
    } catch {
      reportOnce(envelope, scopeLabel, 'ledger', 'ledger-open-error');
      return;
    }
    let initialBytes = null;
    let persisted = false;
    try {
      initialBytes = statLedger(fd).size;
      const bytes = Buffer.from(serialized);
      let offset = 0;
      while (offset < bytes.length) {
        const remaining = bytes.subarray(offset);
        const accepted = writeLedger(fd, remaining);
        if (!Number.isSafeInteger(accepted) || accepted < 1 || accepted > remaining.length) {
          throw new Error(
            `invalid usage-ledger write: wrote ${accepted} of ${remaining.length} remaining bytes`,
          );
        }
        offset += accepted;
      }
      persisted = true;
    } catch {
      if (initialBytes !== null) {
        try {
          truncateLedger(fd, initialBytes);
        } catch {
          reportOnce(envelope, scopeLabel, 'ledger', 'ledger-rollback-error');
        }
      }
      reportOnce(envelope, scopeLabel, 'ledger', 'ledger-write-error');
    } finally {
      try {
        closeLedger(fd);
      } catch {
        reportOnce(envelope, scopeLabel, 'ledger', 'ledger-close-error');
      }
    }
    if (persisted) recorded.add(correlation);
  };
}

// Resolves the current git branch name for `cwd`. Throws on git failure (not
// a repo, detached HEAD tooling missing, etc.) — the loop re-checks this before
// every phase, so a stale/absent branch must surface loudly.
export function currentGitBranch(cwd) {
  const result = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`git branch --show-current failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git branch --show-current failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// The worktree's uncommitted state as `git status --porcelain` output ('' =
// clean). Untracked files count: a full-permission child told to commit per the
// contract can sweep any pre-existing file into its commits.
export function workingTreeStatus(cwd) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`git status --porcelain failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git status --porcelain failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// git's canonical empty tree: diffing against it on an unborn branch yields "everything
// is new" instead of failing the run over a repo that has no commit yet.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// The commit the run starts from. Recorded once in the status stream so a resumed
// run keeps the original baseline and the aggregate diff never silently shrinks to
// "since the resume".
export function currentGitCommit(cwd) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`git rev-parse HEAD failed: ${result.error.message}`);
  }
  if (result.status !== 0) return EMPTY_TREE;
  return result.stdout.trim();
}

export function runBaseline(statusText) {
  return replayAutopilotStatus(statusText).baseline;
}

// The aggregate branch diff is derived data, so the conductor produces it rather than
// asking a child for it: `git diff <baseline>` covers committed and uncommitted tracked
// work in one call, under either commit-auth policy. Untracked paths carry no diff, so
// they are named explicitly — a review input must never hide a new file behind silence.
export function captureBranchDiff({ cwd, baseline, outputPath }) {
  const safePath = parseWorkPath(outputPath, 'work-output', 'diff').path;
  const diff = spawnSync('git', ['diff', '--no-color', baseline], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (diff.error) throw new Error(`git diff ${baseline} failed: ${diff.error.message}`);
  if (diff.status !== 0) throw new Error(`git diff ${baseline} failed: ${diff.stderr.trim()}`);

  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (untracked.error) throw new Error(`git ls-files --others failed: ${untracked.error.message}`);
  if (untracked.status !== 0) throw new Error(`git ls-files --others failed: ${untracked.stderr.trim()}`);
  const untrackedPaths = untracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  const sections = [`=== branch diff: ${baseline}..working tree ===`, diff.stdout.trimEnd()];
  if (untrackedPaths.length > 0) {
    sections.push(
      '=== untracked files (present on disk, no diff above) ===',
      untrackedPaths.join('\n'),
    );
  }
  const contents = `${sections.filter(Boolean).join('\n')}\n`;
  // The derived artifact is created through the confined primitives: parent
  // directories appear with ancestor discipline and the bytes land on a bound
  // ordinary target — never through a symlink.
  mkdirWorkPath(cwd, safePath, { expect: 'work-output', family: 'diff' });
  writeWorkPath(cwd, safePath, contents, { expect: 'work-output', family: 'diff' });
  return { path: safePath, bytes: Buffer.byteLength(contents), untracked: untrackedPaths };
}

function repositoryPath(cwd, absolutePath, label) {
  return assertSafeRelPath(relative(cwd, absolutePath), label);
}

// Work-path inputs (.apex/work/specs/**, .apex/work/plans/**, run artifacts)
// ride the typed confined read; hub-doc reads (routing index, testing checklist,
// conventions, standards) keep their lexical guard — they sit outside the
// .apex/work/ contract of work-paths.mjs.
function readArtifact(cwd, path) {
  if (path.startsWith('.apex/work/')) {
    return readWorkPath(cwd, path, { encoding: 'utf8' });
  }
  const safePath = assertSafeRelPath(path, 'artifact path');
  return readFileSync(join(cwd, safePath), 'utf8');
}

function phaseManifestInput({ phase, cwd, absSpec, runId, attempt, contract, baseline }) {
  const specPath = repositoryPath(cwd, absSpec, 'spec path');
  const specName = basename(absSpec, '.md');
  const routingPath = '.apex/_INDEX.md';
  const testingPath = '.apex/testing-and-checklist.md';
  const conventionsPath = '.apex/conventions.md';
  const planPath = `.apex/work/plans/${specName}.md`;
  const ledgerPath = `.apex/work/tasks/${specName}/ledger.md`;
  const taskResultIndexPath = `.apex/work/tasks/${specName}/task-result-index.md`;
  const branchDiffPath = `.apex/work/tasks/${specName}/branch-diff.txt`;
  const criteriaPath = `.apex/work/tasks/${specName}/success-criteria.md`;
  const evidencePath = `.apex/work/tasks/${specName}/evidence-report.md`;
  const reviewReportPath = `.apex/work/tasks/${specName}/review-report.md`;
  const routingText = readArtifact(cwd, routingPath);
  const standardsBySurface = standardsBySurfaceFromRouting(routingText, { repoRoot: cwd });
  // A cross-cutting entry with no routing row loads no standard. That is a real
  // loss of eager context (a misspelled surface looks exactly like prose), so it
  // is collected here and recorded in the status stream rather than dropped.
  const unroutedSurfaces = [];
  const common = {
    repoRoot: cwd,
    runId,
    attempt,
    outputs: [],
    standardsBySurface,
    onUnroutedSurface: (surface) => unroutedSurfaces.push(surface),
    contract: {
      verdict: contract.verdict,
      gear: contract.gear,
      drive: contract.drive,
      branch: contract.branch,
      commitAuth: contract.commitAuth,
      harness: contract.harness,
      blastRadius: contract.blastRadius,
      logMode: contract.logMode,
    },
  };

  if (phase === 'plan') {
    const route = specPhaseContext(readArtifact(cwd, specPath));
    const manifest = buildPlanManifest({
      ...common,
      modelTier: route.modelTier,
      specPath,
      routingPath,
      testingPath,
      owningSurface: route.owningSurface,
      crossCuttingSurfaces: route.crossCuttingSurfaces,
      otherHubPaths: [conventionsPath],
      outputs: [planPath],
    });
    return { manifest, route, unroutedSurfaces };
  }

  const planText = readArtifact(cwd, planPath);
  const planRoute = phase === 'review'
    ? reviewPhaseContext(planText, readArtifact(cwd, taskResultIndexPath))
    : planPhaseContext(planText);
  if (phase === 'implement') {
    const manifest = buildImplementManifest({
      ...common,
      modelTier: planRoute.modelTier,
      planPath,
      routingPath,
      ledgerPath,
      taskResultIndexPath,
      specPath,
      tasks: planRoute.tasks,
      testCommand: planRoute.testCommand,
      criterionIds: planRoute.criterionIds,
      outputs: [ledgerPath, taskResultIndexPath, branchDiffPath, criteriaPath],
    });
    return { manifest, route: planRoute, unroutedSurfaces };
  }

  materializeSuccessCriteria({ repoRoot: cwd, specPath, outputPath: criteriaPath });
  captureBranchDiff({ cwd, baseline, outputPath: branchDiffPath });
  const manifest = buildReviewManifest({
    ...common,
    modelTier: planRoute.modelTier,
    criteriaPath,
    taskResultIndexPath,
    branchDiffPath,
    tasks: planRoute.tasks,
    testCommand: planRoute.testCommand,
    criterionIds: planRoute.criterionIds,
    outputs: [evidencePath, reviewReportPath],
  });
  return { manifest, route: planRoute, unroutedSurfaces };
}

// The conductor re-derives model application from the argv instead of trusting the
// descriptor's own `modelSelection`, so an adapter that claims `applied` without
// putting the model on the command line is caught. The evidence it looks for is the
// concrete model appearing as its own argv token (or as the value half of a
// `--flag=value` token) — not adjacency to a specific flag spelling. Which flag
// carries it is adapter policy, enforced adapter-side; duplicating that spelling
// here would silently mislabel any harness that uses `-m` or `--model=`.
function carriesConcreteModel(args, model) {
  if (!Array.isArray(args) || typeof model !== 'string' || model.length === 0) return false;
  return args.some((arg) => typeof arg === 'string'
    && (arg === model || (arg.startsWith('-') && arg.endsWith(`=${model}`))));
}

function descriptorRouting(command, requestedTier) {
  if (command.requestedModelTier !== requestedTier) {
    return {
      selection: 'degraded',
      model: null,
      reason: 'spawn descriptor did not preserve the requested model tier',
    };
  }
  if (command.modelSelection === 'applied') {
    const applied = carriesConcreteModel(command.args, command.resolvedModel);
    if (applied) return { selection: 'applied', model: command.resolvedModel, reason: null };
    return {
      selection: 'degraded',
      model: null,
      reason: 'spawn descriptor claimed applied without a matching concrete model argument',
    };
  }
  return {
    selection: 'degraded',
    model: null,
    reason: command.degradationReason ?? 'spawn descriptor supplied no concrete model evidence',
  };
}

// JSONC tolerance for opencode config candidates: an opencode install accepts
// `//` and `/* */` comments plus trailing commas in every candidate file (not
// just `opencode.jsonc` — verified with `opencode debug config` on 1.18.19),
// and plain `JSON.parse` rejects both, which would silently skip the pin. The
// first string-aware scan strips comments; the second strips commas followed
// only by whitespace before a closing brace/bracket. Markers inside string
// literals are never treated as syntax. Anything still unparseable throws —
// the same contract as `JSON.parse`, left to the caller's skip path.
function parseJsonc(text) {
  let stripped = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      stripped += ch;
      i += 1;
      while (i < text.length) {
        stripped += text[i];
        if (text[i] === '\\') {
          i += 1;
          if (i < text.length) stripped += text[i];
        } else if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, text.length);
    } else {
      stripped += ch;
      i += 1;
    }
  }
  let out = '';
  i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < stripped.length) {
        out += stripped[i];
        if (stripped[i] === '\\') {
          i += 1;
          if (i < stripped.length) out += stripped[i];
        } else if (stripped[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
    } else if (ch === ',') {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j])) j += 1;
      if (stripped[j] === '}' || stripped[j] === ']') i += 1;
      else {
        out += ch;
        i += 1;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return JSON.parse(out);
}

// The OpenCode tier table the conductor can supply: OpenCode alone has no
// built-in provider mapping, so the effective `model` pin is read from the
// config candidates an opencode install actually reads, in the override order
// verified against opencode 1.18.19 via `opencode debug config` in fixture
// dirs: `<cwd>/.opencode/opencode.json`, then `<cwd>/opencode.jsonc`, then
// `<cwd>/opencode.json`, then the user-global
// `<configHome>/opencode/opencode.json` (project over global), where
// `configHome` is `XDG_CONFIG_HOME` when it is a non-empty string, else
// `<home>/.config`, and `home` is `HOME` when it is a non-empty string, else
// `os.homedir()` — the portable fallback for environments (e.g. some
// sandboxes) that never set `HOME`. Each guard stays an explicit
// non-empty-string check, never a bare `??`, since `HOME=''`/`XDG_CONFIG_HOME=''`
// would otherwise produce a relative candidate. No repo-root walk-up: the
// conductor checks `<cwd>` only. `.opencode.json` is deliberately absent —
// opencode itself ignores that file, so reading it would route tiers from a
// pin the harness never applies. This is an approximation, not exact
// equivalence: the first candidate whose parsed config carries a string
// `model` field wins, which approximates opencode's project-over-global
// merge for the scalar `model` key. Returns undefined whenever no pin
// resolves to a mapped provider — no config, no string `model` field, or an
// unknown provider — leaving the caller on the declared degradation path.
// Read-only by contract: unreadable or unparseable candidates are skipped,
// never thrown. `env` and `homedir` are injectable seams for hermetic tests:
// a real HOME-unset call resolves the real user's home from passwd, which a
// hermetic test must never read.
export function opencodeProviderModelMappings(cwd, { env = process.env, homedir: resolveHomedir = homedir } = {}) {
  const home = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : resolveHomedir();
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(home, '.config');
  const candidates = [
    join(cwd, '.opencode', 'opencode.json'),
    join(cwd, 'opencode.jsonc'),
    join(cwd, 'opencode.json'),
    join(configHome, 'opencode', 'opencode.json'),
  ];
  for (const candidate of candidates) {
    let parsed;
    try {
      if (!existsSync(candidate)) continue;
      parsed = parseJsonc(readFileSync(candidate, 'utf8'));
    } catch {
      continue;
    }
    const pinned = parsed !== null && typeof parsed === 'object' ? parsed.model : undefined;
    if (typeof pinned !== 'string') continue;
    return tierModelsForProvider(resolveProviderFromModel(pinned));
  }
  return undefined;
}

// Grace between SIGTERM and SIGKILL for real stop causes such as interruption
// or a blocking durable-capture failure.
const KILL_GRACE_MS = 5000;

// '' means "no status file yet" (a fresh run); every other failure — a symlinked
// status target or ancestor, a non-ordinary file — propagates and refuses the run.
function readStatus(repoRoot, statusPath) {
  try {
    return readWorkPath(repoRoot, statusPath, { expect: 'work-output', family: 'status', encoding: 'utf8' });
  } catch (error) {
    if (!absentWorkArtifact(error)) throw error;
    return '';
  }
}

// The first stop-condition marker in `statusText`: this phase gave up (BLOCKED),
// or a doc-wins CONFLICT surfaced mid-run (never auto-overridden — a human rules).
function haltMarker(statusText, phase) {
  return (
    normalizeAutopilotStatus(statusText).find(
      (e) => (e.actor === phase && e.event === 'BLOCKED') || e.event === 'CONFLICT',
    ) ?? null
  );
}

// A small synchronous writable façade lets the generic bridge own destination
// policy while keeping raw persistence fail-fast: when writeSync returns, the
// raw evidence is already accepted by the kernel or the phase is blocking.
function syncFdDestination(fd, writeToFd = writeSync) {
  let closed = false;
  return {
    on() { return this; },
    write(chunk, callback) {
      try {
        if (closed) throw new Error('destination is closed');
        const expectedBytes = Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk));
        const accepted = writeToFd(fd, chunk);
        if (
          accepted !== false
          && (!Number.isSafeInteger(accepted) || accepted !== expectedBytes)
        ) {
          throw new Error(`short raw write: wrote ${accepted} of ${expectedBytes} bytes`);
        }
        callback?.();
        return accepted !== false;
      } catch (error) {
        callback?.(error);
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

// Spawns one fresh child session with piped stdout/stderr. Complete lines flow
// through the observability bridge into an immutable raw capture, optional
// readable destinations, and the mother session's curated live feed. Process
// lifetime remains owned here: detached group, stop escalation, and signal
// forwarding are the same invariants as the original fd-redirection path.
function runChild({
  cmd,
  args,
  cwd,
  rawPath,
  readablePath,
  aggregatePath,
  logMode,
  context,
  descriptor,
  killGraceMs = KILL_GRACE_MS,
  groupConvergenceMs = 1000,
  processGroupProbe = (pid) => process.kill(-pid, 0),
  processGroupSignal = (pid, signal) => process.kill(-pid, signal),
  onSpawn,
  onInterrupt,
  onDegradation,
  onSessionIdentified,
  onDecodedEvent,
  rawWrite = writeSync,
  rawDestinationFactory,
  writerMaxPendingBytes,
  drainTimeoutMs,
  decoder = decodeHeadlessEvent,
  renderer,
  serializer,
  registerNativeStop,
  liveStdout = process.stdout,
  liveStderr = process.stderr,
}) {
  return new Promise((resolveExit) => {
    const destinations = [];
    const opened = [];
    const openDestination = (
      name,
      role,
      path,
      disposition,
      mode,
      writeToFd = writeSync,
      streamFactory,
    ) => {
      const fd = openWorkPathFd(cwd, path, {
        expect: 'work-output',
        family: 'raw',
        disposition,
        mode,
      });
      const absolutePath = join(cwd, path);
      const defaultStream = syncFdDestination(fd, writeToFd);
      let stream = defaultStream;
      if (streamFactory) {
        try {
          stream = streamFactory({ fd, path: absolutePath, name, role, defaultStream });
          if (!stream || typeof stream.write !== 'function' || typeof stream.close !== 'function') {
            throw new TypeError(`${name} destination factory must return a writable, closeable stream`);
          }
        } catch (error) {
          defaultStream.close();
          throw error;
        }
      }
      opened.push(stream);
      destinations.push({ name, role, stream });
      return stream;
    };

    try {
      openDestination(
        'raw', 'raw', rawPath, 'create-new', RAW_OPEN_OPTIONS.mode, rawWrite,
        rawDestinationFactory,
      );
    } catch (error) {
      resolveExit({
        code: null,
        signal: null,
        error: classifyBridgeFailure('raw-open', new Error(`cannot open ${rawPath}: ${error.message}`)),
      });
      return;
    }

    try {
      openDestination('readable', 'readable', readablePath, 'create-new', 0o600);
    } catch (error) {
      onDegradation?.({ capability: 'readable', reason: 'readable-open-error', passthrough: null });
    }
    let aggregateDestination = null;
    let aggregateHealthy = false;
    try {
      aggregateDestination = openDestination('aggregate', 'aggregate', aggregatePath, 'append', 0o600);
      aggregateHealthy = true;
    } catch (error) {
      onDegradation?.({ capability: 'aggregate', reason: 'aggregate-open-error', passthrough: null });
    }
    const closeDestinations = () => {
      for (const destination of opened) {
        try {
          destination.close();
        } catch {
          // A failed readable close cannot erase the already-persisted raw log.
        }
      }
    };
    for (const [name, stream] of [['liveStdout', liveStdout], ['liveStderr', liveStderr]]) {
      if (!stream || typeof stream.write !== 'function') {
        closeDestinations();
        resolveExit({
          code: null,
          signal: null,
          error: new TypeError(`${name} must be a writable stream`),
        });
        return;
      }
      destinations.push({ name, role: name, stream });
    }

    let bridgeError = null;
    let child = null;
    let convergenceStarted = false;
    let convergenceFinished = false;
    let convergenceError = null;
    let childClosed = false;
    let nativeStopCleanup = null;
    let interrupted = null;
    let stopRequested = false;
    let settled = false;
    let pendingExitResult = null;
    let ingestionStates = [];
    let maybeFinish = () => {};
    // Only ESRCH proves absence. Permission/probe errors remain unknown and
    // cannot authorize the next phase. This owns the detached group, not
    // descendants that deliberately create another session or external work.
    const groupAbsent = () => {
      if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return true;
      try { processGroupProbe(child.pid); } catch (error) { return error.code === 'ESRCH'; }
      return false;
    };
    const convergeGroup = async () => {
      if (convergenceStarted || !child) return;
      convergenceStarted = true;
      const waitForAbsence = async (duration) => {
        const deadline = Date.now() + duration;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
          if (groupAbsent()) return true;
        }
        return groupAbsent();
      };
      if (!groupAbsent()) {
        try { processGroupSignal(child.pid, 'SIGTERM'); } catch { /* final probe decides */ }
        if (!await waitForAbsence(killGraceMs)) {
          try { processGroupSignal(child.pid, 'SIGKILL'); } catch { /* final probe decides */ }
          if (!await waitForAbsence(groupConvergenceMs)) {
            convergenceError = Object.assign(new Error('detached child process group absence could not be proven; evidence ingestion aborted; capture may be truncated'), {
              code: 'PROCESS_GROUP_NOT_CONVERGED',
            });
          }
        }
      }
      convergenceFinished = true;
      maybeFinish();
    };
    // All stop sources converge here. The first reason owns the attempt; later
    // signal/bridge races are ignored, so status and teardown settle once.
    const requestStop = (kind, value = null) => {
      if (settled) return false;
      if (kind === 'bridge' && !bridgeError) bridgeError = value;
      if (stopRequested) return false;
      stopRequested = true;
      if (kind === 'bridge') bridgeError = value;
      else interrupted = value;
      if (!child) return true;
      void convergeGroup();
      maybeFinish();
      return true;
    };
    const stopForBridge = (error) => {
      if (bridgeError) return;
      requestStop('bridge', error);
    };
    const writer = new BoundedMultiDestinationWriter({
      destinations,
      ...(writerMaxPendingBytes === undefined ? {} : { maxPendingBytes: writerMaxPendingBytes }),
      ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
      onBlockingError: stopForBridge,
      onDegradation: (degradation) => {
        if (degradation.capability === 'aggregate') aggregateHealthy = false;
        onDegradation?.(degradation);
      },
    });
    const degradations = createDegradationTracker();
    let sessionIdentified = false;

    const persist = (chunks, source = null) => {
      const result = writer.write(chunks, { source });
      if (result.error) stopForBridge(result.error);
      return result;
    };
    const aggregateBoundary = (kind) => persist({
      aggregate: `=== ${kind} run-id=${context.runId} phase=${context.phase} attempt=${context.attempt} display-name=${context.displayName} ===\n`,
    });
    let aggregateFinalized = false;
    const finalizeAggregate = () => {
      if (aggregateFinalized) return;
      aggregateFinalized = true;
      if (!aggregateDestination || !aggregateHealthy) return;
      let writeError = null;
      aggregateDestination.write(
        `=== END run-id=${context.runId} phase=${context.phase} attempt=${context.attempt} display-name=${context.displayName} ===\n`,
        (error) => { writeError = error; },
      );
      if (writeError) {
        aggregateHealthy = false;
        onDegradation?.({ capability: 'aggregate', reason: 'aggregate-write-error', passthrough: null });
      }
    };

    const emitCuratedEffects = (frame, result, source) => {
      if (bridgeError || settled) return;
      const callbackDegradation = deliverDecodedEvent(result.envelope, onDecodedEvent, degradations);
      if (callbackDegradation) onDegradation?.(callbackDegradation);
      const chunks = {};
      if (result.readable !== null) {
        const readable = `${result.readable}\n`;
        chunks.readable = readable;
        chunks.aggregate = readable;
      }
      if (result.live !== null) {
        chunks[frame.sourceStream === 'stderr' ? 'liveStderr' : 'liveStdout'] = `${result.live}\n`;
      }
      const curatedResult = Object.keys(chunks).length === 0 ? null : persist(chunks, source);
      if (curatedResult && !curatedResult.ok) return;

      if (!sessionIdentified && result.envelope?.sessionId) {
        sessionIdentified = true;
        try {
          onSessionIdentified?.(result.envelope.sessionId, descriptor.nativeSession ?? null);
        } catch {
          const degradation = degradations.record('nativeSessionIdentity', 'native-session-error');
          if (degradation) onDegradation?.(degradation);
        }
      }
    };

    const consume = (frame, state) => {
      if (bridgeError) return;
      const result = processEventLine({
        line: frame.line,
        sourceStream: frame.sourceStream,
        context: { ...context, receivedAt: new Date().toISOString() },
        mode: logMode,
        decoder,
        renderer,
        serializer,
        degradations,
      });
      if (result.blockingError) {
        stopForBridge(result.blockingError);
        return;
      }
      if (result.degradation) onDegradation?.(result.degradation);

      // Durable evidence settles before any curated side effect for this line.
      // A raw failure suppresses readable/live output and native session
      // binding; unresolved raw backpressure defers those effects until drain.
      const continuation = () => emitCuratedEffects(frame, result, state.controller);
      const rawResult = persist({ raw: result.raw }, state.controller);
      if (!rawResult.ok) return;
      if (rawResult.paused) {
        state.deferred = continuation;
        return;
      }
      continuation();
    };

    const pump = (state) => {
      if (state.pumping || state.blocked || bridgeError || settled) return;
      state.pumping = true;
      try {
        while (state.queueIndex < state.queue.length && !state.blocked && !bridgeError && !settled) {
          const frame = state.queue[state.queueIndex];
          state.queueIndex += 1;
          consume(frame, state);
        }
        if (state.queueIndex === state.queue.length) {
          state.queue.length = 0;
          state.queueIndex = 0;
        }
      } finally {
        state.pumping = false;
      }
      maybeFinish();
    };

    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      closeDestinations();
      resolveExit({
        code: null,
        signal: null,
        error: new Error(`cannot spawn ${cmd}: ${error.message}`),
      });
      return;
    }

    try {
      onSpawn?.(child);
      aggregateBoundary('BEGIN');
    } catch (error) {
      stopForBridge(error);
    }

    const framers = {
      stdout: new LineFramer({ sourceStream: 'stdout' }),
      stderr: new LineFramer({ sourceStream: 'stderr' }),
    };
    for (const sourceStream of ['stdout', 'stderr']) {
      const source = child[sourceStream];
      const state = {
        source,
        queue: [],
        queueIndex: 0,
        deferred: null,
        blocked: false,
        pumping: false,
        resuming: false,
        ended: false,
        controller: null,
      };
      state.controller = {
        pause() {
          state.blocked = true;
          source.pause();
        },
        resume() {
          if (state.resuming || bridgeError || settled) return;
          state.resuming = true;
          state.blocked = false;
          try {
            const deferred = state.deferred;
            state.deferred = null;
            deferred?.();
            if (!state.blocked && !bridgeError && !settled) pump(state);
          } finally {
            state.resuming = false;
          }
          // Process the accepted line and every already-framed successor before
          // allowing fresh stream data to overtake the deferred continuation.
          if (!state.blocked && !bridgeError && !settled) source.resume();
          maybeFinish();
        },
      };
      ingestionStates.push(state);
      source.on('data', (chunk) => {
        if (bridgeError) return;
        try {
          state.queue.push(...framers[sourceStream].push(chunk));
          pump(state);
        } catch (error) {
          stopForBridge(error);
        }
      });
      source.on('end', () => {
        try {
          const finalFrames = framers[sourceStream].end();
          state.ended = true;
          if (!bridgeError) state.queue.push(...finalFrames);
          pump(state);
          maybeFinish();
        } catch (error) {
          stopForBridge(error);
        }
      });
    }

    const stopForwarding = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGHUP', onSighup);
    };
    // Take the child down, record why, and only then die of the same signal we
    // were sent — the re-raise waits for `finish`, after the SIGKILL escalation
    // has run, so an interrupt cannot orphan a SIGTERM-ignoring child tree.
    const forward = (signal) => {
      stopForwarding();
      requestStop('interrupt', signal);
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    const onSighup = () => forward('SIGHUP'); // closing the terminal must not orphan the run
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);

    // A failed spawn emits BOTH 'error' and 'close': tear down exactly once, or
    // the second pass closes an fd number the host process has already reused.
    const finish = (result) => {
      if (settled) return;
      settled = true;
      stopForwarding();
      for (const state of ingestionStates) {
        state.queue.length = 0;
        state.queueIndex = 0;
        state.deferred = null;
        state.blocked = true;
        if (convergenceError) {
          state.ended = true;
          state.source.destroy();
        }
      }
      writer.terminate();
      if (convergenceError) {
        // This is an explicit evidence abort, never successful final ingestion.
        // Do not let retained pipes or a still-live leader hold the halt open.
        // Already durable raw bytes remain intact; buffered tails are discarded
        // and the blocking error discloses that capture may be truncated.
        for (const framer of Object.values(framers)) {
          try { framer.end(); } catch { /* capture is already blocking */ }
        }
        child.unref();
      }
      // Finalize once after normal stream closure or explicit capture abort.
      // A blocking bridge error must not suppress a healthy aggregate boundary.
      finalizeAggregate();
      closeDestinations();
      if (typeof nativeStopCleanup === 'function') {
        try {
          nativeStopCleanup();
        } catch {
          // teardown of an optional native observer cannot change phase truth
        }
      }
      if (interrupted && !convergenceError) {
        try {
          onInterrupt?.(interrupted);
        } catch {
          // never let bookkeeping swallow the interrupt
        }
        if (interrupted !== 'native-stop') {
          // Dying of the forwarded signal: never resolve back into the drive loop.
          process.kill(process.pid, interrupted);
          return;
        }
      }
      resolveExit({ ...result, interrupted: convergenceError ? null : interrupted,
        error: convergenceError ?? bridgeError ?? result.error });
    };
    maybeFinish = () => {
      if (settled || !convergenceFinished) return;
      if (convergenceError) {
        finish(pendingExitResult ?? { code: null, signal: null, error: null });
        return;
      }
      if (pendingExitResult === null || !childClosed) return;
      const ingestionIdle = ingestionStates.every(
        (state) => state.ended
          && !state.blocked
          && state.deferred === null
          && state.queue.length === 0
          && !state.pumping,
      );
      if (!bridgeError && !ingestionIdle) return;
      const result = pendingExitResult;
      pendingExitResult = null;
      finish(result);
    };
    const finishWhenReady = (result) => {
      if (settled || pendingExitResult !== null) return;
      pendingExitResult = result;
      void convergeGroup();
      maybeFinish();
    };
    child.on('error', (error) => finishWhenReady({
      code: null,
      signal: null,
      error: new Error(`cannot spawn ${cmd}: ${error.message}`),
    }));
    child.on('exit', (code, signal) => finishWhenReady({ code, signal, error: null }));
    child.on('close', (code, signal) => {
      childClosed = true;
      finishWhenReady({ code, signal, error: null });
      maybeFinish();
    });

    if (registerNativeStop) {
      try {
        nativeStopCleanup = registerNativeStop({
          child,
          descriptor,
          stop: () => requestStop('interrupt', 'native-stop'),
        });
      } catch {
        const degradation = degradations.record('nativeStop', 'native-stop-error');
        if (degradation) onDegradation?.(degradation);
      }
    }
  });
}

// The conductor drives only canonical spec artifacts under .apex/work/specs/ —
// any other existing file is refused before spawn or work-dir write. A relative
// argument must already be the canonical spelling (alias forms are rejected,
// never normalized); an absolute argument is gated by where it lands. The
// absolute form is relativized through physical paths where possible, so an
// OS-resolved cwd (e.g. macOS /private/var) never turns a canonical spec into a
// ../.. spelling.
function canonicalSpecRelPath(cwd, specPath) {
  const rel = specPath.startsWith('/') ? physicalRelative(cwd, specPath) : specPath;
  return parseWorkPath(rel, 'spec', 'spec').path;
}

function physicalRelative(cwd, absPath) {
  try {
    return relative(realpathSync(cwd), realpathSync(absPath));
  } catch {
    return relative(cwd, absPath);
  }
}

// Drives `plan → implement → review` as fresh headless sessions and resolves to
// the process exit code (0 = the run reached READY_FOR_PR, 1 = refused or
// halted). The conductor only ever reads the children's DONE / BLOCKED /
// READY_FOR_PR lines: it never pushes, bumps a version, or opens a PR.
export async function runConductor(specPath, opts = {}) {
  const cwd = realpathSync(opts.cwd ?? process.cwd());
  let absSpec = resolve(cwd, specPath);

  let specRelPath;
  try {
    specRelPath = canonicalSpecRelPath(cwd, specPath);
    absSpec = join(cwd, specRelPath);
  } catch (err) {
    console.error(`autopilot: refusing to drive ${absSpec}: ${err.message}`);
    return 1;
  }

  let contract;
  try {
    contract = parseContract(readWorkPath(cwd, specRelPath, { expect: 'spec', encoding: 'utf8' }));
  } catch (err) {
    console.error(`autopilot: cannot read the contract at ${absSpec}: ${err.message}`);
    return 1;
  }

  let branch;
  try {
    branch = currentGitBranch(cwd);
  } catch (err) {
    console.error(`autopilot: ${err.message}`);
    return 1;
  }

  // Refuse before touching the filesystem: a refused run leaves no trace.
  const violations = contractViolations(contract, branch);
  if (violations.length > 0) {
    console.error(`autopilot: refusing to drive ${absSpec}`);
    for (const v of violations) console.error(`  - ${v}`);
    return 1;
  }

  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    console.error(
      `autopilot: refusing to drive ${absSpec}: unsupported platform "${platform}" — deterministic Gear 3 process-group ownership is unavailable`,
    );
    return 1;
  }

  // The run directory is named after the spec: sanitize before it becomes a path.
  // The status path is the run's canonical work artifact — its typed parse also
  // pins the run directory shape.
  let runDir;
  let statusPath;
  try {
    const specName = assertSafeRelPath(basename(absSpec, '.md'), 'spec name');
    runDir = join(cwd, '.apex', 'work', 'tasks', specName);
    statusPath = parseWorkPath(`.apex/work/tasks/${specName}/${STATUS_FILE_NAME}`, 'work-output', 'status').path;
  } catch (err) {
    console.error(`autopilot: refusing to drive ${absSpec}: ${err.message}`);
    return 1;
  }

  // Fresh-run preflight: pre-existing uncommitted changes would silently enter
  // the blast radius — a full-permission child committing per the contract's
  // commit-auth can sweep them into its commits. A resume (a status file with
  // events) accepts the tree as-is: a halted child legitimately leaves work in
  // progress behind. The confined read refuses a symlinked status target or
  // ancestor before anything is created.
  let preflightStatus;
  try {
    preflightStatus = readStatus(cwd, statusPath);
  } catch (err) {
    console.error(`autopilot: refusing to drive ${absSpec}: ${err.message}`);
    return 1;
  }
  const startClassification = classifyWorkflowStart({
    hasDurableState: preflightStatus !== '',
  });
  if (startClassification.classification === 'WORKTREE_OBSERVATION_REQUIRED') {
    let dirty;
    try {
      dirty = workingTreeStatus(cwd);
    } catch (err) {
      console.error(`autopilot: ${err.message}`);
      return 1;
    }
    const observedStart = classifyWorkflowStart({
      hasDurableState: false,
      worktreeStatus: dirty,
    });
    if (observedStart.classification === 'DIRTY_FRESH_REFUSED') {
      console.error(
        `autopilot: refusing to drive ${absSpec}: the working tree has uncommitted changes — commit or stash them first\n${dirty}`,
      );
      return 1;
    }
  }
  // The confined spec/status reads have already checked the physical work
  // ancestors. Acquire before creating or mutating any selected-run artifact.
  const lockPath = join(cwd, '.apex', 'work', LOCK_DIRECTORY_NAME);
  let lock;
  try {
    lock = await acquireRunLock(lockPath, opts);
  } catch (err) {
    console.error(`autopilot: refusing to drive ${absSpec}: ${err.message}`);
    return 1;
  }
  if (!lock.acquired) {
    const who = lock.holder ? ` (pid ${lock.holder})` : '';
    console.error(
      `autopilot: refusing to drive ${absSpec}: another conductor${who} already holds ${lockPath}`,
    );
    return 1;
  }

  const runId = opts.runId ?? randomUUID();
  let result = 1;
  let statusEstablished = false;
  try {
    await opts.lockTransition?.('acquired');
    const repeatedViolations = contractViolations(contract, currentGitBranch(cwd));
    if (repeatedViolations.length) throw new Error(repeatedViolations.join('; '));
    if (readStatus(cwd, statusPath) === '' && workingTreeStatus(cwd) !== '') {
      throw new Error('the working tree has uncommitted changes');
    }
    const existingStatus = readStatus(cwd, statusPath);
    validateStatusProtocol(existingStatus);
    mkdirWorkPath(cwd, statusPath, { expect: 'work-output', family: 'status' });
    if (existingStatus === '') appendStatus(cwd, statusPath, 'CONDUCTOR', 'STATUS_PROTOCOL', `version=${STATUS_PROTOCOL_VERSION}`);
    statusEstablished = true;
    result = await driveLocked(contract, absSpec, runDir, statusPath, { ...opts, cwd, runId, recoveredLocks: lock.recovered });
  } catch (error) {
    console.error(`autopilot: ${error.message}`);
  } finally {
    try {
      await opts.lockTransition?.('before-release');
      releaseRunLock(lockPath, lock.generation);
    } catch (error) {
      result = 1;
      console.error(`autopilot: LOCK_RELEASE_FAILED: ${error.message}`);
      if (statusEstablished) {
        try {
          appendStatus(cwd, statusPath, 'CONDUCTOR', 'LOCK_RELEASE_FAILED', `run-id=${runId} reason=${error.message}`);
        } catch (statusError) {
          console.error(`autopilot: cannot record lock release failure: ${statusError.message}`);
        }
      }
    }
  }
  if (result === 0) console.log(`autopilot: ${PHASES.join(' → ')} complete — READY_FOR_PR; status: ${join(runDir, STATUS_FILE_NAME)}`);
  return result;
}

// The drive loop proper, run only under the acquired run lock.
async function driveLocked(contract, absSpec, runDir, statusPath, opts) {
  const cwd = opts.cwd;
  const commandFor = opts.commandFor ?? headlessCommand;
  const providerVersionFor = opts.providerVersionFor ?? detectProviderRuntimeVersion;
  const runId = opts.runId ?? randomUUID();
  const specName = basename(absSpec, '.md');
  const emittedDegradations = new Set();
  const recordedUsage = new Set();
  const usageDegradations = new Set();
  let halted = false;

  // Every stop condition ends here: the reason is recorded in the status file
  // (the human's interface) and echoed on stderr (what the mother session sees
  // when the background conductor task completes).
  const halt = (note) => {
    if (halted) return 1;
    halted = true;
    console.error(`autopilot: ${appendStatus(cwd, statusPath, 'CONDUCTOR', 'HALTED', note)}`);
    return 1;
  };

  // Resume decisions read this one snapshot, taken before any child runs: a phase
  // is skipped only for conductor acceptance that predates this run. Child-only
  // markers cannot complete any phase. Only the longest completed *prefix* is
  // skipped: a completion marker after a gap (a hand-edited status file, a
  // forged line surviving into the next run) is distrusted and its phase re-run.
  const statusBeforeRun = readStatus(cwd, statusPath);
  const replayBeforeRun = replayAutopilotStatus(statusBeforeRun);
  const priorImplementSpawns = normalizeAutopilotStatus(statusBeforeRun)
    .filter((record) => record.actor === 'CONDUCTOR' && record.event === 'SPAWNED')
    .map((record) => correlatedIdentity(record.note, 'implement'))
    .filter((identity) => identity?.phase === 'implement');
  const retainedForAttempt = (identity) => {
    const retained = captureRetainedApproval(cwd, { planPath: `.apex/work/plans/${specName}.md`,
      indexPath: `.apex/work/tasks/${specName}/task-result-index.md`, runId: identity.runId, attempt: identity.attempt });
    if (retained && !priorImplementSpawns.some((origin) => origin.runId === retained.runId && origin.attempt === retained.attempt)) {
      throw new Error('retained approval has no conductor-owned prior dispatch');
    }
    return retained;
  };
  let completedPrefix = 0;
  while (
    completedPrefix < PHASES.length
    && workflowScopeCompleted(replayBeforeRun, PHASES[completedPrefix])
  ) {
    completedPrefix += 1;
  }

  if (completedPrefix === 2) {
    try {
      const accepted = normalizeAutopilotStatus(statusBeforeRun).map(acceptedIdentity)
        .filter((identity) => identity?.phase === 'implement').at(-1);
      if (!accepted) throw new Error('missing accepted implement identity');
      verifyImplementReviews(cwd, { planPath: `.apex/work/plans/${specName}.md`,
        indexPath: `.apex/work/tasks/${specName}/task-result-index.md`, runId: accepted.runId, attempt: accepted.attempt,
        retainedApproval: retainedForAttempt(accepted) });
    } catch (error) { return halt(`resume reviewer evidence rejected: ${error.message}`); }
  }

  // Same snapshot, same reason: the aggregate diff must span the whole chain, so a
  // resumed run reuses the commit the first run started from rather than re-anchoring
  // to whatever implement has already committed.
  let baseline = replayBeforeRun.baseline;
  if (baseline === null) {
    try {
      baseline = selectBaseline(null, currentGitCommit(cwd));
    } catch (err) {
      return halt(`cannot resolve the run baseline commit: ${err.message}`);
    }
    const line = appendStatus(cwd, statusPath, 'CONDUCTOR', 'BASELINE', `run-id=${runId} commit=${baseline}`);
    console.log(`autopilot: ${line}`);
  }

  for (const recovered of opts.recoveredLocks ?? []) {
    appendStatus(cwd, statusPath, 'CONDUCTOR', 'LOCK_RECOVERED',
      `run-id=${runId} quarantine=${relative(cwd, recovered.quarantine)} pid=${recovered.pid}`);
  }

  for (const [index, phase] of PHASES.entries()) {
    if (index < completedPrefix) continue;

    const phaseNumber = index + 1;
    const attempt = nextPhaseAttempt(readStatus(cwd, statusPath), phase);
    const aggregateName = `phase-${phaseNumber}.log`;
    const readableName = `phase-${phaseNumber}-attempt-${attempt}.log`;
    const rawName = `phase-${phaseNumber}-attempt-${attempt}.raw.jsonl`;
    const displayName = phaseDisplayName(specName, phase, attempt, runId);
    const identity = `run-id=${runId} phase=${phase} attempt=${attempt}`;

    // Blast-radius guard, re-checked before every phase: a child (or a human)
    // may have moved the repo off the contract branch mid-run.
    let phaseBranch;
    try {
      phaseBranch = currentGitBranch(cwd);
    } catch (err) {
      return halt(`${phase}: ${err.message}`);
    }
    if (phaseBranch !== contract.branch || phaseBranch === 'main' || phaseBranch === 'master') {
      return halt(
        `${phase}: current branch "${phaseBranch}" is outside the contract blast radius (branch: ${contract.branch})`,
      );
    }

    const reservedLine = appendStatus(cwd, statusPath, 'CONDUCTOR', 'ATTEMPT_RESERVED', identity);
    console.log(`autopilot: ${reservedLine}`);
    const reservedState = replayAutopilotStatus(readStatus(cwd, statusPath));
    if (!reservedState.attemptsByScope[phase].includes(attempt)) {
      return halt(`${identity}: durable attempt reservation could not be reduced`);
    }

    const manifestPath = `.apex/work/tasks/${specName}/context/phase-${phase}-attempt-${attempt}.json`;
    let manifestResult;
    let retainedApproval = null;
    let route;
    let unroutedSurfaces = [];
    try {
      if (existsSync(join(cwd, manifestPath))) {
        throw new Error(`context manifest already exists and will not be overwritten: ${manifestPath}`);
      }
      const prepared = phaseManifestInput({
        phase, cwd, absSpec, runId, attempt, contract, baseline,
      });
      route = prepared.route;
      unroutedSurfaces = prepared.unroutedSurfaces;
      manifestResult = writeContextManifest(prepared.manifest, {
        repoRoot: cwd,
        manifestPath,
      });
      if (phase === 'implement') retainedApproval = retainedForAttempt({ runId, attempt });
    } catch (err) {
      const line = appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'ARTIFACT_FAILED',
        `${identity} manifest=${manifestPath} reason=${err.message}`,
      );
      console.error(`autopilot: ${line}`);
      return halt(`${identity}: phase context artifact failed: ${err.message}`);
    }

    if (unroutedSurfaces.length > 0) {
      const line = appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'CONTEXT_SURFACE_IGNORED',
        `${identity} manifest=${manifestResult.path} ignored=${JSON.stringify(unroutedSurfaces)}`,
      );
      console.error(`autopilot: ${line}`);
    }

    const prompt = phasePrompt(phase, absSpec, { runId, attempt, manifestPath });
    // OpenCode is the one harness with no built-in tier table: when the
    // effective model pin resolves to a mapped provider, the conductor
    // supplies the shared tier record; otherwise no modelMappings key is
    // passed and the declared-degradation path stands.
    const modelMappings = contract.harness === 'opencode'
      ? opencodeProviderModelMappings(cwd, opts.opencodeConfig)
      : undefined;
    let command;
    try {
      command = commandFor(contract.harness, prompt, {
        displayName,
        modelTier: route.modelTier,
        ...(modelMappings === undefined ? {} : { modelMappings }),
      });
    } catch (err) {
      appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'MODEL_ROUTING_FAILED',
        `${identity} requested-tier=${route.modelTier} manifest=${manifestResult.path} manifest-bytes=${manifestResult.bytes} reason=${err.message}`,
      );
      return halt(`${identity}: cannot build headless descriptor: ${err.message}`);
    }
    if (!command) {
      appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'MODEL_ROUTING_FAILED',
        `${identity} requested-tier=${route.modelTier} manifest=${manifestResult.path} manifest-bytes=${manifestResult.bytes} reason=no-headless-command`,
      );
      return halt(`${phase}: harness "${contract.harness}" has no headless command`);
    }

    let providerVersion = null;
    try {
      const detected = await providerVersionFor(contract.harness, command, cwd);
      if (typeof detected === 'string' && PROVIDER_VERSION_PATTERN.test(detected)) {
        providerVersion = detected;
      }
    } catch {
      // Runtime-version evidence is an accounting gate, not a run-liveness gate.
    }

    const routing = descriptorRouting(command, route.modelTier);
    const model = routing.model ?? 'harness-default';
    const routedLine = appendStatus(
      cwd,
      statusPath,
      'CONDUCTOR',
      'MODEL_ROUTED',
      `${identity} requested-tier=${route.modelTier} manifest=${manifestResult.path} manifest-bytes=${manifestResult.bytes} model-selection=${routing.selection} model=${model} evidence=${route.evidence}${routing.reason ? ` reason=${routing.reason}` : ''}`,
    );
    console.log(`autopilot: ${routedLine}`);
    if (routing.selection === 'degraded') {
      const degradedLine = appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'MODEL_ROUTING_DEGRADED',
        `${identity} requested-tier=${route.modelTier} model-selection=degraded reason=${routing.reason} manifest=${manifestResult.path} manifest-bytes=${manifestResult.bytes}`,
      );
      console.error(`autopilot: ${degradedLine}`);
    }

    if (contract.logMode === 'exact') {
      const line = appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'EXACT_LOGGING',
        `${identity} raw=${rawName} redaction=disabled`,
      );
      console.log(`autopilot: ${line}`);
    }

    const reportDegradation = (degradation) => {
      const capability = degradation?.capability ?? 'observability';
      const reason = degradation?.reason ?? 'unknown-error';
      const key = `${capability}:${reason}`;
      if (emittedDegradations.has(key)) return;
      emittedDegradations.add(key);
      const line = appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'OBSERVABILITY_DEGRADED',
        `${identity} capability=${capability} reason=${reason}`,
      );
      console.error(`autopilot: ${line}`);
    };

    const reportUsageDegradation = ({ envelope, scope, capability, reason }) => {
      const fields = [identity];
      if (sourcedField(envelope?.sessionId) !== null) fields.push(`session-id=${statusField(envelope.sessionId)}`);
      if (sourcedField(envelope?.actorId) !== null) fields.push(`actor-id=${statusField(envelope.actorId)}`);
      if (scope !== null) fields.push(`usage-scope=${statusField(scope)}`);
      fields.push(`capability=${capability}`, `reason=${reason}`, `raw-fallback=${rawName}`);
      const line = appendStatus(
        cwd,
        statusPath,
        'CONDUCTOR',
        'USAGE_TELEMETRY_DEGRADED',
        fields.join(' '),
      );
      console.error(`autopilot: ${line}`);
    };

    const observeUsage = createUsageObserver({
      repoRoot: cwd,
      ledgerPath: `.apex/work/tasks/${specName}/${RESOURCE_USAGE_FILE_NAME}`,
      requestedModelTier: route.modelTier,
      resolvedModel: routing.model,
      modelSelection: routing.selection,
      manifestPath: manifestResult.path,
      manifestBytes: manifestResult.bytes,
      reportDegradation: reportUsageDegradation,
      recorded: recordedUsage,
      degraded: usageDegradations,
      openLedger: opts.usageLedgerOpen,
      writeLedger: opts.usageLedgerWrite,
      closeLedger: opts.usageLedgerClose,
      statLedger: opts.usageLedgerStat,
      truncateLedger: opts.usageLedgerTruncate,
      serialize: opts.usageLedgerSerialize,
    });

    for (const [capability, state] of Object.entries(command.capabilities ?? {})) {
      if (state !== 'yes') {
        reportDegradation({ capability, reason: `declared-${state}` });
      }
    }

    const statusOffset = readStatus(cwd, statusPath).length;

    const result = await runChild({
      cmd: command.cmd,
      args: command.args,
      cwd,
      rawPath: `.apex/work/tasks/${specName}/${rawName}`,
      readablePath: `.apex/work/tasks/${specName}/${readableName}`,
      aggregatePath: `.apex/work/tasks/${specName}/${aggregateName}`,
      logMode: contract.logMode,
      context: {
        runId, phase, attempt, harness: contract.harness, displayName,
        ...(providerVersion === null ? {} : { providerVersion }),
      },
      descriptor: command,
      killGraceMs: opts.killGraceMs,
      groupConvergenceMs: opts.groupConvergenceMs,
      processGroupProbe: opts.processGroupProbe,
      processGroupSignal: opts.processGroupSignal,
      rawWrite: opts.rawWrite,
      rawDestinationFactory: opts.rawDestinationFactory,
      writerMaxPendingBytes: opts.writerMaxPendingBytes,
      drainTimeoutMs: opts.drainTimeoutMs,
      decoder: opts.decoder,
      renderer: opts.renderer,
      serializer: opts.serializer,
      registerNativeStop: opts.registerNativeStop,
      liveStdout: opts.liveStdout,
      liveStderr: opts.liveStderr,
      onSpawn: () => {
        appendStatus(
          cwd,
          statusPath,
          'CONDUCTOR',
          'SPAWNED',
          `${identity} display-name=${displayName} readable=${readableName} raw=${rawName} session=pending`,
        );
        // The phase slice starts just before SPAWNED so completion validation
        // can bind the child's marker to this exact run/attempt spawn.
        console.log(
          `autopilot: ${phase} · attempt ${attempt} · run ${runId.slice(0, 8)} · session pending · ${displayName}`,
        );
      },
      onInterrupt: (reason) => {
        const line = appendStatus(
          cwd,
          statusPath,
          'CONDUCTOR',
          'INTERRUPTED',
          `${identity} source=${reason} child-killed=true`,
        );
        console.error(`autopilot: ${line}`);
        halt(`${identity} interrupted by ${reason}; child killed`);
      },
      onDegradation: reportDegradation,
      onDecodedEvent: observeUsage,
      onSessionIdentified: (sessionId, nativeSession) => {
        const open = nativeSession?.open ?? 'unavailable';
        const resume = nativeSession?.resume ?? 'unavailable';
        const identityState = command.capabilities?.nativeSessionIdentity ?? 'unavailable';
        const openResumeState = command.capabilities?.nativeOpenResume ?? 'unavailable';
        const qualification = nativeSession?.reason ?? 'No native-session qualification is declared.';
        const references = openResumeState === 'yes'
          ? `open=${JSON.stringify(open)} resume=${JSON.stringify(resume)}`
          : `open-hint=${JSON.stringify(open)} resume-hint=${JSON.stringify(resume)}`;
        appendStatus(
          cwd,
          statusPath,
          'CONDUCTOR',
          'SESSION_IDENTIFIED',
          `${identity} session-id=${statusField(sessionId)} native-session-identity=${identityState} native-open-resume=${openResumeState} qualification=${JSON.stringify(qualification)} ${references}`,
        );
        if (openResumeState === 'yes') {
          console.log(
            `autopilot: ${phase} · attempt ${attempt} · session ${statusField(sessionId)} · native open/resume supported · open: ${open} · resume: ${resume} · ${qualification}`,
          );
        } else {
          console.log(
            `autopilot: ${phase} · attempt ${attempt} · session ${statusField(sessionId)} · native open/resume ${openResumeState} · open hint: ${open} · resume hint: ${resume} · ${qualification}`,
          );
        }
      },
    });

    if (result.interrupted) return 1;
    if (result.error) {
      const errorCode = result.error.code ? `${result.error.code}: ` : '';
      return halt(`${identity}: ${errorCode}${result.error.message}`);
    }

    const phaseStatus = readStatus(cwd, statusPath).slice(statusOffset);
    const marker = haltMarker(phaseStatus, phase);

    if (result.code !== 0) {
      const exited = result.code === null ? `on signal ${result.signal}` : `${result.code}`;
      const recorded = marker ? ` — child recorded ${marker.event}: ${marker.note}` : '';
      return halt(
        `${identity}: child exited ${exited}; see ${readableName} (aggregate ${aggregateName})${recorded}`,
      );
    }
    if (marker) {
      return halt(`${phase}: child recorded ${marker.event}: ${marker.note}`);
    }
    if (!childCompleted(phaseStatus, phase, { runId, phase, attempt })) {
      return halt(
        `${identity}: phase exited 0 without recording its completion marker (${COMPLETION_EVENT[phase]}); see ${readableName} (aggregate ${aggregateName})`,
      );
    }
    if (phase === 'implement') {
      try {
        const reviewReceipt = verifyImplementReviews(cwd, {
          planPath: `.apex/work/plans/${specName}.md`,
          indexPath: `.apex/work/tasks/${specName}/task-result-index.md`, runId, attempt, retainedApproval,
        });
        if (reviewReceipt.retainedApproval) appendStatus(cwd, statusPath, 'CONDUCTOR', 'REVIEW_APPROVAL_REUSED',
          `${identity} origin-run-id=${retainedApproval.runId} origin-attempt=${retainedApproval.attempt} state=${retainedApproval.state} digest=${retainedApproval.digest}`);
      } catch (error) {
        appendStatus(cwd, statusPath, 'CONDUCTOR', 'ARTIFACT_FAILED', `${identity} reviewer-evidence=${error.message}`);
        return halt(`${identity}: reviewer evidence rejected: ${error.message}`);
      }
    }
    appendStatus(cwd, statusPath, 'CONDUCTOR', 'PHASE_ACCEPTED', `${identity} child-event=${COMPLETION_EVENT[phase]}`);
  }

  return 0;
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const specPath = argv.find((a) => !a.startsWith('--'));
  if (!specPath) {
    console.error('usage: node scripts/autopilot.mjs <spec-path>');
    return 1;
  }
  const absSpec = resolve(cwd, specPath);
  try {
    canonicalSpecRelPath(cwd, specPath);
  } catch (err) {
    console.error(`autopilot: refusing to drive ${absSpec}: ${err.message}`);
    return 1;
  }
  if (!existsSync(absSpec)) {
    console.error(`autopilot: spec not found: ${absSpec}`);
    return 1;
  }
  return runConductor(absSpec, { cwd });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
