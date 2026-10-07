import { isAbsolute } from 'node:path';

export function allowedName(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules' && !/^(?:auth|credentials|secrets|tokens)(?:\..*)?$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$|\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

// This is a syntax filter. The evidence helper also checks the live filesystem.
export function permittedFilePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 && !path.includes('\\') && !path.includes('\0') && !isAbsolute(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && allowedName(segment));
}
