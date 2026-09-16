// Autopilot drive-mode suite: headless harness command building + conductor
// contract parsing/refusal guards + the conductor drive loop.
//
// Tests the mapping from harness ID to fresh one-shot headless session
// command; `null` = harness has no headless mode, autopilot must not be offered
// (explicit, never silent, degradation). Also tests the extended verdict-artifact
// contract parser, the refusal guards that decide whether the conductor may run,
// and the `plan → implement → review` loop itself (spawn, resume, halt, interruption).
// The loop tests are hermetic: they drive `tests/fixtures/fake-harness.mjs`
// through `opts.commandFor` — a real harness (claude/codex/opencode) is never
// spawned.
import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { headlessCommand } from '../adapters/headless.mjs';
import { collectHeadlessChannel } from '../scripts/cost-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const protocolLine = '2026-08-10T08:00:00.000Z — CONDUCTOR — STATUS_PROTOCOL — version=1\n';
const priorRun = '11111111-1111-4111-8111-111111111111';
function acceptedPhase(phase = 'plan') {
  const event = phase === 'review' ? 'READY_FOR_PR' : 'DONE';
  const number = ['plan', 'implement', 'review'].indexOf(phase) + 1;
  return protocolLine
    + `2026-08-10T09:00:00.000Z — CONDUCTOR — SPAWNED — run-id=${priorRun} phase=${phase} attempt=1 display-name=steepy-topic-${phase}-a1-11111111 readable=phase-${number}-attempt-1.log raw=phase-${number}-attempt-1.raw.jsonl session=pending\n`
    + `2026-08-10T09:00:01.000Z — ${phase} — ${event} — run-id=${priorRun} attempt=1 complete\n`
    + `2026-08-10T09:00:02.000Z — CONDUCTOR — PHASE_ACCEPTED — run-id=${priorRun} phase=${phase} attempt=1 child-event=${event}\n`;
}

describe('headless command builder', () => {
  let headless;
  let autopilot;

  before(async () => {
    const modulePath = join(root, 'adapters', 'headless.mjs');
    const mod = await import(pathToFileURL(modulePath));
    headless = mod;
    autopilot = await import(pathToFileURL(join(root, 'scripts', 'autopilot.mjs')));
  });

  it('reads OpenCode runtime version evidence through an injectable bounded probe', async () => {
    const calls = [];
    const runVersion = (...args) => {
      calls.push(args);
      return { status: 0, stdout: '1.18.27\n' };
    };
    assert.equal(
      await autopilot.detectProviderRuntimeVersion('opencode', { cmd: 'opencode' }, '/repo', runVersion),
      '1.18.27',
    );
    assert.deepEqual(calls, [[
      'opencode', ['--version'], { cwd: '/repo', timeoutMs: 250, maxBuffer: 4096 },
    ]]);
    assert.equal(
      await autopilot.detectProviderRuntimeVersion('opencode', { cmd: 'opencode' }, '/repo', () => ({ status: 1, stdout: '1.18.27\n' })),
      null,
    );
    assert.equal(
      await autopilot.detectProviderRuntimeVersion('opencode', { cmd: 'opencode' }, '/repo', () => ({ status: 0, stdout: 'not-semver\n' })),
      null,
    );
    for (const result of [
      { status: 0, stdout: '1.18.27\n', signal: 'SIGKILL' },
      { status: 0, stdout: '1.18.27\n', error: new Error('overflow') },
      { status: null, stdout: '1.18.27\n' },
    ]) {
      assert.equal(
        await autopilot.detectProviderRuntimeVersion('opencode', { cmd: 'opencode' }, '/repo', () => result),
        null,
      );
    }
  });

  it('exports SUPPORTED_HARNESSES as a frozen array with exactly [claude, codex, opencode]', () => {
    assert.ok(Array.isArray(headless.SUPPORTED_HARNESSES));
    assert.deepEqual(headless.SUPPORTED_HARNESSES, ['claude', 'codex', 'opencode']);
    assert.ok(Object.isFrozen(headless.SUPPORTED_HARNESSES), 'SUPPORTED_HARNESSES must be frozen');
  });

  it('exports headlessCommand as a function', () => {
    assert.equal(typeof headless.headlessCommand, 'function');
  });

  describe('headlessCommand(harness, prompt)', () => {
    it('returns the Claude descriptor without promoting unproven native resumption', () => {
      const result = headless.headlessCommand('claude', 'test prompt', { displayName: 'steepy-plan-1' });
      assert.deepEqual(result, {
        cmd: 'claude',
        args: [
          '-p', 'test prompt',
          '--dangerously-skip-permissions',
          '--allowedTools', headless.CLAUDE_ALLOWED_TOOLS.join(','),
          '--output-format', 'stream-json',
          '--verbose',
          '--forward-subagent-text',
          '--name', 'steepy-plan-1',
        ],
        protocol: 'stream-json',
        displayName: 'steepy-plan-1',
        capabilities: {
          structuredEvents: 'yes', nativeSessionIdentity: 'yes', nativeOpenResume: 'unproven',
          nativeDisplayName: 'yes', agentIdentity: 'yes', parentLink: 'unavailable', nativeStop: 'unavailable',
        },
        nativeSession: {
          open: 'claude --resume <session-id>', resume: 'claude --resume <session-id>',
          reason: 'Claude --resume is an unproven native-session hint: the canary did not complete a resumed request.',
        },
      });
    });

    it('claude declares its tools explicitly — env-scrub hardening forces default mode on undeclared spawns', () => {
      assert.ok(Object.isFrozen(headless.CLAUDE_ALLOWED_TOOLS), 'CLAUDE_ALLOWED_TOOLS must be frozen');
      for (const tool of ['Task', 'Bash', 'Read', 'Edit', 'Write', 'Skill']) {
        assert.ok(
          headless.CLAUDE_ALLOWED_TOOLS.includes(tool),
          `an unattended chain phase cannot run without ${tool}`,
        );
      }
    });

    it('returns the complete Codex descriptor without an unverified native display-name flag', () => {
      const result = headless.headlessCommand('codex', 'test prompt', { displayName: 'steepy-plan-1' });
      assert.deepEqual(result, {
        cmd: 'codex',
        args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '--json', 'test prompt'],
        protocol: 'jsonl',
        displayName: 'steepy-plan-1',
        capabilities: {
          structuredEvents: 'yes', nativeSessionIdentity: 'yes', nativeOpenResume: 'yes',
          nativeDisplayName: 'unavailable', agentIdentity: 'unavailable', parentLink: 'unavailable', nativeStop: 'unavailable',
        },
        nativeSession: {
          open: 'codex resume --include-non-interactive', resume: 'codex exec resume <thread-id>',
          reason: 'Official Codex CLI documentation supports persisted exec session resumption.',
        },
      });
    });

    it('returns the OpenCode descriptor with native session identity and open/resume promoted on real event evidence', () => {
      const result = headless.headlessCommand('opencode', 'test prompt', { displayName: 'steepy-plan-1' });
      assert.deepEqual(result, {
        cmd: 'opencode',
        args: ['run', '--auto', '--format', 'json', '--title', 'steepy-plan-1', 'test prompt'],
        protocol: 'json',
        displayName: 'steepy-plan-1',
        capabilities: {
          structuredEvents: 'yes', nativeSessionIdentity: 'yes', nativeOpenResume: 'yes',
          nativeDisplayName: 'yes', agentIdentity: 'unavailable', parentLink: 'unavailable', nativeStop: 'unavailable',
        },
        nativeSession: {
          open: 'opencode session list --format json', resume: 'opencode run --session <session-id>',
          reason: 'OpenCode emits a sessionID on every structured event and `opencode session list --format json` lists persisted sessions; `opencode run --session <session-id>` resumes one (verified against the real `--format json` stream on opencode 1.18).',
        },
      });
    });

    it('uses a deterministic default display name and freezes descriptor capability data', () => {
      const result = headless.headlessCommand('claude', 'test prompt');
      assert.equal(result.displayName, 'steepy-claude');
      assert.ok(Object.isFrozen(result), 'descriptor must be frozen');
      assert.ok(Object.isFrozen(result.args), 'args must be frozen');
      assert.ok(Object.isFrozen(result.capabilities), 'capabilities must be frozen');
      assert.ok(Object.isFrozen(result.nativeSession), 'native session metadata must be frozen');
    });

    it('returns null for harness="pi"', () => {
      const result = headless.headlessCommand('pi', 'test prompt');
      assert.equal(result, null);
    });

    it('returns null for unknown harness', () => {
      const result = headless.headlessCommand('unknown', 'test prompt');
      assert.equal(result, null);
    });

    it('returns null for empty string harness', () => {
      const result = headless.headlessCommand('', 'test prompt');
      assert.equal(result, null);
    });

    it('returns null for undefined harness', () => {
      const result = headless.headlessCommand(undefined, 'test prompt');
      assert.equal(result, null);
    });

    it('throws TypeError if prompt is empty string', () => {
      assert.throws(
        () => headless.headlessCommand('claude', ''),
        TypeError,
      );
    });

    it('throws TypeError if prompt is not a string', () => {
      assert.throws(
        () => headless.headlessCommand('claude', 123),
        TypeError,
      );
      assert.throws(
        () => headless.headlessCommand('claude', null),
        TypeError,
      );
      assert.throws(
        () => headless.headlessCommand('claude', undefined),
        TypeError,
      );
      assert.throws(
        () => headless.headlessCommand('claude', { prompt: 'test' }),
        TypeError,
      );
    });

    it('throws TypeError for unsupported harness with invalid prompt', () => {
      // For unsupported harnesses, we should return null (not throw) regardless of prompt
      const result = headless.headlessCommand('pi', '');
      assert.equal(result, null);
    });
  });
});

const EXTENDED_CONTRACT = `<!-- verdict: GAP | gear: 3
drive: autopilot
branch: gear3-some-topic
commit-auth: per-task
harness: claude
blast-radius: branch-only, no-push, stop-before-PR
-->

# Some spec
`;

const MANUAL_CONTRACT = `<!-- verdict: CONFLICT (override ratified 2026-08-10) | gear: 3 -->

# Some spec
`;

describe('autopilot conductor', () => {
  let autopilot;

  before(async () => {
    const modulePath = join(root, 'scripts', 'autopilot.mjs');
    const mod = await import(pathToFileURL(modulePath));
    autopilot = mod;
  });

  describe('parseContract(specText)', () => {
    it('parses a full extended artifact to the exact object', () => {
      const result = autopilot.parseContract(EXTENDED_CONTRACT);
      assert.deepEqual(result, {
        verdict: 'GAP',
        gear: 3,
        drive: 'autopilot',
        branch: 'gear3-some-topic',
        commitAuth: 'per-task',
        harness: 'claude',
        blastRadius: 'branch-only, no-push, stop-before-PR',
        logMode: 'safe',
      });
    });

    it('parses a manual single-line artifact with extended fields undefined (manual drive)', () => {
      const result = autopilot.parseContract(MANUAL_CONTRACT);
      assert.deepEqual(result, {
        verdict: 'CONFLICT (override ratified 2026-08-10)',
        gear: 3,
        drive: undefined,
        branch: undefined,
        commitAuth: undefined,
        harness: undefined,
        blastRadius: undefined,
        logMode: 'safe',
      });
    });

    it('parses a runnable gear-3 artifact without a budget', () => {
      const result = autopilot.parseContract(EXTENDED_CONTRACT.replace('budget: 45\n', ''));
      assert.equal(result.budget, undefined);
      assert.deepEqual(autopilot.contractViolations(result, 'gear3-some-topic'), []);
    });

    it('accepts exact log mode and rejects every unsupported value', () => {
      const exact = EXTENDED_CONTRACT.replace('blast-radius:', 'log-mode: exact\nblast-radius:');
      assert.equal(autopilot.parseContract(exact).logMode, 'exact');
      for (const value of ['', 'SAFE', 'unsafe', 'raw']) {
        const text = EXTENDED_CONTRACT.replace('blast-radius:', `log-mode: ${value}\nblast-radius:`);
        assert.throws(() => autopilot.parseContract(text), /log-mode/i);
      }
    });

    it('throws when the text has no HTML comment', () => {
      assert.throws(() => autopilot.parseContract('# no comment here\n'), /verdict/i);
    });

    it('throws when the first comment does not start with verdict:', () => {
      assert.throws(() => autopilot.parseContract('<!-- not a verdict -->\n'), /verdict/i);
    });

    it('throws on an unknown key', () => {
      const text = '<!-- verdict: GAP | gear: 3\ndrivee: autopilot\n-->\n';
      assert.throws(() => autopilot.parseContract(text), /drivee/);
    });

    it('rejects inherited object property names as contract keys', () => {
      for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const text = `<!-- verdict: GAP | gear: 3\n${key}: value\n-->\n`;
        assert.throws(() => autopilot.parseContract(text), new RegExp(`unknown verdict artifact key: "${key}"`));
      }
    });

    it('throws on a non-numeric gear', () => {
      const text = '<!-- verdict: GAP | gear: three -->\n';
      assert.throws(() => autopilot.parseContract(text), /gear/i);
    });

    it('throws on a non-numeric budget', () => {
      const text = '<!-- verdict: GAP | gear: 3\nbudget: soon\n-->\n';
      assert.throws(() => autopilot.parseContract(text), /budget/i);
    });

    it('throws on a budget of 0', () => {
      const text = '<!-- verdict: GAP | gear: 3\nbudget: 0\n-->\n';
      assert.throws(() => autopilot.parseContract(text), /budget/i);
    });

    it('throws on a negative unsupported budget', () => {
      const text = '<!-- verdict: GAP | gear: 3\nbudget: -1\n-->\n';
      assert.throws(() => autopilot.parseContract(text), /budget/i);
    });

    it('throws when the contract comment is not at the head of the spec', () => {
      const text = `# Front matter\n\n${EXTENDED_CONTRACT}`;
      assert.throws(() => autopilot.parseContract(text), /head of the spec/i);
    });

    it('accepts a whitespace-only prefix before the head contract comment', () => {
      const result = autopilot.parseContract(`\n  \n${EXTENDED_CONTRACT}`);
      assert.equal(result.drive, 'autopilot');
    });

    it('throws on a second contract comment later in the artifact', () => {
      const text = `${EXTENDED_CONTRACT}\n<!-- verdict: OTHER | gear: 4 -->\n`;
      assert.throws(() => autopilot.parseContract(text), /only one verdict contract comment/i);
    });

    it('ignores later HTML comments that are not contract comments', () => {
      const text = `${EXTENDED_CONTRACT}\n<!-- steepy:manual-handoff:v1:start -->\nbody\n<!-- steepy:manual-handoff:v1:end -->\n`;
      assert.equal(autopilot.parseContract(text).drive, 'autopilot');
    });

    it('throws on a duplicate known key', () => {
      const text = EXTENDED_CONTRACT.replace('harness: claude\n', 'harness: claude\nbranch: other-branch\n');
      assert.throws(() => autopilot.parseContract(text), /duplicate verdict artifact key: "branch"/);
    });

    it('throws on a duplicate log-mode key even when it repeats the default', () => {
      const text = EXTENDED_CONTRACT.replace('blast-radius:', 'log-mode: safe\nlog-mode: safe\nblast-radius:');
      assert.throws(() => autopilot.parseContract(text), /duplicate verdict artifact key: "log-mode"/);
    });

    it('throws on an empty verdict text', () => {
      const text = EXTENDED_CONTRACT.replace('verdict: GAP', 'verdict:');
      assert.throws(() => autopilot.parseContract(text), /verdict text must be non-empty/i);
    });
  });

  describe('contractViolations(contract, currentBranch)', () => {
    const RUNNABLE = {
      verdict: 'GAP',
      gear: 3,
      drive: 'autopilot',
      branch: 'gear3-topic',
      commitAuth: 'per-task',
      harness: 'claude',
      blastRadius: 'branch-only, no-push, stop-before-PR',
      logMode: 'safe',
    };

    it('returns [] when the contract is fully runnable', () => {
      assert.deepEqual(autopilot.contractViolations(RUNNABLE, 'gear3-topic'), []);
    });

    it('flags a manual-drive contract missing `drive: autopilot`', () => {
      const contract = { ...RUNNABLE, drive: undefined };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.ok(violations.some((v) => /drive: autopilot/.test(v)));
    });

    it('flags a gear other than 3', () => {
      const contract = { ...RUNNABLE, gear: 2 };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.ok(violations.some((v) => /gear/i.test(v)));
    });

    it('flags a missing branch', () => {
      const contract = { ...RUNNABLE, branch: undefined };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.ok(violations.some((v) => /branch/i.test(v)));
    });

    it('flags a current branch that does not match the contract branch', () => {
      const violations = autopilot.contractViolations(RUNNABLE, 'some-other-branch');
      assert.ok(violations.some((v) => /branch/i.test(v)));
    });

    it('flags main as the current branch even when the contract says branch: main', () => {
      const contract = { ...RUNNABLE, branch: 'main' };
      const violations = autopilot.contractViolations(contract, 'main');
      assert.ok(violations.some((v) => /main/.test(v)));
    });

    it('flags master as the current branch even when the contract says branch: master', () => {
      const contract = { ...RUNNABLE, branch: 'master' };
      const violations = autopilot.contractViolations(contract, 'master');
      assert.ok(violations.some((v) => /master/.test(v)));
    });

    it('flags a harness with no headless mode, naming the harness', () => {
      const contract = { ...RUNNABLE, harness: 'pi' };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.ok(violations.some((v) => /pi/.test(v) && /autopilot/i.test(v)));
    });

    it('flags a missing harness', () => {
      const contract = { ...RUNNABLE, harness: undefined };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.ok(violations.some((v) => /harness/i.test(v)));
    });

    it('accepts a missing budget', () => {
      const contract = { ...RUNNABLE, budget: undefined };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.deepEqual(violations, []);
    });

    it('flags a missing commit-auth — implement must never invent its own commit policy', () => {
      const contract = { ...RUNNABLE, commitAuth: undefined };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.ok(violations.some((v) => /commit-auth/.test(v)));
    });

    it('flags a missing blast-radius — no full-permission run without a declared boundary', () => {
      const contract = { ...RUNNABLE, blastRadius: undefined };
      const violations = autopilot.contractViolations(contract, 'gear3-topic');
      assert.ok(violations.some((v) => /blast-radius/.test(v)));
    });

    it('refuses commit-auth values outside the closed per-task enum', () => {
      for (const value of ['Per-Task', 'PER-TASK', 'per_task', 'per-branch', 'none', 'always']) {
        const contract = { ...RUNNABLE, commitAuth: value };
        const violations = autopilot.contractViolations(contract, 'gear3-topic');
        assert.ok(violations.some((v) => /commit-auth/.test(v)), `commit-auth "${value}" must be refused`);
      }
    });

    it('reports an empty commit-auth value as empty, not merely missing', () => {
      const violations = autopilot.contractViolations({ ...RUNNABLE, commitAuth: '' }, 'gear3-topic');
      assert.ok(violations.some((v) => /empty.*commit-auth|commit-auth.*empty/i.test(v)));
    });

    it('refuses blast-radius values other than the single allowed literal', () => {
      for (const value of [
        'Branch-Only, No-Push, Stop-Before-PR',
        'branch-only, no-push',
        'branch-only, no-push, stop-before-PR, hotfixes-too',
        'branch-only, no-push, stop-before-pr',
      ]) {
        const contract = { ...RUNNABLE, blastRadius: value };
        const violations = autopilot.contractViolations(contract, 'gear3-topic');
        assert.ok(violations.some((v) => /blast-radius/.test(v)), `blast-radius "${value}" must be refused`);
      }
    });

    it('reports an empty blast-radius value as empty, not merely missing', () => {
      const violations = autopilot.contractViolations({ ...RUNNABLE, blastRadius: '' }, 'gear3-topic');
      assert.ok(violations.some((v) => /empty.*blast-radius|blast-radius.*empty/i.test(v)));
    });

    it('refuses case-drifted and unknown harness enum values', () => {
      for (const value of ['Claude', 'CODEX', 'open-code', 'cursor']) {
        const contract = { ...RUNNABLE, harness: value };
        const violations = autopilot.contractViolations(contract, 'gear3-topic');
        assert.ok(violations.some((v) => /harness/i.test(v)), `harness "${value}" must be refused`);
      }
    });

    it('refuses case-drifted drive values — the enum is the literal autopilot', () => {
      for (const value of ['Autopilot', 'AUTOPILOT', 'auto']) {
        const contract = { ...RUNNABLE, drive: value };
        const violations = autopilot.contractViolations(contract, 'gear3-topic');
        assert.ok(violations.some((v) => /drive: autopilot/.test(v)), `drive "${value}" must be refused`);
      }
    });
  });

  describe('currentGitBranch(cwd)', () => {
    let repoDir;

    before(() => {
      repoDir = mkdtempSync(join(tmpdir(), 'steepy-autopilot-'));
      execFileSync('git', ['init', '-q', '-b', 'gear3-fixture-branch'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    });

    after(() => {
      rmSync(repoDir, { recursive: true, force: true });
    });

    it('returns the current branch name of a temp git repo', () => {
      assert.equal(autopilot.currentGitBranch(repoDir), 'gear3-fixture-branch');
    });

    it('throws on git failure (not a git repo)', () => {
      const notARepo = mkdtempSync(join(tmpdir(), 'steepy-autopilot-not-a-repo-'));
      try {
        assert.throws(() => autopilot.currentGitBranch(notARepo));
      } finally {
        rmSync(notARepo, { recursive: true, force: true });
      }
    });
  });
});

describe('autopilot conductor loop', () => {
  let autopilot;

  before(async () => {
    const modulePath = join(root, 'scripts', 'autopilot.mjs');
    autopilot = await import(pathToFileURL(modulePath));
  });

  describe('PHASES', () => {
    it('is the frozen plan → implement → review table', () => {
      assert.deepEqual(autopilot.PHASES, ['plan', 'implement', 'review']);
      assert.ok(Object.isFrozen(autopilot.PHASES), 'PHASES must be frozen');
    });
  });

  describe('phasePrompt(phase, specPath)', () => {
    it('names the phase skill and the spec path for every phase, harness-neutrally', () => {
      for (const phase of ['plan', 'implement', 'review']) {
        const prompt = autopilot.phasePrompt(phase, '/repo/.apex/work/specs/topic.md');
        assert.ok(
          prompt.includes(`steepy-apex '${phase}' skill`),
          `prompt for ${phase} must name the steepy-apex '${phase}' skill, got: ${prompt}`,
        );
        assert.ok(
          !prompt.includes('/steepy-apex:'),
          `prompt must not hardcode the Claude slash-command syntax, got: ${prompt}`,
        );
        assert.ok(prompt.includes('/repo/.apex/work/specs/topic.md'));
      }
    });

    it('names no other chain skill than its own phase', () => {
      const prompt = autopilot.phasePrompt('plan', '/repo/spec.md');
      assert.ok(!prompt.includes(`steepy-apex 'implement' skill`));
      assert.ok(!prompt.includes(`steepy-apex 'review' skill`));
    });

    it('states the unattended contract: autopilot, never wait for a human, BLOCKED on the status file', () => {
      const prompt = autopilot.phasePrompt('implement', '/repo/spec.md');
      assert.match(prompt, /autopilot/i);
      assert.match(prompt, /unattended/i);
      assert.match(prompt, /contract/i);
      assert.match(prompt, /never (ask|wait)/i);
      assert.match(prompt, /BLOCKED/);
      assert.match(prompt, /autopilot-status\.md/);
      assert.match(prompt, /non-zero/i);
    });

    it('throws on an unknown phase', () => {
      assert.throws(() => autopilot.phasePrompt('deploy', '/repo/spec.md'), /deploy/);
    });

    it('correlates child status markers with run ID and attempt when supplied', () => {
      const prompt = autopilot.phasePrompt('plan', '/repo/spec.md', {
        runId: '12345678-1234-4234-8234-123456789abc', attempt: 2,
      });
      assert.match(prompt, /run-id `12345678-1234-4234-8234-123456789abc`/);
      assert.match(prompt, /attempt `2`/);
      assert.match(prompt, /echo both.*status marker/i);
    });

    it('names the attempt manifest as authoritative without inlining upstream bodies', () => {
      const prompt = autopilot.phasePrompt('review', '/repo/spec.md', {
        runId: '12345678-1234-4234-8234-123456789abc',
        attempt: 3,
        manifestPath: '.apex/work/tasks/topic/context/phase-review-attempt-3.json',
      });
      assert.match(prompt, /Context manifest: \.apex\/work\/tasks\/topic\/context\/phase-review-attempt-3\.json/);
      assert.match(prompt, /authoritative input inventory/i);
      assert.doesNotMatch(prompt, /UPSTREAM_BODY_SENTINEL/);
      assert.doesNotMatch(prompt, /\/repo\/spec\.md/, 'manifest mode must not direct a full spec read');
      assert.equal([...prompt.matchAll(/steepy-apex/g)].length, 1, 'manifest mode invokes the skill once');
      assert.match(prompt, /run-id `12345678-1234-4234-8234-123456789abc`.*attempt `3`/i);
      assert.match(prompt, /Read required.*onDemand only for a concrete missing fact/i);
      assert.match(prompt, /unattended autopilot/i);
      assert.match(prompt, /never ask[^;]*wait for a human/i);
      assert.match(prompt, /never push[^;]*bump version[^;]*open PR/i);
      assert.match(prompt, /correlated `BLOCKED`.*autopilot-status\.md.*non-zero/i);
    });
  });

  describe('attempt and display identity', () => {
    it('normalizes whole-second UTC markers without changing ledger bytes or completion guards', () => {
      for (const phase of ['plan', 'implement', 'review']) {
        const canonical = acceptedPhase(phase);
        const seconds = canonical.replaceAll('.000Z', 'Z');
        const records = autopilot.normalizeAutopilotStatus(seconds);
        assert.deepEqual(records, autopilot.normalizeAutopilotStatus(canonical));
        assert.equal(records.sourceBytes, seconds);
        assert.equal(records.byteLength, Buffer.byteLength(seconds));
        assert.equal(autopilot.phaseCompleted(seconds, phase), true);
        assert.equal(autopilot.phaseCompleted(seconds.replace(/^.*PHASE_ACCEPTED.*\n/m, ''), phase), false);
      }
      for (const timestamp of ['2026-02-30T13:10:54Z', '2026-09-17T25:10:54Z', 'bad-date']) {
        assert.equal(autopilot.normalizeAutopilotStatus(`${timestamp} — plan — DONE — run-id=${priorRun} attempt=1 complete`).length, 0);
      }
    });

    it('normalizes the Markdown grammar into common envelopes and keeps wrapper projections equivalent', () => {
      const baseline = 'a'.repeat(40);
      const ignoredBaseline = 'b'.repeat(40);
      const planRun = '11111111-1111-4111-8111-111111111111';
      const implementRun = '22222222-2222-4222-8222-222222222222';
      const reviewRun = '33333333-3333-4333-8333-333333333333';
      const status = [
        `2026-08-11T10:00:00.000Z — CONDUCTOR — BASELINE — run-id=${planRun} commit=${baseline}`,
        'this is not a status record',
        '2026-08-11T10:00:01.000Z — plan — DONE — historical uncorrelated completion',
        `2026-08-11T10:00:02.000Z — CONDUCTOR — ATTEMPT_RESERVED — run-id=${planRun} phase=plan attempt=1`,
        `2026-08-11T10:00:03.000Z — CONDUCTOR — ARTIFACT_FAILED — run-id=${planRun} phase=plan attempt=2 reason=missing`,
        `2026-08-11T10:00:04.000Z — CONDUCTOR — SPAWNED — run-id=${planRun} phase=plan attempt=3 display-name=steepy-topic-plan-a3-11111111 readable=phase-1-attempt-3.log raw=phase-1-attempt-3.raw.jsonl session=pending`,
        `2026-08-11T10:00:05.000Z — plan — DONE — run-id=${planRun} attempt=3 plan complete`,
        `2026-08-11T10:00:06.000Z — CONDUCTOR — SPAWNED — run-id=${implementRun} phase=implement attempt=1 display-name=steepy-topic-implement-a1-22222222 readable=phase-2-attempt-1.log raw=phase-2-attempt-1.raw.jsonl session=pending`,
        `2026-08-11T10:00:07.000Z — implement — DONE — run-id=${implementRun} attempt=1 implementation complete`,
        `2026-08-11T10:00:08.000Z — CONDUCTOR — SPAWNED — run-id=${reviewRun} phase=review attempt=1 display-name=steepy-topic-review-a1-33333333 readable=phase-3-attempt-1.log raw=phase-3-attempt-1.raw.jsonl session=pending`,
        `2026-08-11T10:00:09.000Z — review — READY_FOR_PR — run-id=${reviewRun} attempt=1 stopped before release`,
        `2026-08-11T10:00:10.000Z — CONDUCTOR — BASELINE — run-id=${reviewRun} commit=${ignoredBaseline}`,
      ].join('\n');

      const envelopes = autopilot.normalizeAutopilotStatus(status);
      assert.equal(envelopes.length, 11, 'only the non-protocol line is ignored');
      assert.equal(envelopes.sourceBytes, status);
      assert.deepEqual(
        Object.keys(envelopes[0]).slice(0, 5),
        ['schemaVersion', 'sequence', 'runId', 'timestamp', 'event'],
      );
      assert.deepEqual(
        envelopes.map(({ sequence }) => sequence),
        Array.from({ length: envelopes.length }, (_, index) => index + 1),
      );

      const replay = autopilot.replayAutopilotStatus(status);
      assert.equal(replay.baseline, baseline, 'the first baseline remains authoritative');
      assert.deepEqual(replay.attemptsByScope, { plan: [1, 2, 3], implement: [1], review: [1] });
      assert.equal(autopilot.runBaseline(status), replay.baseline);
      assert.equal(autopilot.nextPhaseAttempt(status, 'plan'), 4);
      assert.equal(autopilot.nextPhaseAttempt(status, 'implement'), 2);
      for (const phase of autopilot.PHASES) {
        assert.equal(autopilot.phaseCompleted(status, phase), false, phase);
      }
      assert.equal(
        autopilot.phaseCompleted(status, 'review', { runId: reviewRun, phase: 'review', attempt: 1 }),
        false,
      );
      assert.ok(Object.isFrozen(envelopes));
      assert.ok(Object.isFrozen(replay));
    });

    it('derives the next positive attempt from valid durable attempt events', () => {
      const status = [
        '2026-08-11T10:00:00.000Z — CONDUCTOR — SPAWNED — run-id=11111111-1111-4111-8111-111111111111 phase=plan attempt=1 display-name=steepy-topic-plan-a1-11111111 readable=phase-1-attempt-1.log raw=phase-1-attempt-1.raw.jsonl session=pending',
        'not-a-date — CONDUCTOR — SPAWNED — run-id=bad phase=plan attempt=99',
        '2026-08-11T10:00:01.000Z — plan — SPAWNED — run-id=22222222-2222-4222-8222-222222222222 phase=plan attempt=50',
        '2026-08-11T10:00:02.000Z — CONDUCTOR — SPAWNED — run-id=33333333-3333-4333-8333-333333333333 phase=implement attempt=7 display-name=x readable=y raw=z session=pending',
        '2026-08-11T10:00:03.000Z — CONDUCTOR — SPAWNED — run-id=44444444-4444-4444-8444-444444444444 phase=plan attempt=2 display-name=steepy-topic-plan-a2-44444444 readable=phase-1-attempt-2.log raw=phase-1-attempt-2.raw.jsonl session=pending',
        '2026-08-11T10:00:04.000Z — CONDUCTOR — ARTIFACT_FAILED — run-id=55555555-5555-4555-8555-555555555555 phase=plan attempt=3 manifest=.apex/work/tasks/topic/context/phase-plan-attempt-3.json reason=missing',
        '2026-08-11T10:00:05.000Z — CONDUCTOR — ATTEMPT_RESERVED — run-id=66666666-6666-4666-8666-666666666666 phase=plan attempt=4',
      ].join('\n');
      assert.equal(autopilot.nextPhaseAttempt(status, 'plan'), 5);
      assert.equal(autopilot.nextPhaseAttempt(status, 'implement'), 1);
      assert.equal(autopilot.nextPhaseAttempt('', 'review'), 1);
    });

    it('builds a deterministic display name from spec, phase, attempt, and short run ID', () => {
      assert.equal(
        autopilot.phaseDisplayName('topic-name', 'implement', 3, '12345678-1234-4234-8234-123456789abc'),
        'steepy-topic-name-implement-a3-12345678',
      );
    });
  });

  describe('phaseCompleted(statusText, phase)', () => {
    it('accepts only exact conductor acceptance correlated with a spawn', () => {
      for (const phase of ['plan', 'implement', 'review']) {
        const status = acceptedPhase(phase);
        assert.equal(autopilot.phaseCompleted(status, phase), true);
        for (const forged of [
          status.replace('CONDUCTOR — PHASE_ACCEPTED', `${phase} — PHASE_ACCEPTED`),
          status.replace(/ child-event=\w+/, ' child-event=WRONG'),
          status.replace(/ phase=\w+ attempt=1 child-event=/, ` phase=${phase} phase=review attempt=1 child-event=`),
          status.replace(/run-id=[^ ]+ phase=\w+ attempt=1 child-event=/, 'child-event='),
          status.replace(' — SPAWNED — ', ' — OBSERVED — '),
        ]) assert.equal(autopilot.phaseCompleted(forged, phase), false, forged);
      }
    });
    const done = (phase) => `2026-08-10T10:00:00.000Z — ${phase} — DONE — finished\n`;

    it('does not accept child-only completion', () => {
      assert.equal(autopilot.phaseCompleted(done('plan'), 'plan'), false);
      assert.equal(autopilot.phaseCompleted(done('implement'), 'implement'), false);
    });

    it('is false for a phase with no line at all', () => {
      assert.equal(autopilot.phaseCompleted(done('plan'), 'implement'), false);
      assert.equal(autopilot.phaseCompleted('', 'plan'), false);
    });

    it('is false when the only line is the conductor SPAWNED event', () => {
      const text = '2026-08-10T10:00:00.000Z — CONDUCTOR — SPAWNED — plan → phase-1.log\n';
      assert.equal(autopilot.phaseCompleted(text, 'plan'), false);
    });

    it('requires READY_FOR_PR (not DONE) for review', () => {
      assert.equal(autopilot.phaseCompleted(done('review'), 'review'), false);
      const ready = '2026-08-10T10:00:00.000Z — review — READY_FOR_PR — stopped before bump/PR\n';
      assert.equal(autopilot.phaseCompleted(ready, 'review'), false);
    });

    it('ignores a marker quoted inside another line note', () => {
      const text = '2026-08-10T10:00:00.000Z — CONDUCTOR — HALTED — expected a — plan — DONE — line\n';
      assert.equal(autopilot.phaseCompleted(text, 'plan'), false);
    });

    it('derives phase from the validated actor while rejecting a contradictory redundant phase', () => {
      const runId = '11111111-1111-4111-8111-111111111111';
      const spawned = `2026-08-10T10:00:00.000Z — CONDUCTOR — SPAWNED — run-id=${runId} phase=plan attempt=1 display-name=steepy-topic-plan-a1-11111111 readable=phase-1-attempt-1.log raw=phase-1-attempt-1.raw.jsonl session=pending`;
      const documented = `2026-08-10T10:00:01.000Z — plan — DONE — run-id=${runId} attempt=1 plan.md`;
      const contradictory = `2026-08-10T10:00:01.000Z — plan — DONE — run-id=${runId} phase=review attempt=1 forged`;
      assert.equal(autopilot.phaseCompleted(`${spawned}\n${documented}\n`, 'plan'), false);
      assert.equal(autopilot.phaseCompleted(`${spawned}\n${contradictory}\n`, 'plan'), false);
    });

    it('treats an attempt reservation as structured protocol adoption without treating it as a spawn', () => {
      const status = [
        '2026-08-11T10:00:00.000Z — CONDUCTOR — ATTEMPT_RESERVED — run-id=11111111-1111-4111-8111-111111111111 phase=plan attempt=1',
        '2026-08-11T10:00:01.000Z — plan — DONE — uncorrelated marker after reservation',
      ].join('\n');
      assert.equal(autopilot.phaseCompleted(status, 'plan'), false);
    });
  });

  describe('appendStatus(repoRoot, statusPath, actor, event, note)', () => {
    let dir;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'steepy-autopilot-'));
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('creates the file and appends one ISO-timestamped protocol line per call', () => {
      const statusPath = '.apex/work/tasks/unit-create/autopilot-status.md';
      autopilot.appendStatus(dir, statusPath, 'CONDUCTOR', 'SPAWNED', 'plan → phase-1.log');
      autopilot.appendStatus(dir, statusPath, 'plan', 'DONE', 'plan written');
      const lines = readFileSync(join(dir, statusPath), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z — CONDUCTOR — SPAWNED — plan → phase-1\.log$/);
      assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z — plan — DONE — plan written$/);
    });

    it('strips control characters from a note instead of throwing', () => {
      const statusPath = '.apex/work/tasks/unit-controls/autopilot-status.md';
      // A child's note can echo terminal escapes; recording the event must never
      // fail — the sanitize gate is defense in depth, not a trust boundary here.
      autopilot.appendStatus(dir, statusPath, 'CONDUCTOR', 'HALTED', 'plan: \u001b[31mred\u001b[0m output');
      const text = readFileSync(join(dir, statusPath), 'utf8');
      assert.equal(text.trim().split('\n').length, 1);
      assert.ok(!/[\u0000-\u001F\u007F]/.test(text.trim()), `control chars must be stripped: ${JSON.stringify(text)}`);
      // each stripped escape leaves a separator, never silently joins tokens
      assert.match(text, / — HALTED — plan: \[31mred \[0m output$/m);
    });

    it('keeps a multi-line note on one line (append-only, one line per event)', () => {
      const statusPath = '.apex/work/tasks/unit-multiline/autopilot-status.md';
      autopilot.appendStatus(dir, statusPath, 'CONDUCTOR', 'HALTED', 'git failed:\nfatal: not a repo\n');
      const text = readFileSync(join(dir, statusPath), 'utf8');
      assert.equal(text.trim().split('\n').length, 1);
      assert.match(text, / — HALTED — git failed: fatal: not a repo$/m);
    });

    it('appends to an existing ordinary status file without rewriting its bytes', () => {
      const statusPath = '.apex/work/tasks/unit-append/autopilot-status.md';
      autopilot.appendStatus(dir, statusPath, 'CONDUCTOR', 'SPAWNED', 'first');
      const first = readFileSync(join(dir, statusPath), 'utf8');
      autopilot.appendStatus(dir, statusPath, 'plan', 'DONE', 'second');
      const second = readFileSync(join(dir, statusPath), 'utf8');
      assert.ok(second.startsWith(first), 'an append must extend, never rewrite');
      assert.ok(second.length > first.length);
    });

    it('refuses a symlinked status target instead of appending through it', () => {
      const repoRoot = join(dir, 'symlink-run');
      const outside = join(dir, 'outside-sentinel');
      writeFileSync(outside, 'SENTINEL\n');
      mkdirSync(join(repoRoot, '.apex', 'work', 'tasks', 'symlink-run'), { recursive: true });
      symlinkSync(outside, join(repoRoot, '.apex', 'work', 'tasks', 'symlink-run', 'autopilot-status.md'));
      assert.throws(
        () => autopilot.appendStatus(repoRoot, '.apex/work/tasks/symlink-run/autopilot-status.md', 'CONDUCTOR', 'HALTED', 'nope'),
        /work path: .*symlink/u,
      );
      assert.equal(readFileSync(outside, 'utf8'), 'SENTINEL\n', 'the outside sentinel must stay untouched');
    });
  });
});

describe('runConductor(specPath, opts)', () => {
  let autopilot;

  before(async () => {
    const modulePath = join(root, 'scripts', 'autopilot.mjs');
    autopilot = await import(pathToFileURL(modulePath));
  });

  const STUB = join(here, 'fixtures', 'fake-harness.mjs');
  const stubCommandFor = (harness, prompt, options) => {
    const descriptor = headlessCommand(harness, prompt, options);
    return descriptor === null ? null : {
      ...descriptor,
      cmd: process.execPath,
      args: [
        STUB, prompt, harness, JSON.stringify(descriptor),
        ...(descriptor.resolvedModel ? ['--model', descriptor.resolvedModel] : []),
      ],
    };
  };

  function specText({
    drive = 'autopilot', branch = 'gear3-topic', gear = 3, logMode, harness = 'claude',
    budget, commitAuth = 'per-task', blastRadius = 'branch-only, no-push, stop-before-PR',
    featureComplexity = 'design', owningSurface = 'scripts', crossCuttingSurfaces,
  } = {}) {
    const driveLine = drive === null ? '' : `drive: ${drive}\n`;
    const budgetLine = budget === undefined ? '' : `budget: ${budget}\n`;
    const logModeLine = logMode === undefined ? '' : `log-mode: ${logMode}\n`;
    const crossCuttingLine = crossCuttingSurfaces === undefined
      ? ''
      : `- **Cross-cutting surfaces:** ${crossCuttingSurfaces}\n`;
    const complexityLine = featureComplexity === null
      ? ''
      : `- **Feature complexity:** \`${featureComplexity}\`\n`;
    const owningSurfaceLine = owningSurface === null
      ? ''
      : `- **Owning surface:** \`${owningSurface}\`\n`;
    return `<!-- verdict: GAP | gear: ${gear}
${driveLine}branch: ${branch}
commit-auth: ${commitAuth}
harness: ${harness}
${budgetLine}${logModeLine}blast-radius: ${blastRadius}
-->

# Topic spec

${owningSurfaceLine}${crossCuttingLine}${complexityLine}

UPSTREAM_BODY_SENTINEL_MUST_NOT_BE_IN_PROMPT

## Success criteria

1. SC1 — The branch handoff uses canonical artifacts.
2. SC2 — Review receives criteria without the full spec body.
`;
  }

  // A temp git repo holding one spec, plus the paths the conductor derives from it.
  // Work artifacts are gitignored exactly as in a real hub, and the baseline is
  // committed: the conductor's fresh-run preflight demands a clean working tree.
  function makeRun({
    repoBranch = 'gear3-topic', opencodeModel, opencodeConfig = 'opencode.json',
    opencodeConfigText, rawSpec, ...contract
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'steepy-autopilot-'));
    execFileSync('git', ['init', '-q', '-b', repoBranch], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), '.apex/work/\n');
    // A project model pin is committed config, not work in progress: the
    // fresh-run preflight demands a clean tree, so it joins the baseline.
    const trackedPaths = ['.gitignore', '.apex'];
    if (opencodeModel !== undefined) {
      // `opencode.json` is the filename an opencode install actually reads at
      // the project root — the fixture must pin the way a real user does.
      writeFileSync(
        join(dir, opencodeConfig),
        opencodeConfigText ?? `${JSON.stringify({ model: opencodeModel }, null, 2)}\n`,
      );
      trackedPaths.push(opencodeConfig);
    }
    mkdirSync(join(dir, '.apex', 'standards'), { recursive: true });
    writeFileSync(join(dir, '.apex', '_INDEX.md'), '# Hub\n\n| Surface | Min docs |\n|---|---|\n| `scripts` | [standards/scripts.md](standards/scripts.md) |\n');
    writeFileSync(join(dir, '.apex', 'testing-and-checklist.md'), '# Tests\n\n`npm test`\n');
    writeFileSync(join(dir, '.apex', 'conventions.md'), '# Context manifests\n\nRequired inputs are eager; on-demand inputs are references.\n');
    writeFileSync(join(dir, '.apex', 'standards', 'scripts.md'), '# Scripts\n\nNode built-ins only.\n');
    execFileSync('git', ['add', ...trackedPaths], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
    mkdirSync(join(dir, '.apex', 'work', 'specs'), { recursive: true });
    const specPath = join(dir, '.apex', 'work', 'specs', 'topic.md');
    writeFileSync(specPath, rawSpec ?? specText(contract));
    const taskDir = join(dir, '.apex', 'work', 'tasks', 'topic');
    return { dir, specPath, taskDir, statusFile: join(taskDir, 'autopilot-status.md') };
  }

  function seedPlanArtifacts(run) {
    const planPath = join(run.dir, '.apex', 'work', 'plans', 'topic.md');
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `integration`\n- **Success criteria:** SC1\n');
    mkdirSync(run.taskDir, { recursive: true });
    writeFileSync(join(run.taskDir, 'ledger.md'), '# Ledger\n');
  }

  // Runs the conductor with the fixture env set and console captured, so the
  // suite output stays pristine even for the halt cases.
  async function drive(run, env = {}, opts = {}) {
    const fixtureHome = join(run.dir, '.apex', 'work', 'test-home');
    const vars = {
      HOME: fixtureHome,
      XDG_CONFIG_HOME: join(env.HOME ?? fixtureHome, '.config'),
      FAKE_HARNESS_STATUS: run.statusFile, ...env,
    };
    const previous = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    const out = [];
    const err = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...args) => out.push(args.join(' '));
    console.error = (...args) => err.push(args.join(' '));
    const capture = (sink) => ({
      on() { return this; },
      off() { return this; },
      write(chunk, callback) {
        sink.push(String(chunk).replace(/\n$/, ''));
        callback?.();
        return true;
      },
    });
    try {
      const code = await autopilot.runConductor(run.specPath, {
        commandFor: stubCommandFor,
        cwd: run.dir,
        opencodeConfig: { env: vars, homedir: () => fixtureHome },
        liveStdout: capture(out),
        liveStderr: capture(err),
        ...opts,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    } finally {
      console.log = realLog;
      console.error = realError;
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('isolates OpenCode config reads through the conductor environment seam', async () => {
    const run = makeRun({ harness: 'opencode' });
    const ambient = mkdtempSync(join(tmpdir(), 'steepy-autopilot-sentinel-'));
    const selected = mkdtempSync(join(tmpdir(), 'steepy-autopilot-selected-'));
    const forbidden = join(ambient, 'opencode', 'opencode.json');
    mkdirSync(dirname(forbidden), { recursive: true });
    writeFileSync(forbidden, '{"model":"zai-coding-plan/glm-5.3"}');
    const attempts = [];
    const originals = new Map();
    for (const method of ['existsSync', 'readFileSync', 'openSync']) {
      originals.set(method, fs[method]);
      fs[method] = (path, ...args) => {
        if (String(path) === forbidden) {
          attempts.push(method);
          throw new Error('forbidden ambient config access');
        }
        return originals.get(method)(path, ...args);
      };
    }
    syncBuiltinESMExports();
    try {
      const { code } = await drive(run, {
        HOME: ambient, XDG_CONFIG_HOME: ambient, FAKE_HARNESS_MODE: 'done',
      }, { opencodeConfig: { env: { HOME: selected, XDG_CONFIG_HOME: selected }, homedir: () => selected } });
      assert.deepEqual(attempts, [], 'even caught filesystem attempts violate isolation');
      assert.equal(code, 0);
    } finally {
      for (const [method, original] of originals) fs[method] = original;
      syncBuiltinESMExports();
      for (const dir of [run.dir, ambient, selected]) rmSync(dir, { recursive: true, force: true });
    }
  });

  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function waitFor(predicate, waitLimitMs = 5000) {
    const deadline = Date.now() + waitLimitMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  }

  async function waitGone(pid, waitLimitMs = 3000) {
    const deadline = Date.now() + waitLimitMs;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return !isAlive(pid);
  }

  const statusOf = (run) => (existsSync(run.statusFile) ? readFileSync(run.statusFile, 'utf8') : '');
  const linesWith = (text, needle) => text.split('\n').filter((l) => l.includes(needle));
  const rawEntries = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const captureEntries = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const usageEntries = (run) => captureEntries(join(run.taskDir, 'resource-usage.jsonl'));

  for (const platform of ['linux', 'darwin']) {
    it(`accepts the supported ${platform} platform capability`, async () => {
      const run = makeRun();
      try {
        const result = await drive(run, {}, { platform });
        assert.equal(result.code, 0, result.err);
        assert.equal(linesWith(statusOf(run), ' — PHASE_ACCEPTED — ').length, 3);
      } finally { rmSync(run.dir, { recursive: true, force: true }); }
    });
  }

  for (const platform of ['aix', 'freebsd', 'openbsd', 'sunos', 'win32', 'android']) {
    it(`refuses unsupported ${platform} before coordination, run-state mutation, command construction, or spawn`, async () => {
      const run = makeRun();
      let commands = 0;
      let lockTransitions = 0;
      try {
        const result = await drive(run, {}, {
          platform,
          commandFor: (...args) => { commands += 1; return stubCommandFor(...args); },
          lockTransition: () => { lockTransitions += 1; },
        });
        assert.equal(result.code, 1);
        assert.match(result.err, new RegExp(`refusing to drive.*${platform}.*deterministic Gear 3 process-group ownership is unavailable`, 'i'));
        assert.equal(commands, 0);
        assert.equal(lockTransitions, 0);
        assert.equal(existsSync(run.taskDir), false, 'status, logs, manifests, and usage must remain absent');
        assert.equal(
          readdirSync(join(run.dir, '.apex', 'work')).some((name) => name.startsWith('.gear-3-autopilot.lock')),
          false,
          'no checkout-lock candidate or generation may be created',
        );
      } finally { rmSync(run.dir, { recursive: true, force: true }); }
    });
  }

  class InjectedLiveDestination extends EventEmitter {
    constructor({ results = [true], throwOnWrite = null, autoDrain = false } = {}) {
      super();
      this.results = [...results];
      this.throwOnWrite = throwOnWrite;
      this.autoDrain = autoDrain;
      this.chunks = [];
    }

    write(chunk, callback) {
      if (this.throwOnWrite) throw this.throwOnWrite;
      this.chunks.push(String(chunk));
      callback?.();
      const result = this.results.length > 0 ? this.results.shift() : true;
      if (result === false && this.autoDrain) setImmediate(() => this.emit('drain'));
      return result;
    }
  }

  it('blocks a completed child on unproven group absence and reruns that phase on resume', async () => {
    const run = makeRun();
    const signals = [];
    let probes = 0;
    try {
      const result = await drive(run, {}, {
        processGroupProbe: () => { probes += 1; },
        processGroupSignal: (_pid, signal) => signals.push(signal),
        killGraceMs: 10,
        groupConvergenceMs: 10,
      });
      assert.equal(result.code, 1);
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
      assert.ok(probes >= 3, 'includes a final absence probe');
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1);
      assert.match(status, /HALTED — run-id=[\w-]+ phase=plan attempt=1: PROCESS_GROUP_NOT_CONVERGED/);
      assert.equal(linesWith(status, ' — PHASE_ACCEPTED — ').length, 0);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 1);
      assert.match(status, / — plan — DONE — /);
      assert.equal((await drive(run)).code, 0);
      assert.equal(linesWith(statusOf(run), ' — SPAWNED — ').filter((line) => line.includes('phase=plan')).length, 2);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  });

  it('does not signal a proven absent group or time out a healthy leader', async () => {
    const run = makeRun();
    let probes = 0;
    const signals = [];
    try {
      const result = await drive(run, {}, {
        processGroupProbe: () => { probes += 1; throw Object.assign(new Error('absent'), { code: 'ESRCH' }); },
        processGroupSignal: (_pid, signal) => signals.push(signal),
        killGraceMs: 0,
        groupConvergenceMs: 0,
      });
      assert.equal(result.code, 0);
      assert.equal(probes, 3);
      assert.deepEqual(signals, [], 'absent group must never be signaled');
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  });

  for (const leaderLive of [false, true]) {
    it(`halts on ineffective signals with ${leaderLive ? 'a stopped live leader' : 'an exited leader and inherited pipes'}`, async () => {
      const run = makeRun();
      const pidPath = join(run.taskDir, 'nonconvergent-descendant.pid');
      const expiredPath = join(run.taskDir, 'nonconvergent-expired');
      const signals = [];
      let child;
      let descendantPid;
      try {
        const descendantCode = `process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(expiredPath)}, 'expired'); process.exit(0); }, 1500);`;
        const leaderCode = `
          const {spawn} = require('node:child_process');
          const fs = require('node:fs');
          process.on('SIGTERM', () => {});
          setTimeout(() => process.exit(0), 1600);
          const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio:['ignore','inherit','inherit','ipc']});
          child.once('message', () => {
            fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
            process.stdout.write('durable before stop\\npartial stdout');
            process.stderr.write('partial stderr');
            if (!${leaderLive}) process.exit(0);
          });
        `;
        const result = await drive(run, {}, {
          commandFor: () => ({ cmd: process.execPath, args: ['-e', leaderCode] }),
          processGroupSignal: (_pid, signal) => signals.push(signal),
          killGraceMs: 20,
          groupConvergenceMs: 20,
          registerNativeStop: ({ child: spawned, stop }) => {
            child = spawned;
            if (leaderLive) spawned.stdout.once('data', stop);
          },
        });
        descendantPid = Number(readFileSync(pidPath, 'utf8'));
        assert.equal(existsSync(expiredPath), false, 'failure must settle before fixture expiry');
        assert.equal(isAlive(descendantPid), true, 'injected signals are intentionally ineffective');
        if (leaderLive) assert.equal(isAlive(child.pid), true);
        assert.equal(result.code, 1);
        assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
        const status = statusOf(run);
        assert.match(status, /HALTED — run-id=[\w-]+ phase=plan attempt=1: PROCESS_GROUP_NOT_CONVERGED/);
        assert.match(status, /evidence ingestion aborted; capture may be truncated/);
        assert.equal(linesWith(status, ' — HALTED — ').length, 1);
        assert.equal(linesWith(status, ' — PHASE_ACCEPTED — ').length, 0);
        assert.equal(linesWith(status, ' — SPAWNED — ').length, 1);
        assert.ok(rawEntries(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl')).some((entry) => entry.line === 'durable before stop'));
      } finally {
        if (!descendantPid && existsSync(pidPath)) descendantPid = Number(readFileSync(pidPath, 'utf8'));
        for (const pid of [descendantPid, child?.pid]) {
          if (pid && isAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            assert.equal(await waitGone(pid), true, `fixture ${pid} must be independently cleaned`);
          }
        }
        rmSync(run.dir, { recursive: true, force: true });
      }
    });
  }

  for (const stdio of ['inherit', 'ignore']) {
    for (const exitCode of [0, 7]) {
      it(`converges a SIGTERM-ignoring descendant with ${stdio} pipes after leader exit ${exitCode}`, async () => {
        const run = makeRun();
        const pidPath = join(run.taskDir, 'descendant.pid');
        const expiredPath = join(run.taskDir, 'descendant-expired');
        let descendantPid;
        try {
          const childCode = `process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(expiredPath)}, 'expired'); process.exit(0); }, 1500);`;
          const leaderCode = `
            const {spawn} = require('node:child_process');
            const fs = require('node:fs');
            const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:['ignore', '${stdio}', '${stdio}', 'ipc']});
            child.once('message', () => { fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); process.stdout.write('final stdout'); process.stderr.write('final stderr'); process.exit(${exitCode}); });
          `;
          const result = await drive(run, {}, {
            commandFor: () => ({ cmd: process.execPath, args: ['-e', leaderCode] }),
            killGraceMs: 30,
            groupConvergenceMs: 1000,
          });
          descendantPid = Number(readFileSync(pidPath, 'utf8'));
          assert.equal(existsSync(expiredPath), false, 'convergence must start on exit even while inherited pipes remain open');
          assert.equal(isAlive(descendantPid), false, 'descendant must be gone before the drive loop settles');
          assert.equal(result.code, 1, 'leader has no completion marker');
          const raw = rawEntries(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl'));
          assert.ok(raw.some((entry) => entry.line === 'final stdout'));
          assert.ok(raw.some((entry) => entry.line === 'final stderr'));
          assert.equal(linesWith(statusOf(run), ' — HALTED — ').length, 1);
        } finally {
          if (!descendantPid && existsSync(pidPath)) descendantPid = Number(readFileSync(pidPath, 'utf8'));
          if (descendantPid && isAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
          rmSync(run.dir, { recursive: true, force: true });
        }
      });
    }
  }

  it('advances through all phases when children write whole-second timestamps', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_SECONDS_TIMESTAMP: '1' });
      const status = statusOf(run);
      assert.equal(code, 0, status);
      assert.equal(linesWith(status, ' — PHASE_ACCEPTED — ').length, 3, status);
      for (const phase of ['plan', 'implement', 'review']) {
        assert.match(status, new RegExp(`T\\d{2}:\\d{2}:\\d{2}Z — ${phase} — (DONE|READY_FOR_PR) — `));
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('runs the three phases in order, one fresh session each, and exits 0', async () => {
    const run = makeRun();
    const signalListenersBefore =
      process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP');
    try {
      const { code, out } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_STDERR: '1',
        FAKE_HARNESS_FRAGMENTED: '1',
        FAKE_HARNESS_FINAL_UNTERMINATED: '1',
      });
      assert.equal(code, 0);
      // The interrupt forwarding lives only as long as a child does: a finished
      // run leaves the host process exactly as it found it.
      assert.equal(
        process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP'),
        signalListenersBefore,
        'runConductor must not leave signal handlers installed',
      );
      const status = statusOf(run);
      assert.match(status.split('\n')[0], / — CONDUCTOR — STATUS_PROTOCOL — version=1$/);
      const accepted = linesWith(status, ' — PHASE_ACCEPTED — ');
      assert.equal(accepted.length, 3, status);
      for (const [index, phase] of ['plan', 'implement', 'review'].entries()) {
        const event = phase === 'review' ? 'READY_FOR_PR' : 'DONE';
        assert.match(accepted[index], new RegExp(` — CONDUCTOR — PHASE_ACCEPTED — run-id=[0-9a-f-]+ phase=${phase} attempt=1 child-event=${event}$`));
        assert.ok(status.indexOf(` — ${phase} — ${event} — `) < status.indexOf(accepted[index]));
      }
      const spawned = linesWith(status, ' — SPAWNED — ');
      assert.equal(spawned.length, 3, `expected 3 SPAWNED lines, got:\n${status}`);
      assert.match(spawned[0], /plan/);
      assert.match(spawned[1], /implement/);
      assert.match(spawned[2], /review/);
      for (const n of [1, 2, 3]) {
        assert.ok(existsSync(join(run.taskDir, `phase-${n}.log`)), `phase-${n}.log must exist`);
        assert.ok(existsSync(join(run.taskDir, `phase-${n}-attempt-1.log`)));
        const rawPath = join(run.taskDir, `phase-${n}-attempt-1.raw.jsonl`);
        assert.ok(existsSync(rawPath));
        assert.equal(statSync(rawPath).mode & 0o777, 0o600);
        const entries = rawEntries(rawPath);
        assert.ok(entries.some((entry) => entry.sourceStream === 'stdout'));
        assert.ok(entries.some((entry) => entry.sourceStream === 'stderr'));
        const aggregate = readFileSync(join(run.taskDir, `phase-${n}.log`), 'utf8');
        assert.match(aggregate, /BEGIN.*attempt=1/);
        assert.match(aggregate, /END.*attempt=1/);
      }
      assert.match(readFileSync(join(run.taskDir, 'phase-2-attempt-1.log'), 'utf8'), /fake implement message/);
      assert.match(status, / — plan — DONE — /);
      assert.match(status, / — implement — DONE — /);
      assert.match(status, / — review — READY_FOR_PR — /);
      assert.match(status, / — plan — DONE — run-id=[0-9a-f-]+ attempt=1 /);
      assert.match(status, / — implement — DONE — run-id=[0-9a-f-]+ attempt=1 /);
      assert.match(status, / — review — READY_FOR_PR — run-id=[0-9a-f-]+ attempt=1 /);
      assert.doesNotMatch(status, / — (?:plan|implement|review) — (?:DONE|READY_FOR_PR) — [^\n]*\bphase=/);
      const runIds = spawned.map((line) => line.match(/run-id=([0-9a-f-]{36})/)?.[1]);
      assert.ok(runIds.every(Boolean), `every spawn needs a UUID:\n${status}`);
      assert.equal(new Set(runIds).size, 1, `one invocation needs one run ID:\n${status}`);
      assert.match(spawned[0], /attempt=1 .*display-name=steepy-topic-plan-a1-[0-9a-f]{8}/);
      assert.match(spawned[0], /readable=phase-1-attempt-1\.log raw=phase-1-attempt-1\.raw\.jsonl session=pending/);
      const identified = linesWith(status, ' — SESSION_IDENTIFIED — ');
      assert.equal(identified.length, 3, `one native session binding per phase:\n${status}`);
      assert.ok(identified.every((line) => /run-id=.*phase=.*attempt=1.*session-id=.*native-session-identity=yes.*native-open-resume=unproven.*qualification=.*open-hint=.*resume-hint=/.test(line)));
      assert.match(out, /plan .*attempt 1 .*session pending/);
      assert.match(out, /session claude-plan-session/);
      assert.match(out, /unproven.*open hint:/i);
      assert.doesNotMatch(out, /session claude-plan-session[^\n]*open:/i);
      assert.ok(out.includes(run.statusFile), `summary must name the status file, got: ${out}`);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('keeps fresh and completed-resume bytes compatible through aggregate diff and READY_FOR_PR', async () => {
    const run = makeRun();
    writeFileSync(join(run.dir, 'tracked.txt'), 'baseline\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: run.dir });
    execFileSync('git', ['commit', '-q', '-m', 'tracked baseline'], { cwd: run.dir });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: run.dir, encoding: 'utf8' }).trim();
    try {
      const fresh = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_TELEMETRY: 'phase',
        FAKE_HARNESS_WORK_FILES: '1',
        FAKE_HARNESS_SKIP_BRANCH_DIFF: '1',
      }, { runId: '44444444-4444-4444-8444-444444444444' });
      assert.equal(fresh.code, 0);

      const statusBeforeResume = statusOf(run);
      const diffBeforeResume = readFileSync(join(run.taskDir, 'branch-diff.txt'), 'utf8');
      const planLogBeforeResume = readFileSync(join(run.taskDir, 'phase-1.log'), 'utf8');
      assert.equal(linesWith(statusBeforeResume, ' — BASELINE — ').length, 1, statusBeforeResume);
      assert.equal(linesWith(statusBeforeResume, ' — ATTEMPT_RESERVED — ').length, 3, statusBeforeResume);
      assert.deepEqual(
        linesWith(statusBeforeResume, ' — ATTEMPT_RESERVED — ').map(
          (line) => line.match(/phase=(plan|implement|review)/)?.[1],
        ),
        ['plan', 'implement', 'review'],
      );
      assert.match(statusBeforeResume, / — plan — DONE — /);
      assert.match(statusBeforeResume, / — implement — DONE — /);
      assert.match(statusBeforeResume, / — review — READY_FOR_PR — /);
      assert.match(diffBeforeResume, /-baseline\n\+implemented/);
      assert.ok(existsSync(join(run.taskDir, 'resource-usage.jsonl')));
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: run.dir, encoding: 'utf8' }).trim(), headBefore);

      const resumed = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'claude',
      }, { runId: '55555555-5555-4555-8555-555555555555' });
      assert.equal(resumed.code, 0);
      assert.equal(statusOf(run), statusBeforeResume, 'completed resume must append no status bytes');
      assert.equal(readFileSync(join(run.taskDir, 'branch-diff.txt'), 'utf8'), diffBeforeResume);
      assert.equal(readFileSync(join(run.taskDir, 'phase-1.log'), 'utf8'), planLogBeforeResume);
      assert.equal(linesWith(statusOf(run), ' — SPAWNED — ').length, 3, 'completed phases do not respawn');
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: run.dir, encoding: 'utf8' }).trim(), headBefore);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('rejects a fresh gear-3 contract containing a budget before dispatch', async () => {
    const run = makeRun({ budget: 45 });
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 1);
      assert.equal(existsSync(run.statusFile), false);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  });

  it('rejects a resumed gear-3 contract containing a budget before dispatch', async () => {
    const run = makeRun({ budget: 45 });
    try {
      mkdirSync(run.taskDir, { recursive: true });
      writeFileSync(run.statusFile, acceptedPhase());
      const before = statusOf(run);
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 1);
      assert.equal(statusOf(run), before);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  });

  it('builds each phase manifest at artifact readiness and routes the actual descriptor before SPAWNED', async () => {
    const run = makeRun();
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
      });
      assert.equal(code, 0);

      const captures = captureEntries(capturePath);
      const expectedTierByPhase = { plan: 'most-capable', implement: 'standard', review: 'standard' };
      const expectedModelByPhase = { plan: 'opus', implement: 'sonnet', review: 'sonnet' };
      assert.deepEqual(captures.map(({ phase }) => phase), ['plan', 'implement', 'review']);
      assert.deepEqual(
        captures.map(({ phase, descriptor }) => [phase, descriptor.requestedModelTier]),
        [['plan', 'most-capable'], ['implement', 'standard'], ['review', 'standard']],
      );
      for (const capture of captures) {
        assert.equal(capture.manifestExists, true, `${capture.phase} manifest must exist at spawn`);
        assert.equal(capture.descriptor.modelSelection, 'applied');
        assert.equal(capture.descriptor.resolvedModel, expectedModelByPhase[capture.phase]);
        assert.deepEqual(capture.descriptor.args.slice(-2), ['--model', expectedModelByPhase[capture.phase]]);
        assert.deepEqual(capture.spawnArgs.slice(-2), ['--model', expectedModelByPhase[capture.phase]]);
        assert.match(capture.statusAtSpawn, new RegExp(`MODEL_ROUTED .*phase=${capture.phase}`));
        assert.match(capture.prompt, new RegExp(`context/phase-${capture.phase}-attempt-1\\.json`));
        assert.match(capture.prompt, /authoritative input inventory/i);
        assert.match(capture.prompt, /run-id `[0-9a-f-]{36}`.*attempt `1`/i);
        assert.doesNotMatch(capture.prompt, /UPSTREAM_BODY_SENTINEL_MUST_NOT_BE_IN_PROMPT/);
        assert.doesNotMatch(capture.prompt, /PLAN_BODY_SENTINEL_MUST_NOT_BE_IN_PROMPT/);
      }
      assert.equal(captures[0].planExists, false, 'plan artifact must not predate plan spawn');
      assert.equal(captures[1].planExists, true, 'implement manifest waits for approved plan');
      assert.equal(captures[1].resultIndexExists, false, 'review result index must not predate implement');
      assert.equal(captures[2].ledgerExists, true);
      assert.equal(captures[2].resultIndexExists, true);
      assert.equal(captures[2].branchDiffExists, true);

      const criteriaPath = join(run.taskDir, 'success-criteria.md');
      const criteriaText = readFileSync(criteriaPath, 'utf8');
      assert.match(criteriaText, /Source: `\.apex\/work\/specs\/topic\.md`/);
      assert.match(criteriaText, /Heading: `## Success criteria`/);
      assert.doesNotMatch(criteriaText, /UPSTREAM_BODY_SENTINEL/);

      const status = statusOf(run);
      const routed = linesWith(status, ' — MODEL_ROUTED — ');
      const spawned = linesWith(status, ' — SPAWNED — ');
      assert.equal(routed.length, 3, status);
      const expectedRequired = {
        plan: [
          '.apex/work/specs/topic.md', '.apex/_INDEX.md', '.apex/testing-and-checklist.md',
          '.apex/standards/scripts.md',
        ],
        implement: [
          '.apex/work/plans/topic.md',
        ],
        review: [
          '.apex/work/tasks/topic/success-criteria.md', '.apex/work/tasks/topic/task-result-index.md',
          '.apex/work/tasks/topic/branch-diff.txt', '.apex/standards/scripts.md',
        ],
      };
      for (const [index, phase] of ['plan', 'implement', 'review'].entries()) {
        const manifestPath = join(run.taskDir, 'context', `phase-${phase}-attempt-1.json`);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        assert.equal(manifest.scope.phase, phase);
        assert.equal(manifest.modelTier, expectedTierByPhase[phase]);
        assert.equal(Object.hasOwn(manifest.contract, 'budget'), false);
        assert.deepEqual(manifest.required.map(({ path }) => path), expectedRequired[phase]);
        if (phase === 'implement') {
          assert.deepEqual(manifest.onDemand.map(({ path, available }) => [path, available]), [
            ['.apex/_INDEX.md', true],
            ['.apex/standards/scripts.md', true],
            ['.apex/work/tasks/topic/ledger.md', false],
            ['.apex/work/specs/topic.md', true],
          ]);
          assert.deepEqual(manifest.outputs, [
            '.apex/work/tasks/topic/ledger.md',
            '.apex/work/tasks/topic/task-result-index.md',
            '.apex/work/tasks/topic/branch-diff.txt',
            '.apex/work/tasks/topic/success-criteria.md',
          ]);
        }
        if (phase === 'review') {
          assert.deepEqual(manifest.outputs, [
            '.apex/work/tasks/topic/evidence-report.md',
            '.apex/work/tasks/topic/review-report.md',
          ]);
        }
        assert.ok(manifest.required.every(({ path, bytes, available }) => (
          !path.startsWith('/') && Number.isSafeInteger(bytes) && bytes >= 0 && available === true
        )));
        assert.doesNotMatch(JSON.stringify(manifest), /(?:UPSTREAM|PLAN)_BODY_SENTINEL/);
        assert.match(routed[index], new RegExp(`phase=${phase}.*attempt=1.*tier=${expectedTierByPhase[phase]}`));
        assert.match(routed[index], new RegExp(`manifest=\\.apex/work/tasks/topic/context/phase-${phase}-attempt-1\\.json`));
        assert.match(routed[index], new RegExp(`manifest-bytes=${statSync(manifestPath).size}(?:\\s|$)`));
        assert.match(routed[index], new RegExp(`model-selection=applied model=${expectedModelByPhase[phase]} evidence=`));
        assert.ok(status.indexOf(routed[index]) < status.indexOf(spawned[index]), status);
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('appends deterministic source-grounded phase and actor usage once per correlated completion', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_TELEMETRY: 'both',
        FAKE_HARNESS_USAGE_RETRANSMIT: '1',
        FAKE_HARNESS_USAGE_PARTIAL: '1',
      });
      assert.equal(code, 0);
      const entries = usageEntries(run);
      assert.equal(entries.length, 6, 'three phase aggregates plus three distinct actor details');
      assert.deepEqual(entries[0], {
        schemaVersion: 2,
        runId: entries[0].runId,
        phase: 'plan',
        attempt: 1,
        harness: 'claude',
        sessionId: 'claude-plan-session',
        observationFingerprint: entries[0].observationFingerprint,
        observationScope: { kind: 'session', sessionId: 'claude-plan-session' },
        aggregationEligibility: 'unknown',
        requestedModelTier: 'most-capable',
        resolvedModel: 'opus',
        modelSelection: 'applied',
        manifestPath: '.apex/work/tasks/topic/context/phase-plan-attempt-1.json',
        manifestBytes: statSync(join(run.taskDir, 'context', 'phase-plan-attempt-1.json')).size,
        usage: { inputTokens: 10, outputTokens: 2 },
      });
      assert.deepEqual(entries[1], {
        schemaVersion: 2,
        runId: entries[0].runId,
        phase: 'plan',
        attempt: 1,
        harness: 'claude',
        sessionId: 'claude-plan-session',
        actor: 'subagent',
        actorId: 'plan-worker',
        parentActorId: 'plan-controller',
        observationFingerprint: entries[1].observationFingerprint,
        observationScope: { kind: 'actor', actorId: 'plan-worker' },
        aggregationEligibility: 'nested-actor-detail',
        requestedModelTier: 'most-capable',
        resolvedModel: 'opus',
        modelSelection: 'applied',
        manifestPath: '.apex/work/tasks/topic/context/phase-plan-attempt-1.json',
        manifestBytes: statSync(join(run.taskDir, 'context', 'phase-plan-attempt-1.json')).size,
        usage: { inputTokens: 3 },
      });
      assert.deepEqual(entries.map(({ phase, aggregationEligibility }) => [phase, aggregationEligibility]), [
        ['plan', 'unknown'], ['plan', 'nested-actor-detail'],
        ['implement', 'unknown'], ['implement', 'nested-actor-detail'],
        ['review', 'unknown'], ['review', 'nested-actor-detail'],
      ]);
      assert.ok(entries.every(({ observationFingerprint }) => /^sha256:[0-9a-f]{64}$/.test(observationFingerprint)));
      assert.ok(entries.every((entry) => !Object.hasOwn(entry, 'measurementId')));
      assert.ok(entries.every((entry) => !Object.hasOwn(entry, 'measurementScope')));
      assert.ok(entries.every((entry) => !Object.hasOwn(entry.usage, 'totalTokens')));
      const physicalLines = readFileSync(join(run.taskDir, 'resource-usage.jsonl'), 'utf8').trim().split('\n');
      assert.equal(physicalLines[0], JSON.stringify(entries[0]), 'JSONL key order must be deterministic');
      const rawCompletion = rawEntries(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl'))
        .map(({ line }) => JSON.parse(line))
        .find(({ type, agent_id: actorId }) => type === 'result' && actorId === undefined);
      assert.deepEqual(rawCompletion.usage, {
        input_tokens: 10, output_tokens: 2,
      }, 'the provider-shaped raw event remains the source of truth');

      const gaps = linesWith(statusOf(run), ' — USAGE_TELEMETRY_DEGRADED — ');
      assert.equal(gaps.length, 3, 'phase aggregate completions expose no actor attribution');
      assert.ok(gaps.every((line) => /capability=actorAttribution .*reason=missing-actor-attribution/.test(line)));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('preserves retry attempts as distinct usage records', async () => {
    const run = makeRun({ harness: 'codex' });
    const runId = '12345678-1234-4123-8123-123456789abc';
    try {
      const first = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'fail', FAKE_HARNESS_STREAM: 'codex', FAKE_HARNESS_TELEMETRY: 'phase',
      }, { runId });
      assert.equal(first.code, 1);
      const second = await drive(run, {
        FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'codex', FAKE_HARNESS_TELEMETRY: 'phase',
      }, { runId });
      assert.equal(second.code, 0);
      const planEntries = usageEntries(run).filter(({ phase }) => phase === 'plan');
      assert.deepEqual(planEntries.map(({ attempt }) => attempt), [1, 2]);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('records distinct observations in one session while deduplicating exact retransmissions', async () => {
    const run = makeRun({ harness: 'codex' });
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'codex',
        FAKE_HARNESS_TELEMETRY: 'phase',
        FAKE_HARNESS_USAGE_SECOND: '1',
        FAKE_HARNESS_USAGE_RETRANSMIT: '1',
      });
      assert.equal(code, 0);
      const entries = usageEntries(run);
      assert.equal(entries.length, 6, 'two distinct observations per phase must survive exact retransmission');
      for (const phase of ['plan', 'implement', 'review']) {
        const observations = entries.filter((entry) => entry.phase === phase);
        assert.equal(observations.length, 2);
        assert.notEqual(observations[0].observationFingerprint, observations[1].observationFingerprint);
        assert.ok(observations.every((entry) => !Object.hasOwn(entry, 'measurementId')));
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('binds injected OpenCode runtime version evidence into every usage observation', async () => {
    const run = makeRun({ harness: 'opencode' });
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'opencode',
        FAKE_HARNESS_TELEMETRY: 'phase',
      }, {
        providerVersionFor: () => '1.18.27',
      });
      assert.equal(code, 0);
      const entries = usageEntries(run);
      assert.equal(entries.length, 3);
      assert.ok(entries.every((entry) => entry.providerVersion === '1.18.27'));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('persists missing intermediate steps through conductor-to-report coverage', async () => {
    const run = makeRun({ harness: 'opencode' });
    const wrapper = String.raw`
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, process.argv.slice(1), { env: process.env, encoding: 'utf8' });
for (const line of result.stdout.split('\n')) {
  if (!line) continue;
  let event;
  try { event = JSON.parse(line); } catch { process.stdout.write(line + '\n'); continue; }
  if (event.type === 'step_finish' && event.part?.reason === 'stop') {
    const scope = { sessionID: event.sessionID, messageID: 'msg-' + event.sessionID };
    process.stdout.write(JSON.stringify({ type: 'step_finish', sessionID: event.sessionID,
      part: { ...scope, id: 'prt-missing', type: 'step-finish', reason: 'tool-calls' } }) + '\n');
    event.part = { ...event.part, ...scope, id: 'prt-final' };
  }
  process.stdout.write(JSON.stringify(event) + '\n');
}
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
`;
    try {
      const commandFor = (...args) => {
        const descriptor = stubCommandFor(...args);
        return { ...descriptor, args: ['--input-type=module', '-e', wrapper, ...descriptor.args] };
      };
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'opencode', FAKE_HARNESS_TELEMETRY: 'phase',
      }, { commandFor, providerVersionFor: () => '1.18.27' });
      assert.equal(code, 0);
      const entries = usageEntries(run);
      assert.equal(entries.length, 6, 'both intermediate and final measurement observations must persist per phase');
      const report = collectHeadlessChannel({
        harness: 'opencode', resourceUsageText: readFileSync(join(run.taskDir, 'resource-usage.jsonl'), 'utf8'),
      });
      assert.equal(report.accountingCoverage.status, 'partial');
      assert.equal(report.accountingCoverage.usageUnattributed, 3);
      assert.equal(report.accountingCoverage.included, 3);
      assert.equal(report.phaseRollups.reduce((sum, row) => sum + row.usage.input, 0), 60);
      assert.equal(linesWith(statusOf(run), ' — PHASE_ACCEPTED — ').length, 3);
      assert.ok(entries.filter((entry) => !entry.usage).every((entry) => /^sha256:[0-9a-f]{64}$/.test(entry.observationFingerprint)));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('bounds a real hung version probe, degrades its evidence, and still runs every phase', async () => {
    const run = makeRun({ harness: 'opencode' });
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'steepy-version-probe-'));
    const probeHarness = join(fixtureRoot, 'probe-harness.mjs');
    writeFileSync(probeHarness, `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
if (process.argv[2] === '--version') {
  spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1600);setInterval(()=>{},100)"], { stdio: 'inherit' });
  process.on('SIGTERM', () => {});
  setTimeout(() => process.exit(0), 1600);
  setInterval(() => {}, 100);
} else {
  const result = spawnSync(process.execPath, process.argv.slice(2), { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`);
    chmodSync(probeHarness, 0o755);
    try {
      const started = Date.now();
      assert.equal(
        await autopilot.detectProviderRuntimeVersion('opencode', { cmd: probeHarness }, run.dir),
        null,
      );
      assert.ok(Date.now() - started < 1000, 'the metadata-only bound must beat the fixture safety exit');

      const commandFor = (harness, prompt, options) => {
        const descriptor = stubCommandFor(harness, prompt, options);
        return descriptor === null ? null : { ...descriptor, cmd: probeHarness };
      };
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'opencode',
        FAKE_HARNESS_TELEMETRY: 'phase',
      }, { commandFor });
      assert.equal(code, 0);
      assert.equal(linesWith(statusOf(run), ' — PHASE_ACCEPTED — ').length, 3);
      assert.ok(usageEntries(run).every((entry) => !Object.hasOwn(entry, 'providerVersion')));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('writes a complete JSONL record when the ledger sink accepts only positive short chunks', async () => {
    const run = makeRun();
    let writeCalls = 0;
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'fail',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_TELEMETRY: 'phase',
      }, {
        usageLedgerWrite: (fd, chunk) => {
          writeCalls += 1;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          return writeSync(fd, bytes.subarray(0, Math.max(1, Math.ceil(bytes.length / 2))));
        },
      });
      assert.equal(code, 1, 'the fixture phase still exits non-zero after emitting telemetry');
      assert.ok(writeCalls > 1, 'the test must exercise a positive short write');
      const text = readFileSync(join(run.taskDir, 'resource-usage.jsonl'), 'utf8');
      assert.ok(text.endsWith('\n'));
      assert.equal(text.trim().split('\n').length, 1);
      assert.equal(JSON.parse(text).usage.inputTokens, 10);
      assert.doesNotMatch(statusOf(run), /reason=ledger-write-error/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failed partial ledger line and lets a retransmitted completion persist once', async () => {
    const run = makeRun();
    let writeCalls = 0;
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'fail',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_TELEMETRY: 'phase',
        FAKE_HARNESS_USAGE_RETRANSMIT: '1',
      }, {
        usageLedgerWrite: (fd, chunk) => {
          writeCalls += 1;
          if (writeCalls === 1) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            return writeSync(fd, bytes.subarray(0, 17));
          }
          if (writeCalls === 2) throw new Error('injected failure after partial acceptance');
          return writeSync(fd, chunk);
        },
      });
      assert.equal(code, 1);
      const text = readFileSync(join(run.taskDir, 'resource-usage.jsonl'), 'utf8');
      assert.ok(text.endsWith('\n'));
      assert.equal(text.trim().split('\n').length, 1, 'failed framing must be rolled back before retry');
      assert.equal(JSON.parse(text).usage.inputTokens, 10);
      assert.equal(linesWith(statusOf(run), 'reason=ledger-write-error').length, 1, statusOf(run));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('reports missing usage and actor attribution per correlation without inventing zero', async () => {
    const run = makeRun({ harness: 'opencode', featureComplexity: 'mechanical' });
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'opencode', FAKE_HARNESS_TELEMETRY: 'no-usage',
        FAKE_HARNESS_USAGE_RETRANSMIT: '1',
      });
      assert.equal(code, 0);
      const ledgerPath = join(run.taskDir, 'resource-usage.jsonl');
      const missingUsage = usageEntries(run);
      assert.equal(missingUsage.length, 3, 'one durable completion observation per phase');
      for (const entry of missingUsage) {
        assert.equal(entry.schemaVersion, 2);
        assert.match(entry.observationFingerprint, /^sha256:[0-9a-f]{64}$/);
        assert.deepEqual(entry.observationScope, {
          kind: 'session', sessionId: entry.sessionId,
        });
        assert.equal(Object.hasOwn(entry, 'usage'), false, 'missing provider usage is never encoded as zero');
        assert.equal(entry.aggregationEligibility, 'unknown');
      }
      const gaps = linesWith(statusOf(run), ' — USAGE_TELEMETRY_DEGRADED — ');
      assert.equal(gaps.length, 6, 'usage and actor-attribution gaps are each reported once per phase');
      assert.equal(gaps.filter((line) => /capability=usage /.test(line)).length, 3);
      assert.equal(gaps.filter((line) => /capability=actorAttribution /.test(line)).length, 3);
      assert.ok(gaps.every((line) => !/usage=0|tokens=0|cost=0/.test(line)));
      assert.doesNotMatch(statusOf(run), / — HALTED — /);

      const included = {
        schemaVersion: 2,
        runId: 'run-included',
        phase: 'implement',
        attempt: 1,
        harness: 'opencode',
        sessionId: 'ses-included',
        observationFingerprint: `sha256:${'f'.repeat(64)}`,
        observationScope: { kind: 'session', sessionId: 'ses-included' },
        measurementId: 'opencode:step:ses-included:msg-included:prt-included',
        measurementScope: {
          provider: 'opencode', kind: 'step', sessionId: 'ses-included',
          messageId: 'msg-included', partId: 'prt-included',
        },
        providerVersion: '1.18.27',
        aggregationEligibility: 'provider-measurement',
        usage: { inputTokens: 10 },
      };
      const report = collectHeadlessChannel({
        resourceUsageText: `${JSON.stringify(included)}\n${readFileSync(ledgerPath, 'utf8')}`,
        harness: 'opencode',
      });
      assert.equal(report.accountingCoverage.status, 'partial');
      assert.deepEqual(report.accountingCoverage, {
        status: 'partial', observations: 4, included: 1, excludedOverlap: 0,
        excludedUnknownScope: 0, excludedActorDetail: 0,
        usageUnattributed: 3, invalidOrUnclassifiable: 0, retransmissionsDeduplicated: 0,
      });
      assert.equal(report.phaseRollups.length, 1);
      assert.deepEqual(report.phaseRollups[0].usage, {
        input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      });
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('degrades ledger open, write, and serialization failures without reaching any conductor stop path', async () => {
    for (const failure of ['open', 'write', 'serialization']) {
      const run = makeRun();
      try {
        if (failure === 'open') {
          mkdirSync(join(run.taskDir, 'resource-usage.jsonl'), { recursive: true });
        }
        const injected = failure === 'serialization'
          ? { usageLedgerSerialize: () => undefined }
          : (failure === 'write'
            ? { usageLedgerWrite: () => { throw new Error('injected write failure'); } }
            : {});
        const { code } = await drive(run, {
          FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude',
          FAKE_HARNESS_TELEMETRY: 'phase', FAKE_HARNESS_USAGE_HUGE: '1',
        }, injected);
        assert.equal(code, 0, `${failure} failure must not stop healthy workflow`);
        const status = statusOf(run);
        assert.match(status, new RegExp(`USAGE_TELEMETRY_DEGRADED .*capability=ledger .*reason=ledger-${failure}-error`));
        assert.doesNotMatch(status, / — HALTED — | — BLOCKED — | — TIMEOUT — /);
        assert.equal(linesWith(status, ' — SPAWNED — ').length, 3);
        assert.match(status, / — review — READY_FOR_PR — /);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    }
  });

  it('records explicit model-routing degradation before spawning on the harness default', async () => {
    const run = makeRun({ harness: 'opencode', featureComplexity: 'mechanical' });
    // The conductor resolves the user-global opencode config candidate, so an
    // isolated HOME keeps a developer's real pin out of the degraded path.
    // XDG_CONFIG_HOME must be isolated too, or a developer's real XDG pin
    // leaks into the degraded path once the conductor honors it.
    const emptyHome = mkdtempSync(join(tmpdir(), 'steepy-autopilot-home-'));
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
        HOME: emptyHome,
        XDG_CONFIG_HOME: join(emptyHome, '.config'),
      });
      assert.equal(code, 0);
      const captures = captureEntries(capturePath);
      assert.equal(captures[0].descriptor.requestedModelTier, 'cheap');
      assert.equal(captures[0].descriptor.modelSelection, 'degraded');
      assert.ok(!captures[0].descriptor.args.includes('--model'));
      const status = statusOf(run);
      const degraded = linesWith(status, ' — MODEL_ROUTING_DEGRADED — ');
      const spawned = linesWith(status, ' — SPAWNED — ');
      assert.equal(degraded.length, 3, status);
      for (const [index, line] of degraded.entries()) {
        assert.match(line, /model-selection=degraded.*reason=/);
        assert.ok(status.indexOf(line) < status.indexOf(spawned[index]), status);
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('routes opencode phase tiers from an XDG_CONFIG_HOME global pin, no project pin present', async () => {
    const run = makeRun({ harness: 'opencode' });
    // No project pin: the only candidate that can resolve a provider is the
    // user-global one, read from XDG_CONFIG_HOME (not the hardcoded
    // `<HOME>/.config` path) — HOME itself stays isolated and empty.
    const emptyHome = mkdtempSync(join(tmpdir(), 'steepy-autopilot-home-'));
    const xdgConfigHome = mkdtempSync(join(tmpdir(), 'steepy-autopilot-xdg-'));
    mkdirSync(join(xdgConfigHome, 'opencode'), { recursive: true });
    writeFileSync(
      join(xdgConfigHome, 'opencode', 'opencode.json'),
      `${JSON.stringify({ model: 'zai-coding-plan/glm-5.3' }, null, 2)}\n`,
    );
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
        HOME: emptyHome,
        XDG_CONFIG_HOME: xdgConfigHome,
      });
      assert.equal(code, 0);
      const expectedModelByPhase = {
        plan: 'zai-coding-plan/glm-5.3',
        implement: 'zai-coding-plan/glm-5.3-highspeed',
        review: 'zai-coding-plan/glm-5.3-highspeed',
      };
      const captures = captureEntries(capturePath);
      assert.deepEqual(captures.map(({ phase }) => phase), ['plan', 'implement', 'review']);
      for (const capture of captures) {
        assert.equal(capture.descriptor.modelSelection, 'applied');
        assert.equal(capture.descriptor.resolvedModel, expectedModelByPhase[capture.phase]);
      }
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — MODEL_ROUTING_DEGRADED — ').length, 0, status);
      const routed = linesWith(status, ' — MODEL_ROUTED — ');
      assert.equal(routed.length, 3, status);
      for (const [index, phase] of ['plan', 'implement', 'review'].entries()) {
        assert.ok(routed[index].includes(`phase=${phase} `), routed[index]);
        assert.ok(
          routed[index].includes(`model-selection=applied model=${expectedModelByPhase[phase]} `),
          routed[index],
        );
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
      rmSync(emptyHome, { recursive: true, force: true });
      rmSync(xdgConfigHome, { recursive: true, force: true });
    }
  });

  it('routes opencode phase tiers from the project-pinned provider model', async () => {
    const run = makeRun({ harness: 'opencode', opencodeModel: 'zai-coding-plan/glm-5.3' });
    // Isolated HOME: the user-global config candidate must not leak into the
    // precedence chain, in either direction (pin or no pin).
    const emptyHome = mkdtempSync(join(tmpdir(), 'steepy-autopilot-home-'));
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
        HOME: emptyHome,
      });
      assert.equal(code, 0);
      // The pin selects the provider table; the phase keeps its own tier:
      // plan is most-capable, implement/review are standard.
      const expectedModelByPhase = {
        plan: 'zai-coding-plan/glm-5.3',
        implement: 'zai-coding-plan/glm-5.3-highspeed',
        review: 'zai-coding-plan/glm-5.3-highspeed',
      };
      const captures = captureEntries(capturePath);
      assert.deepEqual(captures.map(({ phase }) => phase), ['plan', 'implement', 'review']);
      for (const capture of captures) {
        assert.equal(capture.descriptor.modelSelection, 'applied');
        assert.equal(capture.descriptor.resolvedModel, expectedModelByPhase[capture.phase]);
        const flag = capture.descriptor.args.indexOf('--model');
        assert.deepEqual(
          capture.descriptor.args.slice(flag, flag + 2),
          ['--model', expectedModelByPhase[capture.phase]],
        );
        assert.deepEqual(capture.spawnArgs.slice(-2), ['--model', expectedModelByPhase[capture.phase]]);
      }
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — MODEL_ROUTING_DEGRADED — ').length, 0, status);
      const routed = linesWith(status, ' — MODEL_ROUTED — ');
      assert.equal(routed.length, 3, status);
      for (const [index, phase] of ['plan', 'implement', 'review'].entries()) {
        assert.ok(routed[index].includes(`phase=${phase} `), routed[index]);
        assert.ok(
          routed[index].includes(`model-selection=applied model=${expectedModelByPhase[phase]} `),
          routed[index],
        );
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('routes opencode phase tiers from an opencode.jsonc pin written as real JSONC', async () => {
    // opencode accepts `opencode.jsonc` with comments and trailing commas; the
    // conductor's candidate scan must tolerate the same syntax, not skip it.
    const run = makeRun({
      harness: 'opencode',
      opencodeModel: 'zai-coding-plan/glm-5.3',
      opencodeConfig: 'opencode.jsonc',
      opencodeConfigText: '// project pin\n{\n  // provider-pinned model\n  "model": "zai-coding-plan/glm-5.3",\n}\n',
    });
    const emptyHome = mkdtempSync(join(tmpdir(), 'steepy-autopilot-home-'));
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
        HOME: emptyHome,
      });
      assert.equal(code, 0);
      const captures = captureEntries(capturePath);
      assert.deepEqual(captures.map(({ phase }) => phase), ['plan', 'implement', 'review']);
      assert.equal(captures[0].descriptor.resolvedModel, 'zai-coding-plan/glm-5.3');
      assert.equal(captures[1].descriptor.resolvedModel, 'zai-coding-plan/glm-5.3-highspeed');
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — MODEL_ROUTING_DEGRADED — ').length, 0, status);
      const routed = linesWith(status, ' — MODEL_ROUTED — ');
      assert.equal(routed.length, 3, status);
      for (const line of routed) {
        assert.ok(line.includes('model-selection=applied model=zai-coding-plan/glm-5.'), line);
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('keeps the declared opencode degradation when no pin resolves under an isolated HOME', async () => {
    const run = makeRun({ harness: 'opencode' });
    // Isolate XDG_CONFIG_HOME alongside HOME: a developer's real XDG pin must
    // not leak into this degraded-path assertion either.
    const emptyHome = mkdtempSync(join(tmpdir(), 'steepy-autopilot-home-'));
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
        HOME: emptyHome,
        XDG_CONFIG_HOME: join(emptyHome, '.config'),
      });
      assert.equal(code, 0);
      for (const capture of captureEntries(capturePath)) {
        assert.equal(capture.descriptor.modelSelection, 'degraded');
        assert.ok(!capture.descriptor.args.includes('--model'));
        assert.ok(!capture.spawnArgs.includes('--model'));
      }
      const status = statusOf(run);
      const routed = linesWith(status, ' — MODEL_ROUTED — ');
      assert.equal(routed.length, 3, status);
      for (const line of routed) {
        assert.ok(line.includes('model-selection=degraded model=harness-default '), line);
      }
      assert.equal(linesWith(status, ' — MODEL_ROUTING_DEGRADED — ').length, 3, status);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('opencodeProviderModelMappings falls back to the injected homedir when HOME is unset', () => {
    // Hermetic proof of the os.homedir() fallback: a real HOME-unset call
    // would read the real user's home from passwd, which a test must never
    // do, so the seam is exercised directly with an injected function
    // instead of going through process.env.
    const injectedHome = mkdtempSync(join(tmpdir(), 'steepy-autopilot-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'steepy-autopilot-cwd-'));
    try {
      mkdirSync(join(injectedHome, '.config', 'opencode'), { recursive: true });
      writeFileSync(
        join(injectedHome, '.config', 'opencode', 'opencode.json'),
        `${JSON.stringify({ model: 'zai-coding-plan/glm-5.3' }, null, 2)}\n`,
      );
      const result = autopilot.opencodeProviderModelMappings(cwd, {
        env: {},
        homedir: () => injectedHome,
      });
      assert.deepEqual(result, {
        cheap: 'zai-coding-plan/glm-5.3-flash',
        standard: 'zai-coding-plan/glm-5.3-highspeed',
        'most-capable': 'zai-coding-plan/glm-5.3',
      });
    } finally {
      rmSync(injectedHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The conductor verifies that the concrete model really reaches the argv; which
  // flag carries it is adapter policy, so a harness spelling it `-m` or `--model=`
  // must not be mislabelled as degraded.
  const modelFlagSpellings = {
    'a short flag': (args) => args.map((arg) => (arg === '--model' ? '-m' : arg)),
    'an inline flag value': (args, model) => {
      const rewritten = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--model' && args[index + 1] === model) {
          rewritten.push(`--model=${model}`);
          index += 1;
        } else rewritten.push(args[index]);
      }
      return rewritten;
    },
  };

  for (const [label, rewrite] of Object.entries(modelFlagSpellings)) {
    it(`accepts concrete model evidence carried by ${label}`, async () => {
      const run = makeRun();
      const commandFor = (harness, prompt, options) => {
        const descriptor = stubCommandFor(harness, prompt, options);
        if (descriptor === null) return null;
        return { ...descriptor, args: rewrite(descriptor.args, descriptor.resolvedModel) };
      };
      try {
        const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' }, { commandFor });
        assert.equal(code, 0);
        const status = statusOf(run);
        assert.equal(linesWith(status, ' — MODEL_ROUTING_DEGRADED — ').length, 0, status);
        const routed = linesWith(status, ' — MODEL_ROUTED — ');
        assert.equal(routed.length, 3, status);
        for (const line of routed) assert.match(line, /model-selection=applied/);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    });
  }

  it('degrades a descriptor that claims an applied model it never puts on the command line', async () => {
    const run = makeRun();
    const commandFor = (harness, prompt, options) => {
      const descriptor = stubCommandFor(harness, prompt, options);
      if (descriptor === null) return null;
      const args = descriptor.args.filter(
        (arg) => arg !== '--model' && arg !== descriptor.resolvedModel,
      );
      return { ...descriptor, args, modelSelection: 'applied' };
    };
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' }, { commandFor });
      assert.equal(code, 0, 'a false applied claim degrades, it does not halt');
      const degraded = linesWith(statusOf(run), ' — MODEL_ROUTING_DEGRADED — ');
      assert.equal(degraded.length, 3, statusOf(run));
      assert.match(degraded[0], /reason=spawn descriptor claimed applied without a matching concrete model argument/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('derives the aggregate branch diff itself, even when implement never wrote one', async () => {
    const run = makeRun();
    // The run starts clean (the conductor refuses a dirty tree); the implement child
    // is what leaves tracked edits and a new file behind, exactly as it would with
    // commit-auth withheld.
    writeFileSync(join(run.dir, 'tracked.txt'), 'baseline\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: run.dir });
    execFileSync('git', ['commit', '-q', '-m', 'tracked'], { cwd: run.dir });
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_SKIP_BRANCH_DIFF: '1',
        FAKE_HARNESS_WORK_FILES: '1',
      });
      assert.equal(code, 0, 'the review gate must not depend on a child-authored diff');

      const status = statusOf(run);
      const baselines = linesWith(status, ' — BASELINE — ');
      assert.equal(baselines.length, 1, status);
      const commit = baselines[0].match(/commit=([0-9a-f]{7,40})/)?.[1];
      assert.ok(commit, baselines[0]);

      const diff = readFileSync(join(run.taskDir, 'branch-diff.txt'), 'utf8');
      assert.match(diff, new RegExp(`^=== branch diff: ${commit}\\.\\.working tree ===`));
      assert.match(diff, /-baseline\n\+implemented/, 'tracked edits must reach the review input');
      assert.match(
        diff,
        /=== untracked files \(present on disk, no diff above\) ===\nbrand-new\.txt/,
        'a new file with no diff must still be named',
      );
      assert.doesNotMatch(diff, /fake implementation/, 'the conductor output is authoritative');

      const reviewManifest = JSON.parse(readFileSync(
        join(run.taskDir, 'context', 'phase-review-attempt-1.json'), 'utf8',
      ));
      const entry = reviewManifest.required.find(
        (item) => item.path === '.apex/work/tasks/topic/branch-diff.txt',
      );
      assert.ok(entry?.available, 'the generated diff must be a satisfied required input');
      assert.equal(entry.bytes, Buffer.byteLength(diff));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('keeps the original baseline when a halted run is resumed', async () => {
    const run = makeRun();
    try {
      const first = await drive(run, { FAKE_HARNESS_MODE: 'blocked' });
      assert.equal(first.code, 1);
      const firstBaseline = linesWith(statusOf(run), ' — BASELINE — ')[0];
      assert.ok(firstBaseline);

      writeFileSync(join(run.dir, 'later.txt'), 'work committed between runs\n');
      execFileSync('git', ['add', 'later.txt'], { cwd: run.dir });
      execFileSync('git', ['commit', '-q', '-m', 'mid-run work'], { cwd: run.dir });

      await drive(run, { FAKE_HARNESS_MODE: 'done' });
      const baselines = linesWith(statusOf(run), ' — BASELINE — ');
      assert.equal(baselines.length, 1, 'a resume must not re-anchor the baseline');
      assert.equal(baselines[0], firstBaseline);
      assert.match(
        readFileSync(join(run.taskDir, 'branch-diff.txt'), 'utf8'),
        /\+work committed between runs/,
        'the aggregate diff must still span work the earlier run left behind',
      );
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('records an unrouted cross-cutting surface instead of halting the phase', async () => {
    const run = makeRun({ crossCuttingSurfaces: '`scripts`, stable hub docs' });
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 0, 'prose in the cross-cutting list must not halt the run');
      const status = statusOf(run);
      const ignored = linesWith(status, ' — CONTEXT_SURFACE_IGNORED — ');
      assert.equal(ignored.length, 1, status);
      assert.match(ignored[0], /phase=plan/);
      assert.match(ignored[0], /ignored=\["stable hub docs"\]/);
      const planManifest = JSON.parse(readFileSync(
        join(run.taskDir, 'context', 'phase-plan-attempt-1.json'), 'utf8',
      ));
      assert.ok(
        planManifest.required.some((entry) => entry.path === '.apex/standards/scripts.md'),
        'the routed implicated plan standard must remain required',
      );
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts when the owning surface itself has no routing row', async () => {
    const run = makeRun({ owningSurface: 'ghost' });
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 1, 'an unrouted owning surface is a binding error, not prose');
      const status = statusOf(run);
      assert.match(linesWith(status, ' — ARTIFACT_FAILED — ')[0], /implicated surface 'ghost'/);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 0, status);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts before plan spawn when owning-surface metadata is missing', async () => {
    const run = makeRun({ owningSurface: null });
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.match(linesWith(status, ' — ARTIFACT_FAILED — ')[0], /missing Owning surface metadata/i);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 0, status);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('routes all-mechanical implementation cheaply while enforcing the standard review floor', async () => {
    const run = makeRun({ featureComplexity: 'mechanical' });
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    const mechanicalPlan = '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `mechanical`\n- **Success criteria:** SC1\n';
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
        FAKE_HARNESS_PLAN_TEXT: mechanicalPlan,
      });
      assert.equal(code, 0);
      const captures = captureEntries(capturePath);
      assert.deepEqual(captures.map(({ descriptor }) => descriptor.requestedModelTier), [
        'cheap', 'cheap', 'standard',
      ]);
      assert.deepEqual(captures.map(({ descriptor }) => descriptor.resolvedModel), [
        'haiku', 'haiku', 'sonnet',
      ]);
      assert.match(linesWith(statusOf(run), ' — MODEL_ROUTED — ')[2], /reviewer-floor=standard/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('rejects an omitted higher-complexity plan task before review spawn', async () => {
    const run = makeRun({ featureComplexity: 'mechanical' });
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    const plan = '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `mechanical`\n- **Success criteria:** SC1\n\n## Task 2\n\n- **Surface:** `scripts`\n- **Complexity:** `design`\n- **Success criteria:** SC2\n';
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_CAPTURE: capturePath,
        FAKE_HARNESS_PLAN_TEXT: plan,
        FAKE_HARNESS_RESULT_INDEX_TEXT: '# Results\n\n- Task 1: DONE; artifact: .apex/work/tasks/topic/task-1-report.md; changed-paths: none; signals: tdd:red-green\n',
      });
      assert.equal(code, 1);
      const captures = captureEntries(capturePath);
      assert.deepEqual(captures.map(({ descriptor }) => descriptor.requestedModelTier), ['cheap', 'standard']);
      assert.match(linesWith(statusOf(run), ' — ARTIFACT_FAILED — ')[0], /omits plan task ids: 2/i);
      assert.ok(!existsSync(join(run.taskDir, 'context', 'phase-review-attempt-1.json')));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  for (const [label, resultIndex, reason] of [
    ['malformed', '# Results\n\n- Task one DONE\n', /malformed reviewed task entry/i],
    ['incomplete shorthand', '# Results\n\n- Task 1: DONE\n', /malformed reviewed task entry/i],
    ['duplicate', '# Results\n\n- Task 1: DONE; artifact: .apex/work/tasks/topic/task-1-report.md; changed-paths: none; signals: none\n- Task 1: DONE; artifact: .apex/work/tasks/topic/task-1-report.md; changed-paths: none; signals: none\n', /duplicate reviewed task id '1'/i],
    ['unknown', '# Results\n\n- Task 99: DONE; artifact: .apex/work/tasks/topic/task-99-report.md; changed-paths: none; signals: none\n', /unknown reviewed task id '99'/i],
  ]) {
    it(`rejects ${label} reviewed-task index evidence before review spawn`, async () => {
      const run = makeRun();
      try {
        const { code } = await drive(run, {
          FAKE_HARNESS_MODE: 'done',
          FAKE_HARNESS_RESULT_INDEX_TEXT: resultIndex,
        });
        assert.equal(code, 1);
        const status = statusOf(run);
        assert.equal(linesWith(status, ' — SPAWNED — ').length, 2, status);
        assert.match(status, / — ARTIFACT_FAILED — .*phase=review/i);
        assert.match(status, reason);
        assert.ok(!existsSync(join(run.taskDir, 'context', 'phase-review-attempt-1.json')));
        assert.ok(!existsSync(join(run.taskDir, 'phase-3-attempt-1.raw.jsonl')));
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    });
  }

  it('rejects a spec without Feature complexity before dispatch', async () => {
    const run = makeRun({ featureComplexity: null });
    const capturePath = join(run.dir, '.apex', 'work', 'spawn-capture.jsonl');
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_CAPTURE: capturePath });
      assert.equal(code, 1);
      assert.equal(existsSync(capturePath), false);
      assert.match(statusOf(run), /missing Feature complexity/);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  });

  it('rejects malformed task complexity after plan approval and before implement spawn', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_PLAN_TEXT: '# Plan\n\n## Task 1\n\n- **Surface:** `scripts`\n- **Complexity:** `enormous`\n',
      });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 1, status);
      assert.match(status, / — ARTIFACT_FAILED — .*phase=implement.*Task 1 Complexity/i);
      assert.ok(existsSync(join(run.taskDir, 'context', 'phase-plan-attempt-1.json')));
      assert.ok(!existsSync(join(run.taskDir, 'context', 'phase-implement-attempt-1.json')));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('records an artifact failure and halts before spawn for missing or malformed required evidence', async () => {
    const missing = makeRun();
    const malformed = makeRun({ featureComplexity: 'enormous' });
    try {
      mkdirSync(missing.taskDir, { recursive: true });
      writeFileSync(missing.statusFile, protocolLine + '2026-08-10T09:00:00.000Z — CONDUCTOR — RESUMING — prior run\n');
      rmSync(join(missing.dir, '.apex', 'standards', 'scripts.md'));
      const missingResult = await drive(missing, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(missingResult.code, 1);
      assert.equal(linesWith(statusOf(missing), ' — SPAWNED — ').length, 0);
      assert.match(statusOf(missing), / — ARTIFACT_FAILED — .*phase=plan.*required input does not exist/);
      assert.ok(!existsSync(join(missing.taskDir, 'phase-1-attempt-1.raw.jsonl')));

      const malformedResult = await drive(malformed, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(malformedResult.code, 1);
      assert.equal(linesWith(statusOf(malformed), ' — SPAWNED — ').length, 0);
      assert.match(statusOf(malformed), / — ARTIFACT_FAILED — .*Feature complexity/i);
    } finally {
      rmSync(missing.dir, { recursive: true, force: true });
      rmSync(malformed.dir, { recursive: true, force: true });
    }
  });

  it('resumes when unrelated notes and prose mention STATUS_PROTOCOL', async () => {
    const run = makeRun();
    try {
      mkdirSync(run.taskDir, { recursive: true });
      const bytes = protocolLine
        + 'Human note: STATUS_PROTOCOL documentation needs clarification.\n'
        + '2026-09-08T09:00:01.000Z — plan — BLOCKED — STATUS_PROTOCOL documentation needs clarification\n'
        + '2026-09-08T09:00:02.000Z — CONDUCTOR — HALTED — quoted — CONDUCTOR — STATUS_PROTOCOL — version=1\n';
      writeFileSync(run.statusFile, bytes);
      const result = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(result.code, 0, result.err);
      assert.doesNotMatch(result.err, /malformed status protocol/i);
      assert.ok(statusOf(run).startsWith(bytes));
      assert.equal(linesWith(statusOf(run), ' — PHASE_ACCEPTED — ').length, 3);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  });

  for (const [label, bytes] of [
    ['missing', 'unversioned status\n'],
    ['uncorrelated', '2026-08-10T09:00:00.000Z — plan — DONE — old\n'],
    ['duplicate', protocolLine + protocolLine],
    ['unsupported', protocolLine.replace('version=1', 'version=2')],
    ['malformed', protocolLine.replace('version=1', 'version=1 extra=true')],
    ['bad timestamp', protocolLine.replace('2026-08-10T08:00:00.000Z', 'bad-date')],
    ['late', '2026-08-10T07:00:00.000Z — CONDUCTOR — BASELINE — commit=abcdef0\n' + protocolLine],
  ]) {
    it(`refuses ${label} status protocol without changing its bytes`, async () => {
      const run = makeRun();
      try {
        mkdirSync(run.taskDir, { recursive: true });
        writeFileSync(run.statusFile, bytes);
        const result = await drive(run, { FAKE_HARNESS_MODE: 'done' });
        assert.equal(result.code, 1);
        assert.match(result.err, /status protocol/i);
        assert.equal(statusOf(run), bytes);
      } finally { rmSync(run.dir, { recursive: true, force: true }); }
    });
  }

  for (const halted of [false, true]) {
    it(`resumes an unaccepted child marker with halted=${halted} at the next attempt`, async () => {
      const run = makeRun();
      try {
        mkdirSync(run.taskDir, { recursive: true });
        const bytes = acceptedPhase().split('\n').filter((line) => !line.includes('PHASE_ACCEPTED')).join('\n')
          + (halted ? '2026-08-10T09:00:03.000Z — CONDUCTOR — HALTED — child convergence failed\n' : '');
        writeFileSync(run.statusFile, bytes);
        const result = await drive(run, { FAKE_HARNESS_MODE: 'done' });
        assert.equal(result.code, 0);
        assert.ok(statusOf(run).startsWith(bytes));
        assert.match(statusOf(run), / — SPAWNED — .*phase=plan attempt=2 /);
      } finally { rmSync(run.dir, { recursive: true, force: true }); }
    });
  }

  it('resumes: a conductor-accepted phase is not re-spawned', async () => {
    const run = makeRun();
    try {
      mkdirSync(run.taskDir, { recursive: true });
      writeFileSync(run.statusFile, acceptedPhase());
      seedPlanArtifacts(run);
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 0);
      const status = statusOf(run);
      const spawned = linesWith(status, ' — SPAWNED — ');
      assert.equal(spawned.length, 3, `expected historical plus 2 new SPAWNED lines, got:\n${status}`);
      assert.equal(spawned.filter((l) => l.includes('phase=plan')).length, 1, status);
      assert.ok(!existsSync(join(run.taskDir, 'phase-1.log')), 'skipped phase must write no log');
      assert.ok(!existsSync(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl')));
      assert.ok(existsSync(join(run.taskDir, 'phase-2.log')));
      assert.match(status, / — review — READY_FOR_PR — /);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts with the reason when a child writes BLOCKED', async () => {
    const run = makeRun();
    try {
      const { code, err } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'blocked',
        FAKE_HARNESS_BLOCK_NOTE: 'spec needs decomposition',
      });
      assert.equal(code, 1);
      const status = statusOf(run);
      const halted = linesWith(status, ' — HALTED — ');
      assert.equal(halted.length, 1, `expected 1 HALTED line, got:\n${status}`);
      assert.match(halted[0], /BLOCKED/);
      assert.equal(linesWith(status, ' — PHASE_ACCEPTED — ').length, 0);
      assert.match(halted[0], /spec needs decomposition/);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 1, 'implement must not be spawned');
      // The halt reason also reaches stderr: that is what the mother session sees
      // when the background conductor task completes.
      assert.match(err, /HALTED/);
      assert.match(err, /spec needs decomposition/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts when a CONFLICT is recorded mid-run (never auto-overrides)', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_MODE_IMPLEMENT: 'conflict' });
      assert.equal(code, 1);
      const status = statusOf(run);
      const halted = linesWith(status, ' — HALTED — ');
      assert.equal(halted.length, 1);
      assert.match(halted[0], /CONFLICT/);
      assert.doesNotMatch(status, / — PHASE_ACCEPTED — .*phase=implement /);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 2, 'review must not be spawned');
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts on a child exit code ≠ 0, naming the code and the log', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE_PLAN: 'fail' });
      assert.equal(code, 1);
      const halted = linesWith(statusOf(run), ' — HALTED — ');
      assert.equal(halted.length, 1);
      assert.match(halted[0], /exit(ed)? 1/);
      assert.equal(linesWith(statusOf(run), ' — PHASE_ACCEPTED — ').length, 0);
      assert.match(halted[0], /phase-1\.log/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts when a child exits 0 without recording its completion marker', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE_PLAN: 'silent' });
      assert.equal(code, 1);
      const halted = linesWith(statusOf(run), ' — HALTED — ');
      assert.equal(halted.length, 1);
      assert.match(halted[0], /without recording its completion marker/);
      assert.equal(linesWith(statusOf(run), ' — PHASE_ACCEPTED — ').length, 0);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('lets every delayed phase exceed the former short work timeout without signal, kill, TIMEOUT, or HALTED', async () => {
    const run = makeRun();
    const signalCapture = join(run.dir, 'unexpected-signal.txt');
    try {
      const startedAt = Date.now();
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_DELAY_MS: '350',
        FAKE_HARNESS_SIGNAL_CAPTURE: signalCapture,
      });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(code, 0);
      assert.ok(elapsedMs >= 1_050, `three 350ms phase delays completed too quickly: ${elapsedMs}ms`);
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 3, status);
      assert.equal(linesWith(status, ' — TIMEOUT — ').length, 0, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 0, status);
      assert.equal(existsSync(signalCapture), false, 'elapsed work time must not signal a healthy child');
      assert.match(status, / — review — READY_FOR_PR — /);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a raw mid-write failure kills the direct child and stubborn descendant before correlated HALTED', async () => {
    const run = makeRun();
    const postHaltSentinel = join(run.dir, 'write-after-halt.txt');
    let rawWrites = 0;
    let failedChunk = '';
    let childPid = null;
    let subprocessPid = null;
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'stubborn',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_POST_HALT_SENTINEL: postHaltSentinel,
      }, {
        rawWrite: (fd, chunk) => {
          rawWrites += 1;
          if (rawWrites === 3) {
            failedChunk = String(chunk);
            const error = new Error('injected raw disk failure');
            error.code = 'ENOSPC';
            throw error;
          }
          return writeSync(fd, chunk);
        },
      });
      assert.equal(code, 1);
      const raw = rawEntries(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl'))
        .map((entry) => entry.line).join('\n');
      childPid = Number(raw.match(/pid=(\d+)/)?.[1]);
      subprocessPid = Number(failedChunk.match(/subprocess=(\d+)/)?.[1]);
      assert.ok(Number.isInteger(childPid), `missing child pid in raw capture: ${raw}`);
      assert.ok(Number.isInteger(subprocessPid), `missing subprocess pid in failed write: ${failedChunk}`);
      assert.equal(await waitGone(childPid), true, `child ${childPid} survived raw failure`);
      assert.equal(await waitGone(subprocessPid), true, `subprocess ${subprocessPid} survived raw failure`);
      const status = statusOf(run);
      const spawned = linesWith(status, ' — SPAWNED — ');
      const halted = linesWith(status, ' — HALTED — ');
      assert.equal(spawned.length, 1, `no later phase may spawn after raw failure:\n${status}`);
      assert.equal(halted.length, 1, status);
      const runId = spawned[0].match(/run-id=([0-9a-f-]{36})/)?.[1];
      assert.ok(runId, spawned[0]);
      assert.match(halted[0], new RegExp(`run-id=${runId} phase=plan attempt=1`));
      assert.equal(linesWith(status, ' — TIMEOUT — ').length, 0, status);
      assert.match(status, /RAW_WRITE_FAILED/);
      const aggregate = readFileSync(join(run.taskDir, 'phase-1.log'), 'utf8');
      assert.equal((aggregate.match(/=== BEGIN /g) ?? []).length, 1, aggregate);
      assert.equal((aggregate.match(/=== END /g) ?? []).length, 1, aggregate);
      assert.equal(
        existsSync(postHaltSentinel),
        false,
        'a stubborn descendant must not survive long enough to write after HALTED',
      );
    } finally {
      for (const pid of [subprocessPid, childPid]) {
        if (pid && isAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a positive short raw write is blocking: it kills the tree, records one correlated HALTED, and never advances', async () => {
    const run = makeRun();
    const postHaltSentinel = join(run.dir, 'short-write-after-halt.txt');
    let childPid = null;
    let subprocessPid = null;
    let shortChunk = '';
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'stubborn',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_POST_HALT_SENTINEL: postHaltSentinel,
      }, {
        rawWrite: (fd, chunk) => {
          const bytes = Buffer.from(chunk);
          if (String(chunk).includes('subprocess=')) {
            shortChunk = String(chunk);
            const short = Math.max(1, bytes.length - 1);
            writeSync(fd, bytes.subarray(0, short));
            return short;
          }
          return writeSync(fd, chunk);
        },
      });
      assert.equal(code, 1);
      const captured = readFileSync(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl'), 'utf8');
      childPid = Number(captured.match(/pid=(\d+)/)?.[1]);
      subprocessPid = Number(shortChunk.match(/subprocess=(\d+)/)?.[1]);
      assert.ok(Number.isInteger(childPid), captured);
      assert.ok(Number.isInteger(subprocessPid), shortChunk);
      assert.equal(await waitGone(childPid), true, `child ${childPid} survived short raw write`);
      assert.equal(await waitGone(subprocessPid), true, `descendant ${subprocessPid} survived short raw write`);
      const status = statusOf(run);
      const spawned = linesWith(status, ' — SPAWNED — ');
      const halted = linesWith(status, ' — HALTED — ');
      assert.equal(spawned.length, 1, `no later phase may spawn:\n${status}`);
      assert.equal(halted.length, 1, status);
      const runId = spawned[0].match(/run-id=([0-9a-f-]{36})/)?.[1];
      assert.match(halted[0], new RegExp(`run-id=${runId} phase=plan attempt=1`));
      assert.match(halted[0], /RAW_WRITE_FAILED/);
      assert.equal(linesWith(status, ' — plan — DONE — ').length, 0, status);
      assert.equal(existsSync(postHaltSentinel), false, 'no descendant side effect may occur after HALTED');
    } finally {
      for (const pid of [subprocessPid, childPid]) {
        if (pid && isAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a raw-open failure halts before spawn and never starts a later phase', async () => {
    const run = makeRun();
    try {
      mkdirSync(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl'), { recursive: true });
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 0, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
      assert.match(status, /run-id=.*phase=plan attempt=1.*RAW_OPEN_FAILED/);
      assert.ok(!existsSync(join(run.taskDir, 'phase-2-attempt-1.raw.jsonl')));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a raw drain timeout kills the process group and halts without becoming a phase timeout', async () => {
    const run = makeRun();
    const liveStdout = new InjectedLiveDestination();
    const liveStderr = new InjectedLiveDestination();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'sleep', FAKE_HARNESS_STREAM: 'claude',
      }, {
        drainTimeoutMs: 20,
        rawWrite: (fd, chunk) => { writeSync(fd, chunk); return false; },
        liveStdout,
        liveStderr,
      });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.match(status, /RAW_DRAIN_FAILED/);
      assert.equal(linesWith(status, ' — TIMEOUT — ').length, 0, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 1, status);
      assert.equal(linesWith(status, ' — SESSION_IDENTIFIED — ').length, 0, status);
      assert.equal(liveStdout.chunks.length, 0);
      assert.equal(liveStderr.chunks.length, 0);
      assert.equal(readFileSync(join(run.taskDir, 'phase-1-attempt-1.log'), 'utf8'), '');
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a raw error while drain is pending discards deferred effects and keeps the blocking halt path', async () => {
    const run = makeRun();
    const liveStdout = new InjectedLiveDestination();
    const liveStderr = new InjectedLiveDestination();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'sleep', FAKE_HARNESS_STREAM: 'claude',
      }, {
        drainTimeoutMs: 500,
        liveStdout,
        liveStderr,
        rawDestinationFactory: ({ defaultStream }) => {
          const destination = new EventEmitter();
          let failed = false;
          destination.write = (chunk, callback) => {
            const accepted = defaultStream.write(chunk, callback);
            if (!failed) {
              failed = true;
              setImmediate(() => destination.emit('error', new Error('injected raw drain error')));
              return false;
            }
            return accepted;
          };
          destination.close = () => defaultStream.close();
          return destination;
        },
      });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.match(status, /RAW_DRAIN_FAILED/);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 1, status);
      assert.equal(linesWith(status, ' — SESSION_IDENTIFIED — ').length, 0, status);
      assert.equal(liveStdout.chunks.length, 0);
      assert.equal(liveStderr.chunks.length, 0);
      assert.equal(readFileSync(join(run.taskDir, 'phase-1-attempt-1.log'), 'utf8'), '');
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a pending-write bound breach kills the child tree and closes the attempt once', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'sleep', FAKE_HARNESS_STREAM: 'claude',
      }, {
        writerMaxPendingBytes: 1,
        rawDestinationFactory: ({ fd, defaultStream }) => ({
          on() { return this; },
          write(chunk) { writeSync(fd, chunk); return true; },
          close() { defaultStream.close(); },
        }),
      });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.match(status, /RAW_PENDING_WRITE_LIMIT/);
      assert.equal(linesWith(status, ' — TIMEOUT — ').length, 0, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a safe-redaction throw kills the child tree and halts before any later phase', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'sleep', FAKE_HARNESS_STREAM: 'claude',
      }, {
        serializer: () => { throw new Error('injected redaction failure'); },
      });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.match(status, /RAW_REDACTION_FAILED/);
      assert.equal(linesWith(status, ' — TIMEOUT — ').length, 0, status);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 1, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('publishes a phase/session start line before a delayed child exits', async () => {
    const run = makeRun();
    const host = join(here, 'fixtures', 'conductor-host.mjs');
    let output = '';
    try {
      const conductor = spawn(process.execPath, [host, run.specPath, run.dir, STUB], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FAKE_HARNESS_STATUS: run.statusFile,
          FAKE_HARNESS_MODE: 'done',
          FAKE_HARNESS_STREAM: 'claude',
          FAKE_HARNESS_DELAY_MS: '350',
        },
      });
      conductor.stdout.on('data', (chunk) => { output += chunk; });
      conductor.stderr.on('data', (chunk) => { output += chunk; });
      const live = await waitFor(() => /plan .*attempt 1 .*session pending/.test(output));
      assert.equal(live, true, `no immediate live start line: ${output}`);
      assert.equal(isAlive(conductor.pid), true, 'the live line must arrive while the child still runs');
      const exit = await new Promise((resolve) => conductor.on('close', resolve));
      assert.equal(exit, 0, output);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('passes the deterministic display name into the headless descriptor builder', async () => {
    const run = makeRun();
    const calls = [];
    try {
      const { code } = await drive(run, { FAKE_HARNESS_MODE_PLAN: 'fail' }, {
        commandFor: (harness, prompt, options) => {
          calls.push({ harness, prompt, options });
          return stubCommandFor(harness, prompt, options);
        },
      });
      assert.equal(code, 1);
      assert.equal(calls.length, 1);
      assert.match(calls[0].options.displayName, /^steepy-topic-plan-a1-[0-9a-f]{8}$/);
      const promptRunId = calls[0].prompt.match(/run-id `([^`]+)`/)?.[1];
      assert.equal(promptRunId?.slice(0, 8), calls[0].options.displayName.slice(-8));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('binds session identity from selectable Claude, Codex, and OpenCode fixture streams', async () => {
    for (const harness of ['claude', 'codex', 'opencode']) {
      const run = makeRun({ harness });
      try {
        const { code, out } = await drive(run, {
          FAKE_HARNESS_MODE_PLAN: 'fail',
          FAKE_HARNESS_STREAM: harness,
          ...(harness === 'codex' ? { FAKE_HARNESS_MULTIPLE: '1' } : {}),
        });
        assert.equal(code, 1);
        const identified = linesWith(statusOf(run), ' — SESSION_IDENTIFIED — ');
        assert.equal(identified.length, 1, `${harness}: ${statusOf(run)}`);
        assert.match(identified[0], new RegExp(`session-id=${harness}-plan-session`));
        const expectedIdentity = 'yes';
        const expectedOpenResume = harness === 'claude' ? 'unproven' : 'yes';
        assert.match(identified[0], new RegExp(`native-session-identity=${expectedIdentity}`));
        assert.match(identified[0], new RegExp(`native-open-resume=${expectedOpenResume}`));
        if (expectedOpenResume === 'unproven') {
          assert.match(identified[0], /qualification=.*open-hint=.*resume-hint=/);
          assert.match(out, /native open\/resume unproven.*open hint:.*resume hint:/i);
          assert.doesNotMatch(out, /native open\/resume supported/i);
        } else {
          assert.match(identified[0], /qualification=.*open=.*resume=/);
          assert.doesNotMatch(identified[0], /open-hint|resume-hint/);
          assert.match(out, /native open\/resume supported.*open:.*resume:/i);
        }
        assert.match(readFileSync(join(run.taskDir, 'phase-1-attempt-1.log'), 'utf8'), /fake plan message/);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    }
  });

  it('routes decoded stderr live events through the bounded stderr destination with source identity', async () => {
    const run = makeRun();
    const liveStdout = new InjectedLiveDestination();
    const liveStderr = new InjectedLiveDestination();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'fail',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_STDERR: '1',
      }, { liveStdout, liveStderr });
      assert.equal(code, 1);
      assert.match(liveStderr.chunks.join(''), /\[stderr\].*fake plan message/);
      assert.doesNotMatch(liveStdout.chunks.join(''), /fake plan message/);
      assert.match(readFileSync(join(run.taskDir, 'phase-1-attempt-1.log'), 'utf8'), /\[stderr\].*fake plan message/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('honors live backpressure and resumes after drain without degrading the phase', async () => {
    const run = makeRun();
    const liveStdout = new InjectedLiveDestination({ results: [false], autoDrain: true });
    const liveStderr = new InjectedLiveDestination();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude',
      }, { liveStdout, liveStderr, drainTimeoutMs: 100 });
      assert.equal(code, 0, statusOf(run));
      assert.match(liveStdout.chunks.join(''), /\[stdout\].*session.started/);
      assert.doesNotMatch(statusOf(run), /liveStdout-(?:write|drain)-error/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('defers raw-accepted line effects until drain, then replays them once in order before resuming framed input', async () => {
    const run = makeRun();
    const liveStdout = new InjectedLiveDestination();
    const liveStderr = new InjectedLiveDestination();
    let injected = false;
    let beforeDrain = null;
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_MULTIPLE: '1',
      }, {
        liveStdout,
        liveStderr,
        drainTimeoutMs: 1_000,
        commandFor: (harness, prompt, options) => {
          const descriptor = stubCommandFor(harness, prompt, options);
          return {
            ...descriptor,
            capabilities: Object.fromEntries(
              Object.keys(descriptor.capabilities).map((capability) => [capability, 'yes']),
            ),
          };
        },
        rawDestinationFactory: ({ path, defaultStream }) => {
          const destination = new EventEmitter();
          destination.write = (chunk, callback) => {
            const accepted = defaultStream.write(chunk, callback);
            if (injected) return accepted;
            injected = true;
            setTimeout(() => {
              beforeDrain = {
                raw: readFileSync(path, 'utf8'),
                readable: readFileSync(join(run.taskDir, 'phase-1-attempt-1.log'), 'utf8'),
                live: liveStdout.chunks.join(''),
                status: statusOf(run),
              };
              destination.emit('drain');
            }, 100);
            return false;
          };
          destination.close = () => defaultStream.close();
          return destination;
        },
      });

      assert.equal(code, 0, statusOf(run));
      assert.ok(beforeDrain, 'raw drain checkpoint was not observed');
      assert.match(beforeDrain.raw, /session\.started|system/);
      assert.equal(beforeDrain.raw.trim().split('\n').length, 1, 'only the accepted lifecycle raw line may precede drain');
      assert.doesNotMatch(beforeDrain.raw, /fake plan message/);
      assert.equal(beforeDrain.readable, '', 'readable effect must wait for required raw drain');
      assert.equal(beforeDrain.live, '', 'live effect must wait for required raw drain');
      assert.equal(linesWith(beforeDrain.status, ' — SESSION_IDENTIFIED — ').length, 0);
      assert.equal(linesWith(beforeDrain.status, ' — SPAWNED — ').length, 1, beforeDrain.status);
      assert.equal(linesWith(beforeDrain.status, ' — DONE — ').length, 1, beforeDrain.status);
      assert.equal(linesWith(beforeDrain.status, ' — PHASE_ACCEPTED — ').length, 0, 'child evidence cannot advance before ingestion finishes');

      const raw = rawEntries(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl'));
      assert.equal(raw.length, 2, 'the same-chunk session and message raw lines are each persisted once');
      assert.equal(raw.filter((entry) => JSON.parse(entry.line).type === 'system').length, 1);
      assert.equal(raw.filter((entry) => JSON.parse(entry.line).type === 'assistant').length, 1);
      const readable = readFileSync(join(run.taskDir, 'phase-1-attempt-1.log'), 'utf8');
      assert.equal((readable.match(/session\.started/g) ?? []).length, 1);
      assert.equal((readable.match(/fake plan message/g) ?? []).length, 1);
      assert.ok(
        readable.indexOf('session.started') < readable.indexOf('fake plan message'),
        `deferred lifecycle must precede the already-framed message:\n${readable}`,
      );
      const live = liveStdout.chunks.join('');
      assert.equal((live.match(/session\.started/g) ?? []).length, 3, 'one session start per phase');
      assert.equal((live.match(/session claude-plan-session · session\.started/g) ?? []).length, 1);
      assert.equal((live.match(/fake plan message/g) ?? []).length, 1);
      assert.ok(live.indexOf('session.started') < live.indexOf('fake plan message'), live);
      const identified = linesWith(statusOf(run), ' — SESSION_IDENTIFIED — ');
      assert.equal(identified.length, 3);
      assert.equal(identified.filter((line) => line.includes('session-id=claude-plan-session')).length, 1);
      assert.equal(linesWith(statusOf(run), ' — OBSERVABILITY_DEGRADED — ').length, 0, statusOf(run));
      assert.equal(linesWith(statusOf(run), ' — HALTED — ').length, 0, statusOf(run));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('defers usage-ledger and telemetry-status side effects until the completion raw line drains', async () => {
    const run = makeRun();
    let blockedCompletion = false;
    let beforeDrain = null;
    const rawTypes = [];
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'fail',
        FAKE_HARNESS_STREAM: 'claude',
        FAKE_HARNESS_TELEMETRY: 'phase',
      }, {
        drainTimeoutMs: 1_000,
        rawDestinationFactory: ({ defaultStream }) => {
          const destination = new EventEmitter();
          destination.write = (chunk, callback) => {
            const accepted = defaultStream.write(chunk, callback);
            let source = null;
            try {
              source = JSON.parse(JSON.parse(String(chunk)).line);
            } catch {
              return accepted;
            }
            rawTypes.push(source.type);
            if (blockedCompletion || source.type !== 'result') return accepted;
            blockedCompletion = true;
            beforeDrain = {
              ledgerExists: existsSync(join(run.taskDir, 'resource-usage.jsonl')),
              telemetryStatus: linesWith(statusOf(run), ' — USAGE_TELEMETRY_DEGRADED — '),
            };
            setTimeout(() => {
              destination.emit('drain');
            }, 100);
            return false;
          };
          destination.close = () => defaultStream.close();
          return destination;
        },
      });

      assert.equal(code, 1, 'the fixture phase still exits non-zero after the drained completion');
      assert.ok(beforeDrain, `completion drain checkpoint was not observed; raw types: ${rawTypes.join(', ')}`);
      assert.equal(beforeDrain.ledgerExists, false);
      assert.deepEqual(beforeDrain.telemetryStatus, []);
      assert.ok(
        existsSync(join(run.taskDir, 'resource-usage.jsonl')),
        `usage ledger was not produced after drain:\n${statusOf(run)}`,
      );
      assert.equal(usageEntries(run).length, 1);
      assert.equal(linesWith(statusOf(run), ' — USAGE_TELEMETRY_DEGRADED — ').length, 1);
      assert.match(statusOf(run), /capability=actorAttribution/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  for (const [label, destination, reason] of [
    ['write error', new InjectedLiveDestination({ throwOnWrite: new Error('closed terminal') }), 'liveStdout-write-error'],
    ['drain timeout', new InjectedLiveDestination({ results: [false] }), 'liveStdout-drain-error'],
  ]) {
    it(`degrades once on live ${label} without fabricating child failure`, async () => {
      const run = makeRun();
      try {
        const { code } = await drive(run, {
          FAKE_HARNESS_MODE: 'done',
          FAKE_HARNESS_STREAM: 'claude',
          ...(label === 'drain timeout' ? { FAKE_HARNESS_DELAY_MS: '100' } : {}),
        }, {
          liveStdout: destination,
          liveStderr: new InjectedLiveDestination(),
          drainTimeoutMs: 20,
        });
        assert.equal(code, 0, statusOf(run));
        assert.equal(linesWith(statusOf(run), `reason=${reason}`).length, 1, statusOf(run));
        assert.equal(linesWith(statusOf(run), ' — HALTED — ').length, 0, statusOf(run));
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    });
  }

  it('never emits child live output or session binding for a line whose required raw write fails', async () => {
    const run = makeRun();
    const liveStdout = new InjectedLiveDestination();
    const liveStderr = new InjectedLiveDestination();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'sleep', FAKE_HARNESS_STREAM: 'claude',
      }, {
        liveStdout,
        liveStderr,
        rawWrite: () => { throw new Error('injected first raw failure'); },
      });
      assert.equal(code, 1);
      assert.equal(liveStdout.chunks.length, 0);
      assert.equal(liveStderr.chunks.length, 0);
      assert.equal(linesWith(statusOf(run), ' — SESSION_IDENTIFIED — ').length, 0, statusOf(run));
      assert.match(statusOf(run), /RAW_WRITE_FAILED/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('defaults contracts to safe raw capture and exact mode announces itself before SPAWNED', async () => {
    const secret = 'sk-task3-secret-value';
    const safeRun = makeRun();
    const exactRun = makeRun({ logMode: 'exact' });
    try {
      const safe = await drive(safeRun, {
        FAKE_HARNESS_MODE_PLAN: 'fail', FAKE_HARNESS_STREAM: 'claude', FAKE_HARNESS_SECRET: secret,
      });
      assert.equal(safe.code, 1);
      assert.doesNotMatch(readFileSync(join(safeRun.taskDir, 'phase-1-attempt-1.raw.jsonl'), 'utf8'), new RegExp(secret));
      assert.doesNotMatch(statusOf(safeRun), /EXACT_LOGGING/);

      const exact = await drive(exactRun, {
        FAKE_HARNESS_MODE_PLAN: 'fail', FAKE_HARNESS_STREAM: 'claude', FAKE_HARNESS_SECRET: secret,
      });
      assert.equal(exact.code, 1);
      assert.match(readFileSync(join(exactRun.taskDir, 'phase-1-attempt-1.raw.jsonl'), 'utf8'), new RegExp(secret));
      const exactLine = linesWith(statusOf(exactRun), ' — EXACT_LOGGING — ')[0];
      const spawnedLine = linesWith(statusOf(exactRun), ' — SPAWNED — ')[0];
      assert.ok(exactLine && spawnedLine);
      assert.ok(statusOf(exactRun).indexOf(exactLine) < statusOf(exactRun).indexOf(spawnedLine));
      assert.match(exact.out, /EXACT_LOGGING/);
    } finally {
      rmSync(safeRun.dir, { recursive: true, force: true });
      rmSync(exactRun.dir, { recursive: true, force: true });
    }
  });

  it('resume allocates attempt 2 from status and preserves immutable attempt 1 evidence', async () => {
    const run = makeRun();
    try {
      const first = await drive(run, { FAKE_HARNESS_MODE_PLAN: 'fail', FAKE_HARNESS_STREAM: 'claude' });
      assert.equal(first.code, 1);
      const attempt1Raw = join(run.taskDir, 'phase-1-attempt-1.raw.jsonl');
      const attempt1Readable = join(run.taskDir, 'phase-1-attempt-1.log');
      const beforeRaw = readFileSync(attempt1Raw, 'utf8');
      const beforeReadable = readFileSync(attempt1Readable, 'utf8');
      const attempt1Manifest = join(run.taskDir, 'context', 'phase-plan-attempt-1.json');
      const beforeManifest = readFileSync(attempt1Manifest, 'utf8');

      const resumed = await drive(run, { FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude' });
      assert.equal(resumed.code, 0);
      assert.equal(readFileSync(attempt1Raw, 'utf8'), beforeRaw);
      assert.equal(readFileSync(attempt1Readable, 'utf8'), beforeReadable);
      assert.equal(readFileSync(attempt1Manifest, 'utf8'), beforeManifest);
      assert.ok(existsSync(join(run.taskDir, 'context', 'phase-plan-attempt-2.json')));
      assert.ok(existsSync(join(run.taskDir, 'phase-1-attempt-2.raw.jsonl')));
      assert.ok(existsSync(join(run.taskDir, 'phase-1-attempt-2.log')));
      const planSpawns = linesWith(statusOf(run), ' — SPAWNED — ').filter((line) => /phase=plan/.test(line));
      assert.equal(planSpawns.length, 2);
      assert.match(planSpawns[0], /attempt=1/);
      assert.match(planSpawns[1], /attempt=2/);
      assert.notEqual(planSpawns[0].match(/run-id=([0-9a-f-]+)/)[1], planSpawns[1].match(/run-id=([0-9a-f-]+)/)[1]);
      const aggregate = readFileSync(join(run.taskDir, 'phase-1.log'), 'utf8');
      assert.match(aggregate, /BEGIN.*attempt=1/);
      assert.match(aggregate, /BEGIN.*attempt=2/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('resume distrusts a completion marker after a gap: implement DONE without plan DONE re-runs both', async () => {
    const run = makeRun();
    try {
      mkdirSync(run.taskDir, { recursive: true });
      writeFileSync(run.statusFile, protocolLine + '2026-08-10T09:00:00.000Z — implement — DONE — from an earlier run\n');
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 0);
      const status = statusOf(run);
      const spawned = linesWith(status, ' — SPAWNED — ');
      assert.equal(spawned.length, 3, `only the longest completed prefix may be skipped, got:\n${status}`);
      assert.match(spawned[0], /plan/);
      assert.match(spawned[1], /implement/);
      assert.match(spawned[2], /review/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('refuses a fresh run on a dirty working tree, before creating any run artifact', async () => {
    const run = makeRun();
    try {
      writeFileSync(join(run.dir, 'stray.txt'), 'pre-existing uncommitted work\n');
      const { code, err } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 1);
      assert.match(err, /uncommitted changes/);
      assert.match(err, /stray\.txt/);
      assert.ok(!existsSync(run.taskDir), 'a preflight-refused run creates no run directory');
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('a resume accepts a dirty tree — a halted child legitimately leaves work in progress', async () => {
    const run = makeRun();
    try {
      mkdirSync(run.taskDir, { recursive: true });
      writeFileSync(run.statusFile, acceptedPhase());
      seedPlanArtifacts(run);
      writeFileSync(join(run.dir, 'in-progress.txt'), 'left behind by the halted child\n');
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 0);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts, without an escaping exception, when the child command cannot be spawned', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {}, {
        commandFor: () => ({ cmd: '/definitely/not/a/binary', args: [] }),
      });
      assert.equal(code, 1);
      const halted = linesWith(statusOf(run), ' — HALTED — ');
      assert.equal(halted.length, 1, `expected 1 HALTED line, got:\n${statusOf(run)}`);
      assert.match(halted[0], /\/definitely\/not\/a\/binary/);
      // Node emits both 'error' and 'close' for a failed spawn: let the second
      // event land, so a double-teardown crash surfaces inside this test.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('does not let a phase forge a later phase\'s completion marker mid-run', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_FORGE_PLAN: 'review:READY_FOR_PR',
      });
      assert.equal(code, 0);
      const status = statusOf(run);
      assert.equal(
        linesWith(status, ' — SPAWNED — ').length,
        3,
        `review must still be spawned despite the forged marker:\n${status}`,
      );
      assert.ok(existsSync(join(run.taskDir, 'phase-3.log')), 'review must really run');
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('does not trust a run-1 forged later-phase completion when run 2 resumes', async () => {
    const run = makeRun();
    try {
      const first = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_MODE_REVIEW: 'silent',
        FAKE_HARNESS_FORGE_PLAN: 'review:READY_FOR_PR',
      });
      assert.equal(first.code, 1);
      assert.equal(
        linesWith(statusOf(run), ' — SPAWNED — ').filter((line) => /phase=review/.test(line)).length,
        1,
      );

      const resumed = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(resumed.code, 0);
      const reviewSpawns = linesWith(statusOf(run), ' — SPAWNED — ')
        .filter((line) => /phase=review/.test(line));
      assert.equal(reviewSpawns.length, 2, `review must run again on resume:\n${statusOf(run)}`);
      assert.match(reviewSpawns[0], /attempt=1/);
      assert.match(reviewSpawns[1], /attempt=2/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('re-checks the branch guard before every phase, halting if the branch moved mid-run', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done',
        FAKE_HARNESS_SWITCH_BRANCH: 'sneaky-branch',
      });
      assert.equal(code, 1);
      const status = statusOf(run);
      assert.match(status, / — plan — DONE — /);
      assert.equal(linesWith(status, ' — SPAWNED — ').length, 1, 'implement must not be spawned');
      const halted = linesWith(status, ' — HALTED — ');
      assert.equal(halted.length, 1);
      assert.match(halted[0], /sneaky-branch/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('halts when the harness has no headless command', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {}, { commandFor: () => null });
      assert.equal(code, 1);
      const halted = linesWith(statusOf(run), ' — HALTED — ');
      assert.equal(halted.length, 1);
      assert.match(halted[0], /headless command/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('degrades and continues when the aggregate phase log cannot be opened', async () => {
    const run = makeRun();
    try {
      // A directory where the aggregate file belongs makes openSync fail; raw,
      // readable-attempt, and live output remain enough to complete the run.
      mkdirSync(join(run.taskDir, 'phase-1.log'), { recursive: true });
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
      assert.equal(code, 0);
      assert.match(statusOf(run), / — OBSERVABILITY_DEGRADED — .*aggregate-open-error/);
      assert.ok(existsSync(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl')));
      assert.ok(existsSync(join(run.taskDir, 'phase-1-attempt-1.log')));
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('degrades and continues when the immutable readable attempt log cannot be opened', async () => {
    const run = makeRun();
    try {
      mkdirSync(join(run.taskDir, 'phase-1-attempt-1.log'), { recursive: true });
      const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude' });
      assert.equal(code, 0);
      assert.match(statusOf(run), / — OBSERVABILITY_DEGRADED — .*readable-open-error/);
      assert.ok(existsSync(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl')));
      assert.match(readFileSync(join(run.taskDir, 'phase-1.log'), 'utf8'), /fake plan message/);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('decoder and renderer failures degrade once per reason without fabricating phase failure', async () => {
    for (const [label, opts, expectedReason] of [
      ['decoder', { decoder: () => { throw new Error('injected decoder failure'); } }, 'decoder-error'],
      ['renderer', { renderer: () => { throw new Error('injected renderer failure'); } }, 'renderer-error'],
    ]) {
      const run = makeRun();
      try {
        const { code } = await drive(run, {
          FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude',
        }, opts);
        assert.equal(code, 0, `${label} degradation must not fail a successful phase`);
        const status = statusOf(run);
        assert.equal(linesWith(status, `reason=${expectedReason}`).length, 1, status);
        assert.equal(linesWith(status, ' — HALTED — ').length, 0, status);
        assert.match(status, / — review — READY_FOR_PR — /);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    }
  });

  it('a native-stop integration failure degrades once and the successful chain continues', async () => {
    const run = makeRun();
    try {
      const { code } = await drive(run, {
        FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude',
      }, {
        registerNativeStop: () => { throw new Error('native manager unavailable'); },
      });
      assert.equal(code, 0);
      const status = statusOf(run);
      assert.equal(linesWith(status, 'capability=nativeStop reason=native-stop-error').length, 1, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 0, status);
      assert.match(status, / — review — READY_FOR_PR — /);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('declares each unavailable or unproven harness capability once per run', async () => {
    const run = makeRun({ harness: 'claude' });
    try {
      const { code, err } = await drive(run, {
        FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude',
      });
      assert.equal(code, 0);
      const status = statusOf(run);
      for (const [capability, state] of [
        ['parentLink', 'unavailable'], ['nativeStop', 'unavailable'],
      ]) {
        const needle = `capability=${capability} reason=declared-${state}`;
        assert.equal(linesWith(status, needle).length, 1, `${needle}:\n${status}`);
        assert.equal(linesWith(err, needle).length, 1, `${needle}:\n${err}`);
      }
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('preserves malformed/unknown lines raw, deduplicates degradation, and never renders reasoning', async () => {
    const run = makeRun({ logMode: 'exact' });
    try {
      const { code, out, err } = await drive(run, {
        FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_STREAM: 'claude', FAKE_HARNESS_EDGE_EVENTS: '1',
      });
      assert.equal(code, 0);
      const status = statusOf(run);
      assert.equal(linesWith(status, 'capability=decoder reason=unknown-event').length, 1, status);
      assert.equal(linesWith(status, 'capability=decoder reason=invalid-json').length, 1, status);
      const raw = readFileSync(join(run.taskDir, 'phase-1-attempt-1.raw.jsonl'), 'utf8');
      assert.match(raw, /future\.event/);
      assert.match(raw, /private-thought-malformed/);
      assert.match(raw, /task_started/);
      assert.match(raw, /task_progress/);
      assert.match(raw, /task_notification/);
      const readable = readFileSync(join(run.taskDir, 'phase-1-attempt-1.log'), 'utf8');
      assert.match(readable, /subagent edge-worker · agent\.started/);
      assert.match(readable, /subagent edge-worker · agent\.completed/);
      assert.match(out, /subagent edge-worker · agent\.started/);
      assert.match(out, /subagent edge-worker · agent\.completed/);
      assert.doesNotMatch(readable, /task_progress/);
      assert.doesNotMatch(`${out}\n${err}\n${readable}`, /private-thought|reasoning/i);
      assert.equal(linesWith(status, ' — HALTED — ').length, 0, status);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('forwards SIGINT to the running child instead of orphaning it', async () => {
    const run = makeRun();
    const host = join(here, 'fixtures', 'conductor-host.mjs');
    let childPid = null;
    let subprocessPid = null;
    try {
      // Own process group, so the test can Ctrl-C the conductor exactly as a
      // terminal would — without signalling the test runner itself.
      const conductor = spawn(process.execPath, [host, run.specPath, run.dir, STUB], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, FAKE_HARNESS_STATUS: run.statusFile, FAKE_HARNESS_MODE_PLAN: 'sleep' },
      });
      const exited = new Promise((resolve) => conductor.on('close', resolve));

      const logPath = join(run.taskDir, 'phase-1-attempt-1.raw.jsonl');
      const started = await waitFor(() => {
        if (!existsSync(logPath)) return false;
        const log = rawEntries(logPath).map((entry) => entry.line).join('\n');
        return /pid=\d+/.test(log) && /subprocess=\d+/.test(log);
      });
      assert.equal(started, true, 'the phase-1 child never reported its pids');
      const log = rawEntries(logPath).map((entry) => entry.line).join('\n');
      childPid = Number(log.match(/pid=(\d+)/)[1]);
      subprocessPid = Number(log.match(/subprocess=(\d+)/)[1]);

      process.kill(-conductor.pid, 'SIGINT');
      await exited;

      assert.equal(await waitGone(childPid), true, `child ${childPid} was orphaned by SIGINT`);
      assert.equal(await waitGone(subprocessPid), true, `subprocess ${subprocessPid} was orphaned by SIGINT`);
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — INTERRUPTED — ').length, 1, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
      assert.ok(status.indexOf(' — INTERRUPTED — ') < status.indexOf(' — HALTED — '), status);
      assert.match(status, / — INTERRUPTED — .*SIGINT/, 'the interruption must be recorded');
    } finally {
      for (const pid of [subprocessPid, childPid]) {
        if (pid && isAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  for (const signal of ['SIGTERM', 'SIGHUP']) {
    it(`records ${signal} as INTERRUPTED before HALTED and kills the child tree`, async () => {
      const run = makeRun();
      const host = join(here, 'fixtures', 'conductor-host.mjs');
      let childPid = null;
      let subprocessPid = null;
      try {
        const conductor = spawn(process.execPath, [host, run.specPath, run.dir, STUB], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, FAKE_HARNESS_STATUS: run.statusFile, FAKE_HARNESS_MODE_PLAN: 'sleep' },
        });
        const exited = new Promise((resolve) => conductor.on('close', resolve));
        const logPath = join(run.taskDir, 'phase-1-attempt-1.raw.jsonl');
        assert.equal(await waitFor(() => {
          if (!existsSync(logPath)) return false;
          const log = rawEntries(logPath).map((entry) => entry.line).join('\n');
          return /pid=\d+/.test(log) && /subprocess=\d+/.test(log);
        }), true);
        const log = rawEntries(logPath).map((entry) => entry.line).join('\n');
        childPid = Number(log.match(/pid=(\d+)/)[1]);
        subprocessPid = Number(log.match(/subprocess=(\d+)/)[1]);

        process.kill(-conductor.pid, signal);
        await exited;
        assert.equal(await waitGone(childPid), true);
        assert.equal(await waitGone(subprocessPid), true);
        const status = statusOf(run);
        assert.equal(linesWith(status, ' — INTERRUPTED — ').length, 1, status);
        assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
        assert.ok(status.indexOf(' — INTERRUPTED — ') < status.indexOf(' — HALTED — '), status);
        assert.match(status, new RegExp(` — INTERRUPTED — .*${signal}`));
      } finally {
        for (const pid of [subprocessPid, childPid]) {
          if (pid && isAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          }
        }
        rmSync(run.dir, { recursive: true, force: true });
      }
    });
  }

  it('simulated native stop converges on INTERRUPTED → HALTED and the same kill-tree path', async () => {
    const run = makeRun();
    let nativeStop;
    let childPid = null;
    let subprocessPid = null;
    try {
      const driving = drive(run, {
        FAKE_HARNESS_MODE_PLAN: 'sleep', FAKE_HARNESS_STREAM: 'claude',
      }, {
        registerNativeStop: ({ stop }) => { nativeStop = stop; },
      });
      const logPath = join(run.taskDir, 'phase-1-attempt-1.raw.jsonl');
      const ready = await waitFor(() => typeof nativeStop === 'function' && existsSync(logPath), 250);
      if (ready) {
        const hasPids = await waitFor(() => {
          const log = rawEntries(logPath).map((entry) => entry.line).join('\n');
          return /pid=\d+/.test(log) && /subprocess=\d+/.test(log);
        }, 250);
        if (hasPids) {
          const log = rawEntries(logPath).map((entry) => entry.line).join('\n');
          childPid = Number(log.match(/pid=(\d+)/)[1]);
          subprocessPid = Number(log.match(/subprocess=(\d+)/)[1]);
        }
        nativeStop();
      }
      const { code } = await driving;
      assert.equal(ready, true, 'native stop callback was not registered');
      assert.equal(code, 1);
      if (childPid) assert.equal(await waitGone(childPid), true);
      if (subprocessPid) assert.equal(await waitGone(subprocessPid), true);
      const status = statusOf(run);
      assert.equal(linesWith(status, ' — INTERRUPTED — ').length, 1, status);
      assert.equal(linesWith(status, ' — HALTED — ').length, 1, status);
      assert.ok(status.indexOf(' — INTERRUPTED — ') < status.indexOf(' — HALTED — '), status);
      assert.match(status, /native-stop/);
    } finally {
      for (const pid of [subprocessPid, childPid]) {
        if (pid && isAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  describe('checkout generation lease', () => {
    const lockOf = (run) => join(run.dir, '.apex/work/.gear-3-autopilot.lock');
    const ownerOf = (run) => join(lockOf(run), 'owner.json');
    const seed = (run, record = { schemaVersion: 1, pid: process.pid, token: 'dead-generation' }) => {
      mkdirSync(lockOf(run));
      writeFileSync(ownerOf(run), JSON.stringify(record));
      return readFileSync(ownerOf(run), 'utf8');
    };
    const deadProbe = () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); };

    for (const variant of ['live', 'EPERM', 'EIO', 'malformed', 'shape', 'symlink', 'multilink', 'fifo', 'non-directory', 'quarantine']) {
      it(`refuses ${variant} generation without status mutation or cleanup`, async () => {
        const run = makeRun();
        try {
          seed(run);
          let processProbe;
          if (['EPERM', 'EIO'].includes(variant)) processProbe = () => { throw Object.assign(new Error('probe'), { code: variant }); };
          if (variant === 'malformed') writeFileSync(ownerOf(run), '{');
          if (variant === 'shape') writeFileSync(ownerOf(run), JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'dead-generation', extra: true }));
          if (variant === 'symlink') {
            renameSync(ownerOf(run), join(run.dir, '.apex/work/sentinel'));
            symlinkSync('../sentinel', ownerOf(run));
          }
          if (variant === 'multilink') linkSync(ownerOf(run), join(run.dir, '.apex/work/sentinel'));
          if (variant === 'fifo') {
            rmSync(ownerOf(run));
            execFileSync('mkfifo', [ownerOf(run)]);
          }
          if (variant === 'non-directory') {
            rmSync(lockOf(run), { recursive: true });
            writeFileSync(lockOf(run), 'sentinel');
          }
          if (variant === 'quarantine') {
            mkdirSync(`${lockOf(run)}.stale-dead-generation`);
            processProbe = deadProbe;
          }
          const identity = statSync(lockOf(run)).ino;
          const result = await drive(run, { FAKE_HARNESS_MODE: 'done' }, { processProbe });
          assert.equal(result.code, 1);
          assert.equal(statSync(lockOf(run)).ino, identity);
          assert.equal(statusOf(run), '');
          assert.ok(!existsSync(run.taskDir));
        } finally { rmSync(run.dir, { recursive: true, force: true }); }
      });
    }

    for (const change of ['branch', 'dirty', 'directory', 'owner']) {
      it(`rechecks ${change} under the lease or before stale retirement`, async () => {
        const run = makeRun();
        try {
          if (['directory', 'owner'].includes(change)) seed(run);
          const result = await drive(run, { FAKE_HARNESS_MODE: 'done' }, {
            processProbe: deadProbe,
            lockTransition(stage) {
              if (stage === 'acquired' && change === 'branch') execFileSync('git', ['checkout', '-q', '-b', 'changed'], { cwd: run.dir });
              if (stage === 'acquired' && change === 'dirty') writeFileSync(join(run.dir, 'dirty.txt'), 'dirty');
              if (stage !== 'stale-observed') return;
              if (change === 'directory') {
                renameSync(lockOf(run), `${lockOf(run)}.saved`);
                seed(run);
              }
              if (change === 'owner') {
                renameSync(ownerOf(run), join(lockOf(run), 'saved.json'));
                writeFileSync(ownerOf(run), JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'dead-generation' }));
              }
            },
          });
          assert.equal(result.code, 1);
          assert.equal(statusOf(run), '');
          assert.ok(!existsSync(run.taskDir));
        } finally { rmSync(run.dir, { recursive: true, force: true }); }
      });
    }

    it('retains a dead generation quarantine and records correlated recovery', async () => {
      const run = makeRun();
      try {
        const bytes = seed(run);
        const result = await drive(run, { FAKE_HARNESS_MODE: 'done' }, { processProbe: deadProbe });
        assert.equal(result.code, 0);
        assert.equal(readFileSync(`${lockOf(run)}.stale-dead-generation/owner.json`, 'utf8'), bytes);
        assert.match(statusOf(run), /LOCK_RECOVERED.*run-id=.*quarantine=\.apex\/work\/\.gear-3-autopilot\.lock\.stale-dead-generation.*pid=/);
        assert.ok(!existsSync(lockOf(run)));
      } finally { rmSync(run.dir, { recursive: true, force: true }); }
    });

    it('ignores unrelated per-spec pidfiles and releases on halt', async () => {
      const run = makeRun();
      try {
        mkdirSync(run.taskDir, { recursive: true });
        const unrelated = join(run.taskDir, 'autopilot.lock');
        writeFileSync(unrelated, String(process.pid));
        const result = await drive(run, { FAKE_HARNESS_MODE_PLAN: 'blocked' });
        assert.equal(result.code, 1);
        assert.match(statusOf(run), /HALTED/);
        assert.equal(readFileSync(unrelated, 'utf8'), String(process.pid));
        assert.ok(!existsSync(lockOf(run)));
      } finally { rmSync(run.dir, { recursive: true, force: true }); }
    });

    for (const mismatch of ['pid', 'token', 'owner', 'directory']) {
      it(`preserves release ${mismatch} ambiguity and fails a completed drive`, async () => {
        const run = makeRun();
        try {
          const result = await drive(run, { FAKE_HARNESS_MODE: 'done' }, {
            lockTransition(stage) {
              if (stage !== 'before-release') return;
              if (mismatch === 'directory') {
                renameSync(lockOf(run), `${lockOf(run)}.saved`);
                seed(run);
              } else if (mismatch === 'owner') {
                const bytes = readFileSync(ownerOf(run));
                renameSync(ownerOf(run), join(lockOf(run), 'saved.json'));
                writeFileSync(ownerOf(run), bytes);
              } else {
                const record = JSON.parse(readFileSync(ownerOf(run)));
                record[mismatch] = mismatch === 'pid' ? process.pid + 1 : 'substituted';
                writeFileSync(ownerOf(run), JSON.stringify(record));
              }
            },
          });
          assert.equal(result.code, 1);
          assert.ok(existsSync(lockOf(run)));
          assert.match(statusOf(run), /LOCK_RELEASE_FAILED.*run-id=/);
          assert.doesNotMatch(result.out, /complete — READY_FOR_PR/);
        } finally { rmSync(run.dir, { recursive: true, force: true }); }
      });
    }

    for (const differentSpec of [false, true]) {
      it(`excludes same checkout contenders (different spec: ${differentSpec}) while distinct roots proceed`, async () => {
        const run = makeRun();
        const other = makeRun();
        try {
          const spec = differentSpec ? join(run.dir, '.apex/work/specs/other.md') : run.specPath;
          if (differentSpec) writeFileSync(spec, readFileSync(run.specPath));
          let contender;
          let independent;
          const result = await drive(run, { FAKE_HARNESS_MODE: 'done' }, {
            async lockTransition(stage) {
              if (stage !== 'acquired') return;
              contender = await autopilot.runConductor(spec, { cwd: run.dir, commandFor: () => { throw new Error('must not spawn'); } });
              independent = await drive(other, { FAKE_HARNESS_MODE: 'done' });
            },
          });
          assert.equal(contender, 1);
          assert.equal(independent.code, 0);
          assert.equal(result.code, 0);
        } finally {
          rmSync(run.dir, { recursive: true, force: true });
          rmSync(other.dir, { recursive: true, force: true });
        }
      });
    }

    for (const stage of ['stale-observed', 'before-stale-rename']) {
      it(`a barrier-delayed stale contender at ${stage} preserves a successor`, async () => {
        const run = makeRun();
        try {
          seed(run);
          let successorOwner;
          const delayed = await drive(run, { FAKE_HARNESS_MODE: 'done' }, {
            processProbe: deadProbe,
            async lockTransition(checkpoint) {
              if (checkpoint !== stage) return;
              let resumeSuccessor;
              let successorAcquired;
              const acquired = new Promise((resolve) => { successorAcquired = resolve; });
              const barrier = new Promise((resolve) => { resumeSuccessor = resolve; });
              const successor = autopilot.runConductor(run.specPath, {
                cwd: run.dir, processProbe: deadProbe, commandFor: () => { throw new Error('stop successor'); },
                async lockTransition(point) {
                  if (point === 'acquired') {
                    successorOwner = readFileSync(ownerOf(run), 'utf8');
                    successorAcquired();
                    await barrier;
                  }
                },
              });
              await acquired;
              // Return to the delayed contender while the successor holds its lease.
              run.successor = successor;
              run.resumeSuccessor = resumeSuccessor;
            },
          });
          assert.equal(delayed.code, 1);
          assert.equal(readFileSync(ownerOf(run), 'utf8'), successorOwner);
          assert.equal(statusOf(run), '');
          run.resumeSuccessor();
          await run.successor;
        } finally {
          run.resumeSuccessor?.();
          await run.successor;
          rmSync(run.dir, { recursive: true, force: true });
        }
      });
    }
  });

  describe('refusal before any spawn', () => {
    const refuses = (label, makeRunArgs, expected) => {
      it(label, async () => {
        const run = makeRun(makeRunArgs);
        let spawnAttempts = 0;
        try {
          const { code, err } = await drive(run, {}, {
            commandFor: (harness, prompt) => {
              spawnAttempts += 1;
              return stubCommandFor(harness, prompt);
            },
          });
          assert.equal(code, 1);
          assert.equal(spawnAttempts, 0, 'must refuse before building any command');
          assert.match(err, expected);
          assert.equal(statusOf(run), '', 'a refused run writes no status line');
          assert.ok(!existsSync(join(run.taskDir, 'phase-1.log')), 'a refused run writes no log');
        } finally {
          rmSync(run.dir, { recursive: true, force: true });
        }
      });
    };

    it('refuses a spec whose name is not a safe run-directory segment', async () => {
      const run = makeRun();
      try {
        const unsafeSpec = join(run.dir, '.apex', 'work', 'specs', 'to pic.md');
        writeFileSync(unsafeSpec, readFileSync(run.specPath, 'utf8'));
        const { code, err } = await drive({ ...run, specPath: unsafeSpec }, {});
        assert.equal(code, 1);
        assert.match(err, /to pic/);
        assert.ok(!existsSync(join(run.dir, '.apex', 'work', 'tasks')), 'no run directory is created');
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    });

    refuses('the current branch is not the contract branch', { repoBranch: 'some-other-branch' }, /branch/i);
    refuses('the current branch is main', { repoBranch: 'main', branch: 'main' }, /main/);
    refuses('the contract has no drive: autopilot', { drive: null }, /drive: autopilot/);
    refuses('the contract gear is not 3', { gear: 2 }, /gear/i);

    // The frozen-contract negative matrix: each malformed or drifted contract
    // must refuse the whole run before any spawn and before a single byte lands
    // under the work dir — parse refusals and guard refusals alike.
    const refusesRawSpec = (label, rawSpec, expected) => {
      it(label, async () => {
        const run = makeRun({ rawSpec });
        let spawnAttempts = 0;
        try {
          const { code, err } = await drive(run, {}, {
            commandFor: (harness, prompt) => {
              spawnAttempts += 1;
              return stubCommandFor(harness, prompt);
            },
          });
          assert.equal(code, 1);
          assert.equal(spawnAttempts, 0, 'must refuse before building any command');
          assert.match(err, expected);
          assert.equal(statusOf(run), '', 'a refused run writes no status line');
          assert.ok(!existsSync(join(run.dir, '.apex', 'work', 'tasks')), 'a refused run writes nothing under the work dir');
        } finally {
          rmSync(run.dir, { recursive: true, force: true });
        }
      });
    };

    refusesRawSpec('a spec with duplicate contract keys', specText().replace('harness: claude\n', 'harness: claude\nbranch: other-branch\n'), /duplicate/);
    refusesRawSpec('a spec whose contract comment is not at the head', `# Front matter\n\n${specText()}`, /head of the spec/);
    refusesRawSpec('a spec carrying a second contract comment', `${specText()}\n<!-- verdict: OTHER | gear: 4 -->\n`, /only one verdict contract comment/);
    refusesRawSpec('a case-drifted drive value', specText({ drive: 'Autopilot' }), /drive: autopilot/);
    refusesRawSpec('a case-drifted commit-auth policy', specText({ commitAuth: 'Per-Task' }), /commit-auth/);
    refusesRawSpec('an unknown commit-auth policy', specText({ commitAuth: 'per-branch' }), /commit-auth/);
    refusesRawSpec('an empty commit-auth policy', specText({ commitAuth: '' }), /commit-auth/);
    refusesRawSpec('a case-drifted blast-radius literal', specText({ blastRadius: 'Branch-Only, No-Push, Stop-Before-PR' }), /blast-radius/);
    refusesRawSpec('an extended blast-radius literal', specText({ blastRadius: 'branch-only, no-push, stop-before-PR, hotfixes-too' }), /blast-radius/);
    refusesRawSpec('an empty blast-radius policy', specText({ blastRadius: '' }), /blast-radius/);
    refusesRawSpec('a case-drifted harness id', specText({ harness: 'Claude' }), /Claude/);
    refusesRawSpec('a non-numeric budget', specText({ budget: 'soon' }), /budget/);
  });

  // Task-4 work-path security confinement: every work-path site routes through
  // scripts/work-paths.mjs (or adopts its physical discipline where the typed
  // grammar deliberately has no family, i.e. the run lock). CLI/source-spec
  // refusals run the real script as a subprocess; the symlink containment
  // matrix proves the outside-repo sentinel is never read or written.
  describe('work-path security confinement', () => {
    const conductorCli = (cwd, arg) => spawnSync(
      process.execPath,
      [join(root, 'scripts', 'autopilot.mjs'), arg],
      { cwd, encoding: 'utf8' },
    );
    const noWorkDirWrites = (run) => assert.ok(
      !existsSync(join(run.dir, '.apex', 'work', 'tasks')),
      'a refused run must leave nothing under the work dir',
    );
    const outsideSentinel = (content = 'OUTSIDE-SENTINEL\n') => {
      const dir = mkdtempSync(join(tmpdir(), 'steepy-autopilot-outside-'));
      const file = join(dir, 'sentinel');
      writeFileSync(file, content);
      return { dir, file, content };
    };
    const dirtyMarker = (run) => writeFileSync(
      join(run.dir, 'dirty-marker.txt'),
      'keeps a pre-confinement conductor at its dirty-tree refusal, never at a real spawn\n',
    );

    it('CLI refuses a valid source spec outside .apex/work/specs/ with zero spawns and zero work-dir writes', () => {
      const run = makeRun();
      const stray = join(run.dir, 'outside-spec.md');
      writeFileSync(stray, specText());
      try {
        const r = conductorCli(run.dir, stray);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /refusing to drive/);
        assert.match(r.stderr, /work path/);
        noWorkDirWrites(run);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    });

    it('CLI refuses an existing .apex/work/plans file as the source spec (wrong type for the site)', () => {
      const run = makeRun();
      const planPath = join(run.dir, '.apex', 'work', 'plans', 'topic.md');
      mkdirSync(dirname(planPath), { recursive: true });
      writeFileSync(planPath, specText());
      dirtyMarker(run);
      try {
        const r = conductorCli(run.dir, planPath);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /this call site expects spec/);
        noWorkDirWrites(run);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    });

    it('CLI refuses an alias spelling of a spec path — never normalized', () => {
      const run = makeRun();
      dirtyMarker(run);
      try {
        const r = conductorCli(run.dir, '.apex/work/specs//topic.md');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /empty segment/);
        noWorkDirWrites(run);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
      }
    });

    it('CLI refuses a symlinked status target without reading or writing the outside sentinel', () => {
      const run = makeRun();
      const sentinel = outsideSentinel('');
      dirtyMarker(run);
      try {
        mkdirSync(run.taskDir, { recursive: true });
        symlinkSync(sentinel.file, run.statusFile);
        const r = conductorCli(run.dir, run.specPath);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /symlink target blocks/);
        assert.equal(existsSync(sentinel.file), true, 'the sentinel must not be removed');
        assert.equal(readFileSync(sentinel.file, 'utf8'), '', 'the sentinel must stay untouched');
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(sentinel.dir, { recursive: true, force: true });
      }
    });

    it('CLI refuses a symlinked run-directory target with zero bytes written outside', () => {
      const run = makeRun();
      const outside = mkdtempSync(join(tmpdir(), 'steepy-autopilot-outside-'));
      dirtyMarker(run);
      try {
        mkdirSync(join(run.dir, '.apex', 'work', 'tasks'), { recursive: true });
        symlinkSync(outside, run.taskDir);
        const r = conductorCli(run.dir, run.specPath);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /symlink ancestor blocks/);
        assert.deepEqual(readdirSync(outside), [], 'nothing may be written through the symlinked run dir');
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('CLI refuses a symlinked .apex/work/tasks ancestor with zero bytes written outside', () => {
      const run = makeRun();
      const outside = mkdtempSync(join(tmpdir(), 'steepy-autopilot-outside-'));
      dirtyMarker(run);
      try {
        mkdirSync(join(run.dir, '.apex', 'work'), { recursive: true });
        symlinkSync(outside, join(run.dir, '.apex', 'work', 'tasks'));
        const r = conductorCli(run.dir, run.specPath);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /symlink ancestor blocks/);
        assert.deepEqual(readdirSync(outside), [], 'nothing may be written through the symlinked ancestor');
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('CLI refuses a symlinked run-lock target without reading the outside sentinel', () => {
      const run = makeRun();
      // A live pid in the sentinel keeps a pre-confinement conductor on its
      // holder-refusal path (never a real spawn); the confined holder read must
      // instead refuse the symlink itself without reading one byte of it.
      const sentinel = outsideSentinel(`${process.pid}\n`);
      try {
        mkdirSync(run.taskDir, { recursive: true });
        symlinkSync(sentinel.file, join(run.dir, '.apex/work/.gear-3-autopilot.lock'));
        const r = conductorCli(run.dir, run.specPath);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /not an ordinary directory/);
        assert.equal(readFileSync(sentinel.file, 'utf8'), `${process.pid}\n`, 'the sentinel must stay untouched');
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(sentinel.dir, { recursive: true, force: true });
      }
    });

    it('degrades a symlinked aggregate log without appending through it', async () => {
      const run = makeRun();
      const sentinel = outsideSentinel();
      try {
        mkdirSync(run.taskDir, { recursive: true });
        symlinkSync(sentinel.file, join(run.taskDir, 'phase-1.log'));
        const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
        assert.equal(code, 0, 'aggregate observability failure remains non-blocking');
        assert.equal(readFileSync(sentinel.file, 'utf8'), sentinel.content, 'no aggregate byte may cross the symlink');
        assert.match(statusOf(run), /OBSERVABILITY_DEGRADED .*capability=aggregate .*reason=aggregate-open-error/);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(sentinel.dir, { recursive: true, force: true });
      }
    });

    it('degrades a symlinked usage ledger without appending telemetry through it', async () => {
      const run = makeRun();
      const sentinel = outsideSentinel();
      try {
        mkdirSync(run.taskDir, { recursive: true });
        symlinkSync(sentinel.file, join(run.taskDir, 'resource-usage.jsonl'));
        const { code } = await drive(run, {
          FAKE_HARNESS_MODE: 'done',
          FAKE_HARNESS_STREAM: 'claude',
          FAKE_HARNESS_TELEMETRY: 'phase',
        });
        assert.equal(code, 0, 'usage observability failure remains non-blocking');
        assert.equal(readFileSync(sentinel.file, 'utf8'), sentinel.content, 'no ledger byte may cross the symlink');
        assert.match(statusOf(run), /USAGE_TELEMETRY_DEGRADED .*capability=ledger .*reason=ledger-open-error/);
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(sentinel.dir, { recursive: true, force: true });
      }
    });

    it('a symlinked status file refuses the whole run before any spawn or outside write', async () => {
      const run = makeRun();
      const sentinel = outsideSentinel();
      try {
        mkdirSync(run.taskDir, { recursive: true });
        symlinkSync(sentinel.file, run.statusFile);
        const { code, err } = await drive(run, { FAKE_HARNESS_MODE: 'done' });
        assert.equal(code, 1);
        assert.match(err, /symlink target blocks/);
        assert.equal(readFileSync(sentinel.file, 'utf8'), sentinel.content, 'no byte may cross the symlink');
        assert.ok(!existsSync(join(run.taskDir, 'phase-1.log')), 'a refused run spawns nothing');
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(sentinel.dir, { recursive: true, force: true });
      }
    });

    it('the review-phase branch-diff write refuses a symlinked diff target and leaves the sentinel untouched', async () => {
      const run = makeRun();
      const sentinel = outsideSentinel();
      try {
        mkdirSync(run.taskDir, { recursive: true });
        symlinkSync(sentinel.file, join(run.taskDir, 'branch-diff.txt'));
        // The stub child skips its own diff write: the conductor's confined
        // write is the site under test here.
        const { code } = await drive(run, { FAKE_HARNESS_MODE: 'done', FAKE_HARNESS_SKIP_BRANCH_DIFF: '1' });
        assert.equal(code, 1, 'a hostile diff target must halt the run, not complete it');
        const failed = linesWith(statusOf(run), ' — ARTIFACT_FAILED — ')[0] ?? '';
        assert.match(failed, /work path: .*symlink/u);
        assert.equal(readFileSync(sentinel.file, 'utf8'), sentinel.content, 'no byte may cross the symlink');
      } finally {
        rmSync(run.dir, { recursive: true, force: true });
        rmSync(sentinel.dir, { recursive: true, force: true });
      }
    });
  });
});

describe('autopilot main(argv)', () => {
  let autopilot;

  before(async () => {
    const modulePath = join(root, 'scripts', 'autopilot.mjs');
    autopilot = await import(pathToFileURL(modulePath));
  });

  async function captured(argv, opts) {
    const err = [];
    const realError = console.error;
    console.error = (...args) => err.push(args.join(' '));
    try {
      const code = await autopilot.main(argv, opts);
      return { code, err: err.join('\n') };
    } finally {
      console.error = realError;
    }
  }

  it('exits 1 with usage when no spec path is given', async () => {
    const { code, err } = await captured([]);
    assert.equal(code, 1);
    assert.match(err, /usage/i);
    assert.match(err, /autopilot\.mjs/);
  });

  it('exits 1 when the spec path does not exist', async () => {
    const { code, err } = await captured(['/nonexistent/spec-does-not-exist.md']);
    assert.equal(code, 1);
    assert.match(err, /spec-does-not-exist\.md/);
  });

  it('runs the conductor in the given cwd, which refuses a manual-drive spec (no spawn)', async () => {
    // Hermetic: the run happens in this temp repo, never in the ambient checkout,
    // so the suite passes from a non-git working directory too.
    const dir = mkdtempSync(join(tmpdir(), 'steepy-autopilot-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'gear3-topic'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      mkdirSync(join(dir, '.apex', 'work', 'specs'), { recursive: true });
      const specPath = join(dir, '.apex', 'work', 'specs', 'manual-spec.md');
      writeFileSync(specPath, '<!-- verdict: GAP | gear: 3 -->\n\n# Manual spec\n');
      const { code, err } = await captured(['.apex/work/specs/manual-spec.md'], { cwd: dir });
      assert.equal(code, 1);
      assert.match(err, /drive: autopilot/);
      assert.ok(!/git branch/.test(err), `must not fall over on git, got: ${err}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative spec path against the given cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'steepy-autopilot-'));
    try {
      const { code, err } = await captured(['nope.md'], { cwd: dir });
      assert.equal(code, 1);
      assert.match(err, new RegExp(join(dir, 'nope.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
