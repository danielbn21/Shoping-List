import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Encrypts stored API keys with a random key kept next to the database (DATA_DIR/secret.key, mode 0600).
// Back up both files together: a database restored without its key cannot decrypt saved API keys.
export function makeSecrets(dataDir) {
  const keyFile = path.join(dataDir, 'secret.key');
  let key;
  if (fs.existsSync(keyFile)) key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
  else { key = crypto.randomBytes(32); fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 }); }
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
    },
    decrypt(stored) {
      try {
        const [iv, tag, enc] = String(stored).split('.').map((x) => Buffer.from(x, 'base64'));
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
      } catch { return null; }
    },
  };
}
