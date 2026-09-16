# adapters — Technical Standard

> Owning surface: `adapters`. Read this before editing `adapters`.

## Scope
- Owns: `adapters/**` harness integration modules (OpenCode plugin, Pi extension,
  `adapters/headless.mjs` — the harness → headless one-shot command map the gear-3
  autopilot conductor uses) and the per-harness packaging manifests they serve
  (`.codex-plugin/`, `.agents/plugins/marketplace.json`, harness-specific hook
  manifests such as `hooks/hooks-codex.json`, the root `cordis.patch.yml` bundle-patch
  file, and `package.json`'s `dsh` key).
- Does NOT own: engine scripts (`scripts` surface), the canonical `skills/` prose
  (`skills` surface), test suites (`tests` surface), or the Claude Code manifest
  `.claude-plugin/plugin.json` (release tooling, `scripts` surface via
  `bump-version.mjs`).
- Exemplar: `adapters/opencode/steepy-apex.js`

## Runtime boundary

Adapters declare configured host wiring, not a timeless host-runtime guarantee. Native installation/canary work can read host configuration, create host cache state, invoke a host subprocess, and use its authenticated provider path; hermetic adapter tests do not replace that evidence. Claude, Codex, and OpenCode have Steepy headless descriptors. Pi and DSH do not gain descriptors just to complete a matrix; DSH's documented host automation modes remain distinct from Steepy's unsupported deterministic runner.

## Conventions
- Plain ESM, zero dependencies — Node/host built-ins only, no build step.
- Use only the host harness's provided API (the context/config objects it passes in);
  never import engine scripts from adapter code.
- Fail-open on missing optional host APIs: capability-check, then skip gracefully —
  an adapter must load without error on a host that lacks an optional feature.
- On a dependency-injection host, "capability-check, then skip gracefully" is satisfied
  by dependency-gated activation — register each capability behind its own gate that runs
  only once the host's own dependency graph resolves that service — not by a synchronous
  presence probe at load time. A synchronous probe can run before a sibling service that
  is about to become healthy, and so can silently register nothing on a host where the
  service works moments later; this refines the rule above for such hosts, it does not
  replace it where a synchronous check is correct.
- A packaging manifest (a bundle/plugin patch file, a per-harness plugin manifest, an npm `files`
  allowlist, …) is not verified by reading it against a fact sheet or a same-shaped sibling
  example, however carefully sourced — a relative reference's resolution root depends on the
  composition context the file is loaded into, and a sibling that never exercises a relative
  reference proves nothing about a row that does. The only verification that counts is loading the
  manifest's own row on a real host, under the same composition (bundle, profile, marketplace
  root, …) it will actually run in.
- Resolve the package's own location via `import.meta.url` (or the host-provided
  plugin root), never via a hardcoded path.
- Idempotent injection: anything an adapter writes into a session (bootstrap block,
  tool mapping) carries a marker guard so repeat events never duplicate it.
- Pi evaluates that bootstrap marker against the current session entries on every
  `session_start`; an adapter-instance flag must not suppress a marker-free session reached through
  new, fork, resume, or reload. When session history is unavailable, Pi may use a process-local
  duplicate guard as a fail-open fallback, but that fallback cannot prove per-session delivery.
- Bootstrap guidance is project-name agnostic: instruct the host to read applicable
  `AGENTS.md` files in root-to-project order, locate the canonical bootstrap under
  `.agents/skills`, fall back to `.apex/_INDEX.md`, and declare inline execution of
  the relevant owning standard when that bootstrap is unavailable. Do not hardcode a
  repository bootstrap name.
- OpenCode discovers project specialists only from `.opencode/agents`, using the
  native thin frontmatter and filename-derived agent name. Missing, invalid, unreadable,
  or non-directory native layouts register no project specialists; `.claude/agents` is never read.
- OpenCode discovery treats the host-supplied project root and each adapter-owned namespace
  component as physical directories: before normalization, every native-platform lexical
  component is inspected and any `..` parent traversal is conservatively rejected so it cannot
  erase a symlink or non-directory ancestor. Relative project paths without parent traversal are
  supported from the current working directory, then checked through the same physical root-to-project
  walk. `lstat` rejects symlinks and non-directories, and an actual `ENOENT` along
  `.opencode/agents` means no project specialists. Candidate agent
  descriptors must be ordinary non-symlink files, verified again on the opened descriptor,
  and are capped at 1 MiB both before and during reading. `O_NOFOLLOW` and `O_NONBLOCK` narrow
  replacement/FIFO hazards where the host OS provides them; Node exposes no portable `openat`
  ancestor walk, so this is a best-effort same-process TOCTOU boundary, not a race-free sandbox.
  Invalid discovery emits at most eight optional host-log warnings per config pass, each capped
  at 256 characters; missing or rejecting logging remains fail-open.
- OpenCode transform ownership is the adapter's identity of the exact injected part in the
  current live `output.messages` projection. User-visible marker text is never ownership
  evidence: a repeated transform of the same projection stays idempotent, while a fresh host
  projection receives a fresh adapter-owned bootstrap part.
- Pi bootstrap provenance is an entry with `type: custom_message` and the adapter's exact
  `customType`, matching the entry Pi persists for `sendMessage`. Generic `custom` state,
  user/evidence content, and marker-bearing messages owned by another extension never suppress
  delivery. Readable history remains session-authoritative across startup, new, fork, resume,
  and reload; history-unavailable mode retains only the documented process-local fallback.
- Pi and DSH do not invent harness-specific specialist directories; their scope is
  generic bootstrap guidance and the host capabilities they actually expose.
- A headless descriptor declares its command, protocol, display/native metadata, and
  capabilities. Its decoder maps only source evidence: it never owns workflow policy or invents
  actor hierarchy, and it preserves unknown or malformed source input for fallback.
- Decoded harness task events (e.g. Claude system/task_started → `agent.started`,
  system/task_notification → `agent.completed`/`agent.failed`) are agent-identity evidence:
  their `subagent_type`, `task_id`, and completion `status`/`summary` fields are direct source
  observations, never a flag-only inference. Such event evidence can promote an
  `agentIdentity` capability cell to `yes`; chatty plumbing (e.g. `task_progress`,
  `task_updated`) stays raw-only and never renders per-event.
- Adapters own concrete model apply/degrade from the controller's effective abstract tier, then
  return direct provider usage evidence and capability evidence. They never choose controller
  policy, infer usage, or turn a missing provider capability into a synthetic success.
  For Codex, the stable mapping provenance is the official OpenAI model guide at
  `https://developers.openai.com/api/docs/guides/latest-model`. `applied` means the concrete model
  selection argument is present; provider acceptance is known only from process success/failure.
  OpenCode deliberately degrades by default until a verified mapping is injected.
- A tier mapping is a cost/capability ladder, so every row ascends: `cheap` is that harness's small
  fast model and never a frontier one. An inverted row silently sends every mechanical task to the
  most expensive model available — the exact waste tier routing exists to prevent.
- A tier derived by aggregating across units of work must state which unit it prices: pricing a
  phase by its hardest supervised task is the same waste the ladder rule exists to prevent.
- Concrete tier mappings are provider-keyed engine tables (`adapters/model-mappings.mjs`):
  provider → tier → concrete model id, every row carrying per-row provenance (`source` and
  `verifiedAt`) — never an unlabeled id.
- Interactive-path tier resolution requires config-time provider knowledge — a pinned
  `config.model` whose provider prefix selects the shared table; without a mapped pin,
  nothing tier-related registers and dispatch degrades to the session model, declared as
  such.
- Registered hub surface agents are agent-static — each runs at its frontmatter tier;
  the `steepy-<tier>` trio is the per-dispatch tier choice. When the effective task tier
  differs from a registered agent's tier, dispatch degrades to the matching
  `steepy-<tier>` agent with the specialist prompt inlined, declared in the ledger.
- Mapping freshness is verified by script (`scripts/verify-model-mappings.mjs`), which
  proposes a patch on drift; the tables are updated only by a human-ratified patch, never
  silently at runtime.

## Anti-patterns
- No build step — adapters ship as-authored.
- No `CLAUDE_*` references — Claude-specific env vars are Claude packaging, never
  adapter code.
- No absolute or user-home path literals.
- No behavior in adapters: workflow logic lives in the canonical `skills/` tree;
  adapters only wire discovery, invocation ergonomics, and bootstrap injection.

## Testing
Narrowest validation that can falsify a change here:

```sh
node --test tests/adapters.test.mjs
```
