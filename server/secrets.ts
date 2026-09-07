import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function secretStore(dataDir: string) {
  const configured = process.env.INNOVISTA_ENCRYPTION_KEY || process.env.SINTERIQ_ENCRYPTION_KEY;
  const file = path.join(dataDir, '.innovista-encryption-key');
  let key: Buffer;
  if (configured) {
    key = Buffer.from(configured, /^[a-f0-9]{64}$/i.test(configured) ? 'hex' : 'base64');
    if (key.length !== 32)
      throw new Error('Encryption key must contain exactly 32 bytes in hex or base64.');
  } else if (fs.existsSync(file)) {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32)
      throw new Error('Invalid encryption key file. Restore the original key from backup.');
  } else {
    // Refuse to replace a lost master key when an existing database may contain ciphertext.
    if (fs.existsSync(path.join(dataDir, 'innovista.db')))
      throw new Error(
        'Encryption key missing. Restore .innovista-encryption-key or set INNOVISTA_ENCRYPTION_KEY.',
      );
    key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('hex'), { flag: 'wx', mode: 0o600 });
  }
  return {
    encrypt(value: string) {
      if (!value) return '';
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decrypt(value: string) {
      return decryptWithKey(value, key);
    },
  };
}
export function decryptWithKey(value: string, key: Buffer): string {
  if (!value) return '';
  if (!value.startsWith('enc:v1:')) return value;
  const body = Buffer.from(value.slice(7), 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, 12));
  cipher.setAuthTag(body.subarray(12, 28));
  return Buffer.concat([cipher.update(body.subarray(28)), cipher.final()]).toString('utf8');
}
