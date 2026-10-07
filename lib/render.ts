import { truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { object, type DecisionResult } from './decision.ts';

function safe(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function lines(details: unknown, expanded: boolean, partial: boolean): string[] {
  if (!object(details)) return ['Magic 8-ball: no structured result (host argument or execution error).'];
  if (partial) return [`Magic 8-ball: ${safe(details.stage)}…`];
  if (details.ok === false && object(details.error)) {
    return [`Magic 8-ball: ${safe(details.error.code ?? details.error.kind)} (${safe(details.error.stage ?? 'unknown stage')})`, safe(details.error.message), ...(details.error.evidenceCode ? [`Evidence: ${safe(details.error.evidenceCode)}`] : [])];
  }
  if (details.ok !== true || !object(details.probabilities) || !object(details.usage)) return ['Magic 8-ball: result unavailable.'];
  const result = details as unknown as Extract<DecisionResult, { ok: true }>;
  const total = result.usage.cost?.total;
  const cost = typeof total === 'number' && Number.isFinite(total) ? total.toFixed(6) : 'unknown';
  const distribution = Object.entries(result.probabilities).map(([id, p]) => `${safe(id)} ${typeof p === 'number' ? (p * 100).toFixed(1) : '?'}%`).join(' · ');
  const compact = [
    `Advisory ${result.abstained ? 'abstention' : 'choice'}: ${safe(result.answer)}`,
    distribution,
    `Backend confidence: ${safe(result.confidence)} (concentration, not correctness) · reported cost: $${cost}`,
  ];
  if (!expanded || !object(result.state)) return compact;
  compact.push(`Builder reasoning: ${safe(result.models?.builder.reasoning ?? 'default (legacy provider behavior)')}`);
  compact.push(`Goal: ${safe(result.state.goal)}`);
  for (const key of ['constraints', 'current_state', 'uncertainties'] as const) {
    for (const entry of result.state[key] ?? []) compact.push(`${key}: ${safe(entry)}`);
  }
  for (const entry of result.state.evidence ?? []) compact.push(`[${safe(entry.source)}] ${safe(entry.fact)}`);
  for (const source of result.collection?.evidence ?? []) {
    const range = source.range ? ` bytes [${source.range.start}, ${source.range.end}) / ${source.range.totalBytes}` : '';
    compact.push(`[${safe(source.id)}] ${safe(source.source)}${range}${source.truncated ? ' (truncated)' : ''}${source.code ? ` (${safe(source.code)})` : ''}`);
  }
  return compact;
}

// Theme styling happens on each render, so no stale theme colors are cached.
export function renderDecision(details: unknown, expanded: boolean, partial: boolean, color: (text: string) => string): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      return lines(details, expanded, partial).flatMap(line => wrapTextWithAnsi(color(line), width)).map(line => truncateToWidth(line, width));
    },
  };
}

export function renderQuestion(question: unknown, color: (text: string) => string): Component {
  return { invalidate() {}, render: width => width > 0 ? [truncateToWidth(color(`Magic 8-ball · ${safe(question)}`), width)] : [] };
}
