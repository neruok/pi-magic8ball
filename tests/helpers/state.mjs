import { emptyUsage } from '../../lib/decision.ts';
import { buildState } from '../../lib/builder.ts';

// Migrate old synthetic JSON fixtures to the new builder protocol. Never used by production.
// Existing assertions still inspect the original fixture turn. An extra acknowledged stop
// has known zero mock usage; incremental-state.test.mjs tests real per-turn accounting.
const sections = { goal: 'goal', constraints: 'constraints', current_state: 'observations', evidence: 'evidence', uncertainties: 'uncertainties' };
export function stateCalls(state) {
  return Object.entries(state).map(([field, value]) => ({ type: 'toolCall', name: `magic8ball_set_${sections[field]}`, id: `state-${field}`, arguments: { value } }));
}
function isReady(context) {
  return context.messages.at(-1)?.role === 'toolResult' && context.messages.at(-1)?.toolName === 'magic8ball_set_uncertainties';
}
function stop() { return { role: 'assistant', content: [], stopReason: 'stop', usage: emptyUsage(), timestamp: 1 }; }
function adapt(message) {
  if (message.stopReason !== 'stop' || !Array.isArray(message.content)) return message;
  const text = message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
  let state;
  try { state = JSON.parse(text); } catch { return message; }
  if (!state || !Object.keys(sections).every(field => Object.hasOwn(state, field)) || Object.keys(state).length !== 5) return message;
  return { ...message, content: stateCalls(state), stopReason: 'toolUse' };
}
export function stateCompletion(complete) {
  return async (context, ...rest) => isReady(context) ? stop() : adapt(await complete(context, ...rest));
}
export function buildFixtureState(request, dependencies, ...rest) {
  return buildState(request, { ...dependencies, complete: stateCompletion(dependencies.complete) }, ...rest);
}
export function stateStream(stream) {
  return (model, context, options) => {
    if (isReady(context)) return { result: async () => stop() };
    const result = stream(model, context, options);
    return { ...result, result: async () => adapt(await result.result()) };
  };
}
