import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { DecisionError, parseSettings, type ModelSelection } from './decision.ts';
import { selectModel } from './model-picker.ts';
import { loadSettings, saveSettingsPatch, settingsPaths, type LoadedSettings, type Role, type Scope, type SettingsPaths } from './settings.ts';

const USAGE = 'Usage: /magic8ball [--global|--project] [show | builder <provider> <model> | classifier <provider> <model>]. No subcommand opens the two-model picker. Saves default to global (user) settings.';
function parseCommand(args: string): { scope: Scope; role?: Role; pair?: ModelSelection[Role]; show: boolean } {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const flags = tokens.filter(t => t.startsWith('--'));
  if (flags.length > 1 || flags.some(f => f !== '--global' && f !== '--project')) throw new Error(USAGE);
  const scope: Scope = flags[0] === '--project' ? 'project' : 'global';
  const rest = tokens.filter(t => !t.startsWith('--'));
  if (!rest.length) return { scope, show: false };
  if (rest[0] === 'show' && rest.length === 1) return { scope, show: true };
  if ((rest[0] === 'builder' || rest[0] === 'classifier') && rest.length === 3) {
    const role = rest[0];
    const pair = { provider: rest[1], model: rest[2] };
    parseSettings({ [role]: pair });
    return { scope, role, pair, show: false };
  }
  throw new Error(USAGE);
}
function describe(loaded: LoadedSettings, paths: SettingsPaths, trusted: boolean): string {
  const selections = (['builder', 'classifier'] as const).map(role => {
    const pair = loaded.settings[role];
    return `${role}: ${pair ? `${pair.provider} / ${pair.model} (${loaded.sources[role]})` : 'not configured'}`;
  });
  return ['Effective magic8ball settings:', ...selections, `global (user): ${paths.global}`, `project: ${paths.project}${trusted ? '' : ' (ignored: project not trusted)'}`].join('\n');
}
function resolve(ctx: ExtensionCommandContext, role: Role, pair: ModelSelection[Role]): void {
  const model = role === 'builder' ? ctx.modelRegistry.find(pair.provider, pair.model) : ctx.modelRegistry.findOfType('classifier', pair.provider, pair.model);
  if (!model || (role === 'builder' && model.api === 'pi-virtual')) throw new DecisionError('model-unavailable');
}
async function pick(ctx: ExtensionCommandContext, role: Role, scope: Scope, current?: ModelSelection[Role]): Promise<ModelSelection[Role] | undefined> {
  const models = role === 'builder'
    ? ctx.modelRegistry.getAvailable().filter(model => model.api !== 'pi-virtual')
    : await ctx.modelRegistry.getAvailableOfType('classifier');
  if (!models.length) throw new DecisionError('model-unavailable');
  const pair = await selectModel(ctx, `magic8ball ${role} (${scope} settings)`, models, current);
  if (!pair) return undefined;
  resolve(ctx, role, pair);
  return pair;
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand('magic8ball', {
    description: 'Configure advisory decision models; picker, show, builder/classifier, --global/--project',
    async handler(args, ctx) {
      const paths = settingsPaths(ctx.cwd, getAgentDir());
      let saveStarted = false;
      try {
        let command: ReturnType<typeof parseCommand>;
        try { command = parseCommand(args); }
        catch (error) { ctx.ui.notify(error instanceof DecisionError ? error.message : USAGE, 'error'); return; }
        const loaded = await loadSettings(paths, ctx.isProjectTrusted());
        if (command.show || (!command.role && !ctx.hasUI)) {
          ctx.ui.notify(describe(loaded, paths, ctx.isProjectTrusted()) + '\n' + USAGE, 'info');
          return;
        }
        if (command.scope === 'project' && !ctx.isProjectTrusted()) {
          ctx.ui.notify('Project settings require Pi project trust. Use --global or trust this project through Pi.', 'error');
          return;
        }
        await ctx.waitForIdle();
        const patch: Partial<ModelSelection> = {};
        if (command.role && command.pair) {
          resolve(ctx, command.role, command.pair);
          patch[command.role] = command.pair;
        } else {
          ctx.ui.notify(describe(loaded, paths, ctx.isProjectTrusted()), 'info');
          for (const role of ['builder', 'classifier'] as const) {
            const pair = await pick(ctx, role, command.scope, loaded.settings[role]);
            if (!pair) { ctx.ui.notify('Configuration cancelled; settings unchanged.', 'info'); return; }
            patch[role] = pair;
          }
        }
        saveStarted = true;
        await saveSettingsPatch(paths, command.scope, patch, ctx.isProjectTrusted());
        const effective = await loadSettings(paths, ctx.isProjectTrusted());
        ctx.ui.notify(`Saved ${command.scope} settings at ${paths[command.scope]}.\n${describe(effective, paths, ctx.isProjectTrusted())}`, 'info');
      } catch (error) {
        const message = error instanceof DecisionError ? error.message : 'Cannot update magic8ball settings.';
        const outcome = saveStarted ? 'A save may have completed; inspect before retrying.' : 'This command did not save settings.';
        ctx.ui.notify(`${message}\nglobal: ${paths.global}\nproject: ${paths.project}\n${outcome} Use /magic8ball show to inspect effective settings.`, 'error');
      }
    }
  });
}
