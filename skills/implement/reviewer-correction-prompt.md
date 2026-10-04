# Reviewer response correction (steepy)

Use only after the controller has validated the assigned report and Git state and durably reserved
its single format correction for a captured `reviewerResponseProtocol: 3` response with an
unambiguous `APPROVED` or `ISSUES_FOUND` verdict. `BLOCKED`, `NEEDS_CONTEXT`, and semantically
ambiguous responses are not repairable. A crash does not replenish the correction attempt.
This is a response-only correction, not a new review.
Read the controller-supplied original response and correction reservation; do not reread source,
rerun tests, rewrite reports or issues, or produce any other effect.

Keep the frozen `status` and `signals` values, types, spelling, and meaning exactly as captured.
The only repairable forms are reverse order of the two text lines, or one Markdown code block
wrapping the entire payload in the selected format. Remove the one wrapper or restore field order
in one correction. A repairable classification is not acceptance; return the corrected two-field
payload to the controller for validation. Do not add `artifact`, `changed-paths`, commentary,
headings, or a new review. If both forms or any value/type/count error is present, stop without
inventing a verdict.
