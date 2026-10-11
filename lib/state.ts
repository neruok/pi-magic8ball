import type { Tool } from '@earendil-works/pi-ai';
import { DecisionError, LIMITS, object, type DecisionState } from './decision.ts';

const text = { type: 'string', minLength: 1, pattern: '\\S' };
const strings = { type: 'array', items: text };
const evidence = { type: 'array', items: { type: 'object', properties: { fact: text, source: text }, required: ['fact', 'source'], additionalProperties: false } };
const sections = [
  { name: 'magic8ball_set_goal', field: 'goal', value: text },
  { name: 'magic8ball_set_constraints', field: 'constraints', value: strings },
  { name: 'magic8ball_set_observations', field: 'current_state', value: strings },
  { name: 'magic8ball_set_evidence', field: 'evidence', value: evidence },
  { name: 'magic8ball_set_uncertainties', field: 'uncertainties', value: strings },
] as const;

// Plain JSON schemas keep the pure builder and offline benchmark independent of host runtime imports.
// These declarations belong only to the nested builder. Never register them on Pi.
export const STATE_TOOLS: Tool[] = sections.map(section => ({
  name: section.name,
  description: `Replace the complete ${section.field} section of this invocation's owned state. ${section.field === 'goal' ? 'Supply a nonblank string.' : 'Use an empty array when no entries are known.'}${section.field === 'evidence' ? ' Evidence sources must already be collected IDs.' : ''} Changes affect memory only.`,
  parameters: { type: 'object', properties: { value: section.value }, required: ['value'], additionalProperties: false },
}));
export function isStateTool(name: string): boolean { return sections.some(section => section.name === name); }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function validValue(field: keyof DecisionState, value: unknown, sourceIds: readonly string[]): boolean {
  if (field === 'goal') return nonempty(value);
  if (!Array.isArray(value)) return false;
  // Inspect every index: Array.every skips holes, which serialize to invalid null entries.
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
    const entry = value[index];
    if (field !== 'evidence') { if (!nonempty(entry)) return false; }
    else if (!object(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'fact') || !Object.hasOwn(entry, 'source')
      || !nonempty(entry.fact) || !nonempty(entry.source) || !sourceIds.includes(entry.source)) return false;
  }
  return true;
}

export class BuilderState {
  private draft: Partial<DecisionState> = {};
  snapshot(): Partial<DecisionState> { return structuredClone(this.draft); }
  serialize(): string { return JSON.stringify(this.draft); }
  apply(name: string, args: unknown, sourceIds: readonly string[]): { updated: string } {
    const section = sections.find(section => section.name === name);
    if (!section || !object(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'value') || !validValue(section.field, args.value, sourceIds)) throw new DecisionError('invalid-state');
    const candidate = { ...this.draft, [section.field]: structuredClone(args.value) };
    if (Buffer.byteLength(JSON.stringify(candidate)) > LIMITS.stateBytes) throw new DecisionError('invalid-state');
    this.draft = candidate;
    return { updated: section.field };
  }
}

/** Keep only the declared state argument shape in user-enabled transcript capture. */
export function stateArguments(name: string, args: unknown): Record<string, unknown> {
  if (!isStateTool(name) || !object(args)) return {};
  const value = args.value;
  if (name === 'magic8ball_set_goal') return typeof value === 'string' ? { value } : {};
  if (!Array.isArray(value)) return {};
  if (name === 'magic8ball_set_evidence') {
    return { value: value.filter(object).map(entry => Object.fromEntries(['fact', 'source'].filter(key => typeof entry[key] === 'string').map(key => [key, entry[key]]))) };
  }
  return { value: value.filter(entry => typeof entry === 'string') };
}
