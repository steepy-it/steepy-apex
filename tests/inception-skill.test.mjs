// The v2 procedure is checked as a runnable public-CLI recipe, not just spellings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planProjectScaffold, applyProjectScaffold } from '../scripts/project-scaffold.mjs';
import { renderTemplate } from '../scripts/template.mjs';
import { publicationRef } from '../scripts/inception-protocol.mjs';
import { sectionBetween, frontmatter } from './support/markdown.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = readFileSync(join(root, 'skills/inception/SKILL.md'), 'utf8');
const flat = text => text.replace(/\s+/g, ' ');
const area = '.apex/inception';
const doc = name => readFileSync(join(root, 'skills/inception', name), 'utf8');
const section = heading => flat(sectionBetween(skill, heading, '\n### Step '));
function example(id) {
  const match = skill.match(new RegExp(`<!-- example:${id} -->\\n\x60\x60\x60(?:json|bash|text)\\n([\\s\\S]*?)\\n\x60\x60\x60`));
  assert.ok(match, `missing executable example ${id}`);
  return match[1];
}
function fixture(t, { beforeStart } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'inception-skill-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const write = (path, bytes) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), bytes); };
  const json = (path, value) => write(path, JSON.stringify(value) + '\n');
  const read = () => JSON.parse(readFileSync(join(repo, area, 'run.json'), 'utf8'));
  const cli = (args, expected = 0) => {
    const result = spawnSync(process.execPath, [join(root, 'scripts/inception-state.mjs'), ...args, '--repo-root', repo], { encoding: 'utf8' });
    assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  // Examples contain argv tokens and --text=value; no shell evaluation is involved.
  const run = (id, replacements = {}, expected = 0) => {
    let command = example(id);
    for (const [key, value] of Object.entries(replacements)) command = command.replaceAll(`<${key}>`, value);
    assert.doesNotMatch(command.replace('<engine-root>', root), /<[a-z-]+>/, `unresolved ${id}`);
    const args = command.split(' ').slice(2).filter((value, i, all) => value !== '--repo-root' && all[i - 1] !== '--repo-root');
    return cli(args, expected);
  };
  const report = id => write(`${area}/bootstrap/${id}.md`, example('unit-report').replaceAll('<unit-id>', id).replaceAll('<status>', 'DONE'));
  const begin = (id, kind = 'check', previous = null, allowedPaths = []) => {
    json(`${area}/bootstrap/${id}-input.json`, { kind, inputs: [], outputs: [{ path: `${area}/bootstrap/${id}.md`, role: 'report' }], allowedPaths });
    cli(['unit', 'begin', '--id', id, '--input', `${area}/bootstrap/${id}-input.json`, ...(previous ? ['--previous-unit', previous] : [])]);
    report(id);
  };
  write('app.cjs', "module.exports = 'ready';\n");
  beforeStart?.({ repo, write, json });
  run('start');
  return { repo, write, json, read, cli, run, report, begin };
}
function approved(t, options) {
  const f = fixture(t, options);
  for (const phase of ['architecture', 'research', 'approval']) f.cli(['transition', '--to', phase, '--reason=Confirmed']);
  f.run('bootstrap', {}, 1); // No approval must never enter bootstrap.
  f.json(`${area}/project/project-unit.json`, JSON.parse(example('project-unit')));
  f.run('project-begin');
  f.write(`${area}/project/decision-register.md`, '# Decisions\nDR-1: representative path approved in fixture.\n');
  f.json(`${area}/project/verification-contract.json`, JSON.parse(example('verification-contract')));
  f.write(`${area}/project/project-report.md`, example('unit-report').replaceAll('<unit-id>', 'project').replaceAll('<status>', 'DONE'));
  f.run('project-finish');
  f.run('approve');
  assert.equal(f.cli(['verify-approval']).ok, true);
  f.run('bootstrap');
  f.cli(['transition', '--to', 'verification', '--reason=Bootstrap-verified']);
  f.json(`${area}/project/environment.json`, JSON.parse(example('environment')));
  const cycle = f.run('verification-begin').cycle.path;
  return { ...f, cycle };
}
function collect(f, id) {
  const command = example('capture').replace('<engine-root>', root).replaceAll('<cycle>', f.cycle).replaceAll('<unit-id>', id);
  const args = command.split(' ').slice(2);
  const index = args.indexOf('--repo-root'); args[index + 1] = f.repo;
  const result = spawnSync(process.execPath, [join(root, 'scripts/capture-inception-evidence.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'succeeded');
  return JSON.parse(result.stdout);
}
function attest(f, id, purpose = 'check') {
  const input = JSON.parse(example('manual-attestation'));
  input.purpose = purpose;
  if (purpose === 'revalidate') input.checks[0].procedure = 'Reopen the same representative path';
  f.json(`${area}/bootstrap/${id}-attest.json`, input);
  f.run('attest', { cycle: f.cycle, 'attestation-input': `${area}/bootstrap/${id}-attest.json` });
}
function pass(f, id) { f.begin(id); collect(f, id); attest(f, id); f.cli(['unit', 'finish', '--id', id]); }

test('entry remains portable, human-led, pre-hub and outside the workflow chain', () => {
  assert.match(frontmatter(skill), /^name: inception\ndescription: [^\n]+\nuser-invocable: true$/);
  assert.match(flat(skill), /pre-hub skill/);
  assert.match(flat(skill), /no headless or autopilot mode/);
  assert.match(flat(skill), /scripts live two levels up/);
  for (const text of [skill, doc('research-prompt.md'), doc('bootstrap-part-prompt.md')]) {
    assert.doesNotMatch(text, /CLAUDE_|\/Users\/|\/home\/|\bgpt-\d|\bsonnet\b|\bopus\b|steepy:manual-handoff/);
  }
});

test('helper table covers v2 recovery, unit, effect, verification and terminal commands without retired mutation flags', () => {
  const helper = sectionBetween(skill, '## Helper commands', '## Procedure');
  for (const command of ['inspect', 'unit begin', 'unit finish', 'unit reconcile', 'unit close-incomplete', 'publish resume', 'resume-check', 'block resolve', 'effect intent', 'effect outcome', 'effect reconcile', 'verification begin', 'verification resume', 'verification attest', 'verification status', 'verification summarize', 'verify-complete']) assert.ok(helper.includes(`inception-state.mjs ${command} --repo-root .`), command);
  assert.match(helper, /--previous-unit <id>/);
  assert.match(helper, /--contract <path>/);
  assert.doesNotMatch(helper, /--verification|--files-from|--file |--kind |--result |--passed/);
  assert.match(helper, /Exit `0`/); assert.match(helper, /Exit `1`/); assert.match(helper, /Exit `2`/);
});

test('the classify table names exactly the rows the helper emits', () => {
  const source = readFileSync(join(root, 'scripts/inception-state.mjs'), 'utf8');
  const classify = source.slice(source.indexOf('export function classifyState'), source.indexOf('// Version inspection reads'));
  const emitted = new Set([...classify.matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)].map(m => m[1]));
  const table = sectionBetween(skill, 'Act on the `row` field', '### Step 1');
  const documented = new Set([...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map(m => m[1]));
  assert.ok(emitted.has('resume-abandon'));
  assert.deepEqual([...documented].sort(), [...emitted].sort());
  assert.match(flat(table), /`resume-abandon` \| An interrupted abandon left a prepared intent\. Run `abandon --resume` to finish it; every other `inception-state\.mjs` writer refuses until then/);
});

test('resume authority is descriptor refs and resume-check, with three approval cases and unsupported run format refusal', () => {
  const s = section('### Step 1');
  for (const pattern of [/resume-check/, /before any new writer/, /absent/, /valid/, /divergent/, /verification resume/, /publish resume/, /last note is not authority/, /unsupported run format/, /Never repeat a concluded or uncertain effect/]) assert.match(s, pattern);
  assert.doesNotMatch(s, /latest resume note:.*exact paths it lists/);
});

test('units precede decisions, research, child dispatch, application writes and effects; coordinator validates reports and observed diff', () => {
  const s = flat(skill);
  assert.match(s, /Before any decision, research, child dispatch, application write, or effect/);
  assert.match(s, /unit begin/); assert.match(s, /unit finish/);
  assert.match(s, /coordinator.*complete report.*observed diff/i);
  assert.match(s, /immutable.*outputs/i);
  assert.match(s, /previous-unit/);
  assert.match(s, /writerStopped/);
  assert.match(s, /absent PID or a report alone/);
  assert.match(s, /live or unverifiable/);
  assert.match(s, /trust boundary/);
});

test('project contract is approved before bootstrap and cannot be weakened to hide failed required checks', () => {
  const s = section('### Step 5');
  for (const pattern of [/verification-contract\.json/, /automatic.*manual.*both/, /roots/, /exclusions/, /reobserve/, /decision-register/, /verbatim/, /human/, /--contract/, /all current project documents/, /reapproval/, /hash.*human/]) assert.match(s, pattern);
  assert.match(flat(skill), /Never make a failed required check optional/);
});
test('every decision-register row gets the coverage entry discovery reads, and approve enforces it', () => {
  const s = section('### Step 5');
  assert.match(s, /register row its own entry whose `id` is the lowercase register ID \(`DR-1` → `dr-1`\)/);
  assert.match(s, /`approve` refuses a register row without its `dr-n` entry/);
  assert.match(flat(skill), /Each ID gets a coverage entry `dr-n` in the verification contract/);
  const prompt = flat(readFileSync(join(root, 'skills/discovery/explore-inception-prompt.md'), 'utf8'));
  assert.match(prompt, /register `DR-n` maps only to exact `coverage` `id` `dr-n`/);
});

test('verification obeys cycles, capture provenance, manual human attest, all required checks after fixes and session reobservation', () => {
  const s = section('### Step 10');
  for (const pattern of [/verification begin/, /capture-inception-evidence/, /verification attest/, /both/, /explicit human/, /purpose.*revalidate/, /all required automatic and manual checks/, /new cycle/, /not-executed/, /verification summarize/, /limits/, /checkpoint create/, /--cycle/, /verify-complete/, /presentation only/, /completion/]) assert.match(s, pattern);
  assert.doesNotMatch(s, /--verification|Write `\.apex\/inception\/verification\/results\.md`/);
});

test('pauses and sessions recommend context management without granting authority or forcing a restart', () => {
  assert.match(flat(skill), /Recommend three sessions/);
  assert.match(flat(skill), /Pauses are recommendations/);
  assert.match(flat(skill), /never authorize work/);
  assert.match(flat(skill), /complete.*closing note.*never restart/i);
  assert.match(flat(skill), /abandon --repo-root \. --resume/);
});

test('research and architecture preserve official version evidence, nine categories, dialogue and one representative path', () => {
  const s = flat(skill);
  for (const term of ['system shape', 'contracts between parts', 'data', 'identity and access', 'internal architecture', 'repository and tooling', 'testing strategy', 'hosting and deploy', 'observability and errors']) assert.ok(s.includes(term));
  assert.match(s, /one question at a time/);
  assert.match(s, /confirmed answer that is still valid is never asked again/);
  assert.match(s, /Versions you remember are not verified versions/);
  assert.match(s, /one representative path/);
  assert.match(s, /official source, an explicit version, a verification date/);
});

for (const [file, tier] of [['research-prompt.md', 'standard'], ['bootstrap-part-prompt.md', 'most-capable']]) test(`${file}: bounded persisted child report, correlation and coordinator-owned state`, () => {
  const text = doc(file); const s = flat(text);
  assert.match(text, new RegExp(`model: ${tier}`));
  for (const field of ['[UNIT_ID]', '[INPUT_PATHS]', '[OUTPUT_FILE]', '[CORRELATION]']) assert.ok(text.includes(field), field);
  assert.match(s, /already persisted/);
  assert.match(s, /descriptor.*effect/i);
  assert.match(s, /Never.*run-state helper/);
  assert.match(s, /observed diff/);
  assert.match(s, /steepy-inception-unit: v2; id: \[UNIT_ID\]; status:/);
  assert.match(s, /steepy-inception-unit-end: \[UNIT_ID\]/);
  assert.match(s, /inline degradation/);
  assert.match(text, /status: <DONE\|DONE_WITH_CONCERNS\|NEEDS_CONTEXT\|BLOCKED>\n    artifact: \[OUTPUT_FILE\]\n    changed-paths: <paths or none>\n    signals: <short IDs or none>/);
});

test('documented project-unit, approval, capture, human attestation and complete examples execute through public CLI', t => {
  const f = approved(t);
  f.begin('verify'); const captured = collect(f, 'verify');
  assert.deepEqual(collect(f, 'verify'), captured, 'same registered collector invocation recovers, without new execution');
  f.cli(['unit', 'finish', '--id', 'verify']);
  assert.deepEqual(f.cli(['verification', 'status', '--cycle', f.cycle]).missing, ['representative']);
  f.begin('human'); attest(f, 'human'); f.cli(['unit', 'finish', '--id', 'human']);
  assert.deepEqual(f.run('verification-status', { cycle: f.cycle }).missing, []);
  f.json(`${area}/project/limits.json`, []);
  f.run('summarize', { cycle: f.cycle });
  const checkpoint = f.run('checkpoint').checkpoint.path;
  f.run('complete', { cycle: f.cycle, checkpoint });
  assert.equal(f.run('verify-complete').ok, true);
  const completion = f.read().completion.path;
  const revision = f.read().revision;
  f.run('closing-note', { completion });
  assert.equal(f.read().phase, 'complete');
  assert.ok(f.read().revision > revision);
  assert.equal(f.run('verify-complete').ok, true);
});

test('documented session resume preserves snapshot checks but reobserve requires new proof; application fix invalidates all required evidence', t => {
  const f = approved(t); pass(f, 'first');
  f.run('resume-check');
  f.run('verification-resume', { cycle: f.cycle });
  assert.deepEqual(f.run('verification-status', { cycle: f.cycle }).missing, ['representative']);
  f.begin('reobserve'); attest(f, 'reobserve', 'revalidate'); f.cli(['unit', 'finish', '--id', 'reobserve']);
  assert.deepEqual(f.run('verification-status', { cycle: f.cycle }).missing, []);
  const old = f.cycle;
  f.begin('fix', 'bootstrap', null, ['app.cjs']); f.write('app.cjs', "module.exports = 'ready'; // corrected\n"); f.cli(['unit', 'finish', '--id', 'fix']);
  f.cycle = f.run('verification-begin').cycle.path; assert.notEqual(f.cycle, old);
  assert.deepEqual(f.run('verification-status', { cycle: f.cycle }).missing, ['representative']);
  f.begin('manual-new'); attest(f, 'manual-new'); f.cli(['unit', 'finish', '--id', 'manual-new']);
  assert.deepEqual(f.run('verification-status', { cycle: f.cycle }).missing, ['representative'], 'old automatic result cannot satisfy the new cycle');
  f.begin('automatic-new'); collect(f, 'automatic-new'); f.cli(['unit', 'finish', '--id', 'automatic-new']);
  assert.deepEqual(f.run('verification-status', { cycle: f.cycle }).missing, []);
});

test('divergent approval refuses continued bootstrap and document changes require approval-phase unit plus reapproval', t => {
  const f = approved(t);
  f.write(`${area}/project/decision-register.md`, '# Changed without approval\n');
  f.cli(['verify-approval'], 1); f.run('resume-check', {}, 1);
  f.cli(['transition', '--to', 'approval', '--reason=Targeted-decision']);
  f.json(`${area}/bootstrap/reapproval-input.json`, { kind: 'decision', inputs: [], outputs: [{ path: `${area}/project/decision-register.md`, role: 'decision' }, { path: `${area}/bootstrap/reapproval.md`, role: 'report' }], allowedPaths: [] });
  f.cli(['unit', 'begin', '--id', 'reapproval', '--input', `${area}/bootstrap/reapproval-input.json`]);
  f.write(`${area}/project/decision-register.md`, '# Targeted human-confirmed change\n');
  f.report('reapproval'); f.cli(['unit', 'finish', '--id', 'reapproval']);
  const previousCycle = f.read().currentCycle;
  f.run('approve'); assert.equal(f.read().currentCycle, null); assert.ok(previousCycle);
  f.cli(['verify-approval']);
});

test('stopped-writer example closes incomplete and retry uses explicit --previous-unit, never a report or PID absence', t => {
  const f = fixture(t); f.begin('interrupted', 'research');
  f.cli(['unit', 'close-incomplete', '--id', 'interrupted', '--reason=Interrupted', '--evidence', `${area}/bootstrap/interrupted.md`], 1);
  f.json(`${area}/bootstrap/stopped.json`, JSON.parse(example('stopped-writer')));
  f.run('close-incomplete'); assert.equal(f.read().units[0].state, 'closed-incomplete');
  f.json(`${area}/bootstrap/retry-input.json`, { kind: 'research', inputs: [], outputs: [{ path: `${area}/bootstrap/retry.md`, role: 'report' }], allowedPaths: [] });
  f.run('retry-begin'); f.report('retry'); f.cli(['unit', 'finish', '--id', 'retry']);
  assert.equal(f.read().units[1].previousUnit, 'interrupted');
});

test('unit input refs are exact digest-bound paths, not recency discovery', t => {
  const f = fixture(t);
  f.write(`${area}/project/input.md`, 'confirmed');
  const input = publicationRef(`${area}/project/input.md`, Buffer.from('confirmed'));
  f.json(`${area}/bootstrap/ref-input.json`, { kind: 'decision', inputs: [input], outputs: [{ path: `${area}/bootstrap/ref.md`, role: 'report' }], allowedPaths: [] });
  f.write(`${area}/project/input.md`, 'divergent');
  f.cli(['unit', 'begin', '--id', 'ref', '--input', `${area}/bootstrap/ref-input.json`], 1);
  assert.equal(f.read().activeUnit, null);
});

test('documented effect intent/outcome JSON includes exact id and structured observation correlation', t => {
  const f = approved(t); f.begin('generate', 'bootstrap', null, ['generated.txt']);
  const intent = JSON.parse(example('effect-intent-input'));
  const observation = JSON.parse(example('effect-observation'));
  const outcome = JSON.parse(example('effect-outcome-input'));
  f.json(`${area}/bootstrap/generate-intent.json`, intent);
  f.run('effect-intent');
  assert.equal(f.cli(['effect', 'status']).uncertain, 1);
  const result = spawnSync(intent.command.executable, intent.command.args, { cwd: f.repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.repo, 'generated.txt'), 'utf8'), 'generated\n');
  f.json(`${area}/bootstrap/generate-observation.json`, observation);
  f.json(`${area}/bootstrap/generate-outcome.json`, outcome);
  f.run('effect-outcome');
  f.cli(['unit', 'finish', '--id', 'generate']);
  assert.equal(f.read().blocks.length, 0);
  assert.equal(f.read().currentCycle, null);
  f.run('effect-outcome', {}, 1); // A concluded intent cannot be replayed.
});

test('blocking procedure settles the writer before status/note and distinguishes live waiting from persisted blocked', () => {
  const s = flat(sectionBetween(skill, '## Blocking and abandon'));
  for (const pattern of [/stop new work/, /[Ss]ettle the active writer before/, /demonstrably completed/, /Never fabricate a successful report/, /live or.*unverifiable/, /retain the active unit/, /waiting condition/, /do not claim.*blocked transition/, /uncertain effects.*unaccepted application drift.*independent blocks/, /no replay permission/]) assert.match(s, pattern);
  assert.ok(s.indexOf('unit close-incomplete') < s.indexOf('example:blocking-transition'), 'observed-stop closure precedes blocked status');
  assert.ok(s.indexOf('example:blocking-transition') < s.indexOf('example:blocking-note'), 'note follows persisted blocked status');
});

test('documented missing-input blocking recipe closes decision/research incomplete before recording status and note', t => {
  for (const kind of ['decision', 'research']) {
    const f = fixture(t);
    const opening = JSON.parse(example('blocking-unit')); opening.kind = kind;
    f.json(`${area}/project/recon-input.json`, opening);
    f.run('blocking-begin');
    const baseline = f.read().baseline;
    const application = readFileSync(join(f.repo, 'app.cjs'));
    assert.throws(() => readFileSync(join(f.repo, 'required-material.txt')), { code: 'ENOENT' });
    f.write(`${area}/project/recon-report.md`, example('unit-report').replaceAll('<unit-id>', 'recon').replaceAll('<status>', 'BLOCKED'));
    f.cli(['unit', 'finish', '--id', 'recon'], 1);
    const refused = f.run('blocking-transition', {}, 1);
    assert.match(refused.error, /activeUnit recon excludes this writer/);
    f.json(`${area}/project/recon-stopped.json`, JSON.parse(example('blocking-stopped')));
    f.run('blocking-close');
    assert.equal(f.read().activeUnit, null);
    assert.equal(f.read().units[0].state, 'closed-incomplete');
    assert.deepEqual(f.read().baseline, baseline);
    f.run('blocking-transition'); f.run('blocking-note');
    assert.equal(f.read().status, 'blocked');
    assert.equal(f.read().units.length, 1);
    assert.equal(f.read().units[0].state, 'closed-incomplete');
    assert.equal(f.read().resumeNotes.length, 1);
    const note = readFileSync(join(f.repo, f.read().resumeNotes[0].path), 'utf8');
    assert.match(note, /obtain-readable-required-material/);
    assert.match(note, /recon-stopped\.json/);
    assert.deepEqual(readFileSync(join(f.repo, 'app.cjs')), application, 'settlement must not repeat application work');
  }
});

test('blocking after closure preserves uncertain effects, application drift and existing block evidence', t => {
  const f = approved(t); f.begin('recon', 'bootstrap', null, ['generated.txt']);
  f.json(`${area}/bootstrap/generate-intent.json`, JSON.parse(example('effect-intent-input')));
  f.run('effect-intent'); // Intent exists; no application command is executed or claimed successful.
  const baseline = f.read().baseline;
  const blocks = f.read().blocks;
  f.write('app.cjs', "module.exports = 'unaccepted drift';\n");
  f.json(`${area}/project/recon-stopped.json`, JSON.parse(example('blocking-stopped')));
  f.run('blocking-close'); f.run('blocking-transition'); f.run('blocking-note');
  assert.equal(f.read().units.at(-1).state, 'closed-incomplete');
  assert.deepEqual(f.read().baseline, baseline, 'closure must not accept the changed application as baseline');
  assert.deepEqual(f.read().blocks, blocks, 'existing block evidence is not resolved by blocking/closure');
  assert.equal(f.cli(['effect', 'status']).uncertain, 1);
  f.cli(['transition', '--to', 'active', '--reason=Still-unresolved'], 1);
  assert.equal(f.read().status, 'blocked');
  assert.equal(readFileSync(join(f.repo, 'app.cjs'), 'utf8'), "module.exports = 'unaccepted drift';\n");
});

test('live registered capture retains its active unit and cannot claim blocked status or write a note', async t => {
  const { beginCapture } = await import('../scripts/inception-state.mjs');
  const f = approved(t); f.begin('recon');
  beginCapture(f.repo, { cycle: f.cycle, check: 'representative', unit: 'recon', purpose: 'check' });
  f.json(`${area}/project/recon-stopped.json`, JSON.parse(example('blocking-stopped')));
  const before = f.read();
  const refusal = f.run('blocking-close', {}, 1);
  assert.match(refusal.error, /alive|live/);
  f.run('blocking-transition', {}, 1); f.run('blocking-note', {}, 1);
  assert.deepEqual(f.read(), before);
  assert.equal(f.read().activeUnit, 'recon');
  assert.equal(f.read().status, 'active');
});


// Task 11: execute init/discovery's documented CLIs against a completed v2 run.
test('complete source recipe verifies before source reads, certifies init, and rejects later drift without mutating the run', t => {
  const init = readFileSync(join(root, 'skills/init/SKILL.md'), 'utf8');
  const discovery = readFileSync(join(root, 'skills/discovery/SKILL.md'), 'utf8');
  const prepare = init.match(/node <engine-root>\/scripts\/inception-governance\.mjs prepare --repo-root <repo-root> --input <governance-input-json>/)?.[0];
  const finish = init.match(/node <engine-root>\/scripts\/inception-governance\.mjs finish --repo-root <repo-root>/)?.[0];
  const gate = discovery.match(/node <engine-root>\/scripts\/inception-state\.mjs verify-complete --repo-root \./)?.[0];
  assert.ok(prepare && finish && gate, 'all documented integration commands must exist');
  const f = approved(t); mkdirSync(join(f.repo, 'src')); pass(f, 'source-check');
  const checkpoint = f.run('checkpoint').checkpoint.path;
  f.run('complete', { cycle: f.cycle, checkpoint });
  const beforeRun = readFileSync(join(f.repo, area, 'run.json'));
  const run = (command, inputPath, expected = 0) => {
    const tokens = command.replace('<engine-root>', root).replace('<repo-root>', f.repo).replace('<governance-input-json>', inputPath ?? '').split(' ');
    const repoIndex = tokens.indexOf('--repo-root'); tokens[repoIndex + 1] = f.repo;
    const result = spawnSync(process.execPath, tokens.slice(1), { encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr + result.stdout);
    return result.status === 0 ? JSON.parse(result.stdout) : result;
  };
  const sourceReads = [];
  const loadSource = (expected = 0) => {
    const receipt = run(gate, null, expected);
    if (expected !== 0) return receipt;
    assert.equal(receipt.ok, true);
    // The dispatcher passes this exact array; no descriptor traversal or derived path.
    for (const path of receipt.inputPaths) { sourceReads.push(path); readFileSync(join(f.repo, path)); }
    return receipt;
  };
  const receipt = loadSource();
  const completion = JSON.parse(readFileSync(join(f.repo, receipt.completion.path))).body;
  const approval = JSON.parse(readFileSync(join(f.repo, completion.approval.path))).body;
  assert.deepEqual(sourceReads, [area + '/run.json', completion.approval.path, ...approval.documents.map(d => d.path), completion.summary.path, completion.report.path]);
  assert.equal(receipt.coverage[0].id, 'dr-1');
  assert.equal(receipt.coverage[0].status, 'verified');
  assert.equal(receipt.checks[0].result, 'succeeded');
  const projectModel = { projectName: 'sample', description: 'Confirmed app', devCommands: ['node --test'], surfaces: [{ name: 'web', path: 'src', agent: 'web-agent', testCmd: 'node --test' }], resolutions: {} };
  const template = (name, values) => renderTemplate(readFileSync(join(root, 'templates', name), 'utf8'), values);
  const documents = [
    { path: '.apex/_INDEX.md', content: template('_INDEX.md', { projectName: projectModel.projectName, routingRows: template('routing-row.md', { surface: 'web', docsPath: 'standards/web.md', agent: 'web-agent', skill: '—' }).trimEnd(), gitPolicyDirective: '' }) },
    { path: '.apex/standards/web.md', content: template('surface-standard.md', { name: 'web', path: 'src', testCmd: 'node --test' }) },
    ...['conventions', 'glossary', 'testing-and-checklist'].map(name => ({ path: `.apex/${name}.md`, content: `# ${name}\nConfirmed interview decisions.\n` })),
  ];
  const plan = planProjectScaffold({ hubRoot: f.repo, model: projectModel });
  assert.deepEqual(plan.conflicts, []);
  const inputPath = '.apex/work/init/' + receipt.runId + '/governance-input.json';
  f.json(inputPath, { schema: 'steepy-inception-governance-input/v1', runId: receipt.runId, completion: receipt.completion, projectModel, documents });
  run(prepare, inputPath);
  const readCount = sourceReads.length;
  loadSource(1); assert.equal(sourceReads.length, readCount, 'pending receipt blocks source bodies');
  // Recovery takes precedence over a now-red source gate and retains exact input.
  run(prepare, inputPath);
  applyProjectScaffold({ hubRoot: f.repo, plan });
  for (const document of documents) f.write(document.path, document.content);
  run(finish);
  assert.deepEqual(loadSource().inputPaths, receipt.inputPaths);
  run(prepare, inputPath); run(finish); // idempotent receipt replay
  const gateResult = spawnSync(process.execPath, [join(root, 'scripts/validate-hub.mjs'), f.repo], { encoding: 'utf8' });
  assert.equal(gateResult.status, 0, gateResult.stdout + gateResult.stderr);
  const countAfterInit = sourceReads.length;
  f.write('.codex/foreign.md', 'Application change inside a provider\n');
  const rejected = loadSource(1);
  assert.match(rejected.stdout, /application-drift/);
  assert.equal(sourceReads.length, countAfterInit, 'failed gate never reads source bodies');
  assert.deepEqual(readFileSync(join(f.repo, area, 'run.json')), beforeRun);
});


for (const prefix of ['full-scaffold', 'through-customized-replacement']) test(`T11-R1 pending recovery replays retained plan after ${prefix}`, t => {
  const customPath = '.codex/agents/web-agent.toml';
  const f = approved(t, { beforeStart: ({ write }) => write(customPath, 'name = "web-agent"\ndescription = "custom"\n') });
  mkdirSync(join(f.repo, 'src')); pass(f, 'retained-plan-check');
  f.run('complete', { cycle: f.cycle, checkpoint: f.run('checkpoint').checkpoint.path });
  const descriptorBytes = readFileSync(join(f.repo, area, 'run.json'));
  const verified = f.run('verify-complete');
  const projectModel = { projectName: 'sample', description: 'Confirmed app', devCommands: ['node --test'], surfaces: [{ name: 'web', path: 'src', agent: 'web-agent', testCmd: 'node --test' }], resolutions: {} };
  const unresolved = planProjectScaffold({ hubRoot: f.repo, model: projectModel });
  assert.equal(unresolved.conflicts[0].id, 'v1:web-agent-codex:customized');
  assert.deepEqual(unresolved.conflicts[0].choices, ['replace', 'abort']);
  projectModel.resolutions[unresolved.conflicts[0].id] = 'replace';
  const originalPlan = planProjectScaffold({ hubRoot: f.repo, model: projectModel });
  assert.deepEqual(originalPlan.conflicts, []);
  const template = (name, values) => renderTemplate(readFileSync(join(root, 'templates', name), 'utf8'), values);
  const documents = [
    { path: '.apex/_INDEX.md', content: template('_INDEX.md', { projectName: 'sample', routingRows: template('routing-row.md', { surface: 'web', docsPath: 'standards/web.md', agent: 'web-agent', skill: '—' }).trimEnd(), gitPolicyDirective: '' }) },
    { path: '.apex/standards/web.md', content: template('surface-standard.md', { name: 'web', path: 'src', testCmd: 'node --test' }) },
    ...['conventions', 'glossary', 'testing-and-checklist'].map(name => ({ path: `.apex/${name}.md`, content: `# ${name}\nConfirmed interview decisions.\n` })),
  ];
  const work = `.apex/work/init/${verified.runId}`;
  const inputPath = work + '/governance-input.json';
  const planPath = work + '/scaffold-plan.json';
  f.json(inputPath, { schema: 'steepy-inception-governance-input/v1', runId: verified.runId, completion: verified.completion, projectModel, documents });
  f.json(planPath, originalPlan);
  const inputBytes = readFileSync(join(f.repo, inputPath));
  const planBytes = readFileSync(join(f.repo, planPath));
  const governance = (command, expected = 0) => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/inception-governance.mjs'), command, '--repo-root', f.repo, ...(command === 'prepare' ? ['--input', inputPath] : [])], { encoding: 'utf8' });
    assert.equal(r.status, expected, r.stdout + r.stderr); return r;
  };
  governance('prepare');
  const reservationBytes = readFileSync(join(f.repo, '.apex/init-provenance.pending.json'));
  const customIndex = originalPlan.operations.findIndex(op => op.path === customPath);
  assert.ok(customIndex >= 0 && customIndex < originalPlan.operations.length - 1, 'fixture has a genuine remaining publication suffix');
  if (prefix === 'full-scaffold') applyProjectScaffold({ hubRoot: f.repo, plan: originalPlan });
  else {
    // Materialize the exact on-disk ordered prefix a publication interruption leaves.
    for (const op of originalPlan.operations.slice(0, customIndex + 1)) f.write(op.path, op.content);
  }
  assert.throws(() => planProjectScaffold({ hubRoot: f.repo, model: projectModel }), /resolution .* does not match a current conflict/);
  f.run('verify-complete', {}, 1); // Pending recovery must not use this as its entry gate.
  const alreadyApplied = originalPlan.operations.filter(op => {
    try { return readFileSync(join(f.repo, op.path), 'utf8') === op.content; } catch { return false; }
  });
  const metadata = () => alreadyApplied.map(op => {
    const stat = statSync(join(f.repo, op.path));
    return [op.path, readFileSync(join(f.repo, op.path)).toString('base64'), stat.mode, stat.mtimeMs];
  });
  const before = metadata();
  governance('prepare'); // byte-identical retained governance input after actual replacement
  const init = readFileSync(join(root, 'skills/init/SKILL.md'), 'utf8');
  const recipe = init.match(/<!-- example:retained-scaffold-apply -->\n```javascript\n([\s\S]*?)\n```/)?.[1];
  assert.ok(recipe, 'document a concrete public retained-plan recovery recipe');
  const code = recipe.replaceAll('<engine-root>', root).replaceAll('<repo-root>', f.repo).replaceAll('<governance-input-json>', inputPath).replaceAll('<scaffold-plan-json>', planPath);
  const recovered = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.applied, originalPlan.operations.length - alreadyApplied.length);
  assert.deepEqual(metadata(), before, 'recovery never rewrites completed scaffold files');
  const documentsLine = init.split('\n').map(line => line.trim()).find(line => line.startsWith('node <engine-root>/scripts/inception-governance.mjs documents '));
  assert.ok(documentsLine, 'document the public documents command');
  const documentsArgs = documentsLine.replace('node ', '').replaceAll('<engine-root>', root).replaceAll('<repo-root>', f.repo).replaceAll('<governance-input-json>', inputPath).split(' ');
  const written = spawnSync(process.execPath, documentsArgs, { encoding: 'utf8' });
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.ok(JSON.parse(written.stdout).created.length > 0, 'documents writes the missing certified documents');
  for (const document of JSON.parse(inputBytes).documents) {
    assert.equal(readFileSync(join(f.repo, document.path), 'utf8'), document.content);
    assert.equal(statSync(join(f.repo, document.path)).mode & 0o777, 0o644);
  }
  governance('finish');
  assert.equal(f.run('verify-complete').ok, true);
  assert.deepEqual(readFileSync(join(f.repo, inputPath)), inputBytes);
  assert.deepEqual(readFileSync(join(f.repo, planPath)), planBytes);
  assert.deepEqual(readFileSync(join(f.repo, '.apex/init-provenance.pending.json')), reservationBytes);
  assert.deepEqual(readFileSync(join(f.repo, area, 'run.json')), descriptorBytes);
});
