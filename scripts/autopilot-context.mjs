#!/usr/bin/env node
import {
  existsSync, readFileSync, statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSafeHubRoot, assertSafeLine, assertSafeRelPath } from './sanitize.mjs';
import { parseWorkPath, readWorkPath, writeWorkPath } from './work-paths.mjs';
import { parseTaskResultProjection } from './task-results.mjs';

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1;
export const MODEL_TIERS = Object.freeze(['cheap', 'standard', 'most-capable']);
export const PHASE_ROLES = Object.freeze(['plan', 'implement', 'review']);
export const TASK_ROLES = Object.freeze(['implementer', 'task-reviewer', 'fix', 'final-review']);

const COMPLEXITY_TIER = Object.freeze({
  mechanical: 'cheap',
  integration: 'standard',
  design: 'most-capable',
});

// The phase-controller tier no longer follows the hardest supervised task: it is
// floored and capped at `standard`, with `cheap` eligible only when every task is
// `mechanical`. The distribution is recorded so the decision stays auditable.
function complexityDistribution(tasks) {
  return {
    mechanical: tasks.filter((task) => task.complexity === 'mechanical').length,
    integration: tasks.filter((task) => task.complexity === 'integration').length,
    design: tasks.filter((task) => task.complexity === 'design').length,
  };
}

function distributionToken(distribution) {
  return `distribution=mechanical:${distribution.mechanical},integration:${distribution.integration},design:${distribution.design}`;
}

const KNOWN_ROLES = new Set([...PHASE_ROLES, ...TASK_ROLES]);
const ROLE_PHASE = Object.freeze({
  plan: 'plan',
  implement: 'implement',
  review: 'review',
  implementer: 'implement',
  'task-reviewer': 'implement',
  fix: 'implement',
  'final-review': 'implement',
});
const TASK_SCOPED_ROLES = new Set(['implementer', 'task-reviewer', 'fix']);
const MANIFEST_KEYS = new Set([
  'schemaVersion', 'runId', 'scope', 'objective', 'required', 'onDemand', 'outputs',
  'modelTier', 'attempt', 'testCommand', 'criterionIds', 'contract',
]);
const SCOPE_KEYS = new Set(['phase', 'task', 'role']);
const INPUT_KEYS = new Set(['path', 'purpose', 'read', 'bytes', 'available']);

const PURPOSES = Object.freeze({
  spec: 'approved specification',
  criteria: 'success-criteria source',
  plan: 'approved implementation plan',
  routing: 'surface routing table',
  testing: 'testing checklist',
  standard: 'implicated surface standard',
  brief: 'task contract',
  report: 'implementer report',
  issue: 'reviewer issue artifact',
  taskDiff: 'current task diff',
  branchDiff: 'aggregate branch diff',
  resultIndex: 'plan and task-result index',
  ledger: 'implementation task ledger',
  hub: 'hub context if a concrete missing fact requires it',
  upstream: 'upstream context if the task brief is insufficient',
});

function safeRoot(value) {
  assertSafeLine(value, 'repo root');
  return assertSafeHubRoot(value);
}

function safeInteger(value, label, { minimum = 1, optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`invalid ${label}: expected an integer >= ${minimum}`);
  }
  return value;
}

function safeTier(value) {
  assertSafeLine(value, 'modelTier');
  if (!MODEL_TIERS.includes(value)) {
    throw new Error(`unknown model tier '${value}': expected ${MODEL_TIERS.join(' | ')}`);
  }
  return value;
}

function safeRole(value) {
  assertSafeLine(value, 'role');
  if (!KNOWN_ROLES.has(value)) throw new Error(`unknown context role '${value}'`);
  return value;
}

function safeStringArray(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${label} must be a list`);
  return values.map((value, index) => assertSafeLine(value, `${label}[${index}]`));
}

function markdownField(section, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(section).match(new RegExp(
    `^\\s*[-*]?\\s*(?:\\*\\*${escaped}(?::\\*\\*|\\*\\*:)|${escaped}:)\\s*(.*?)\\s*$`, 'im',
  ));
  if (!match) return undefined;
  return match[1].trim().replace(/^`([^`]*)`$/, '$1').trim();
}

function complexityValue(raw, label) {
  const value = String(raw ?? '').replace(/[`*_]/g, '').trim().toLowerCase();
  if (!Object.hasOwn(COMPLEXITY_TIER, value)) {
    throw new Error(`malformed ${label}: expected mechanical | integration | design`);
  }
  return value;
}

function plainMetadataValue(raw) {
  return String(raw ?? '').replace(/[`*_]/g, '').trim();
}

function surfaceList(raw) {
  const clean = plainMetadataValue(raw);
  if (!clean || /^none$/i.test(clean)) return [];
  return clean.split(',').map((value) => value.trim()).filter(Boolean);
}

function surfaceMetadata(owningRaw, crossCuttingRaw) {
  if (owningRaw === undefined) return { owningSurface: undefined, crossCuttingSurfaces: [] };
  const owningSurface = plainMetadataValue(owningRaw);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owningSurface)) {
    throw new Error('Owning surface must name exactly one surface; use Cross-cutting surfaces separately');
  }
  return { owningSurface, crossCuttingSurfaces: surfaceList(crossCuttingRaw) };
}

export function specPhaseContext(specText) {
  const complexityRaw = markdownField(specText, 'Feature complexity');
  const surfaces = surfaceMetadata(
    markdownField(specText, 'Owning surface'),
    markdownField(specText, 'Cross-cutting surfaces'),
  );
  if (!surfaces.owningSurface) {
    throw new Error('spec is missing Owning surface metadata');
  }
  if (complexityRaw === undefined) throw new Error('spec is missing Feature complexity metadata');
  const complexity = complexityValue(complexityRaw, 'Feature complexity');
  return {
    ...surfaces,
    complexity,
    modelTier: COMPLEXITY_TIER[complexity],
    evidence: `spec:Feature-complexity=${complexity}`,
  };
}

export function planPhaseContext(planText, { review = false } = {}) {
  const text = String(planText ?? '');
  // Discover every H2 Task-like boundary before validating any identifier. If
  // discovery starts from the valid-ID regex, a malformed task after a valid one
  // silently becomes prose inside the preceding task and disappears downstream.
  const taskLikeHeadings = [...text.matchAll(/^##[ \t]+Task\b[^\r\n]*$/gim)];
  if (taskLikeHeadings.length === 0) throw new Error('approved plan contains no Task headings');
  const headings = taskLikeHeadings.map((heading) => {
    const canonical = heading[0].match(
      /^##[ \t]+Task[ \t]+([1-9]\d*)(?:(?:[ \t]+.+)|(?:[ \t]*(?:—|-|:|\)|\.)[ \t]*.*))?[ \t]*$/i,
    );
    if (!canonical) throw new Error(`invalid H2 Task heading '${heading[0]}'`);
    return { 0: heading[0], 1: canonical[1], index: heading.index };
  });
  const seenTaskIds = new Set();
  let previousTaskNumber = 0;
  for (const heading of headings) {
    const id = heading[1];
    const taskNumber = Number(id);
    if (!Number.isSafeInteger(taskNumber)) {
      throw new Error(`plan task id '${id}' must be a positive safe integer`);
    }
    if (seenTaskIds.has(id)) throw new Error(`duplicate plan task id '${id}'`);
    if (taskNumber <= previousTaskNumber) {
      throw new Error(`plan task ids must be strictly increasing: ${previousTaskNumber} then ${taskNumber}`);
    }
    seenTaskIds.add(id);
    previousTaskNumber = taskNumber;
  }
  const tasks = headings.map((heading, index) => {
    const section = text.slice(heading.index, headings[index + 1]?.index ?? text.length);
    const complexityRaw = markdownField(section, 'Complexity');
    if (complexityRaw === undefined) throw new Error(`Task ${heading[1]} is missing Complexity evidence`);
    const complexity = complexityValue(complexityRaw, `Task ${heading[1]} Complexity`);
    const surface = markdownField(section, 'Surface');
    if (!surface) throw new Error(`Task ${heading[1]} is missing Surface evidence`);
    const testCommand = markdownField(section, 'Test command');
    const criteria = markdownField(section, 'Success criteria');
    if (criteria === undefined) throw new Error(`Task ${heading[1]} is missing Success criteria evidence`);
    const { criterionIds } = parseSuccessCriteria(criteria, { label: `Task ${heading[1]} Success criteria` });
    return {
      task: assertSafeLine(heading[1], 'task identifier'),
      owningSurface: assertSafeLine(surface.replace(/[`*_]/g, '').trim(), `Task ${heading[1]} surface`),
      complexity,
      ...(testCommand === undefined ? {} : {
        testCommand: assertSafeLine(testCommand.replace(/[`*_]/g, '').trim(), `Task ${heading[1]} test command`),
      }),
      criterionIds,
    };
  });
  const distribution = complexityDistribution(tasks);
  const allMechanical = distribution.mechanical === tasks.length;
  const eligibleTier = allMechanical ? 'cheap' : 'standard';
  const modelTier = review && eligibleTier === 'cheap' ? 'standard' : eligibleTier;
  const testCommands = [...new Set(tasks.map((task) => task.testCommand).filter(Boolean))];
  const criterionIds = [...new Set(tasks.flatMap((task) => task.criterionIds))];
  return {
    tasks,
    modelTier,
    ...(testCommands.length === 1 ? { testCommand: testCommands[0] } : {}),
    criterionIds,
    evidence: review && eligibleTier === 'cheap'
      ? `phase-controller-tier=${modelTier};${distributionToken(distribution)};reviewer-floor=standard`
      : `phase-controller-tier=${modelTier};${distributionToken(distribution)}`,
  };
}

export function reviewPhaseContext(planText, resultIndexText) {
  const plan = planPhaseContext(planText);
  const planTasks = new Map();
  for (const task of plan.tasks) {
    const key = task.task.toLowerCase();
    if (planTasks.has(key)) throw new Error(`duplicate plan task id '${task.task}'`);
    planTasks.set(key, task);
  }

  const reviewedIds = [];
  const seen = new Set();
  const normalizedIndex = String(resultIndexText ?? '').replace(/\r\n?/g, '\n');
  const projection = parseTaskResultProjection(normalizedIndex);
  const recordId = (id) => {
    const key = id.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate reviewed task id '${id}'`);
    if (!planTasks.has(key)) throw new Error(`unknown reviewed task id '${id}'`);
    seen.add(key);
    reviewedIds.push(id);
  };
  if (projection !== null) {
    for (const entry of projection) recordId(entry.task);
  }
  for (const line of projection === null ? normalizedIndex.split('\n') : []) {
    if (!/^\s*[-*]\s+Task\b/i.test(line)) continue;
    const match = line.match(/^- Task ([A-Za-z0-9]+): (DONE|DONE_WITH_CONCERNS); artifact: ([^;]+); changed-paths: ([^;]+); signals: ([^;]+)$/);
    if (!match) throw new Error(`malformed reviewed task entry: ${line.trim()}`);
    const id = assertSafeLine(match[1], 'reviewed task id');
    if (match[3] !== match[3].trim() || match[4] !== match[4].trim() || match[5] !== match[5].trim()) {
      throw new Error(`malformed reviewed task entry: ${line.trim()}`);
    }
    assertSafeRelPath(match[3], `Task ${id} result artifact`);
    const changedPaths = match[4];
    if (changedPaths !== 'none') {
      for (const path of changedPaths.split(',').map((value) => value.trim())) {
        assertSafeRelPath(path, `Task ${id} changed path`);
      }
    }
    if (!/^(?:none|[A-Za-z0-9][A-Za-z0-9:._-]*(?:,\s*[A-Za-z0-9][A-Za-z0-9:._-]*)*)$/.test(match[5])) {
      throw new Error(`malformed reviewed task signals for Task ${id}`);
    }
    recordId(id);
  }
  if (reviewedIds.length === 0) throw new Error('task result index contains no reviewed task entries');
  const omittedIds = plan.tasks
    .map((task) => task.task)
    .filter((id) => !seen.has(id.toLowerCase()));
  if (omittedIds.length > 0) {
    throw new Error(`task result index omits plan task ids: ${omittedIds.join(', ')}`);
  }

  const tasks = reviewedIds.map((id) => planTasks.get(id.toLowerCase()));
  const distribution = complexityDistribution(tasks);
  const allMechanical = distribution.mechanical === tasks.length;
  const eligibleTier = allMechanical ? 'cheap' : 'standard';
  const modelTier = eligibleTier === 'cheap' ? 'standard' : eligibleTier;
  const testCommands = [...new Set(tasks.map((task) => task.testCommand).filter(Boolean))];
  const criterionIds = [...new Set(tasks.flatMap((task) => task.criterionIds))];
  return {
    tasks,
    modelTier,
    ...(testCommands.length === 1 ? { testCommand: testCommands[0] } : {}),
    criterionIds,
    evidence: [
      `result-index:reviewed-tasks=${reviewedIds.join(',')}`,
      `phase-controller-tier=${modelTier}`,
      distributionToken(distribution),
      ...(eligibleTier === 'cheap' ? ['reviewer-floor=standard'] : []),
    ].join(';'),
  };
}

function assertCriteriaOnlyPath(path, label = 'review criteria path') {
  const safePath = assertSafeRelPath(path, label);
  try {
    return parseWorkPath(safePath, 'criteria', 'criteria').path;
  } catch (error) {
    throw new Error(`${label} must name a criteria-only artifact: ${error.message}`);
  }
}

function assertSpecSourcePath(path) {
  const safePath = assertSafeRelPath(path, 'criteria source spec path');
  try {
    return parseWorkPath(safePath, 'spec', 'spec').path;
  } catch (error) {
    throw new Error(`criteria source must be a canonical spec under .apex/work/specs/: ${error.message}`);
  }
}

// One strict success-criteria grammar shared by every call site. Section mode
// parses a document's single `## Success criteria` H2 and requires the spec's
// canonical SC1…SCn sequence; field mode parses an extracted task mapping,
// whose unique IDs stay in source order but may skip criteria owned by another
// task. BigInt comparison keeps arbitrarily long digit strings from collapsing
// through Number overflow.
export function parseSuccessCriteria(source, { section = false, label = 'success criteria' } = {}) {
  const text = String(source ?? '');
  const headings = [...text.matchAll(/^##[ \t]+Success criteria[ \t]*$/gim)];
  if (section && headings.length !== 1) {
    throw new Error(`${label} must contain exactly one '## Success criteria' heading; found ${headings.length}`);
  }
  let heading;
  let sectionText;
  let target = text;
  if (section) {
    heading = headings[0][0];
    const start = headings[0].index;
    const remainder = text.slice(start + heading.length);
    const nextHeading = remainder.search(/^#{1,2}\s+/m);
    sectionText = text.slice(start, nextHeading === -1 ? text.length : start + heading.length + nextHeading)
      .trimEnd();
    target = sectionText;
  }
  const criterionIds = [];
  for (const match of target.matchAll(/\bSC\d+\b/g)) {
    const id = match[0];
    if (!/^SC[1-9]\d*$/.test(id)) {
      throw new Error(`${label}: invalid success-criterion ID '${id}': IDs are SC<n> with n >= 1 and no leading zeros`);
    }
    criterionIds.push(id);
  }
  if (criterionIds.length === 0) {
    throw new Error(`${label} is missing success-criterion IDs`);
  }
  const seen = new Set();
  for (const id of criterionIds) {
    if (seen.has(id)) throw new Error(`${label}: duplicate success-criterion ID '${id}'`);
    seen.add(id);
  }
  for (let index = 1; index < criterionIds.length; index += 1) {
    const previous = BigInt(criterionIds[index - 1].slice(2));
    const current = BigInt(criterionIds[index].slice(2));
    if (section && current !== previous + 1n) {
      throw new Error(`${label}: success-criterion IDs must be strictly sequential: ${criterionIds[index - 1]} then ${criterionIds[index]}`);
    }
    if (!section && current <= previous) {
      throw new Error(`${label}: success-criterion IDs must be strictly increasing: ${criterionIds[index - 1]} then ${criterionIds[index]}`);
    }
  }
  if (section && criterionIds[0] !== 'SC1') {
    throw new Error(`${label}: success-criterion IDs must start at SC1`);
  }
  return {
    criterionIds,
    ...(section ? { heading, section: sectionText } : {}),
  };
}

export function materializeSuccessCriteria({ repoRoot, specPath, outputPath }) {
  const root = safeRoot(repoRoot);
  const sourcePath = assertSpecSourcePath(specPath);
  const destinationPath = assertCriteriaOnlyPath(outputPath, 'criteria artifact path');
  const source = readWorkPath(root, sourcePath, { expect: 'spec', encoding: 'utf8' });
  const { heading, section } = parseSuccessCriteria(source, { section: true, label: 'criteria source' });
  const contents = [
    '# Review criteria',
    '',
    `Source: \`${sourcePath}\``,
    `Heading: \`${heading}\``,
    '',
    section,
    '',
  ].join('\n');
  writeWorkPath(root, destinationPath, contents, { expect: 'criteria', family: 'criteria' });
  return {
    path: destinationPath,
    bytes: Buffer.byteLength(contents),
    sourcePath,
    heading,
  };
}

export function standardsBySurfaceFromRouting(routingText, { repoRoot } = {}) {
  const result = {};
  for (const line of String(routingText ?? '').split('\n')) {
    const match = line.match(/^\s*\|\s*`([^`]+)`\s*\|[^|]*\]\(([^)]+)\)/);
    if (!match) continue;
    const surface = assertSafeLine(match[1], 'routing surface');
    const linked = assertSafeRelPath(match[2], `standard path for ${surface}`);
    const core = assertSafeRelPath(join('.apex', linked), `standard path for ${surface}`);
    if (repoRoot === undefined || !core.endsWith('-core.md')) {
      result[surface] = core;
      continue;
    }
    const root = safeRoot(repoRoot);
    const coreText = readFileSync(join(root, core), 'utf8');
    const leaves = [];
    for (const row of coreText.split('\n')) {
      const leaf = row.match(/^\s*\|[^|]+\|[^|]+\|[^|]*\]\(([^)]+)\)\s*\|/);
      if (!leaf) continue;
      const leafPath = assertSafeRelPath(join(dirname(core), leaf[1]), `leaf standard path for ${surface}`);
      if (leafPath === core || leaves.includes(leafPath)) continue;
      leaves.push(leafPath);
    }
    result[surface] = leaves.length === 0 ? core : { core, leaves };
  }
  return result;
}

function safePaths(values, label) {
  return safeStringArray(values, label).map((path) => assertSafeRelPath(path, label));
}

function scalarContract(contract) {
  if (contract === undefined) return undefined;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('contract metadata must be an object of scalar values');
  }
  const result = {};
  for (const [key, value] of Object.entries(contract)) {
    assertSafeLine(key, 'contract metadata key');
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`unsafe contract metadata key '${key}'`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`contract metadata '${key}' must be a finite scalar`);
    }
    if (typeof value === 'string') assertSafeLine(value, `contract metadata '${key}'`);
    result[key] = value;
  }
  return result;
}

function rejectUnexpectedProperties(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unexpected ${label} property '${key}'`);
  }
}

function inspectPath(repoRoot, path, purpose, read, required) {
  assertSafeRelPath(path, `${required ? 'required' : 'on-demand'} path`);
  assertSafeLine(purpose, 'input purpose');
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute)) {
    if (required) throw new Error(`required input does not exist: ${path}`);
    return { path, purpose, read, available: false };
  }
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    if (required) throw new Error(`required input is not a file: ${path}`);
    return { path, purpose, read, available: false };
  }
  return { path, purpose, read, bytes: stat.size, available: true };
}

function required(repoRoot, path, purpose) {
  if (path === undefined) throw new Error(`missing required named path for ${purpose}`);
  return inspectPath(repoRoot, path, purpose, 'full', true);
}

function onDemand(repoRoot, path, purpose) {
  return inspectPath(repoRoot, path, purpose, 'on-demand', false);
}

function optionalOnDemand(repoRoot, path, purpose) {
  return path === undefined ? [] : [onDemand(repoRoot, path, purpose)];
}

function commonManifest(input, { phase, role, task, objective, requiredInputs, onDemandInputs }) {
  const repoRoot = safeRoot(input.repoRoot);
  const runId = assertSafeLine(input.runId, 'runId');
  if (!runId) throw new Error('runId must not be empty');
  const manifest = {
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    runId,
    scope: {
      phase,
      ...(task === undefined ? {} : { task: safeInteger(task, 'task') }),
      role: safeRole(role),
    },
    objective: assertSafeLine(objective, 'objective'),
    required: requiredInputs(repoRoot),
    onDemand: onDemandInputs(repoRoot),
    outputs: safePaths(input.outputs, 'output path'),
    modelTier: safeTier(input.modelTier),
  };
  if (input.attempt !== undefined) manifest.attempt = safeInteger(input.attempt, 'attempt');
  if (input.testCommand !== undefined) manifest.testCommand = assertSafeLine(input.testCommand, 'testCommand');
  if (input.criterionIds !== undefined) manifest.criterionIds = safeStringArray(input.criterionIds, 'criterionIds');
  const contract = scalarContract(input.contract);
  if (contract !== undefined) manifest.contract = contract;
  return validateContextManifest(manifest, { repoRoot });
}

function taskInput(input, config) {
  return commonManifest(input, {
    phase: 'implement',
    task: input.task,
    ...config,
  });
}

function inputSurface(task, index) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error(`tasks[${index}] must be an object`);
  }
  const value = task.owningSurface ?? task.surface;
  if (value === undefined) throw new Error(`tasks[${index}] is missing owningSurface`);
  return assertSafeLine(value, `tasks[${index}].owningSurface`);
}

// Two classes of implicated surface, deliberately not treated alike. An owning or
// per-task surface is a routing fact the plan and the specialist binding depend on:
// an unregistered one is a real binding error and halts. Cross-cutting metadata is
// human prose ("stable hub docs" alongside real surfaces), so an unregistered entry
// is reported through `onUnroutedSurface` and skipped — halting a run over one word
// in a list would turn advisory context into a binding requirement.
// A surface named in both classes keeps the strict treatment.
export function deriveImplicatedStandardPaths({
  owningSurface, crossCuttingSurfaces = [], tasks = [], standardsBySurface, onUnroutedSurface,
}) {
  if (!standardsBySurface || typeof standardsBySurface !== 'object' || Array.isArray(standardsBySurface)) {
    throw new Error('standardsBySurface must be an object');
  }
  if (onUnroutedSurface !== undefined && typeof onUnroutedSurface !== 'function') {
    throw new TypeError('onUnroutedSurface must be a function');
  }
  if (!Array.isArray(tasks)) throw new Error('tasks must be a list');

  const order = [];
  const mustRoute = new Set();
  const record = (surface, required) => {
    if (!order.includes(surface)) order.push(surface);
    if (required) mustRoute.add(surface);
  };
  if (owningSurface !== undefined) record(assertSafeLine(owningSurface, 'owningSurface'), true);
  for (const surface of safeStringArray(crossCuttingSurfaces, 'crossCuttingSurfaces')) {
    record(surface, false);
  }
  tasks.forEach((task, index) => record(inputSurface(task, index), true));

  const paths = [];
  for (const surface of order) {
    if (!Object.hasOwn(standardsBySurface, surface)) {
      if (mustRoute.has(surface)) {
        throw new Error(`no standard path registered for implicated surface '${surface}'`);
      }
      onUnroutedSurface?.(surface);
      continue;
    }
    const entry = standardsBySurface[surface];
    if (typeof entry === 'string') {
      paths.push(assertSafeRelPath(entry, `standard path for ${surface}`));
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.core !== 'string' || !Array.isArray(entry.leaves)) {
      throw new Error(`invalid modular standard routing for surface '${surface}'`);
    }
    paths.push(assertSafeRelPath(entry.core, `core standard path for ${surface}`));
    paths.push(...safePaths(entry.leaves, `leaf standard path for ${surface}`));
  }
  return [...new Set(paths)];
}

function implicatedStandardInventory(input) {
  const allPaths = deriveImplicatedStandardPaths(input);
  const conditional = new Set();
  for (const entry of Object.values(input.standardsBySurface)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const path of safePaths(entry.leaves, 'leaf standard path')) conditional.add(path);
  }
  return {
    required: allPaths.filter((path) => !conditional.has(path)),
    conditional: allPaths.filter((path) => conditional.has(path)),
  };
}

function selectedStandardPaths(input) {
  const values = input.standardPaths ?? (input.standardPath === undefined ? [] : [input.standardPath]);
  const paths = safePaths(values, 'standard path');
  if (paths.length === 0) throw new Error('task role requires at least one standard path');
  const seen = new Set();
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`duplicate standard path '${path}'`);
    seen.add(path);
  }
  return paths;
}

export function buildImplementerManifest(input) {
  const standards = selectedStandardPaths(input);
  return taskInput(input, {
    role: 'implementer',
    objective: `Implement Task ${safeInteger(input.task, 'task')} from its approved brief`,
    requiredInputs: (root) => [
      required(root, input.briefPath, PURPOSES.brief),
      ...standards.map((path) => required(root, path, 'owning standard')),
    ],
    onDemandInputs: (root) => [
      ...optionalOnDemand(root, input.planPath, PURPOSES.upstream),
      ...optionalOnDemand(root, input.specPath, PURPOSES.upstream),
      ...optionalOnDemand(root, input.hubIndexPath, PURPOSES.hub),
      ...safePaths(input.diffPaths, 'diff path').map((path) => onDemand(root, path, PURPOSES.taskDiff)),
    ],
  });
}

export function buildTaskReviewerManifest(input) {
  const standards = selectedStandardPaths(input);
  return taskInput(input, {
    role: 'task-reviewer',
    objective: `Review Task ${safeInteger(input.task, 'task')} against its approved brief`,
    requiredInputs: (root) => [
      required(root, input.briefPath, PURPOSES.brief),
      required(root, input.reportPath, PURPOSES.report),
      required(root, input.taskDiffPath, PURPOSES.taskDiff),
      ...standards.map((path) => required(root, path, 'owning standard')),
    ],
    onDemandInputs: (root) => optionalOnDemand(root, input.hubIndexPath, PURPOSES.hub),
  });
}

export function buildFixManifest(input) {
  const standards = selectedStandardPaths(input);
  return taskInput(input, {
    role: 'fix',
    objective: `Fix the recorded issues for Task ${safeInteger(input.task, 'task')}`,
    requiredInputs: (root) => [
      required(root, input.briefPath, PURPOSES.brief),
      required(root, input.issuePath, PURPOSES.issue),
      required(root, input.taskDiffPath, PURPOSES.taskDiff),
      ...standards.map((path) => required(root, path, 'owning standard')),
    ],
    onDemandInputs: () => [],
  });
}

export function buildFinalReviewManifest(input) {
  if ((input.standardPaths ?? []).length === 0 && input.standardPath === undefined) {
    throw new Error('final-review requires at least one relevant standard');
  }
  const standardPaths = selectedStandardPaths(input);
  return commonManifest(input, {
    phase: 'implement',
    role: 'final-review',
    objective: 'Review the completed branch against the approved success criteria',
    requiredInputs: (root) => [
      required(root, assertCriteriaOnlyPath(input.criteriaPath), PURPOSES.criteria),
      required(root, input.taskResultIndexPath, PURPOSES.resultIndex),
      required(root, input.branchDiffPath, PURPOSES.branchDiff),
      ...standardPaths.map((path) => required(root, path, PURPOSES.standard)),
    ],
    onDemandInputs: () => [],
  });
}

export function buildTaskManifest(role, input) {
  safeRole(role);
  const builders = {
    implementer: buildImplementerManifest,
    'task-reviewer': buildTaskReviewerManifest,
    fix: buildFixManifest,
    'final-review': buildFinalReviewManifest,
  };
  if (!Object.hasOwn(builders, role)) throw new Error(`'${role}' is not a task role`);
  return builders[role](input);
}

function implicatedStandards(input) {
  return implicatedStandardInventory({
    owningSurface: input.owningSurface,
    crossCuttingSurfaces: input.crossCuttingSurfaces,
    tasks: input.tasks,
    standardsBySurface: input.standardsBySurface,
    onUnroutedSurface: input.onUnroutedSurface,
  });
}

export function buildPlanManifest(input) {
  const standards = implicatedStandards(input);
  return commonManifest(input, {
    phase: 'plan',
    role: 'plan',
    objective: 'Produce an implementation plan from the approved specification',
    requiredInputs: (root) => [
      required(root, input.specPath, PURPOSES.spec),
      required(root, input.routingPath, PURPOSES.routing),
      required(root, input.testingPath, PURPOSES.testing),
      ...standards.required.map((path) => required(root, path, PURPOSES.standard)),
    ],
    onDemandInputs: (root) => [
      ...standards.conditional.map((path) => onDemand(root, path, 'conditional surface standard')),
      ...safePaths(input.otherHubPaths, 'on-demand hub path')
        .filter((path) => !standards.required.includes(path) && !standards.conditional.includes(path))
        .map((path) => onDemand(root, path, PURPOSES.hub)),
    ],
  });
}

export function buildImplementManifest(input) {
  // Preserve deterministic routing validation without making task standards eager
  // controller context. Task-local child manifests still load their owning standard.
  const standards = implicatedStandards(input);
  return commonManifest(input, {
    phase: 'implement',
    role: 'implement',
    objective: 'Execute the approved plan through task-local artifacts',
    requiredInputs: (root) => [
      required(root, input.planPath, PURPOSES.plan),
    ],
    onDemandInputs: (root) => [
      onDemand(root, input.routingPath, PURPOSES.routing),
      ...standards.required.map((path) => onDemand(root, path, PURPOSES.standard)),
      ...standards.conditional.map((path) => onDemand(root, path, 'conditional surface standard')),
      onDemand(root, input.ledgerPath, PURPOSES.ledger),
      ...optionalOnDemand(root, input.taskResultIndexPath, PURPOSES.resultIndex),
      ...optionalOnDemand(root, input.specPath, PURPOSES.upstream),
    ],
  });
}

export function buildReviewManifest(input) {
  const standards = implicatedStandards(input);
  return commonManifest(input, {
    phase: 'review',
    role: 'review',
    objective: 'Verify branch evidence against the approved success criteria',
    requiredInputs: (root) => [
      required(root, assertCriteriaOnlyPath(input.criteriaPath), PURPOSES.criteria),
      required(root, input.taskResultIndexPath, PURPOSES.resultIndex),
      required(root, input.branchDiffPath, PURPOSES.branchDiff),
      ...standards.required.map((path) => required(root, path, PURPOSES.standard)),
    ],
    onDemandInputs: (root) => [
      ...standards.conditional.map((path) => onDemand(root, path, 'conditional surface standard')),
      ...safePaths(input.otherHubPaths, 'on-demand hub path')
        .filter((path) => !standards.required.includes(path) && !standards.conditional.includes(path))
        .map((path) => onDemand(root, path, PURPOSES.hub)),
    ],
  });
}

export function buildPhaseManifest(role, input) {
  safeRole(role);
  const builders = { plan: buildPlanManifest, implement: buildImplementManifest, review: buildReviewManifest };
  if (!Object.hasOwn(builders, role)) throw new Error(`'${role}' is not a phase role`);
  return builders[role](input);
}

function validateInputEntry(entry, index, list, repoRoot) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${list}[${index}] must be an object`);
  }
  rejectUnexpectedProperties(entry, INPUT_KEYS, `${list}[${index}]`);
  const requiredEntry = list === 'required';
  assertSafeRelPath(entry.path, `${requiredEntry ? 'required' : 'on-demand'} path`);
  assertSafeLine(entry.purpose, `${list}[${index}].purpose`);
  const expectedRead = requiredEntry ? 'full' : 'on-demand';
  if (entry.read !== expectedRead) throw new Error(`${list}[${index}].read must be '${expectedRead}'`);
  const absolute = join(repoRoot, entry.path);
  const available = existsSync(absolute) && statSync(absolute).isFile();
  if (requiredEntry && !available) throw new Error(`required input does not exist: ${entry.path}`);
  if (entry.available !== available) throw new Error(`${list}[${index}].available does not match repository state`);
  if (available) {
    const bytes = statSync(absolute).size;
    if (entry.bytes !== bytes) throw new Error(`${list}[${index}].bytes does not match repository state`);
  } else if (entry.bytes !== undefined) {
    throw new Error(`${list}[${index}].bytes must be absent when the path is unavailable`);
  }
  return {
    path: entry.path,
    purpose: entry.purpose,
    read: expectedRead,
    ...(available ? { bytes: entry.bytes } : {}),
    available,
  };
}

export function validateContextManifest(manifest, { repoRoot }) {
  const root = safeRoot(repoRoot);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be an object');
  rejectUnexpectedProperties(manifest, MANIFEST_KEYS, 'manifest');
  if (manifest.schemaVersion !== CONTEXT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported context manifest schemaVersion '${manifest.schemaVersion}'`);
  }
  assertSafeLine(manifest.runId, 'runId');
  if (!manifest.scope || typeof manifest.scope !== 'object' || Array.isArray(manifest.scope)) throw new Error('scope must be an object');
  rejectUnexpectedProperties(manifest.scope, SCOPE_KEYS, 'scope');
  const role = safeRole(manifest.scope.role);
  if (!PHASE_ROLES.includes(manifest.scope.phase)) throw new Error(`unknown context phase '${manifest.scope.phase}'`);
  if (manifest.scope.phase !== ROLE_PHASE[role]) {
    throw new Error(`role '${role}' requires phase '${ROLE_PHASE[role]}'`);
  }
  let task;
  if (TASK_SCOPED_ROLES.has(role)) {
    task = safeInteger(manifest.scope.task, 'task');
  } else if (manifest.scope.task !== undefined) {
    throw new Error(`phase role '${role}' must not declare a task`);
  }
  const objective = assertSafeLine(manifest.objective, 'objective');
  if (!Array.isArray(manifest.required) || !Array.isArray(manifest.onDemand)) throw new Error('required and onDemand must be lists');
  const requiredInputs = manifest.required.map((entry, index) => validateInputEntry(entry, index, 'required', root));
  const onDemandInputs = manifest.onDemand.map((entry, index) => validateInputEntry(entry, index, 'onDemand', root));
  const outputs = safePaths(manifest.outputs, 'output path');
  const modelTier = safeTier(manifest.modelTier);
  if (role === 'review' || role === 'final-review') {
    const criteria = requiredInputs.find((entry) => entry.purpose === PURPOSES.criteria);
    if (!criteria) throw new Error(`role '${role}' requires a criteria-only artifact`);
    assertCriteriaOnlyPath(criteria.path);
  }
  const normalized = {
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    runId: manifest.runId,
    scope: {
      phase: manifest.scope.phase,
      ...(task === undefined ? {} : { task }),
      role,
    },
    objective,
    required: requiredInputs,
    onDemand: onDemandInputs,
    outputs,
    modelTier,
  };
  if (manifest.attempt !== undefined) normalized.attempt = safeInteger(manifest.attempt, 'attempt');
  if (manifest.testCommand !== undefined) normalized.testCommand = assertSafeLine(manifest.testCommand, 'testCommand');
  if (manifest.criterionIds !== undefined) normalized.criterionIds = safeStringArray(manifest.criterionIds, 'criterionIds');
  if (manifest.contract !== undefined) normalized.contract = scalarContract(manifest.contract);
  return normalized;
}

export function writeContextManifest(manifest, { repoRoot, manifestPath }) {
  const root = safeRoot(repoRoot);
  const path = parseWorkPath(
    assertSafeRelPath(manifestPath, 'manifest path'),
    'work-output',
    'manifest',
  ).path;
  const normalized = validateContextManifest(manifest, { repoRoot: root });
  const json = `${JSON.stringify(normalized, null, 2)}\n`;
  writeWorkPath(root, path, json, { expect: 'work-output', family: 'manifest' });
  return { path, bytes: Buffer.byteLength(json), manifest: normalized };
}

export function manifestReferencePrompt({ phase, manifestPath, skill, runId, attempt }) {
  if (!PHASE_ROLES.includes(phase)) throw new Error(`unknown context phase '${phase}'`);
  assertSafeRelPath(manifestPath, 'manifest path');
  assertSafeLine(skill, 'skill');
  const expectedSkill = `steepy-apex:${phase}`;
  if (skill !== expectedSkill) {
    throw new Error(`skill '${skill}' does not match phase '${phase}'; expected '${expectedSkill}'`);
  }
  assertSafeLine(runId, 'runId');
  safeInteger(attempt, 'attempt');
  return [
    `Invoke the ${skill.slice(0, skill.indexOf(':'))} '${skill.slice(skill.indexOf(':') + 1)}' skill.`,
    `Context manifest: ${manifestPath} (authoritative input inventory).`,
    `run-id \`${runId}\`; attempt \`${attempt}\`; echo both in status markers.`,
    'Read required; use onDemand only for a concrete missing fact.',
  ].join(' ');
}

const CLI_PATH_OPTIONS = Object.freeze([
  'brief', 'report', 'task-diff', 'standard', 'hub-index', 'plan', 'spec', 'issue',
  'criteria', 'task-result-index', 'branch-diff', 'artifact-output',
]);

const ROLE_OPTIONS = Object.freeze({
  implementer: new Set(['brief', 'standard', 'plan', 'spec', 'hub-index']),
  'task-reviewer': new Set(['brief', 'report', 'task-diff', 'standard', 'hub-index']),
  fix: new Set(['brief', 'issue', 'task-diff', 'standard']),
  'final-review': new Set(['criteria', 'task-result-index', 'branch-diff', 'standard']),
});

function cliInput(values, repoRoot) {
  const role = safeRole(values.role);
  if (!TASK_ROLES.includes(role)) throw new Error(`CLI only creates task-role manifests, got '${role}'`);
  const allowed = ROLE_OPTIONS[role];
  if (values['task-result-protocol'] !== undefined && !['1', '2'].includes(values['task-result-protocol'])) {
    throw new Error('--task-result-protocol must be 1 or 2');
  }
  for (const option of CLI_PATH_OPTIONS) {
    if (values[option] !== undefined && option !== 'artifact-output' && !allowed.has(option)) {
      throw new Error(`--${option} is not valid for role ${role}`);
    }
  }
  const common = {
    repoRoot,
    runId: values['run-id'],
    modelTier: values['model-tier'],
    task: values.task === undefined ? undefined : Number(values.task),
    testCommand: values['test-command'],
    criterionIds: values.criterion,
    outputs: values['artifact-output'],
    ...(values['task-result-protocol'] === undefined ? {} : { contract: { taskResultProtocol: Number(values['task-result-protocol']) } }),
  };
  const standards = values.standard ?? [];
  return {
    role,
    input: {
      ...common,
      briefPath: values.brief,
      reportPath: values.report,
      taskDiffPath: values['task-diff'],
      standardPaths: standards,
      hubIndexPath: values['hub-index'],
      planPath: values.plan,
      specPath: values.spec,
      issuePath: values.issue,
      criteriaPath: values.criteria,
      taskResultIndexPath: values['task-result-index'],
      branchDiffPath: values['branch-diff'],
    },
  };
}

// The review phase parses the implement handoff before it can build a manifest, so
// a malformed bullet is only discovered after implement has spent its whole budget —
// at a gate no child can recover from. This exposes the identical parse as a check
// implement runs on itself, one step before it claims DONE, where the failure is
// still a concrete fixable message instead of a halted run.
function suppliedOptionsOutside(values, accepted) {
  return Object.entries(values)
    .filter(([option, value]) => value !== undefined && value !== false && !accepted.has(option))
    .map(([option]) => option);
}

// Work-path inputs (.apex/work/**) ride the typed confined read, mirroring the
// conductor's readArtifact boundary; any other input keeps the lexical guard,
// because hub docs sit outside the .apex/work/ contract of work-paths.mjs.
function readRepoFile(repoRoot, path, label) {
  const safePath = assertSafeRelPath(path, label);
  if (safePath.startsWith('.apex/work/')) {
    return readWorkPath(repoRoot, safePath, { expect: 'work-output', encoding: 'utf8' });
  }
  return readFileSync(join(repoRoot, safePath), 'utf8');
}

function verifyPlan(values) {
  const usage = 'usage: autopilot-context.mjs --verify-plan --repo-root <root> --plan <plan-path>';
  const accepted = new Set(['verify-plan', 'repo-root', 'plan']);
  if (!values['repo-root'] || !values.plan || suppliedOptionsOutside(values, accepted).length > 0) {
    console.error(usage);
    return 2;
  }
  try {
    const repoRoot = safeRoot(values['repo-root']);
    const route = planPhaseContext(readRepoFile(repoRoot, values.plan, 'plan path'));
    console.log(`plan OK — ${route.tasks.length} task(s): ${route.tasks.map((task) => task.task).join(', ')}`);
    return 0;
  } catch (error) {
    console.error(`autopilot-context: plan rejected: ${error.message}`);
    return 1;
  }
}

function verifyHandoff(values) {
  const usage = 'usage: autopilot-context.mjs --verify-handoff --repo-root <root> --plan <plan-path> --task-result-index <index-path>';
  const accepted = new Set(['verify-handoff', 'repo-root', 'plan', 'task-result-index']);
  if (!values['repo-root'] || !values.plan || !values['task-result-index']
    || suppliedOptionsOutside(values, accepted).length > 0) {
    console.error(usage);
    return 2;
  }
  try {
    const repoRoot = safeRoot(values['repo-root']);
    const read = (path, label) => readRepoFile(repoRoot, path, label);
    const route = reviewPhaseContext(
      read(values.plan, 'plan path'),
      read(values['task-result-index'], 'task-result-index path'),
    );
    const ids = route.tasks.map((task) => task.task).join(', ');
    console.log(`handoff OK — ${route.tasks.length} reviewed task(s): ${ids}`);
    return 0;
  } catch (error) {
    console.error(`autopilot-context: handoff rejected: ${error.message}`);
    return 1;
  }
}

export function main(argv = process.argv.slice(2)) {
  const usage = 'usage: autopilot-context.mjs --role <implementer|task-reviewer|fix|final-review> --repo-root <root> --run-id <id> --model-tier <tier> --output <manifest-path> [role-specific named paths]';
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        role: { type: 'string' },
        'repo-root': { type: 'string' },
        'run-id': { type: 'string' },
        'task-result-protocol': { type: 'string' },
        task: { type: 'string' },
        'model-tier': { type: 'string' },
        'test-command': { type: 'string' },
        criterion: { type: 'string', multiple: true },
        brief: { type: 'string' },
        report: { type: 'string' },
        'task-diff': { type: 'string' },
        standard: { type: 'string', multiple: true },
        'hub-index': { type: 'string' },
        plan: { type: 'string' },
        spec: { type: 'string' },
        issue: { type: 'string' },
        criteria: { type: 'string' },
        'task-result-index': { type: 'string' },
        'branch-diff': { type: 'string' },
        'artifact-output': { type: 'string', multiple: true },
        output: { type: 'string' },
        'verify-plan': { type: 'boolean' },
        'verify-handoff': { type: 'boolean' },
      },
    }));
  } catch (error) {
    console.error(`autopilot-context: ${error.message}`);
    console.error(usage);
    return 2;
  }
  if (values['verify-plan'] && values['verify-handoff']) {
    console.error('autopilot-context: choose exactly one verification mode');
    return 2;
  }
  if (values['verify-plan']) return verifyPlan(values);
  if (values['verify-handoff']) return verifyHandoff(values);
  if (!values.role || !values['repo-root'] || !values['run-id'] || !values['model-tier'] || !values.output) {
    console.error(usage);
    return 2;
  }
  try {
    const repoRoot = safeRoot(values['repo-root']);
    const { role, input } = cliInput(values, repoRoot);
    const manifest = buildTaskManifest(role, input);
    const result = writeContextManifest(manifest, { repoRoot, manifestPath: values.output });
    console.log(`wrote ${result.path} (${result.bytes} bytes)`);
    return 0;
  } catch (error) {
    console.error(`autopilot-context: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
