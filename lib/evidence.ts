import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DecisionError, LIMITS, object, truncateUtf8, type ByteRange } from './decision.ts';
import { allowedName, permittedFilePath } from './paths.ts';

export type EvidenceResult = { text: string; truncated: boolean; range?: ByteRange; code?: 'path-not-found' };
async function contained(cwd: string, path: unknown, directory: boolean): Promise<string | undefined> {
  if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\\') || path.includes('\0') || isAbsolute(path)) throw new DecisionError('evidence-failed', 'path-denied');
  const root = await realpath(cwd);
  if (path === '.' && directory) return root;
  if (!permittedFilePath(path)) throw new DecisionError('evidence-failed', 'path-denied');
  const segments = path.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = await lstat(current).catch(error => {
      // Absence is recoverable only during this guarded walk, never from root or hook errors.
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new DecisionError('evidence-failed', 'path-denied');
    if (index < segments.length - 1 && !stat.isDirectory()) throw new DecisionError('evidence-failed', 'wrong-type');
  }
  const resolved = await realpath(current);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(current) !== resolved) throw new DecisionError('evidence-failed', 'path-denied');
  const stat = await lstat(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new DecisionError('evidence-failed', 'wrong-type');
  return resolved;
}

async function fileWindow(path: string, byteOffset: number, byteLength: number, signal?: AbortSignal): Promise<EvidenceResult> {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new DecisionError('evidence-failed', 'wrong-type');
    const start = Math.min(byteOffset, stat.size);
    const buffer = Buffer.alloc(Math.min(byteLength, stat.size - start));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    signal?.throwIfAborted();
    const continues = start + bytesRead < stat.size;
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new DecisionError('evidence-failed', 'invalid-text');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: continues }); }
    catch { throw new DecisionError('evidence-failed', 'invalid-text'); }
    let completeBytes = bytesRead;
    if (continues && bytesRead) {
      // Fatal decoding validated the window. Its only possible pending data is one incomplete UTF-8 suffix.
      let last = bytesRead - 1;
      while (last > 0 && (bytes[last] & 0xc0) === 0x80) last--;
      const lead = bytes[last];
      const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      if (bytesRead - last < width) completeBytes = last;
    }
    // Count raw bytes, not re-encoded text: TextDecoder can omit a leading BOM.
    const end = start + completeBytes;
    return { text, truncated: start > 0 || end < stat.size, range: { start, end, totalBytes: stat.size } };
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

async function collectEvidence(cwd: string, operation: string, args: unknown, signal?: AbortSignal): Promise<EvidenceResult> {
  signal?.throwIfAborted();
  if (!object(args) || !['read', 'list', 'search'].includes(operation)) throw new DecisionError('evidence-failed', 'invalid-arguments');
  const keys = operation === 'read' ? ['path', 'offset', 'limit', 'byteOffset', 'byteLength'] : operation === 'search' ? ['path', 'text', 'byteOffset', 'byteLength'] : ['path'];
  if (Object.keys(args).some(k => !keys.includes(k))) throw new DecisionError('evidence-failed', 'invalid-arguments');
  const requestedPath = args.path === undefined && operation === 'list' ? '.' : args.path;
  if (typeof requestedPath !== 'string' || !requestedPath) throw new DecisionError('evidence-failed', 'invalid-arguments');
  const offset = args.offset === undefined ? 1 : args.offset;
  const limit = args.limit === undefined ? 200 : args.limit;
  if (operation === 'read' && (!Number.isSafeInteger(offset) || (offset as number) < 1 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200)) throw new DecisionError('evidence-failed', 'invalid-arguments');
  if (operation === 'search' && (typeof args.text !== 'string' || !args.text || Buffer.byteLength(args.text) > 1000)) throw new DecisionError('evidence-failed', 'invalid-arguments');
  const byteOffset = args.byteOffset === undefined ? 0 : args.byteOffset;
  const byteLength = args.byteLength === undefined ? LIMITS.evidenceBytes : args.byteLength;
  if (!Number.isSafeInteger(byteOffset) || (byteOffset as number) < 0 || !Number.isSafeInteger(byteLength) || (byteLength as number) < 1 || (byteLength as number) > LIMITS.evidenceBytes) throw new DecisionError('evidence-failed', 'invalid-arguments');
  const path = await contained(cwd, requestedPath, operation === 'list');
  signal?.throwIfAborted();
  if (path === undefined) return { code: 'path-not-found', text: 'The permitted workspace path was not found when checked. This is absence, not file content. Use observed directory names for further calls.', truncated: false };
  if (operation === 'list') return list(path, signal);
  const prefix = await fileWindow(path, byteOffset as number, byteLength as number, signal);
  const lines = prefix.text ? prefix.text.split('\n') : [];
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
  return { text: bounded.text, truncated: truncated || bounded.truncated, range: prefix.range };
}

export async function evidence(cwd: string, operation: string, args: unknown, signal?: AbortSignal): Promise<EvidenceResult> {
  try { return await collectEvidence(cwd, operation, args, signal); }
  catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DecisionError) throw error;
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new DecisionError('evidence-failed', code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'io-failed');
  }
}
