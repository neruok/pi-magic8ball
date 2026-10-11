import type { Context, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { isStateTool, stateArguments } from './state.ts';
import { LIMITS, object, truncateUtf8, type BuilderReasoning, type EvidenceFailureCode, type ModelSelection } from './decision.ts';

const CAPTURE_BYTES = LIMITS.transcriptBytes;
const USAGE = 'Usage: /magic8ball transcripts [on|off|show]. No argument toggles session-only capture.';
const ARGUMENT_FIELDS = ['path', 'offset', 'limit', 'text', 'byteOffset', 'byteLength'];
const STOP_REASONS = ['stop', 'toolUse', 'length', 'error', 'aborted'];

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!object(value)) return {};
  return Object.fromEntries(names.filter(name => Object.hasOwn(value, name) && (typeof value[name] === 'string' || typeof value[name] === 'number' && Number.isFinite(value[name]))).map(name => [name, value[name]]));
}
function content(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return [];
  return value.flatMap((block): unknown[] => {
    if (!object(block)) return [];
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
    if (block.type === 'toolCall') return [{ type: 'toolCall', ...fields(block, ['id', 'name']), arguments: typeof block.name === 'string' && isStateTool(block.name) ? stateArguments(block.name, block.arguments) : fields(block.arguments, ARGUMENT_FIELDS) }];
    return []; // Never retain thinking, signatures, images, or unknown provider blocks.
  });
}
function message(value: unknown, roleOverride?: string): unknown {
  if (!object(value)) return undefined;
  const role = roleOverride ?? value.role;
  if (!['user', 'assistant', 'toolResult'].includes(String(role))) return undefined;
  const failed = role === 'assistant' && ['error', 'aborted'].includes(String(value.stopReason));
  return { role, ...fields(value, ['toolCallId', 'toolName', ...(role === 'assistant' ? ['providerThinkingLevel'] : [])]), ...(STOP_REASONS.includes(String(value.stopReason)) ? { stopReason: value.stopReason } : {}), content: failed ? [] : content(value.content) };
}
function probabilities(value: unknown): Record<string, number> {
  if (!object(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
}

export interface TranscriptRecorder {
  builderRequest(model: ModelSelection['builder'], context: Context, options?: ModelsSimpleStreamOptions, requestedReasoning?: BuilderReasoning): void;
  builderResponse(value: unknown): void;
  evidenceResult(value: unknown): void;
  stateResult(value: unknown): void;
  evidenceFailure(name: string, id: string, code: EvidenceFailureCode): void;
  classifierRequest(model: ModelSelection['classifier'], value: unknown): void;
  classifierResponse(value: unknown): void;
  finish(value: unknown): void;
}

/** Extension-local text only. No original message objects or provider metadata are retained. */
export class TranscriptStore {
  private enabled = false;
  private latest?: { id: string; text: string; bytes: number; truncated: boolean; closed: boolean; status: string; failure?: string };
  isEnabled(): boolean { return this.enabled; }
  private clear(): void {
    // Revoke and erase the object still referenced by an in-flight recorder, not just the index.
    if (this.latest) { this.latest.text = ''; this.latest.bytes = 0; this.latest.closed = true; this.latest.failure = undefined; }
    this.latest = undefined;
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }
  reset(): void { this.setEnabled(false); }
  begin(id: string): TranscriptRecorder | undefined {
    if (!this.enabled) return undefined;
    this.clear();
    const trace = { id: truncateUtf8(id.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), 512).text, text: '', bytes: 0, truncated: false, closed: false, status: 'running', failure: undefined as string | undefined };
    this.latest = trace;
    const active = () => this.enabled && this.latest === trace && !trace.closed;
    const append = (label: string, project: () => unknown): void => {
      if (!active() || trace.truncated) return;
      // Logging must never replace the decision outcome, even for malformed adapter values.
      let text: string;
      try { text = `\n--- ${label} ---\n${JSON.stringify(project(), null, 2)}\n`; }
      catch { text = `\n--- ${label} ---\n[entry could not be captured]\n`; }
      const bounded = truncateUtf8(text, CAPTURE_BYTES - trace.bytes);
      trace.text += bounded.text;
      trace.bytes += Buffer.byteLength(bounded.text);
      trace.truncated = bounded.truncated;
    };
    return {
      builderRequest: (model, context, options, requestedReasoning = 'default') => append('builder request', () => ({ model: fields(model, ['provider', 'model']), requestedReasoning, options: fields(options, ['reasoning', 'maxTokens', 'maxRetries']), systemPrompt: context.systemPrompt, messages: context.messages.map(value => message(value)).filter(Boolean), tools: context.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) })),
      builderResponse: value => append('builder response', () => message(value, 'assistant')),
      evidenceResult: value => append('evidence result', () => message(value)),
      stateResult: value => append('state result', () => message(value)),
      evidenceFailure: (name, id, code) => {
        if (!active()) return;
        append('evidence failure', () => ({ toolName: name, toolCallId: id, code }));
        if (trace.truncated) {
          // A bounded diagnostic survives body clipping; it never contains tool/hook error text.
          const clean = (value: string) => truncateUtf8(value.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), 512);
          const tool = clean(name), call = clean(id);
          trace.failure = `\n--- evidence failure (diagnostic footer) ---\n${JSON.stringify({ toolName: tool.text, toolCallId: call.text, identifiersTruncated: tool.truncated || call.truncated, code }, null, 2)}\n`;
        }
      },
      classifierRequest: (model, value) => append('classifier request', () => {
        // This context is constructed from already-validated state and criteria by the orchestrator.
        if (!object(value)) return {};
        return { model: fields(model, ['provider', 'model']), state: value.state, questions: value.questions };
      }),
      classifierResponse: value => append('classifier response', () => {
        const failed = object(value) && ['error', 'aborted'].includes(String(value.stopReason));
        const decision = !failed && object(value) && object(value.answers) && object(value.answers.decision) ? value.answers.decision : {};
        return { ...(object(value) && STOP_REASONS.includes(String(value.stopReason)) ? { stopReason: value.stopReason } : {}), answers: { decision: { ...fields(decision, ['type', 'choice', 'confidence']), probabilities: probabilities(decision.probabilities) } } };
      }),
      finish: value => {
        if (!active()) return;
        trace.closed = true;
        trace.status = object(value) && value.ok === true ? 'completed' : 'failed';
      },
    };
  }
  showText(): string {
    if (!this.enabled) return 'Transcript capture is off. Use /magic8ball transcripts on.';
    if (!this.latest) return 'No transcript captured yet. Capture applies to subsequent calls.';
    return `Transcript ${this.latest.id} (${this.latest.status})\nLogical Pi inputs/visible outputs, not provider wire payloads.\n${this.latest.text}${this.latest.truncated ? `\n[transcript truncated at ${CAPTURE_BYTES} UTF-8 bytes]\n` : ''}${this.latest.failure ?? ''}`;
  }
}

/** Read-only inline viewport. Data stays out of the session message stream. */
export function createTranscriptViewer(text: () => string, terminal: { rows: number }, done: () => void) {
  let offset = 0, page = 1, cacheText = '', cacheWidth = -1, lines: string[] = [];
  return {
    render(width: number): string[] {
      const current = text().replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
      if (current !== cacheText || width !== cacheWidth) {
        cacheText = current; cacheWidth = width;
        lines = current.split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))).map(line => truncateToWidth(line, width));
      }
      const height = Math.max(1, terminal.rows - 2);
      page = Math.max(1, height - (height >= 3 ? 1 : 0));
      offset = Math.min(offset, Math.max(0, lines.length - page));
      const body = lines.slice(offset, offset + page);
      return height >= 3 ? [...body, truncateToWidth(`↑↓ scroll • PgUp/PgDn • Esc/Ctrl+C close (${offset + 1}/${lines.length})`, width)] : body;
    },
    invalidate() { cacheWidth = -1; },
    handleInput(data: string) {
      const kb = getKeybindings();
      if (kb.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) { done(); return; }
      if (kb.matches(data, 'tui.select.up')) offset = Math.max(0, offset - 1);
      if (kb.matches(data, 'tui.select.down')) offset++;
      if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
      if (matchesKey(data, Key.pageDown)) offset += page;
      if (matchesKey(data, Key.home)) offset = 0;
      if (matchesKey(data, Key.end)) offset = lines.length;
    },
  };
}

export async function transcriptCommand(args: string, ctx: ExtensionCommandContext, store: TranscriptStore): Promise<void> {
  const tokens = args.trim().split(/\s+/);
  if (tokens.length > 2 || ![undefined, 'on', 'off', 'show'].includes(tokens[1])) { ctx.ui.notify(USAGE, 'error'); return; }
  if (tokens[1] !== 'show') {
    store.setEnabled(tokens[1] === 'on' || (tokens[1] === undefined && !store.isEnabled()));
    ctx.ui.notify(store.isEnabled()
      ? 'Transcript capture is on for this session. Content can be sensitive. Only the last captured invocation is kept in memory (128000-byte limit). Use /magic8ball transcripts show to view it; off clears it.'
      : 'Transcript capture is off; retained text cleared.', 'info');
    return;
  }
  if (ctx.mode !== 'tui' || !store.isEnabled()) { ctx.ui.notify(store.showText(), 'info'); return; }
  await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
    const viewer = createTranscriptViewer(() => store.showText(), tui.terminal, () => done());
    return { ...viewer, handleInput(data: string) { viewer.handleInput(data); tui.requestRender(); } };
  });
}
