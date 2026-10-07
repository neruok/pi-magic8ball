import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DecisionError, LIMITS, object, truncateUtf8 } from './decision.ts';

export type EvidenceResult = { text: string; truncated: boolean };
function allowedName(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules' && !/^(?:auth|credentials|secrets|tokens)(?:\..*)?$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$|\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}
async function contained(cwd: string, path: unknown, directory: boolean): Promise<string> {
  if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\\') || path.includes('\0') || isAbsolute(path)) throw new DecisionError('evidence-failed');
  const root = await realpath(cwd);
  if (path === '.' && directory) return root;
  const segments = path.split('/');
  if (segments.some(s => !s || s === '..' || s === '.' || !allowedName(s))) throw new DecisionError('evidence-failed');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new DecisionError('evidence-failed');
  }
  const resolved = await realpath(current);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(current) !== resolved) throw new DecisionError('evidence-failed');
  const stat = await lstat(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new DecisionError('evidence-failed');
  return resolved;
}

async function filePrefix(path: string, signal?: AbortSignal): Promise<EvidenceResult> {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new DecisionError('evidence-failed');
    const buffer = Buffer.alloc(LIMITS.evidenceBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    const truncated = stat.size > bytesRead;
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new DecisionError('evidence-failed');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
    return { text, truncated };
  } finally { await handle.close(); }
}

async function list(path: string, signal?: AbortSignal): Promise<EvidenceResult> {
  const names: string[] = [];
  let scanned = 0, truncated = false;
  const directory = await opendir(path);
  // Inspect no more than 200 entries, including omitted names.
  for await (const entry of directory) {
    signal?.throwIfAborted();
    if (scanned++ >= 200) { truncated = true; break; }
    if (allowedName(entry.name) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory())) names.push(`${entry.name}${entry.isDirectory() ? '/' : ''}`);
  }
  const bounded = truncateUtf8(names.sort().join('\n'), LIMITS.evidenceBytes);
  return { text: bounded.text, truncated: truncated || bounded.truncated };
}

export async function evidence(cwd: string, operation: string, args: unknown, signal?: AbortSignal): Promise<EvidenceResult> {
  signal?.throwIfAborted();
  if (!object(args) || !['read', 'list', 'search'].includes(operation)) throw new DecisionError('evidence-failed');
  const keys = operation === 'read' ? ['path', 'offset', 'limit'] : operation === 'search' ? ['path', 'text'] : ['path'];
  if (Object.keys(args).some(k => !keys.includes(k))) throw new DecisionError('evidence-failed');
  const path = await contained(cwd, args.path === undefined && operation === 'list' ? '.' : args.path, operation === 'list');
  if (operation === 'list') return list(path, signal);
  const offset = args.offset === undefined ? 1 : args.offset;
  const limit = args.limit === undefined ? 200 : args.limit;
  if (operation === 'read' && (!Number.isSafeInteger(offset) || (offset as number) < 1 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200)) throw new DecisionError('evidence-failed');
  if (operation === 'search' && (typeof args.text !== 'string' || !args.text || Buffer.byteLength(args.text) > 1000)) throw new DecisionError('evidence-failed');
  const prefix = await filePrefix(path, signal);
  const lines = prefix.text.split('\n');
  const selected: string[] = [];
  let truncated = prefix.truncated;
  for (let i = 0; i < lines.length; i++) {
    if (operation === 'read') {
      if (i < (offset as number) - 1) continue;
      if (selected.length === limit) { truncated = true; break; }
    } else if (!lines[i].includes(args.text as string)) continue;
    if (selected.length >= 200) { truncated = true; break; }
    selected.push(`${i + 1}: ${lines[i]}`);
  }
  const bounded = truncateUtf8(selected.join('\n'), LIMITS.evidenceBytes);
  return { text: bounded.text, truncated: truncated || bounded.truncated };
}
