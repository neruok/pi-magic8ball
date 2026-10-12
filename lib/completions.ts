import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { argumentCompletions as complete, type Choice } from '@neruok/pi-common/commands';
import { parseSettings } from './decision.ts';
import { supportedReasoning } from './reasoning.ts';
import { loadSettings, settingsPaths } from './settings.ts';

export type CompletionContext = Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>;
const commands: Choice[] = [
  { value: 'show', description: 'Show effective settings and their sources' },
  { value: 'builder', description: 'Set the context-builder provider and model' },
  { value: 'classifier', description: 'Set the decision-classifier provider and model' },
  { value: 'reasoning', description: 'Inspect or set reasoning effort' },
  { value: 'timeout', description: 'Inspect or set the deadline in milliseconds' },
  { value: 'transcripts', description: 'Toggle or view session-only transcript capture' },
];
const actions: Choice[] = [
  { value: 'on', description: 'Enable capture for subsequent calls' },
  { value: 'off', description: 'Disable capture and clear retained text' },
  { value: 'show', description: 'View the last captured invocation' },
];

export function argumentCompletions(prefix: string, ctx?: CompletionContext) {
  return complete(prefix, {
    commands, modelCommands: ['builder', 'classifier'], isolatedCommands: { transcripts: actions },
    validateModel: (command, pair) => { parseSettings({ [command]: pair }); },
    models: command => {
      if (!ctx) return [];
      return command === 'builder' ? ctx.modelRegistry.getAvailable().filter(model => model.api !== 'pi-virtual') : ctx.modelRegistry.getAvailableOfType('classifier');
    },
    reasoning: async project => {
      if (!ctx || (project && !ctx.isProjectTrusted())) return [];
      const pair = (await loadSettings(settingsPaths(ctx.cwd, getAgentDir()), project)).settings.builder;
      if (!pair) return [];
      const model = ctx.modelRegistry.find(pair.provider, pair.model);
      if (!model || model.api === 'pi-virtual') return [];
      return supportedReasoning(model).map(value => ({ value, description: value === 'default' ? 'Keep legacy provider behavior' : `Set reasoning to ${value}` }));
    },
  });
}
