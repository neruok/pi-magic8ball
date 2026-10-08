# @neruok/pi-magic8ball

An advisory choice tool for Pi. A lightweight context builder collects neutral state. Jev or Clef then returns a choice distribution.

The builder does not choose or rank responses. Its output has a fixed schema. Schema validation cannot prove neutrality or factual accuracy.

Configured providers can incur charges. They receive the context you permit the tool to collect.
Results are advisory evidence, not authorization or execution commands. Confidence measures distribution concentration, not correctness.

## Install and load

Requires Node.js 24 or newer. Pi 1.0.4 is the tested host version.
Later Pi versions are not yet verified. Runtime peers use `*` as Pi requires, not as a compatibility guarantee.

After npm publication, install the pinned release:

```bash
pi install npm:@neruok/pi-magic8ball@0.1.0
```

Or install from the repository:

```bash
pi install git:github.com/neruok/pi-magic8ball
```

This tracks the repository's default branch. Use a reviewed tag or commit to pin an installation.
Pi records the package in personal settings. Add `--local` for trusted project settings.
Review extension code before installation. Restart Pi or use `/reload` after installation.

To try a local checkout for one invocation:

```bash
pi -e /absolute/path/to/pi-magic8ball/magic8ball.ts
```

The local invocation does not change package settings. Pi supplies the host packages listed in `package.json`.

The release candidate is `@neruok/pi-magic8ball@0.1.0`, licensed under [MIT](LICENSE).
Release preparation does not publish the package. Registry ownership and publication credentials still require verification.

## Configure models

Use `/magic8ball` to select both models interactively. The picker lists available physical chat models and classifiers.
Like `/model`, it uses an inline list of at most 10 models with fuzzy search by provider, model ID, or display name.
Use `/magic8ball show` to inspect the effective selections, their sources, and settings paths.
There is no default model or automatic fallback. Configuration makes no generation or classification requests.

You can also set each role directly:

```text
/magic8ball builder your-chat-provider your-small-tool-capable-model
/magic8ball classifier typesafe jev-latest
```

For Clef instead of Jev:

```text
/magic8ball classifier cloudflare-workers-ai @cf/cloudflare/clef
```

Commands save to user settings by default. Add `--project` for this workspace, or use `/magic8ball --project` for its two-model picker.
Project writes require Pi project trust. Cancelling either picker leaves settings unchanged.
Without interactive UI, use explicit identifiers; the bare command only displays settings and usage.
Commands do not change Pi's active conversation model.

### Command autocomplete

Type the full `/magic8ball ` command, including its space, to show subcommands and scope flags.
Further arguments suggest transcript actions, available role-specific providers and models, supported builder reasoning levels, or timeout reset.
Model search matches identifiers and display names with Pi's fuzzy matching.
Reasoning suggestions use the builder that the chosen scope would update. Global is the default, even with an effective project override.
Use `--project` before the level to get project-builder choices.

Pi 1.0.4 has a Tab-routing defect after Tab completes a command name. The next Tab can fail to open argument completion.
After name completion, type the first letter of a subcommand, wait for the menu, then press Tab.
Use `r` for reasoning, `b` for builder, `c` for classifier, or `t` for timeout/transcripts.
For the full argument menu, press Backspace to remove the trailing space, wait for the command menu, then type Space.
These workarounds were checked with Pi's actual editor and mock terminal dimensions. The extension does not patch Pi or replace its editor.

Selecting a suggestion inserts text only. It does not save settings, change capture, or make model requests.
Submit the completed command to apply it. Code updates require `/reload`, but settings updates apply on the next call.

### Settings files

- User: `<Pi agent directory>/magic8ball.json`, normally `~/.pi/agent/magic8ball.json`. This respects Pi's profile directory and `PI_CODING_AGENT_DIR`.
- Project: `<current workspace>/.pi/magic8ball.json`. Pi must report the project as trusted before this file is read.

Example user settings:

```json
{
  "builder": { "provider": "your-chat-provider", "model": "your-small-tool-capable-model" },
  "classifier": { "provider": "typesafe", "model": "jev-latest" }
}
```

Each file can set either or both roles. A project role replaces the entire user role; individual provider/model fields never inherit.
Files use strict JSON, with only these role fields and optional root `timeoutMs`, and must fit within 16000 UTF-8 bytes. Each identifier must contain 1–512 UTF-8 bytes without whitespace.
Malformed or inaccessible settings fail closed. Symlink files, symlink immediate parent directories, and nonregular files are rejected.
Both effective roles must be configured before a decision can run. Manual edits and successful command saves apply on the next call without `/reload`.
The former four `PI_MAGIC8BALL_*` model-selection variables are ignored.

Saves preserve the other role in the selected file, serialize writes, and use atomic replacement.
A `.lock` file prevents concurrent processes from overwriting one another. A leftover lock must be inspected before removal; there is no automatic lock reclamation.
An error after a save can leave its outcome uncertain. Inspect the files and `/magic8ball show` before retrying.
Nonparticipating writers can race validation; these checks are not an OS sandbox or a power-loss durability guarantee.

Other Jev and Clef catalog entries work through the same Pi classifier API, including `@cf/cloudflare/clef-flash`.
Use Pi's normal provider authentication. Do not put API keys in `magic8ball.json`, tool arguments, or this repository.

The builder must be a chat model that supports tool calls and JSON output. Select a small physical model, not a decision model.
The extension rejects Pi virtual-model entries before requests. This prevents a router from adding hidden model calls.
Model size alone does not establish evidence quality. One live smoke call completed both model stages with conversation context only.
It returned a valid advisory distribution without abstention. This does not establish calibration or context-builder quality.

## Tool

```json
{
  "question": "Which implementation strategy fits this repository?",
  "responses": {
    "extend_existing": "Add the behavior to the existing extension.",
    "separate_extension": "Create a separate extension.",
    "harness": "Implement the behavior in the harness."
  },
  "context": {
    "conversation": true,
    "workspace": true,
    "files": ["magic8ball.ts", "lib/builder.ts"]
  }
}
```

Call `magic8ball` with this input. Response descriptions are mandatory. The tool adds `insufficient_evidence` unless `abstain` is false.
Caller choices must number 2–25 with abstention, or 2–26 without it. Identifiers must match `[A-Za-z][A-Za-z0-9_]{0,63}`.
Reserved identifiers are `__proto__`, `constructor`, `prototype`, and `insufficient_evidence`.

Both context flags default to true. Set both to false to classify state built only from the question and response descriptions.
Optional `context.files` holds up to eight distinct workspace-relative file hints. Omission or an empty array supplies no hints.
Hints guide the builder. They do not trigger reads or expand permissions. Nonempty hints require workspace scope.
The input rejects denied path syntax, duplicates, null, and invalid types before model calls.
The evidence helper checks file existence, type, symlinks, and containment when a read occurs.
Scope flags control gathering. They do not restrict the caller's existing transcript or the parent agent's other tools.

A success returns:

- `answer`, `probabilities`, and backend `confidence`.
- `abstained`, `advisory: true`, and `confidenceMeaning`.
- Validated state, model identifiers, collection metadata, and usage.
- A source ledger with collector IDs, scope, source names, truncation, and inspected byte ranges.

Confidence describes distribution concentration, not probability of correctness. The extension preserves confidence separately from the winning probability.
Treat the result as evidence, not authorization or a command. The parent agent remains responsible for its action.

Probabilities are returned unchanged, without renormalization. Their sum must be within `0.000001` of one.
For values on the four-decimal grid, the validator also permits rounding error up to `0.00005 × number of choices`, including abstention.
It checks that bound in integer units. It does not round finer-precision values to qualify or relax range, key, confidence, or winner checks.

Every result includes `usageComplete`. True means no provider request began, or all begun requests returned usage before the tool returned. False means some usage is unknown; reported zero tokens or cost does not prove zero billing. Completed rejected replies still count toward reported usage. Late completions cannot update returned totals.

An error returns `ok: false`, `error.kind`, `error.code`, `error.stage`, and known completed-call usage.
The code equals the error kind. Evidence failures can also include a fixed `error.evidenceCode` (see Context builder). Stages are `preparation`, `collection`, `validation`, and `classification`.
The response contains no fabricated decision or raw provider error.

The call view shows the full sanitized question and supplied choice descriptions, with line breaks and wrapping. It does not change the inputs sent to the models.
The compact tool view shows the advisory choice, distribution, backend confidence, reported input/output/cache-read/cache-write tokens, cost, and incomplete-usage warning when needed. Errors also show known usage.
Expand the tool result to see facts, source IDs, inspected ranges, truncation, and uncertainties.
Progress updates show the current stage without context text. Structured results remain available without terminal UI.
Pi rejects arguments that fail the registered schema before the extension executes. Those errors use Pi's normal argument-error format.
Pi marks the tool result as an error. Raw provider errors are not copied into the response.

### Failure diagnostics

Add `"diagnostics": true` to a tool call to include fixed `error.diagnostics.phase` and `category` hints on failure. Omission or false leaves those hints out; successful results do not include diagnostics. This flag does not enable transcript capture, change settings, or authorize another request.

Phases distinguish input validation, preparation, builder requests, evidence calls, state validation, classification, and answer validation. Categories distinguish extension/local failures, terminal provider errors/aborts, and allowlisted HTTP/status-code hints such as authentication, rejection, rate limit, or transport. Unknown exceptions remain `unknown`. These are hints, not verified root causes. Raw error text, rejected state, credentials, headers, and thinking are not returned. Pi may persist tool arguments and these fixed hints in the parent transcript.

## Invocation deadline

The existing default stays **120000 milliseconds (two minutes)**. Set a different end-to-end deadline through the user command:

```text
/magic8ball timeout
/magic8ball timeout 300000
/magic8ball --project timeout 60000
/magic8ball --project timeout default
```

The query reports effective milliseconds and source without writing or generating. A decimal integer from 1 through 2147483647 is accepted. `default` removes only that scope's explicit timeout. Commands work without configured models and preserve all other settings in that file. Model and reasoning saves preserve its timeout too.

Optional root `timeoutMs` in `magic8ball.json` uses independent precedence: trusted project, global, then the two-minute default. A timeout-only project does not replace model roles; a model-only project inherits the global timeout. Untrusted project files remain unread. New invocations read fresh settings; changes cannot alter an in-flight invocation.

The budget starts at invocation entry, including settings preparation. Settings resolution uses the default until the configured budget is known, then measures that budget from the original entry. Every builder/classifier request receives a positive integer remaining timeout and zero retries. The local deadline still returns when a provider ignores cancellation. A longer deadline is not a monetary cap or a guarantee that remote work stops.

## Builder reasoning

Use the user-only command to inspect the effective level and the selected model's supported choices:

```text
/magic8ball reasoning
/magic8ball reasoning medium
/magic8ball --project reasoning high
/magic8ball reasoning default
```

Commands make no model requests. Saves default to global settings; project writes require trust.
A global reasoning write updates the global builder, not a project model override. A project write saves a complete effective builder override.
Both preserve the classifier. If a project builder overrides the global builder, it also overrides that role's reasoning.

The builder role in `magic8ball.json` accepts optional `reasoning`: `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
Only levels advertised by the selected model are accepted. Unsupported explicit levels fail before model work with `unsupported-reasoning`; no silent level or model fallback is used.
Omission and `default` preserve previous request behavior. They do not inherit the parent's thinking level.
`off` is accepted only when advertised and omits Pi's simple-stream reasoning option. Provider adapters control the native mapping.
Other supported levels are forwarded on every builder request. The classifier is unchanged.
Model commands and the two-model picker replace complete roles, so selecting a model without a reasoning field resets it to the legacy default. Set a level after selecting models.

More reasoning can increase latency and charges. The 2048-token output hint remains; some adapters add or adjust thinking budgets within model limits.
Existing request/tool ceilings and the deadline still apply. Neither reasoning levels nor token hints are a fixed monetary budget or a guarantee of better evidence gathering.
Explicit configuration appears in builder model metadata and the expanded result. Captured requests show the requested level and safe token/retry options; responses show native effort only when the SDK supplies it.
Hidden reasoning content remains excluded.

## Optional transcripts

Capture is off by default. Use these user-only commands:

```text
/magic8ball transcripts          # toggle capture
/magic8ball transcripts on       # enable for subsequent calls
/magic8ball transcripts show     # view the last captured invocation
/magic8ball transcripts off      # disable and clear retained text
```

Capture includes logical builder prompts/messages, tool declarations, visible responses, model-facing evidence results, and classifier inputs/outputs.
It omits hidden reasoning, signatures, images, authentication metadata, and raw provider errors. Failed or aborted builder response text is omitted.
These are filtered Pi transcripts, not raw provider wire payloads or per-request timing reports.
Ordinary conversation, file content, and visible model text can still contain sensitive data. The filter is not a secret detector.

Only the most recently started captured invocation is retained, with a 128000-byte UTF-8 body ceiling and an explicit truncation marker.
Display headers and a bounded failed-call diagnostic footer are outside that body ceiling. The footer survives clipping; each identifier is limited to 512 bytes with clipping reported, and off/reset also clears it.
Repeated `on` preserves it. `off`, session replacement, reload, and shutdown clear it; late results cannot restore it.
No transcript files, persistent capture settings, session entries, or model-facing result fields are added. Hosts and clients can retain displayed data separately.

In the TUI, the viewer is read-only: arrows and Page Up/Down scroll; Home/End jump; Escape or Ctrl+C closes it.
RPC `show` sends a user-directed notification. Capturing or viewing makes no additional model requests.
After loading a changed extension with `/reload`, enable capture before the call you want to inspect. Earlier calls cannot be reconstructed.

## Context builder

The builder runs a separate model loop with an in-memory transcript. It loads no extensions or inherited agent roles.
Its evidence calls use the parent's `ctx.executeTool`, so Pi's validation and permission hooks still run.

For an unknown directory layout, its instructions say to list the parent, wait for the result, then use exact returned names for child paths.
Independent calls can still be grouped. Instructions alone cannot prove that the builder follows this procedure.

It can use only these evidence tools:

- `magic8ball_list`: list one directory without recursion.
- `magic8ball_read`: read numbered lines from one text file.
- `magic8ball_search`: search one text file for a literal string.

These helpers are inactive model declarations but remain callable nested tools. Other orchestrators can discover them through Pi's tool catalog.
They have the same path restrictions when called directly.

A permitted missing read/list/search path returns a `path-not-found` observation, not a tool error.
This can occur only during the guarded path walk after validating arguments and all existing ancestors. Root failures and later I/O races remain errors.
Missing paths receive collector IDs and status metadata, consume evidence-call budget, and can inform later builder calls within the same limits.
They are absence observations, not file content. There is no automatic application retry.

Restricted paths, symlinks, wrong types, invalid arguments/text, access denials, and other I/O errors remain hard failures.
Fixed helper diagnostics are `invalid-arguments`, `path-denied`, `wrong-type`, `invalid-text`, `permission-denied`, and `io-failed`.
Unknown Pi validation/hook/runtime errors use `tool-denied-or-failed`; that label does not assert a permission denial.
An `isError` or thrown nested-tool result always stops collection, even if it claims `path-not-found`.
The final error and transcript show safe diagnostic codes without raw error text. Transcripts link failed evidence calls to their call IDs.

Paths must be workspace-relative. Helpers reject hidden paths, conventional credential files, `node_modules`, symlinks, and special files.
Reads and searches inspect one byte window of at most 16000 bytes.
Optional `byteOffset` defaults to 0. Optional `byteLength` defaults to 16000 and permits values from 1 through 16000.
Offsets must be nonnegative safe integers. Null values and invalid ranges fail.
The result reports a half-open byte range `[start, end)` and the observed file size.
Beyond EOF, the inspected range is empty at EOF. A window that starts inside a UTF-8 sequence fails.
A terminal partial UTF-8 sequence is omitted when more file bytes remain. The returned `end` excludes those bytes.
Resume at that `end` to read the complete character. The helper does not read beyond `byteLength` to complete it.
If no complete character fits, the result has empty text and an empty, truncated range.
Increase `byteLength` to at least four bytes before continuing from an empty range before EOF.
Malformed UTF-8 and incomplete sequences at EOF still fail.
Line numbers and `read.offset` refer to the selected window, not the whole file.
A window can start inside a line. Its first numbered line is then a fragment.
Truncation marks uninspected prefixes, tails, and output clipping. It does not imply all inspected bytes appear in the output.
Lists inspect at most 200 entries and use one extra entry to detect overflow. Results show truncation explicitly.

The collector assigns `conversation` to nonempty permitted conversation and `e1` through `e8` to successful workspace calls.
Final state evidence must cite these IDs, not file paths or invented sources. Unknown citations fail before classification.
The source ledger contains metadata, not file contents. Source validation cannot prove that a claim follows from its source.

The builder receives bounded active-branch context with context edits and compaction applied. Images, system instructions, and tool arguments are omitted.
Known earlier magic8ball tool results are omitted. Ordinary assistant text remains, even beside a magic8ball tool call.
Tool-call blocks and their arguments are omitted. A conversation quotation or compaction summary can still contain earlier decisions or probabilities.

There is no shell, Git execution, web access, write tool, classifier tool, or recursive subagent tool in the builder.

### Limits

Each invocation permits at most:

| Resource | Ceiling |
| --- | --- |
| Serialized request | 16000 UTF-8 bytes |
| Conversation text | 24000 UTF-8 bytes, retaining the end |
| Final state | 12000 UTF-8 bytes |
| Builder requests | 4 |
| Evidence calls | 8 |
| Builder output per request | 2048 requested tokens |
| Total duration | Configured invocation deadline; default 120000 milliseconds |

The last permitted builder request has no evidence tools and must return final state.
The builder also receives no tools after eight evidence calls. Each request reports remaining counts and finalization status.
Tool calls during finalization fail without execution. Eight calls bound inspected file bytes to at most 128000 per invocation.
The extension makes one classifier request after valid state. It makes no application-level retries or model fallbacks.
It requests `maxRetries: 0` from providers. Provider adapters can have their own transport behavior.
Token caps depend on provider support. These limits are not a monetary budget. Configured provider calls can incur charges.

Cancellation and the deadline propagate to all stages. A provider that ignores abort can continue its request after the tool returns an error.
No later stage starts after cancellation. Returned usage includes only calls whose usage arrived before the result settled.

### Data boundaries

The builder provider receives the question, descriptions, permitted conversation, and collected file content.
The classifier provider receives the question, descriptions, and final state. The parent session records state and results through normal Pi persistence.
The extension creates no separate transcript files or background services.

The path filter is not a secret detector or operating-system sandbox. Ordinary files and conversation text can contain secrets.
Concurrent filesystem mutation can race path validation. Parent permission hooks are trusted code and can have their own effects.
Use trusted workspaces and providers suitable for the data. Use OS isolation when stronger boundaries are required.

## Development

The tests use Node's built-in test runner. They make no model requests.
Exact development dependencies and `package-lock.json` provide a clean-checkout setup. No worktree symlinks are required.
Development dependencies include Pi 1.0.4, TypeScript, and Node typings. Pi supplies runtime peers when it loads the extension.
Host packages are not bundled runtime dependencies.

```bash
npm ci --ignore-scripts
npm run verify
```

The GitHub Actions workflow runs these commands on Node 24. Tests and CI make no model requests.

The suite covers AC-1 through AC-27 from [the generated contract](docs/pi-magic8ball.md).
Tests use temporary settings, mock catalogs and model responses, synthetic keys, mock fetch, and terminal dimensions.
They check limits, source IDs, cancellation, settings, transcripts, rendering, autocomplete, and classifier validation.
They do not establish live provider compatibility, terminal appearance, calibration, or builder quality.

The package check also runs inside `npm run verify`. Run it separately with:

```bash
npm run check:package
```

It packs with lifecycle scripts disabled, checks the file list, and extracts into a private temporary directory.
The packed TypeScript entry must register through Pi's loader without adjacent `node_modules`.
The packed benchmark dry run must work without an adapter or provider calls.
The check requires `tar`, as supplied by the Linux CI runner. Windows and macOS checks have not run.
No build step or compiled entry is required. Pi loads the source TypeScript through its extension loader.

The canonical contract lives in the maintainer workspace documentation store as `pi-magic8ball`.
Author changes through checkout, preview, and import. Compile the project copy through `docs_compile`.
Do not edit the generated contract directly.

### Before npm publication

The selected release is `@neruok/pi-magic8ball@0.1.0` under MIT. The manifest sets public access for the scoped package.

1. Confirm the manifest and lockfile identify the intended release.
2. Run `npm ci --ignore-scripts` and `npm run verify` in a clean checkout.
3. Inspect `npm pack --dry-run --ignore-scripts` and the package contents, including `LICENSE`.
4. Confirm registry access and ownership of the `@neruok` scope.
5. Get explicit publication authorization before running `npm publish`.

Package checks do not grant publication authority. Get explicit authorization before commits, tags, pushes, or npm publication.
The development dependencies pin Pi 1.0.4. Passing tests do not certify other host versions.

## Opt-in quality benchmark

Inspect the call plan without loading providers, adapters, or credentials:

```bash
npm run benchmark -- --dry-run --config small --config other
```

Two builder configurations produce 24 comparisons and permit at most 88 model calls.
The plan covers missing evidence, conflicting evidence, prompt injection, and decisive constraints, with both response orders.
Each builder configuration uses the normal bounded context loop. The direct baseline classifies a fixed factual state without a builder.
All inputs are synthetic. The benchmark does not inspect the workspace or parent session.

To prepare a live run:

1. Copy `scripts/benchmark-adapter.example.mjs` to a local adapter file.
2. Replace its builder and classifier identifiers with explicit catalog selections.
3. Use the same classifier for all builder configurations.
4. Configure provider authentication through Pi's normal boundary. Do not put credentials in the adapter.
5. Review the dry-run plan and authorize provider charges before execution.

A live invocation requires both flags:

```bash
npm run benchmark -- --allow-spend --adapter ./my-benchmark-adapter.mjs --output ./benchmark-report.json
```

The adapter is trusted executable code, not sandboxed data. Dry runs never import it.
The example creates a model runtime without a session, extension discovery, or network catalog refresh.
It rejects unavailable physical builders and classifiers. Each request asks for `maxRetries: 0`.
Custom adapters must honor the supplied signal and request options. Providers can have their own transport behavior.
`--config` can restrict a live run to named adapter configurations. Ctrl+C cancels the remaining comparisons.
Output files use exclusive creation, so an existing report is not overwritten.

Reports include model identifiers, per-case decisions, accuracy, abstention, response-order sensitivity, invalid-output counts, and reported usage.
Fact and uncertainty coverage use fixture keyword matching. These metrics are diagnostic heuristics, not semantic proofs.
Reports include aggregate and per-configuration results. They omit final state, transcripts, and raw provider errors.
The benchmark has no application-level retries. A failed comparison contributes an error count and the next planned comparison proceeds.
No live benchmark ran during implementation. A synthetic fixture benchmark cannot establish general calibration or neutrality.

Boolean/score questions, Git execution, and web research remain outside the tool contract.
