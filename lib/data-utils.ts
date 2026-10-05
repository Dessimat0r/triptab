/** Deterministic JSON for equality and review markers, independent of locale. */
export function canonicalJson(value: unknown, undefinedValue = 'null'): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry, undefinedValue)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], undefinedValue)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? undefinedValue;
}
export function encodeBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw Error('Invalid base64url data');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}
export function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
export async function sha256Hex(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeHex(await sha256(value));
}
export async function sha256Base64url(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeBase64url(await sha256(value));
}
