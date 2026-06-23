/**
 * HALEEM Activation Service — Crypto Utilities
 * Key generation, Admin Token, HMAC signing, AES encryption.
 * Standalone version — no CEP dependencies.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── File Paths ─────────────────────────────────────────
const DATA_DIR = path.join(os.homedir(), '.haleem-service');
const SECRET_KEY_FILE = path.join(DATA_DIR, 'master.key');
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin.token');
const PAIRED_DEVICE_FILE = path.join(DATA_DIR, 'paired_device.enc');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// App token shared with client plugin (for client HMAC auth)
const APP_TOKEN = 'HU_APP_2026_' + crypto.createHash('md5').update('HALEEM-ULTRA-CLIENT').digest('hex').substring(0, 16);

// ─── Master Secret ──────────────────────────────────────
var _cachedSecret = null;
function secret() {
  if (_cachedSecret) return _cachedSecret;
  try {
    if (fs.existsSync(SECRET_KEY_FILE)) {
      _cachedSecret = fs.readFileSync(SECRET_KEY_FILE, 'utf8').trim();
      return _cachedSecret;
    }
  } catch (e) {}
  _cachedSecret = crypto.randomBytes(48).toString('base64');
  try { fs.writeFileSync(SECRET_KEY_FILE, _cachedSecret, { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
  return _cachedSecret;
}

// ─── Admin Token (256-bit) ──────────────────────────────
var _adminToken = null;
function getAdminToken() {
  if (_adminToken) return _adminToken;
  try {
    if (fs.existsSync(ADMIN_TOKEN_FILE)) {
      _adminToken = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
      return _adminToken;
    }
  } catch (e) {}
  // Generate new 256-bit token
  _adminToken = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(ADMIN_TOKEN_FILE, _adminToken, { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
  return _adminToken;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  var expected = getAdminToken();
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch (e) { return false; }
}

// ─── Key Generation ─────────────────────────────────────
function generateKey() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var segments = [];
  for (var s = 0; s < 4; s++) {
    var bytes = crypto.randomBytes(4);
    var seg = '';
    for (var i = 0; i < 4; i++) seg += chars[bytes[i] % chars.length];
    segments.push(seg);
  }
  return segments.join('-');
}

// ─── HMAC Signing ───────────────────────────────────────
function signPayload(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function verifySignature(payload, signature) {
  if (!payload || !signature) return false;
  try {
    var expected = signPayload(payload);
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch (e) { return false; }
}

// ─── Client Request Verification ────────────────────────
function createClientSignature(body, timestamp, nonce) {
  var payload = body + '|' + timestamp + '|' + nonce;
  return crypto.createHmac('sha256', APP_TOKEN).update(payload).digest('hex');
}

function verifyClientRequest(body, timestamp, nonce, signature) {
  if (!body || !timestamp || !nonce || !signature) return false;
  try {
    var expected = createClientSignature(body, timestamp, nonce);
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch (e) { return false; }
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── AES-256-CBC Encryption ─────────────────────────────
function encrypt(text, key) {
  var k = crypto.createHash('sha256').update(key || secret()).digest();
  var iv = crypto.randomBytes(16);
  var cipher = crypto.createCipheriv('aes-256-cbc', k, iv);
  var enc = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

function decrypt(data, key) {
  var k = crypto.createHash('sha256').update(key || secret()).digest();
  var parts = data.split(':');
  if (parts.length < 2) throw new Error('Invalid encrypted data');
  var iv = Buffer.from(parts[0], 'hex');
  var decipher = crypto.createDecipheriv('aes-256-cbc', k, iv);
  return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
}

// ─── Device Pairing ─────────────────────────────────────
function getPairedDevice() {
  try {
    if (!fs.existsSync(PAIRED_DEVICE_FILE)) return null;
    var raw = fs.readFileSync(PAIRED_DEVICE_FILE, 'utf8');
    return JSON.parse(decrypt(raw));
  } catch (e) { return null; }
}

function pairDevice(deviceFingerprint, deviceName) {
  var data = { fingerprint: deviceFingerprint, name: deviceName || 'Android', pairedAt: new Date().toISOString() };
  var enc = encrypt(JSON.stringify(data));
  fs.writeFileSync(PAIRED_DEVICE_FILE, enc, 'utf8');
  return data;
}

function unpairDevice() {
  try { if (fs.existsSync(PAIRED_DEVICE_FILE)) fs.unlinkSync(PAIRED_DEVICE_FILE); } catch (e) {}
}

function verifyDevice(fingerprint) {
  var paired = getPairedDevice();
  if (!paired) return false;
  return paired.fingerprint === fingerprint;
}

module.exports = {
  generateKey, signPayload, verifySignature, encrypt, decrypt,
  verifyClientRequest, createClientSignature, generateNonce,
  getAdminToken, verifyAdminToken,
  getPairedDevice, pairDevice, unpairDevice, verifyDevice,
  APP_TOKEN, DATA_DIR
};
