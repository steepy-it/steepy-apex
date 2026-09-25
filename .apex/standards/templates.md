# templates — Technical Standard

> Owning surface: `templates`. Read this before editing `templates`.

## Scope

- Owns: the scaffold Markdown and TOML under `templates/` — the `{{placeholder}}` source files
  rendered into a target project, plus the plain fill-in skeletons that ship as-is.
- The final v1 layout consists of the root instruction pair `AGENTS.md` and `claude-import.md`, the
  project bootstrap pair `project-bootstrap-skill.md` and `claude-bootstrap-stub.md`, the specialist
  adapter triad `surface-agent-claude.md` / `surface-agent-codex.toml` /
  `surface-agent-opencode.md`, the hub-building sources `_INDEX.md`, `routing-row.md`,
  `surface-standard.md`, and `surface-standard-core.md`, the per-run inception skeletons
  `inception-project.md` and `inception-verification.md`, and the durable-hub skeletons
  `project-context.md` and `project-architecture.md`.
- Does NOT own: the project-model values fed to templates (→ `skills` interview), the rendering
  implementation (→ `scripts`), or the target project's hub content.
- Exemplar: `templates/surface-standard.md`

## Conventions

- `AGENTS.md` and `claude-import.md` are mixed-artifact managed-block sources. Their managed block
  is the first content after an optional UTF-8 BOM and they never carry generated provenance.
- Entirely generated v1 Markdown places `<!-- steepy:generated:<artifact-id>:v1 -->` immediately
  after frontmatter (or on the first line without frontmatter); generated TOML places the equivalent
  `# steepy:generated:<artifact-id>:v1` on its first line.
- The canonical project bootstrap is a harness-neutral navigation router: it reads `AGENTS.md` and
  `.apex/_INDEX.md`, resolves minimum surface docs and the specialist, and invokes workflows by
  semantic skill name; coverage, gear, ratification, branch, and workflow-state ceremony stay in
  the gear-aware workflow skills. Claude delegates to it through a thin stub;
  each specialist adapter names its agent, surface/path, semantic bootstrap, and owning standard
  without copying rules from the standard.
- `{{placeholder}}` substitution is strict in code-rendered paths: `renderTemplate` throws for an
  unknown value. The prose-generated hub sources need every declared value supplied by the owning
  skill.
- Free-text values are validated before substitution: every `path` passes `assertSafeRelPath` and
  `testCmd` passes `assertSafeTestCommand` before it renders inside a fenced block. Test commands
  preserve harmless shell quoting and backticks exactly, but reject any single line that CommonMark
  would treat as the emitted backtick fence's closing delimiter. Project `devCommands`
  are either absent or non-empty, backtick-free safe single-line UTF-8; every other such line is
  preserved exactly inside its inline-code bullet so the canonical Project model round-trips.
- Until a renderer owns TOML escaping, the Codex adapter renders the free-text project description
  and safe relative path in comments and derives its TOML strings only from slug fields. Raw
  safe-line or safe-path text must not be interpolated into a TOML string.
- The Codex adapter omits the `model` field so the spawned session inherits its model; no sentinel
  string represents inheritance. Claude keeps consuming the shared native `{{model}}` value.
- Rendering is idempotent and the generated Markdown lints green.
- The inception and project skeletons (`inception-project.md`, `inception-verification.md`,
  `project-context.md`, `project-architecture.md`) are plain fill-in structures like
  `surface-standard.md`: proportioned per project, never a fixed technology catalog or a mandated
  document count, and they carry no `{{placeholder}}` or generated-provenance marker.

### Generated-bootstrap work and inception boundaries

- The generated bootstrap carries a thin, navigation-scoped default-deny boundary for `.apex/work/**`:
  a workflow may consume only exact work paths named by its accepted handoff; a pathless invocation
  is limited to bounded workflow-header recovery discovery; and a user may explicitly authorize an
  exact path or broader work-area scope. This rule applies transitively to child agents, while only
  the phase orchestrator interprets the handoff.
- It carries a separate, stricter boundary for `.apex/inception/**`: only the exact input paths for
  the current step, or a scope the user explicitly authorizes, permit a read; this area has no
  pathless recovery of its own, and the template never encodes the inception handoff schema.
- Generated provenance remains unchanged at `v1`.
- `templates/prior/v1.0/project-bootstrap-skill.md` keeps the exact bootstrap source released in
  v1.0.0-v1.0.4, before the inception boundary. It is never rendered as output: the scripts render
  it only to recognize an untouched earlier bootstrap, and its digest is pinned, so never edit it.
  A later change to a generated template whose provenance stays `v1` adds its released source here.
- Templates do not define phase role maps, lifecycle transitions, envelope grammar, or
  harness-native invocation rendering; those remain outside the generated bootstrap contract.

## Anti-patterns

- Every `{{placeholder}}` in a code-rendered template must be supplied by the renderer. Adding one
  without wiring it into the rendering path breaks scaffolding.
- No unsanitized free-text inline: validate paths and commands before rendering so generated
  Markdown, YAML frontmatter, and TOML remain valid.
- The routing-row format lives in two places — `templates/routing-row.md` and `routingRow()` in
  `scripts/new-surface.mjs`; a shape change must update both so generated rows stay coherent.
- Generated Markdown must lint green under `validate-hub`: relative links must resolve and stable
  documents must remain reachable from `_INDEX`.
- The `<!-- steepy-hub-version: N -->` stamp in `_INDEX.md` is not a placeholder; copy it verbatim.

## Testing

Template contract validation:

```sh
node --test tests/template.test.mjs
```
