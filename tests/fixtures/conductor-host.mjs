// Hosts one `runConductor` run in its own process, so a test can send it a real
// signal (the Ctrl-C case) instead of simulating one. Argv:
//   <spec-path> <repo-cwd> <fake-harness-path>
// The fake harness is wired through `opts.commandFor`, exactly as the in-process
// tests do — no real harness is ever spawned.
import { runConductor } from '../../scripts/autopilot.mjs';
import { headlessCommand } from '../../adapters/headless.mjs';
import { join } from 'node:path';

const [specPath, cwd, stubPath] = process.argv.slice(2);
// Always isolate this subprocess and its fake descendants, even when its
// parent test has an ambient OpenCode pin. No real harness is invoked here.
const fixtureHome = join(cwd, '.apex', 'work', 'test-home');
process.env.HOME = fixtureHome;
process.env.XDG_CONFIG_HOME = join(fixtureHome, '.config');

const code = await runConductor(specPath, {
  cwd,
  opencodeConfig: { env: process.env, homedir: () => fixtureHome },
  commandFor: (harness, prompt, options) => {
    const descriptor = headlessCommand(harness, prompt, options);
    return descriptor === null ? null : {
      ...descriptor,
      cmd: process.execPath,
      args: [
        stubPath, prompt, harness, JSON.stringify(descriptor),
        ...(descriptor.resolvedModel ? ['--model', descriptor.resolvedModel] : []),
      ],
    };
  },
});

process.exit(code);
