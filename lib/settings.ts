import { constants } from 'node:fs';
import { lstat, open, mkdir, rename, link, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { DecisionError, LIMITS, parseSettings, type DecisionSettings, type ModelSelection } from './decision.ts';

export type Settings = DecisionSettings;
export type Scope = 'global' | 'project';
export type Role = keyof ModelSelection;
export type SettingsPaths = Record<Scope, string>;
export type LoadedSettings = { settings: Settings; sources: Partial<Record<Role | 'timeoutMs', Scope>> };
export function settingsPaths(cwd: string, agentDir: string): SettingsPaths {
  return { global: join(agentDir, 'magic8ball.json'), project: join(cwd, '.pi', 'magic8ball.json') };
}
function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function unavailable(error: unknown): never { throw error instanceof DecisionError ? error : new DecisionError('settings-unavailable'); }
async function checkParent(path: string): Promise<void> {
  try {
    const stat = await lstat(dirname(path));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DecisionError('settings-unavailable');
  } catch (error) { if (!missing(error)) unavailable(error); }
}
async function readLayer(path: string): Promise<{ settings: Settings; raw?: Buffer }> {
  let handle: FileHandle | undefined;
  try {
    await checkParent(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DecisionError('settings-unavailable');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new DecisionError('settings-unavailable');
    if (opened.size > LIMITS.requestBytes) throw new DecisionError('invalid-config');
    const buffer = Buffer.alloc(LIMITS.requestBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LIMITS.requestBytes) throw new DecisionError('invalid-config');
    const raw = buffer.subarray(0, length);
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      return { settings: parseSettings(value), raw };
    } catch { throw new DecisionError('invalid-config'); }
  } catch (error) {
    if (missing(error)) return { settings: {} };
    return unavailable(error);
  } finally {
    try { await handle?.close(); } catch (error) { unavailable(error); }
  }
}

export async function loadSettings(paths: SettingsPaths, trusted: boolean): Promise<LoadedSettings> {
  const global = (await readLayer(paths.global)).settings;
  const project = trusted ? (await readLayer(paths.project)).settings : {};
  const settings: Settings = { ...global, ...project };
  const sources: LoadedSettings['sources'] = {};
  for (const role of ['builder', 'classifier', 'timeoutMs'] as const) {
    if (project[role]) sources[role] = 'project';
    else if (global[role]) sources[role] = 'global';
  }
  return { settings, sources };
}

export async function saveSettingsPatch(paths: SettingsPaths, scope: Scope, patch: Settings, trusted: boolean, resetTimeout = false): Promise<void> {
  if (scope === 'project' && !trusted) throw new DecisionError('settings-unavailable');
  const validated = parseSettings(patch);
  if (!Object.keys(validated).length && !resetTimeout) throw new DecisionError('invalid-config');
  const path = paths[scope];
  try {
    await withFileMutationQueue(path, async () => {
      await checkParent(path);
      await mkdir(dirname(path), { recursive: true });
      await checkParent(path);
      const lockPath = path + '.lock';
      let lock: FileHandle | undefined;
      let ownedTemp = false;
      const temp = path + '.' + randomUUID() + '.tmp';
      try {
        // No stale-lock reclamation: another writer, or uncertain prior completion, must be inspected.
        lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        const before = await readLayer(path);
        const next = { ...before.settings, ...validated };
        if (resetTimeout) delete next.timeoutMs;
        const text = JSON.stringify(next, null, 2) + '\n';
        if (Buffer.byteLength(text) > LIMITS.requestBytes) throw new DecisionError('invalid-config');
        const output = await open(temp, 'wx', 0o600);
        ownedTemp = true;
        try { await output.writeFile(text, 'utf8'); await output.sync(); }
        finally { await output.close(); }
        const current = await readLayer(path);
        if (before.raw ? !current.raw?.equals(before.raw) : current.raw !== undefined) throw new DecisionError('settings-unavailable');
        if (before.raw) await rename(temp, path);
        else await link(temp, path); // Exclusive first creation, never replace a newly appeared file.
      } finally {
        try {
          if (ownedTemp) { try { await unlink(temp); } catch (error) { if (!missing(error)) throw error; } }
        } finally {
          if (lock) {
            try {
              const owned = await lock.stat();
              const current = await lstat(lockPath);
              if (owned.ino !== current.ino || owned.dev !== current.dev || current.isSymbolicLink()) throw new DecisionError('settings-unavailable');
              await unlink(lockPath);
            } finally { await lock.close(); }
          }
        }
      }
    });
  } catch (error) { unavailable(error); }
}
