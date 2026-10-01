# Controller role instructions (steepy)

This file is packaged with the role prompts. Use its contents only when the controller selects
`controllerProtocol: 2` in the exact role manifest. The controller supplies the role, run identity,
phase, task or whole-branch scope, iteration, role sequence, selected result protocols, and exact
artifact paths. Do not discover or invoke an installed skill by name.

Read and validate the manifest first. Eagerly read every `required` input and no other work input;
use an `onDemand` path only for a named missing fact, recording the reason in the assigned report.
Normal repository source discovery remains available. Follow the assigned role prompt and the
selected response schema. Do not infer inputs or outputs by listing `.apex/work/**`.

The controller owns the run and event state, ledger and lifecycle transitions, reservations,
receipts, Git commits, and replaceable projections. Do not write those paths or advance status.
The writer may edit only its assigned repository source paths; a reviewer is read-only on source.
Write the controller-assigned role report and, when the role verdict requires it, the
controller-assigned issues artifact. Treat those output paths as DRAFT until the controller verifies
the response, content, and evidence and publishes the lifecycle. Do not claim acceptance from a
report or its prose. Return only the selected closed response payload; keep all findings in the
assigned artifacts. A report is evidence, never the verdict source.
