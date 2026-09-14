const crypto = require('crypto');

function getMasterKey() {
  const raw = String(process.env.RED_DAWN_MASTER_KEY || '').trim();
  if (!raw) throw new Error('RED_DAWN_MASTER_KEY is missing. Generate one with: node scripts/generate-master-key.js');

  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) return key;
  } catch {}
  throw new Error('RED_DAWN_MASTER_KEY must be exactly 32 bytes as 64 hex characters or base64.');
}

function encryptText(plaintext) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(b => b.toString('base64')).join(':');
}

function decryptText(payload) {
  const [ivB64, tagB64, cipherB64] = String(payload || '').split(':');
  if (!ivB64 || !tagB64 || !cipherB64) throw new Error('Invalid encrypted value.');
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]).toString('utf8');
}

function encryptJson(value) {
  return encryptText(JSON.stringify(value));
}

function decryptJson(payload, fallback = null) {
  try {
    return JSON.parse(decryptText(payload));
  } catch (err) {
    if (fallback !== null) return fallback;
    throw err;
  }
}

module.exports = { encryptText, decryptText, encryptJson, decryptJson };
