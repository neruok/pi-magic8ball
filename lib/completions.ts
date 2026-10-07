import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fuzzyFilter, type AutocompleteItem } from '@earendil-works/pi-tui';
import { REASONING_LEVELS, parseSettings } from './decision.ts';
import { supportedReasoning } from './reasoning.ts';
import { loadSettings, settingsPaths } from './settings.ts';

export type CompletionContext = Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>;
interface Choice { value: string; description: string }
interface Syntax { base: string; fragment: string; args: string[]; scoped: boolean; project: boolean }
const commands: Choice[] = [
  { value: 'show', description: 'Show effective settings and their sources' },
  { value: 'builder', description: 'Set the context-builder provider and model' },
  { value: 'classifier', description: 'Set the decision-classifier provider and model' },
  { value: 'reasoning', description: 'Inspect or set builder reasoning' },
  { value: 'transcripts', description: 'Toggle or view session-only transcript capture' },
];
const scopes: Choice[] = [
  { value: '--global', description: 'Use global user settings (default save scope)' },
  { value: '--project', description: 'Use project settings (writes require trust)' },
];
const actions: Choice[] = [
  { value: 'on', description: 'Enable capture for subsequent calls' },
  { value: 'off', description: 'Disable capture and clear retained text' },
  { value: 'show', description: 'View the last captured invocation' },
];

function syntax(prefix: string): Syntax | undefined {
  const fragment = prefix.match(/\S*$/)![0];
  const base = prefix.slice(0, prefix.length - fragment.length);
  const tokens = base.trim() ? base.trim().split(/\s+/) : [];
  const flags = tokens.filter(token => token.startsWith('--'));
  if (flags.length > 1 || flags.some(flag => !scopes.some(choice => choice.value === flag))) return undefined;
  const args = tokens.filter(token => !token.startsWith('--'));
  const [command, argument] = args;
  if (command === 'transcripts') {
    if (flags.length || args.length > 2 || (argument && !actions.some(choice => choice.value === argument))) return undefined;
  } else if (command === 'show') {
    if (args.length > 1) return undefined;
  } else if (command === 'reasoning') {
    if (args.length > 2 || (argument && !REASONING_LEVELS.some(level => level === argument))) return undefined;
  } else if (command === 'builder' || command === 'classifier') {
    if (args.length > 3) return undefined;
  } else if (command) return undefined;
  return { base, fragment, args, scoped: flags.length > 0, project: flags[0] === '--project' };
}

async function choices(input: Syntax, ctx?: CompletionContext): Promise<Choice[]> {
  const { args, fragment, scoped, project } = input;
  const [command, provider] = args;
  const availableScopes = scoped || command === 'transcripts' ? [] : scopes;
  if (fragment.startsWith('--')) return availableScopes;
  if (!command) return [...commands.filter(choice => !scoped || choice.value !== 'transcripts'), ...availableScopes];
  if (command === 'transcripts') return args.length === 1 ? actions : [];
  if (command === 'show' || (command === 'reasoning' && args.length === 2) || args.length === 3) return availableScopes;
  if (!ctx) return [];
  if (command === 'reasoning') {
    if (project && !ctx.isProjectTrusted()) return [];
    const loaded = await loadSettings(settingsPaths(ctx.cwd, getAgentDir()), project);
    const pair = loaded.settings.builder;
    if (!pair) return [];
    const model = ctx.modelRegistry.find(pair.provider, pair.model);
    if (!model || model.api === 'pi-virtual') return [];
    return supportedReasoning(model).map(value => ({ value, description: value === 'default' ? 'Keep legacy provider behavior' : `Set builder reasoning to ${value}` }));
  }
  const models = command === 'builder'
    ? ctx.modelRegistry.getAvailable().filter(model => model.api !== 'pi-virtual')
    : await ctx.modelRegistry.getAvailableOfType('classifier');
  if (!provider) {
    return [...new Set(models.map(model => model.provider))].sort((a, b) => a.localeCompare(b))
      .filter(value => value.toLowerCase().startsWith(fragment.toLowerCase()))
      .map(value => ({ value, description: `Available ${command} provider` }));
  }
  const candidates = models.filter(model => model.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
  return fuzzyFilter(candidates, fragment, model => `${model.id} ${model.name ?? ''}`)
    .map(model => ({ value: model.id, description: model.name || `Available ${command} model` }));
}

export async function argumentCompletions(prefix: string, ctx?: CompletionContext): Promise<AutocompleteItem[] | null> {
  const input = syntax(prefix);
  if (!input) return null;
  try {
    const catalogArgument = (input.args[0] === 'builder' || input.args[0] === 'classifier') && input.args.length < 3 && !input.fragment.startsWith('--');
    const candidates = await choices(input, ctx);
    const matched = catalogArgument ? candidates : candidates.filter(choice => choice.value.startsWith(input.fragment));
    const items = matched.filter(choice => {
      if (!catalogArgument) return true;
      if (choice.value.startsWith('--')) return false;
      // Catalog identifiers must also fit the explicit command's settings grammar.
      try { parseSettings({ [input.args[0]]: { provider: input.args[1] ?? choice.value, model: input.args[1] ? choice.value : 'placeholder' } }); return true; }
      catch { return false; }
    }).map(choice => ({ value: `${input.base}${choice.value} `, label: choice.value, description: choice.description }));
    return items.length ? items : null;
  } catch {
    // Completion is advisory UI: keep lookup failures silent and never retry.
    return null;
  }
}
