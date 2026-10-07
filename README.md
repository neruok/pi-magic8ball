# pi-magic8ball

An advisory choice tool for Pi. A lightweight context builder collects neutral state. Jev or Clef then returns a choice distribution.

The builder does not choose or rank responses. Its output has a fixed schema. Schema validation cannot prove neutrality or factual accuracy.

## Load

Requires Node.js 24 or newer and Pi 1.0.4 or newer. This version was checked against Pi 1.0.4.

Load the extension for one invocation:

```bash
pi -e /absolute/path/to/pi-magic8ball/magic8ball.ts
```

No installation or profile change is required. Pi supplies the host packages listed in `package.json`.

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
Files use strict JSON, with only these role fields, and must fit within 16000 UTF-8 bytes. Each identifier must contain 1–512 UTF-8 bytes without whitespace.
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
    "workspace": true
  }
}
```

Call `magic8ball` with this input. Response descriptions are mandatory. The tool adds `insufficient_evidence` unless `abstain` is false.
Caller choices must number 2–25 with abstention, or 2–26 without it. Identifiers must match `[A-Za-z][A-Za-z0-9_]{0,63}`.
Reserved identifiers are `__proto__`, `constructor`, `prototype`, and `insufficient_evidence`.

Both context flags default to true. Set both to false to classify state built only from the question and response descriptions.
Scope flags control gathering. They do not restrict the caller's existing transcript or the parent agent's other tools.

A success returns:

- `answer`, `probabilities`, and backend `confidence`.
- `abstained`, `advisory: true`, and `confidenceMeaning`.
- Validated state, model identifiers, collection metadata, and usage.

Confidence describes distribution concentration, not probability of correctness. The extension preserves confidence separately from the winning probability.
Treat the result as evidence, not authorization or a command. The parent agent remains responsible for its action.

An error returns `ok: false`, an error kind, and completed-call usage. It contains no fabricated decision.
Pi rejects arguments that fail the registered schema before the extension executes. Those errors use Pi's normal argument-error format.
Pi marks the tool result as an error. Raw provider errors are not copied into the response.

## Context builder

The builder runs a separate model loop with an in-memory transcript. It loads no extensions or inherited agent roles.
Its evidence calls use the parent's `ctx.executeTool`, so Pi's validation and permission hooks still run.

It can use only these evidence tools:

- `magic8ball_list`: list one directory without recursion.
- `magic8ball_read`: read numbered lines from one text file.
- `magic8ball_search`: search one text file for a literal string.

These helpers are inactive model declarations but remain callable nested tools. Other orchestrators can discover them through Pi's tool catalog.
They have the same path restrictions when called directly.

Paths must be workspace-relative. Helpers reject hidden paths, conventional credential files, `node_modules`, symlinks, and special files.
Reads and searches inspect only the first 16000 bytes of a file. Offsets refer to lines within that prefix, not the whole file.
Lists inspect at most 200 entries and use one extra entry to detect overflow. Results show truncation explicitly.

The builder receives bounded active-branch context with context edits and compaction applied. Images, system instructions, and tool arguments are omitted.
Known earlier magic8ball tool results are omitted. A conversation quotation or compaction summary can still contain earlier decisions or probabilities.

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
| Total duration | 120000 milliseconds |

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
Type-checking requires TypeScript and Node typings. Direct test execution requires the host peer packages to resolve in `node_modules`.
This worktree uses ignored symlinks to the installed Pi packages and Node typings. No packages were installed for this implementation.

```bash
npm run verify
```

The suite covers AC-1 through AC-10 from [the generated contract](docs/pi-magic8ball.md).
The original 14 checks failed against the V1 no-op scaffold. All nine settings/command checks failed before the settings implementation.
The two overflow checks and four compact-search checks failed before their respective picker changes. Cancellation checks passed before and after.
The implemented version passes all 30 checks and strict TypeScript checking. The installed Pi loader registers four tools and `/magic8ball` without errors.
Tests use temporary settings files, mock UI/model catalogs, model responses, terminal dimensions, and the nested-tool boundary.
They use the installed Pi session projection and TypeBox schemas. They do not prove terminal rendering, live Jev/Clef behavior, calibration, or context-builder quality.

The canonical contract is document `pi-magic8ball` in the maintainer workspace documentation store.
Author changes through checkout, preview, and import. Publish to this worktree with `docs_compile` and its project output root.
Do not edit the generated contract directly.

V1 excludes boolean/score questions, Git execution, and web research.
