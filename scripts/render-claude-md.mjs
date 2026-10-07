#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSafeHubRoot } from './sanitize.mjs';
import {
  applyProjectScaffold,
  planRootInstructions,
  previewProjectScaffold,
  validateProjectScaffoldPlan,
} from './project-scaffold.mjs';

const SURFACE_ARG = /^-?\s*([a-z0-9][a-z0-9-]*)\s*\(([^()\r\n]+)\)\s*$/u;
const COMMAND_ARG = /^-\s*[^:`\r\n]+:\s*`([^`\r\n]+)`\s*$/u;

function parseCommand(value) {
  return value.match(COMMAND_ARG)?.[1] ?? value;
}

function parseSurface(value, index, testCmd) {
  const match = value.match(SURFACE_ARG);
  if (!match) {
    throw new TypeError(`surface[${index}] must use '<name> (<path>)' syntax`);
  }
  const [, name, path] = match;
  return { name, path, agent: `${name}-agent`, testCmd };
}

export function projectModelFromArgs({ project, description = '', dev = [], surface = [] }) {
  const devCommands = dev.map(parseCommand);
  return {
    projectName: project,
    description,
    devCommands,
    surfaces: surface.map((value, index) => parseSurface(value, index, devCommands[0] ?? '')),
    resolutions: {},
  };
}

function parseRootArgs(argv) {
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === '--dev' || flag === '--surface') && typeof value === 'string' && value.startsWith('-')) {
      args.push(`${flag}=${value}`);
      index += 1;
    } else {
      args.push(flag);
    }
  }
  return args;
}

// Render the current managed root pair through the public planner.
export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: parseRootArgs(argv),
      strict: true,
      allowPositionals: false,
      options: {
        project: { type: 'string' },
        description: { type: 'string' },
        hub: { type: 'string' },
        templates: { type: 'string' },
        dev: { type: 'string', multiple: true },
        surface: { type: 'string', multiple: true },
        upsert: { type: 'boolean' },
      },
    }));
    if (!values.project) throw new TypeError('--project <name> is required');
    const hubRoot = assertSafeHubRoot(values.hub || process.cwd());
    const model = projectModelFromArgs(values);
    const plan = planRootInstructions({ hubRoot, model, templatesDir: values.templates });
    previewProjectScaffold(plan);
    validateProjectScaffoldPlan(plan);
    if (plan.conflicts.length > 0) {
      throw new Error(`root instruction conflicts require resolution: ${plan.conflicts.map(({ id }) => id).join(', ')}`);
    }
    applyProjectScaffold({ hubRoot, plan });
    console.log(`steepy: wrote ${resolve(hubRoot, 'AGENTS.md')} and ${resolve(hubRoot, 'CLAUDE.md')}`);
    return 0;
  } catch (error) {
    console.error(`steepy render-claude-md: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
