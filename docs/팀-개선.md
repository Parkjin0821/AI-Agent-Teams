# Team evolution — verified implementation boundary

## Regression fixes and model registration

Four reproduced gaps are fixed: human criterion evidence no longer completes a team goal;
planning completion claims still pass security/policy/QA; coding/UI require code capability;
evaluation linkage survives plan parsing; incoming request batches are deduplicated.

The connection screen exposes pending model registration and explicit manual official-account
attestation. `/api/models` lists/registers profiles; `/api/models/attest` records who confirmed
the official source and their account evidence. This is **manual attestation, not automatic account verification**.
Registering or changing a profile clears previous confirmation. No model names or performance tiers
are inferred from branding. Operational tier is a local routing setting, not an official benchmark.
Actual model execution and modality support still require real runtime validation.

Image billing: official Codex subscription image generation uses included limits/credits;
API-key image generation uses API billing instead. [Official pricing](https://learn.chatgpt.com/docs/pricing).
The current AGENT HQ CLI adapter does not yet expose image generation despite official product
support; it correctly leaves image tasks waiting. No paid API integration or image call was added.

## Collaborative assignment update

Adaptive projects with provider switching enabled now use one capability-based selector for all roles.
The planning model sees verified candidates and can suggest a model with a task-specific reason.
The engine first enforces account/support verification, required capabilities, reasoning/tier,
quota availability, explicit pins and reviewer independence. Suggestions cannot override these gates.
Matching project evaluations (same task, conditions and reasoning) rank above a proposal; public
benchmarks and fabricated scores are excluded. Without comparable measurements the reason explicitly says so.
Current adapters expose text/code, Claude web and its configured connector path; neither exposes image
generation. Image tasks wait instead of pretending Codex or Claude Code can generate an image.
Legacy policies retain their previous behaviour until switched to adaptive/provider-switch mode.
Candidate comparisons and proposal reasons are saved on checkpoints and shown in project collaboration.

## Architecture decision

Compared: (1) extend the serial role loop, (2) persistent collaboration queue with bounded dispatch,
(3) independent team services. Selected (2) on the existing SQLite checkpoint engine.
It preserves project isolation, permission enforcement and restart recovery without introducing a new server.
Same-project edits remain serial until isolated workspaces, dependencies, merge gates and conflict tests exist.

## The seven gaps

| Gap | Implemented in this phase | Remaining |
|---|---|---|
| Planning dependency | Workers propose concrete follow-ups with criteria; persistent deduplicated queue | In-flight dependency graph, assignment negotiation and human approval per proposal |
| Fixed executors | Opt-in development provider routing by complexity/risk; low-risk quota fallback after checkpoints | Account-verified model catalogue, model-specific quota gates; no automatic downgrade of high-risk work |
| Parallel cooperation | Manual and timer execution share concurrency/project locks | Isolated branches/workspaces and safe merge; intentionally not enabled |
| Continuous improvement | Opt-in low-risk follow-up dispatch, maximum 3 budget units; daily project cap; no simulated dispatch | Long-running discovery, experiment evaluation, multi-team acceptance |
| Model choice | Task complexity/risk enters reasoning choice; profile validation | Comparable measured performance and usage-cost forecasting; no fabricated model scores |
| Security/policy | Engine forces both reviews after real workers; QA AI read-only; declared external effects stop for human decision | Comprehensive effect detection, capability grants, update/installation security pipeline |
| Quality | Design acceptance checklist and research source/inference requirements | Rendered visual checks, usability tests, source reliability and application E2E |

## Record team

Engine-based recording does not consume another AI turn. `GET /api/projects/:id/records` returns:
stable content digest, metadata snapshot, GitHub Markdown/base64 content and Notion paragraph blocks.
Raw conversations, output text, file contents and model identifiers are excluded from external drafts.
Simulation is explicitly marked as not verified. No external request is sent by this endpoint.
This is a draft/export layer, **not a connected synchronisation service**.

Official interfaces researched:
- [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents): repository-specific Contents write permission; existing-file changes require SHA. Prefer immutable digest paths to avoid overwriting human edits.
- [Notion update page](https://developers.notion.com/reference/patch-page): property updates and body content are distinct; content uses block APIs. Never use erase_content for sync.
- [Notion append block children](https://developers.notion.com/reference/patch-block-children): connection access to target page and insert-content capability must be verified before integration.

Connection prerequisites: approved GitHub owner/repository/branch, approved Notion page,
server-side credentials isolated from agent child environments, redaction review and per-destination publication authority.
Persistent outbox with digest idempotency, conflict detection, destination IDs, partial failures,
and timeout reconciliation is required before automatic delivery. Do not blindly retry an ambiguous Notion append.
Rich decision/rationale summaries require a separate redaction and approval pass; current export is metadata-only.

## Operating controls

- `/api/goals/:id/autonomy` accepts `enabled` and `remaining` (0–3). Disabled by default.
- Follow-up budgets move to one child; they never multiply. Unknown/normal/high risk or declared external effects are not auto-dispatched.
- `/api/projects/:id/model-policy` can set `allowProviderSwitch`; new conversation projects enable it, existing policies are preserved.
- High-risk development does not switch to another provider merely because its preferred quota is exhausted.
- Authentication, permission failures and unresolved approvals remain stopped. Restart interruption still requires recovery.
- Tool “implemented” is not “executed successfully”; dashboard records show actual execution separately.

## Next authority required

Do not collect credentials in chat. Choose destination repository and Notion page first,
then configure least-privilege connections. No external write has been performed in this phase.
