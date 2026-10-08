import type { ModelThinkingLevel, Usage } from '@earendil-works/pi-ai';
import { permittedFilePath } from './paths.ts';
import { Execution, type FailureDiagnostics } from './execution.ts';

export const LIMITS = Object.freeze({ requestBytes: 16000, stateBytes: 12000, conversationBytes: 24000, evidenceBytes: 16000, builderRequests: 4, evidenceCalls: 8, outputTokens: 2048, timeoutMs: 120000 });
export const ABSTENTION = 'insufficient_evidence';
export const REASONING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type BuilderReasoning = 'default' | ModelThinkingLevel;
export const EVIDENCE_FAILURE_CODES = ['invalid-arguments', 'path-denied', 'wrong-type', 'invalid-text', 'permission-denied', 'io-failed', 'tool-denied-or-failed'] as const;
export type EvidenceFailureCode = typeof EVIDENCE_FAILURE_CODES[number];
export function isEvidenceFailureCode(value: unknown): value is EvidenceFailureCode { return typeof value === 'string' && EVIDENCE_FAILURE_CODES.includes(value as EvidenceFailureCode); }
export type ErrorKind = 'invalid-input' | 'invalid-state' | 'invalid-answer' | 'invalid-config' | 'settings-unavailable' | 'not-configured' | 'model-unavailable' | 'unsupported-reasoning' | 'builder-failed' | 'classifier-failed' | 'evidence-failed' | 'budget-exhausted' | 'cancelled' | 'timeout';
const MESSAGES: Record<ErrorKind, string> = {
  'invalid-input': 'Invalid magic8ball input. Check response descriptions, identifiers, scopes, counts, and size.',
  'invalid-state': 'The context builder did not return valid neutral state within the size limit.',
  'invalid-answer': 'The classifier did not return a valid choice distribution.',
  'not-configured': 'Configure both models with /magic8ball or magic8ball.json before use.',
  'invalid-config': 'Invalid magic8ball.json. Check JSON, complete provider/model pairs, fields, and size.',
  'settings-unavailable': 'Cannot safely access magic8ball settings. Inspect /magic8ball show and the settings paths before retrying.',
  'model-unavailable': 'A configured model is not available in the Pi catalog.',
  'unsupported-reasoning': 'The configured builder reasoning level is unsupported. Use /magic8ball reasoning to inspect supported levels.',
  'builder-failed': 'The context builder failed. No classification was attempted.',
  'classifier-failed': 'The classifier failed. No decision is available.',
  'evidence-failed': 'An evidence call failed or was denied. No classification was attempted.',
  'budget-exhausted': 'The context builder exhausted its request or evidence-call limit.',
  cancelled: 'The decision was cancelled.', timeout: 'The decision exceeded its deadline.'
};
export class DecisionError extends Error {
  readonly kind: ErrorKind;
  readonly evidenceCode?: EvidenceFailureCode;
  constructor(kind: ErrorKind, evidenceCode?: EvidenceFailureCode) { super(MESSAGES[kind]); this.kind = kind; this.evidenceCode = evidenceCode; }
}
export type DecisionRequest = { question: string; responses: Record<string, string>; abstain: boolean; context: { conversation: boolean; workspace: boolean; files?: string[] } };
export type DecisionState = { goal: string; constraints: string[]; current_state: string[]; evidence: { fact: string; source: string }[]; uncertainties: string[] };
export type ModelSelection = { builder: { provider: string; model: string; reasoning?: BuilderReasoning }; classifier: { provider: string; model: string } };
export type ByteRange = { start: number; end: number; totalBytes: number };
export type CollectedEvidence = { id: string; scope: 'conversation' | 'workspace'; source: string; truncated: boolean; range?: ByteRange; code?: 'path-not-found' };
export type Collection = { conversationTruncated: boolean; evidenceCalls: number; sources: string[]; evidence: CollectedEvidence[] };
export type DecisionStage = 'preparation' | 'collection' | 'validation' | 'classification';
export type DecisionProgress = { stage: DecisionStage };
export type RecordUsage = (usage?: Partial<Usage>) => void;
export type DecisionDependencies = {
  prepare(execution: Execution): Promise<ModelSelection>;
  build(request: DecisionRequest, signal: AbortSignal, recordUsage: RecordUsage, execution: Execution): Promise<{ text: string; collection: Collection }>;
  classify(request: DecisionRequest, state: DecisionState, signal: AbortSignal, execution: Execution): Promise<unknown>;
};
export type DecisionResult = ({ ok: true; answer: string; probabilities: Record<string, number>; confidence: number; abstained: boolean; advisory: true; confidenceMeaning: string; state: DecisionState; models: ModelSelection; collection: Collection } | { ok: false; error: { kind: ErrorKind; code: ErrorKind; stage: DecisionStage; message: string; evidenceCode?: EvidenceFailureCode; diagnostics?: FailureDiagnostics } }) & { usage: Usage; usageComplete: boolean };

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value: Record<string, unknown>, allowed: string[], required: string[] = allowed): boolean {
  return Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k));
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

export function validateRequest(input: unknown): DecisionRequest {
  const bad = () => { throw new DecisionError('invalid-input'); };
  if (!object(input) || !exactKeys(input, ['question', 'responses', 'abstain', 'context', 'diagnostics'], ['question', 'responses'])) return bad();
  if (!nonempty(input.question) || !object(input.responses) || (Object.hasOwn(input, 'abstain') && typeof input.abstain !== 'boolean')) return bad();
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch { return bad(); }
  if (Buffer.byteLength(serialized) > LIMITS.requestBytes) return bad();
  if (Object.hasOwn(input, 'diagnostics') && typeof input.diagnostics !== 'boolean') return bad();
  const abstain = input.abstain !== false;
  const entries = Object.entries(input.responses);
  if (entries.length < 2 || entries.length > (abstain ? 25 : 26)) return bad();
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype', ABSTENTION].includes(key) || !nonempty(value)) return bad();
  }
  const context: DecisionRequest['context'] = { conversation: true, workspace: true };
  if (Object.hasOwn(input, 'context')) {
    if (!object(input.context) || !exactKeys(input.context, ['conversation', 'workspace', 'files'], [])) return bad();
    for (const key of ['conversation', 'workspace'] as const) {
      if (Object.hasOwn(input.context, key)) {
        if (typeof input.context[key] !== 'boolean') return bad();
        context[key] = input.context[key];
      }
    }
    if (Object.hasOwn(input.context, 'files')) {
      const files = input.context.files;
      if (!Array.isArray(files) || files.length > LIMITS.evidenceCalls || !files.every(permittedFilePath) || new Set(files).size !== files.length || (!context.workspace && files.length > 0)) return bad();
      context.files = [...files];
    }
  }
  const responses = Object.fromEntries(entries) as Record<string, string>;
  if (abstain) responses[ABSTENTION] = 'Available evidence is insufficient to reliably distinguish the supplied choices.';
  return { question: input.question, responses, abstain, context };
}

export function parseState(text: string, sourceIds?: readonly string[]): DecisionState {
  const bad = () => { throw new DecisionError('invalid-state'); };
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.stateBytes) return bad();
  let state: unknown;
  try { state = JSON.parse(text); } catch { return bad(); }
  if (!object(state) || !exactKeys(state, ['goal', 'constraints', 'current_state', 'evidence', 'uncertainties']) || !nonempty(state.goal)) return bad();
  for (const key of ['constraints', 'current_state', 'uncertainties']) {
    if (!Array.isArray(state[key]) || !state[key].every(nonempty)) return bad();
  }
  if (!Array.isArray(state.evidence) || !state.evidence.every(e => object(e) && exactKeys(e, ['fact', 'source']) && nonempty(e.fact) && nonempty(e.source))) return bad();
  if (sourceIds && state.evidence.some(e => !sourceIds.includes(e.source))) return bad();
  return state as DecisionState;
}

export type DecisionSettings = Partial<ModelSelection> & { timeoutMs?: number };
export function parseSettings(value: unknown): DecisionSettings {
  if (!object(value) || !exactKeys(value, ['builder', 'classifier', 'timeoutMs'], [])) throw new DecisionError('invalid-config');
  const settings: DecisionSettings = {};
  if (Object.hasOwn(value, 'timeoutMs')) {
    if (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2147483647) throw new DecisionError('invalid-config');
    settings.timeoutMs = value.timeoutMs;
  }
  for (const role of ['builder', 'classifier'] as const) {
    if (!Object.hasOwn(value, role)) continue;
    const pair = value[role];
    if (!object(pair) || !exactKeys(pair, role === 'builder' ? ['provider', 'model', 'reasoning'] : ['provider', 'model'], ['provider', 'model'])) throw new DecisionError('invalid-config');
    if (Object.hasOwn(pair, 'reasoning') && (typeof pair.reasoning !== 'string' || !REASONING_LEVELS.includes(pair.reasoning as BuilderReasoning))) throw new DecisionError('invalid-config');
    for (const key of ['provider', 'model'] as const) {
      if (typeof pair[key] !== 'string' || !pair[key] || /\s/.test(pair[key]) || Buffer.byteLength(pair[key]) > 512) throw new DecisionError('invalid-config');
    }
    settings[role] = { provider: pair.provider as string, model: pair.model as string, ...(role === 'builder' && Object.hasOwn(pair, 'reasoning') ? { reasoning: pair.reasoning as BuilderReasoning } : {}) };
  }
  return settings;
}

export function readConfig(value: unknown): ModelSelection {
  const settings = parseSettings(value);
  if (!settings.builder || !settings.classifier) throw new DecisionError('not-configured');
  return { builder: settings.builder, classifier: settings.classifier };
}

// Range and finiteness checks precede this sum check. Returned values are never rewritten.
function validProbabilitySum(values: number[]): boolean {
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= .000001) return true;
  const units = values.map(value => Math.round(value * 10000));
  if (!values.every((value, index) => value === units[index] / 10000)) return false;
  // Each four-decimal value can contribute at most half a unit of rounding error.
  return 2 * Math.abs(units.reduce((a, b) => a + b, 0) - 10000) <= values.length;
}

function validateAnswer(result: unknown, responses: Record<string, string>) {
  if (!object(result) || result.stopReason !== 'stop') throw new DecisionError('classifier-failed');
  const answer = object(result.answers) ? result.answers.decision : undefined;
  const bad = () => { throw new DecisionError('invalid-answer'); };
  if (!object(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(responses, answer.choice) || !object(answer.probabilities)) return bad();
  const keys = Object.keys(responses);
  if (!exactKeys(answer.probabilities, keys)) return bad();
  const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!probability(answer.confidence) || !Object.values(answer.probabilities).every(probability)) return bad();
  const probabilities = answer.probabilities as Record<string, number>;
  if (!validProbabilitySum(Object.values(probabilities))) return bad();
  if (probabilities[answer.choice] !== Math.max(...Object.values(probabilities))) return bad();
  return { answer: answer.choice, confidence: answer.confidence, probabilities: { ...probabilities } };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(total: Usage, usage?: Partial<Usage>): void {
  if (!usage) return;
  const amount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) total[key] += amount(usage[key]);
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] += amount(usage.cost?.[key]);
}

// The deadline also bounds a provider promise that does not honor its abort signal.
export async function decide(input: unknown, deps: DecisionDependencies, external?: AbortSignal, timeoutMs = LIMITS.timeoutMs, onProgress?: (progress: DecisionProgress) => void): Promise<DecisionResult> {
  const usage = emptyUsage();
  const execution = new Execution(timeoutMs, external);
  let stage: ErrorKind = 'model-unavailable';
  let phase: DecisionStage = 'preparation';
  const progress = (next: DecisionStage) => {
    execution.check();
    phase = next;
    // Display failures must not change decision behavior.
    try { onProgress?.({ stage: next }); } catch { /* No raw UI errors in model context. */ }
  };
  const signal = execution.signal;
  const check = () => execution.check();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => { try { execution.check(); } catch (error) { reject(error); } };
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    check();
    const request = validateRequest(input);
    const operation = async (): Promise<DecisionResult> => {
      progress('preparation');
      execution.setPhase('preparation');
      const models = await deps.prepare(execution); check();
      stage = 'builder-failed'; progress('collection');
      execution.setPhase('builder');
      const built = await deps.build(request, signal, u => { if (execution.accepting) addUsage(usage, u); }, execution); check();
      progress('validation');
      execution.setPhase('state-validation');
      const state = parseState(built.text, built.collection.evidence?.map(source => source.id) ?? []);
      stage = 'classifier-failed'; progress('classification');
      execution.setPhase('classifier');
      const raw = await execution.provider('classifier', async () => {
        const result = await deps.classify(request, state, signal, execution);
        if (execution.accepting && object(result) && object(result.usage)) addUsage(usage, result.usage as Partial<Usage>);
        return result;
      });
      check();
      // Terminal provider failures retain their provider diagnostic category.
      if (object(raw) && raw.stopReason === 'stop') execution.setPhase('answer-validation');
      const answer = validateAnswer(raw, request.responses);
      check();
      return { ok: true, ...answer, abstained: answer.answer === ABSTENTION, advisory: true, confidenceMeaning: 'Distribution concentration, not probability of correctness.', state, models, collection: built.collection, usage: structuredClone(usage), usageComplete: execution.usageComplete };
    };
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    // Cancellation/deadline takes precedence even if a provider rejects during abort.
    if (signal.aborted) { try { execution.check(); } catch (aborted) { error = aborted; } }
    const kind: ErrorKind = error instanceof DecisionError ? error.kind : stage;
    // Copy usage so late provider completion cannot mutate a returned error.
    return { ok: false, error: { kind, code: kind, stage: phase, message: MESSAGES[kind], ...(kind === 'evidence-failed' && error instanceof DecisionError && isEvidenceFailureCode(error.evidenceCode) ? { evidenceCode: error.evidenceCode } : {}), ...(object(input) && input.diagnostics === true ? { diagnostics: execution.diagnostics(error) } : {}) }, usage: structuredClone(usage), usageComplete: execution.usageComplete };
  } finally {
    execution.finish();
    signal.removeEventListener('abort', rejectAbort);
  }
}

export function truncateUtf8(text: string, maxBytes: number, tail = false): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  if (tail) {
    let start = bytes.length - maxBytes;
    while ((bytes[start] & 0xc0) === 0x80) start++;
    return { text: bytes.subarray(start).toString('utf8'), truncated: true };
  }
  let end = maxBytes;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
