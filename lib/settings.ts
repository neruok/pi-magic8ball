import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { SettingsError, loadScopedSettings, settingsPaths as commonPaths, updateJsonSettings, type Scope, type SettingsPaths } from '@neruok/pi-common/settings';
import { DecisionError, LIMITS, parseSettings, type DecisionSettings, type ModelSelection } from './decision.ts';

export type Settings = DecisionSettings;
export type { Scope, SettingsPaths };
export type Role = keyof ModelSelection;
export type LoadedSettings = { settings: Settings; sources: Partial<Record<Role | 'timeoutMs', Scope>> };
export const settingsPaths = (cwd: string, agentDir: string): SettingsPaths => commonPaths(cwd, agentDir, 'magic8ball.json');
function unavailable(error: unknown): never {
  throw error instanceof DecisionError ? error
    : new DecisionError(error instanceof SettingsError ? error.code : 'settings-unavailable');
}
export async function loadSettings(paths: SettingsPaths, trusted: boolean): Promise<LoadedSettings> {
  try { return await loadScopedSettings(paths, trusted, LIMITS.requestBytes, parseSettings); }
  catch (error) { return unavailable(error); }
}
export async function saveSettingsPatch(paths: SettingsPaths, scope: Scope, patch: Settings, trusted: boolean, resetTimeout = false): Promise<void> {
  if (scope === 'project' && !trusted) throw new DecisionError('settings-unavailable');
  const validated = parseSettings(patch);
  if (!Object.keys(validated).length && !resetTimeout) throw new DecisionError('invalid-config');
  try {
    await withFileMutationQueue(paths[scope], () => updateJsonSettings(paths[scope], LIMITS.requestBytes, value => {
      let before: Settings;
      try { before = parseSettings(value); } catch { throw new SettingsError('invalid-config'); }
      const next = { ...before, ...validated };
      if (resetTimeout) delete next.timeoutMs;
      return next;
    }));
  } catch (error) { unavailable(error); }
}
