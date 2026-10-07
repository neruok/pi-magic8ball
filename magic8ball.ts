import { Type } from 'typebox';
import type { Api, ClassifierApi, ClassifierModel, JsonValue, Model, Tool } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { buildState } from './lib/builder.ts';
import { decide, DecisionError, readConfig, type DecisionDependencies } from './lib/decision.ts';
import { evidence } from './lib/evidence.ts';
import { loadSettings, settingsPaths } from './lib/settings.ts';
import { registerSettingsCommand } from './lib/settings-command.ts';

const text = Type.String({ minLength: 1 });
const strings = Type.Array(text);
const StateSchema = Type.Object({ goal: text, constraints: strings, current_state: strings, evidence: Type.Array(Type.Object({ fact: text, source: text }, { additionalProperties: false })), uncertainties: strings }, { additionalProperties: false });
const ModelSchema = Type.Object({ provider: text, model: text }, { additionalProperties: false });
const UsageSchema = Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), totalTokens: Type.Number(), cost: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), total: Type.Number() }) });
const OutputSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), answer: text, probabilities: Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 })), confidence: Type.Number({ minimum: 0, maximum: 1 }), abstained: Type.Boolean(), advisory: Type.Literal(true), confidenceMeaning: text, state: StateSchema, models: Type.Object({ builder: ModelSchema, classifier: ModelSchema }), collection: Type.Object({ conversationTruncated: Type.Boolean(), evidenceCalls: Type.Integer(), sources: strings }), usage: UsageSchema }, { additionalProperties: false }),
  Type.Object({ ok: Type.Literal(false), error: Type.Object({ kind: text, message: text }), usage: UsageSchema }, { additionalProperties: false })
]);
const InputSchema = Type.Object({
  question: text,
  responses: Type.Record(Type.String(), text, { minProperties: 2, maxProperties: 26, description: 'Response identifiers mapped to mandatory descriptions. Default abstention reserves one of 26 choices.' }),
  abstain: Type.Optional(Type.Boolean({ description: 'Add insufficient_evidence. Default true.' })),
  context: Type.Optional(Type.Object({ conversation: Type.Optional(Type.Boolean({ description: 'Share bounded conversation text. Default true.' })), workspace: Type.Optional(Type.Boolean({ description: 'Permit bounded workspace reads. Default true.' })) }, { additionalProperties: false }))
}, { additionalProperties: false });

const EVIDENCE_TOOLS = [
  { operation: 'read', name: 'magic8ball_read', description: 'Read one workspace text file. Reject hidden paths, credential names, symlinks, external paths and special files. Inspect only the first 16000 bytes. Return at most 200 numbered lines.', parameters: Type.Object({ path: text, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }) },
  { operation: 'list', name: 'magic8ball_list', description: 'List one workspace directory, without recursion. Inspect at most 200 entries and omit hidden paths, credential names, node_modules, symlinks and special files.', parameters: Type.Object({ path: Type.Optional(text) }, { additionalProperties: false }) },
  { operation: 'search', name: 'magic8ball_search', description: 'Search for literal text in the first 16000 bytes of one permitted workspace file. Return at most 200 numbered matching lines. No regular expressions or recursive scan.', parameters: Type.Object({ path: text, text }, { additionalProperties: false }) }
];

function dependencies(ctx: ExtensionToolContext): DecisionDependencies {
  let builder: Model<Api> | undefined;
  let classifier: ClassifierModel<ClassifierApi> | undefined;
  return {
    async prepare() {
      const models = readConfig((await loadSettings(settingsPaths(ctx.cwd, getAgentDir()), ctx.isProjectTrusted())).settings);
      builder = ctx.modelRegistry.find(models.builder.provider, models.builder.model);
      classifier = ctx.modelRegistry.findOfType('classifier', models.classifier.provider, models.classifier.model);
      if (!builder || builder.api === 'pi-virtual' || !classifier) throw new DecisionError('model-unavailable');
      return models;
    },
    async build(request, signal, recordUsage) {
      if (!builder) throw new DecisionError('model-unavailable');
      const selected = builder;
      return buildState(request, {
        tools: EVIDENCE_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })) as Tool[],
        conversation: request.context.conversation ? ctx.sessionManager.buildSessionProjection().messages : [],
        complete: (context, _signal, options) => ctx.modelRegistry.streamSimple(selected, context, options).result(),
        executeTool: async (name, args, signal) => {
          const outcome = await ctx.executeTool(name, args, { signal });
          return { ...outcome.result, isError: outcome.isError };
        }
      }, signal, recordUsage);
    },
    async classify(request, state, signal) {
      if (!classifier) throw new DecisionError('model-unavailable');
      return ctx.modelRegistry.classify(classifier, { state, questions: { decision: { type: 'choice', instructions: request.question, criteria: request.responses } } }, { signal, maxRetries: 0 });
    }
  };
}

export default function magic8ball(pi: ExtensionAPI): void {
  registerSettingsCommand(pi);
  for (const tool of EVIDENCE_TOOLS) {
    pi.registerTool({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      exposure: 'codemode', namespace: { name: 'magic8ball-evidence', description: 'Bounded read-only workspace evidence tools for the decision-context builder.' },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async execute(_id, args, signal, _update, ctx) {
        const result = await evidence(ctx.cwd, tool.operation, args, signal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
    });
  }
  pi.registerTool({
    name: 'magic8ball', label: 'Magic 8-ball', exposure: 'model-only',
    description: 'Ask an advisory choice question with mandatory descriptions for each response. A separate context builder gathers neutral state, then Jev or Clef returns a distribution. Results are advisory evidence, never authorization or an execution command. Confidence measures distribution concentration, not probability of correctness. You remain responsible for the final action. Context defaults to conversation and workspace. No shell, git execution, web, writes, or hidden model fallback. Uses host-configured models and may incur provider charges.',
    promptGuidelines: ['Treat magic8ball results as advisory evidence. You remain responsible for decisions and authorization.'],
    parameters: InputSchema, outputSchema: OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(_id, args, signal, _update, ctx) {
      const result = await decide(args, dependencies(ctx), signal ?? ctx.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as unknown as JsonValue, details: result, isError: !result.ok, usage: result.usage };
    }
  });
}
