// Complete, controller-owned task contracts. The older planPhaseContext parser
// remains the public compatibility boundary for historical runs.
import { LOCAL_AREA_NAMES, assertSafeLine, assertSafeRelPath } from './sanitize.mjs';
import { parseStrictJson } from './inception-handoff.mjs';

const FIELD_NAMES = [
  'Requirements and deliverables', 'Relevant global constraints', 'Surface',
  'Specialist agent', 'Exact paths', 'Test command', 'Dependencies',
  'Complexity', 'Success criteria',
];
const OPTIONAL_FIELDS = ['Standard paths', 'Routing reasons'];
const ALL_FIELDS = new Set([...FIELD_NAMES, ...OPTIONAL_FIELDS]);
const FIELD_LABEL = /^-[ \t]+\*\*([^*]+?)(?::\*\*|\*\*:)[ \t]*(.*)$/;
const SPEC_REFERENCE = /\.apex\/work\/specs\/[A-Za-z0-9][A-Za-z0-9._-]*\.md#[A-Za-z0-9][A-Za-z0-9._-]*/g;
// Any spelling that can name the work spec area, in any case: dot segments,
// then optionally `.apex/work/` or `work/`, then `specs/<name>.md`. A deeper
// ordinary path such as `docs/specs/x.md` is not a spec mention.
const SPEC_PATH_MENTION = /(?<![A-Za-z0-9._/-])(?:\.\.?\/)*(?:(?:\.apex\/)?work\/)?specs\/[A-Za-z0-9._-]+\.md/gi;
const PATH_RUN = /^(?:`[^`\n]+`(?:[ \t]*,[ \t]*`[^`\n]+`)*|[A-Za-z0-9._@/-]+(?:[ \t]*,[ \t]*[A-Za-z0-9._@/-]+)*)/;
const ANNOTATION = /^(?:[ \t]+[—–-]|[ \t]*:)[ \t]+\S/;

function taskSections(text) {
  const headings = [...text.matchAll(/^##[ \t]+Task\b[^\r\n]*$/gim)];
  if (headings.length === 0) throw new Error('approved plan contains no Task headings');
  const seen = new Set();
  let previous = 0;
  return headings.map((match, index) => {
    const heading = /^##[ \t]+Task[ \t]+([1-9]\d*)(?:[ \t]+(?:—|-|:|\.|\))[ \t]*[^\r\n]*)?[ \t]*$/i.exec(match[0]);
    if (!heading) throw new Error(`invalid H2 Task heading '${match[0]}'`);
    const number = Number(heading[1]);
    if (!Number.isSafeInteger(number)) throw new Error(`plan task id '${heading[1]}' must be a positive safe integer`);
    if (seen.has(heading[1])) throw new Error(`duplicate plan task id '${heading[1]}'`);
    if (number <= previous) throw new Error(`plan task ids must be strictly increasing: ${previous} then ${number}`);
    previous = number;
    seen.add(heading[1]);
    return {
      task: heading[1], heading: match[0].trim(),
      body: text.slice(match.index + match[0].length, headings[index + 1]?.index ?? text.length),
    };
  });
}

// A CommonMark code fence: 3+ backticks (no backtick in the info string) or 3+
// tildes after at most 3 spaces, closed by the same character at least as long.
function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return match[1];
}

function closesFence(line, fence) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match) && match[1][0] === fence[0] && match[1].length >= fence.length;
}

// The fields form one leading list. A value continues on blank or indented
// lines, so nested bullets stay inside their field. The first other line starts
// the verbatim task notes, which run to the next H2. An unknown top-level bold
// label and any canonical field after the notes are rejected rather than merged.
// Fenced lines are verbatim content of their field or notes: a fenced H2 or
// label is never a boundary. Every other open container fails closed: a fence
// still open at the section end, a field fence whose list item an unindented
// line ends, and an HTML comment still open at an H2 or at the section end.
function fieldsOf({ task, body }) {
  const fields = new Map();
  const notes = [];
  let current = null;
  let fence = null;
  let comment = false;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (notes.length === 0 && /^[^ \t]/.test(line)) {
        throw new Error(`Task ${task} has an unclosed code fence in ${current}`);
      }
      (notes.length > 0 ? notes : fields.get(current)).push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (/^##[ \t]/.test(line)) {
      if (comment) throw new Error(`Task ${task} has an unclosed HTML comment`);
      break;
    }
    if (comment) {
      comment = !line.includes('-->');
    } else {
      fence = openingFence(line);
      comment = !fence && /^ {0,3}<!--/.test(line) && !line.slice(line.indexOf('<!--') + 4).includes('-->');
    }
    const label = FIELD_LABEL.exec(line);
    if (notes.length > 0) {
      if (label && ALL_FIELDS.has(label[1])) throw new Error(`Task ${task} field ${label[1]} follows task notes`);
      notes.push(line);
    } else if (label) {
      if (!ALL_FIELDS.has(label[1])) throw new Error(`Task ${task} has unknown field ${label[1]}`);
      if (fields.has(label[1])) throw new Error(`Task ${task} has duplicate ${label[1]} field`);
      current = label[1];
      fields.set(current, [label[2]]);
    } else if (current && (!line.trim() || /^[ \t]/.test(line))) {
      fields.get(current).push(line);
    } else if (line.trim()) {
      notes.push(line);
    }
  }
  // An open fence would otherwise swallow every global section after it.
  if (fence) throw new Error(`Task ${task} has an unclosed code fence`);
  if (comment) throw new Error(`Task ${task} has an unclosed HTML comment`);
  // Keep a value's nested structure: only the label-line lead and the trailing
  // blank lines are trimmed.
  const values = Object.fromEntries([...fields].map(([name, lines]) => [
    name, lines.join('\n').replace(/^[ \t]+/, '').trimEnd(),
  ]));
  for (const field of FIELD_NAMES) {
    if (!values[field]?.trim()) throw new Error(`Task ${task} is missing ${field}`);
  }
  return { fields: values, notes: notes.join('\n').trimEnd() };
}

function scalar(value, label) {
  const clean = value.trim().replace(/^`([^`\n]+)`$/, '$1').trim();
  assertSafeLine(clean, label);
  if (!clean) throw new Error(`${label} is empty`);
  return clean;
}

// One entry is a leading comma run of paths, all backticked or all plain. Exact
// paths may follow it with a dash or colon annotation (the expected change at
// that path), and that annotation alone may wrap onto further indented lines.
function pathEntry(entry, label, annotated) {
  const run = PATH_RUN.exec(entry);
  const rest = entry.slice(run?.[0].length ?? 0);
  const annotation = annotated && ANNOTATION.test(rest);
  if (!run || (rest && !annotation)) {
    throw new Error(`${label} entry must be ${annotated ? 'paths with an optional dash or colon annotation' : 'paths only'}: ${entry}`);
  }
  return { paths: run[0].split(',').map((part) => part.trim().replace(/^`([^`]+)`$/, '$1')), annotation };
}

function pathList(value, label, { annotated = false } = {}) {
  const [first, ...nested] = value.split('\n');
  const paths = [];
  let wraps = false;
  const take = (entry) => {
    const parsed = pathEntry(entry.trim(), label, annotated);
    paths.push(...parsed.paths);
    wraps = parsed.annotation;
  };
  if (first.trim()) take(first);
  for (const line of nested) {
    if (!line.trim()) continue;
    const bullet = /^[ \t]+[-*][ \t]+(\S.*)$/.exec(line);
    if (bullet) take(bullet[1]);
    else if (!wraps) throw new Error(`${label} must list one path entry per nested bullet: ${line.trim()}`);
  }
  if (paths.length === 0) throw new Error(`${label} has an empty path`);
  const seen = new Set();
  return paths.map((path) => {
    assertSafeRelPath(path, label);
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.') || path.endsWith('/')) {
      throw new Error(`${label} must contain canonical paths: ${path}`);
    }
    // Case-insensitive, because darwin storage is: these are outside source.
    const [first, second] = parts.map((part) => part.toLowerCase());
    if (first === '.git') throw new Error(`${label} must not name Git metadata: ${path}`);
    if (first === '.apex' && (parts.length === 1 || LOCAL_AREA_NAMES.includes(second))) {
      throw new Error(`${label} must not enter repository-local area .apex${second ? `/${second}` : ''}: ${path}`);
    }
    if (seen.has(path)) throw new Error(`${label} has duplicate path ${path}`);
    seen.add(path);
    return path;
  });
}

function criteria(value, task) {
  const ids = value.split(',').map((part) => scalar(part, `Task ${task} Success criteria`));
  let previous = 0n;
  for (const id of ids) {
    if (!/^SC[1-9]\d*$/.test(id) || BigInt(id.slice(2)) <= previous) {
      throw new Error(`Task ${task} Success criteria must be unique increasing SC IDs`);
    }
    previous = BigInt(id.slice(2));
  }
  return ids;
}

function dependencies(value, task, preceding) {
  if (scalar(value, `Task ${task} Dependencies`).toLowerCase() === 'none') return [];
  const ids = value.split(',').map((part) => {
    const match = /^(?:Task[ \t]+)?([1-9]\d*)$/.exec(scalar(part, `Task ${task} dependency`));
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Task ${task} has invalid dependency ${part.trim()}`);
    return match[1];
  });
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Task ${task} has duplicate dependency Task ${id}`);
    if (!preceding.has(id)) throw new Error(`Task ${task} dependency Task ${id} must be a prior task`);
    seen.add(id);
  }
  return ids;
}

function routingRows(routingText) {
  const routes = new Map();
  for (const line of String(routingText ?? '').split(/\r?\n/)) {
    const match = /^\|[ \t]*`([a-z0-9][a-z0-9-]*)`[ \t]*\|[ \t]*\[[^\]]+\]\(([^)]+)\)[ \t]*\|[ \t]*`([^`]+)`[ \t]*\|/.exec(line);
    if (!match) continue;
    if (routes.has(match[1])) throw new Error(`duplicate routing row for surface ${match[1]}`);
    const linked = assertSafeRelPath(match[2], `routing standard for ${match[1]}`);
    routes.set(match[1], { standard: assertSafeRelPath(`.apex/${linked}`, 'routed standard'), agent: match[3] });
  }
  return routes;
}

function specReferences(values, capabilities, task) {
  if (!Array.isArray(capabilities)) throw new Error('specCapabilities must be a list');
  const byReference = new Map();
  for (const capability of capabilities) {
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)
      || typeof capability.reference !== 'string' || typeof capability.text !== 'string'
      || !capability.text.trim() || byReference.has(capability.reference)) {
      throw new Error('spec capability must declare one unique exact reference and nonempty text');
    }
    byReference.set(capability.reference, capability.text);
  }
  const references = [];
  for (const value of values) {
    const matches = [...value.matchAll(SPEC_REFERENCE)];
    for (const mention of value.matchAll(SPEC_PATH_MENTION)) {
      if (!matches.some((match) => match.index === mention.index)) {
        throw new Error(`Task ${task} spec section needs an exact path and heading capability`);
      }
    }
    for (const match of matches) if (!references.includes(match[0])) references.push(match[0]);
  }
  return references.map((reference) => {
    if (!byReference.has(reference)) throw new Error(`Task ${task} spec section lacks exact declared capability: ${reference}`);
    return { reference, text: byReference.get(reference) };
  });
}

// A whole path token: `auth.md` is not mentioned by `web-auth.md`.
function mentionsToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9._/-])${escaped}(?![A-Za-z0-9._/-])`).test(text);
}

function selectedStandards(fields, surface, route, registered) {
  if (!registered || typeof registered !== 'object' || Array.isArray(registered)
    || !Object.hasOwn(registered, surface)) throw new Error(`no standard path registered for surface ${surface}`);
  const entry = registered[surface];
  if (typeof entry === 'string') {
    if (entry !== route.standard) throw new Error(`standard routing mismatch for surface ${surface}`);
    if (fields['Standard paths'] !== undefined) {
      const selected = pathList(fields['Standard paths'], 'Standard paths');
      if (selected.length !== 1 || selected[0] !== entry) throw new Error(`Standard paths must match routed standard for ${surface}`);
    }
    return [entry];
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.core !== route.standard
    || !Array.isArray(entry.leaves)) throw new Error(`invalid modular standard routing for ${surface}`);
  if (!fields['Standard paths']) throw new Error(`Standard paths required for modular core ${surface}`);
  if (!fields['Routing reasons']) throw new Error(`Routing reasons required for modular core ${surface}`);
  const selected = pathList(fields['Standard paths'], 'Standard paths');
  if (selected[0] !== entry.core) throw new Error(`modular standard core must be first for ${surface}`);
  let previous = -1;
  for (const path of selected.slice(1)) {
    const at = entry.leaves.indexOf(path);
    if (at < 0) throw new Error(`Standard paths leaf is not reachable from routed core: ${path}`);
    if (at <= previous) throw new Error(`Standard paths leaves must follow routed order for ${surface}`);
    previous = at;
    const basename = path.split('/').at(-1);
    if (!mentionsToken(fields['Routing reasons'], path) && !mentionsToken(fields['Routing reasons'], basename)) {
      throw new Error(`Routing reasons must explain selected leaf ${basename}`);
    }
  }
  return selected;
}

export function parseExecutablePlan(planText, { routingText, standardsBySurface, specCapabilities = [] } = {}) {
  const text = String(planText ?? '');
  const routes = routingRows(routingText);
  const prior = new Set();
  const tasks = taskSections(text).map((section) => {
    const { fields, notes } = fieldsOf(section);
    const surface = scalar(fields.Surface, `Task ${section.task} Surface`);
    const route = routes.get(surface);
    if (!route) throw new Error(`Task ${section.task} surface ${surface} is not routed`);
    const agent = scalar(fields['Specialist agent'], `Task ${section.task} Specialist agent`);
    if (agent !== route.agent) throw new Error(`Task ${section.task} Specialist agent conflicts with routing for ${surface}`);
    const complexity = scalar(fields.Complexity, `Task ${section.task} Complexity`);
    if (!['mechanical', 'integration', 'design'].includes(complexity)) throw new Error(`Task ${section.task} has invalid Complexity`);
    const result = {
      task: section.task,
      heading: section.heading,
      requirements: fields['Requirements and deliverables'],
      constraints: fields['Relevant global constraints'],
      owningSurface: surface,
      specialistAgent: agent,
      exactPaths: pathList(fields['Exact paths'], `Task ${section.task} Exact paths`, { annotated: true }),
      exactPathsText: fields['Exact paths'],
      testCommand: scalar(fields['Test command'], `Task ${section.task} Test command`),
      dependencies: dependencies(fields.Dependencies, section.task, prior),
      complexity,
      criterionIds: criteria(fields['Success criteria'], section.task),
      standardPaths: selectedStandards(fields, surface, route, standardsBySurface),
      ...(fields['Routing reasons'] ? { routingReasons: fields['Routing reasons'] } : {}),
      ...(notes ? { notes } : {}),
      resolvedSpecSections: specReferences([...Object.values(fields), notes], specCapabilities, section.task),
    };
    prior.add(section.task);
    return result;
  });
  return { tasks };
}

// A value that starts on the next line (a nested list) keeps that layout.
function field(label, value) {
  return `- **${label}:**${value.startsWith('\n') ? '' : ' '}${value}`;
}

export function materializeTaskBrief(task, { sourcePlanPath } = {}) {
  if (!task || typeof task !== 'object' || !Array.isArray(task.exactPaths)
    || !Array.isArray(task.standardPaths)) throw new Error('task must be a parsed executable task');
  const lines = [
    `# Task ${task.task} brief`,
    '',
    ...(sourcePlanPath ? [`Source plan: \`${assertSafeRelPath(sourcePlanPath, 'source plan path')}\``, ''] : []),
    field('Requirements and deliverables', task.requirements),
    field('Relevant global constraints', task.constraints),
    `- **Surface:** \`${task.owningSurface}\``,
    `- **Specialist agent:** \`${task.specialistAgent}\``,
    field('Exact paths', task.exactPathsText ?? task.exactPaths.map((path) => `\`${path}\``).join(', ')),
    `- **Test command:** \`${task.testCommand}\``,
    `- **Dependencies:** ${task.dependencies.length ? task.dependencies.map((id) => `Task ${id}`).join(', ') : 'none'}`,
    `- **Complexity:** ${task.complexity}`,
    `- **Success criteria:** ${task.criterionIds.join(', ')}`,
    `- **Standard paths:** ${task.standardPaths.map((path) => `\`${path}\``).join(', ')}`,
    ...(task.routingReasons ? [field('Routing reasons', task.routingReasons)] : []),
    '',
    ...(task.notes ? ['## Task notes', '', task.notes, ''] : []),
  ];
  for (const { reference, text } of task.resolvedSpecSections) {
    lines.push(`## Resolved spec section: \`${reference}\``, '', text, '');
  }
  return lines.join('\n');
}

export function parseFixTargets(issueText, { taskIds, findingIds } = {}) {
  if (!Array.isArray(taskIds) || !Array.isArray(findingIds) || !taskIds.length || !findingIds.length) {
    throw new Error('fix targets require exact taskIds and findingIds inventories');
  }
  const text = String(issueText ?? '').replace(/\r\n?/g, '\n');
  // Any marker line, whatever its version, counts: an alternate one is ambiguous.
  const markers = [...text.matchAll(/^steepy-fix-targets:[^\n]*$/gm)];
  if (markers.length !== 1 || !/^steepy-fix-targets: v1[ \t]*$/.test(markers[0][0])) {
    throw new Error('issue artifact must contain exactly one steepy-fix-targets: v1 marker');
  }
  const rest = text.slice(markers[0].index + markers[0][0].length);
  const block = /^\n```json\n([^]*?)\n```(?:\n|$)/.exec(rest);
  if (!block) throw new Error('fix-targets JSON block must follow marker immediately');
  const rows = parseStrictJson(block[1], 'fix targets');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('fix targets must be a nonempty array');
  const tasks = new Set(taskIds.map(String));
  const findings = new Set(findingIds);
  if (tasks.size !== taskIds.length || findings.size !== findingIds.length) throw new Error('fix target inventories contain duplicates');
  const seenTasks = new Set();
  const seenFindings = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'issueIds,task') throw new Error('fix target row must have exactly task and issueIds');
    const task = String(row.task);
    if (typeof row.task !== 'string' || !tasks.has(task)) throw new Error(`unknown task in fix targets: ${task}`);
    if (seenTasks.has(task)) throw new Error(`duplicate task in fix targets: ${task}`);
    seenTasks.add(task);
    if (!Array.isArray(row.issueIds) || row.issueIds.length === 0) throw new Error(`Task ${task} fix targets need issueIds`);
    for (const id of row.issueIds) {
      if (typeof id !== 'string' || !findings.has(id)) throw new Error(`unknown finding in fix targets: ${id}`);
      if (seenFindings.has(id)) throw new Error(`duplicate finding in fix targets: ${id}`);
      seenFindings.add(id);
    }
  }
  for (const id of findings) if (!seenFindings.has(id)) throw new Error(`fix targets omit finding ${id}`);
  return rows;
}
