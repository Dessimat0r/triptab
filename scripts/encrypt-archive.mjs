import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

// Private operator utility. Neither keys nor backup plaintext are ever logged.
const magic = Buffer.from('TRIPBK01');
const [mode, input, output, keyFile] = process.argv.slice(2);
let createdOutput = false;
let createdKey = false;
if (!['encrypt', 'decrypt'].includes(mode) || !input || !output || !keyFile) {
  process.stderr.write('Usage: encrypt-archive.mjs encrypt|decrypt INPUT OUTPUT KEY_FILE\n');
  process.exit(2);
}

try {
  if (mode === 'encrypt') {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const handle = await open(keyFile, 'wx', 0o600);
    createdKey = true;
    try {
      await handle.writeFile(JSON.stringify({
        format: 'TRIPBK01', algorithm: 'AES-256-GCM',
        key_base64: key.toString('base64'), created_at: new Date().toISOString(),
      }) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(magic);
    const out = createWriteStream(output, { flags: 'wx', mode: 0o600 });
    out.once('open', () => { createdOutput = true; });
    out.write(Buffer.concat([magic, nonce]));
    await pipeline(createReadStream(input), cipher, out);
    const encrypted = await open(output, 'a');
    try { await encrypted.write(cipher.getAuthTag()); await encrypted.sync(); }
    finally { await encrypted.close(); }
    key.fill(0);
  } else {
    const record = JSON.parse(await readFile(keyFile, 'utf8'));
    if (record.format !== 'TRIPBK01' || record.algorithm !== 'AES-256-GCM') throw new Error('format');
    const key = Buffer.from(record.key_base64, 'base64');
    if (key.length !== 32) throw new Error('key');
    const handle = await open(input, 'r');
    let size, header, tag;
    try {
      size = (await handle.stat()).size;
      if (size < 36) throw new Error('size');
      header = Buffer.alloc(20); tag = Buffer.alloc(16);
      await handle.read(header, 0, 20, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally { await handle.close(); }
    if (!header.subarray(0, 8).equals(magic)) throw new Error('format');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
    decipher.setAAD(magic); decipher.setAuthTag(tag);
    const out = createWriteStream(output, { flags: 'wx', mode: 0o600 });
    out.once('open', () => { createdOutput = true; });
    await pipeline(createReadStream(input, { start: 20, end: size - 17 }), decipher, out);
    key.fill(0);
  }
} catch {
  // Authentication failures can leave unauthenticated output: remove it.
  if (createdOutput) await unlink(output).catch(() => {});
  if (createdKey) await unlink(keyFile).catch(() => {});
  process.stderr.write('Encrypted archive operation failed.\n');
  process.exitCode = 1;
}
