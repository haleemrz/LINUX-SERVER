/**
 * HALEEM Activation Service — Security Module
 * Rate limiting, nonce tracking, input validation, logging.
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'security.log');
const MAX_LOG_SIZE = 1024 * 1024; // 1MB rotate

// ─── Rate Limiter ───────────────────────────────────────
var rateBuckets = {};
var RATE_WINDOW = 60000;
var RATE_LIMIT = 15;
var BLOCK_THRESHOLD = 25;
var BLOCK_DURATION = 300000;

function checkRateLimit(ip) {
  var now = Date.now();
  var bucket = rateBuckets[ip];
  if (!bucket) {
    rateBuckets[ip] = { count: 1, firstReq: now, blocked: false, blockedAt: 0, fails: 0 };
    return { allowed: true };
  }
  if (bucket.blocked) {
    if (now - bucket.blockedAt > BLOCK_DURATION) {
      bucket.blocked = false; bucket.fails = 0; bucket.count = 1; bucket.firstReq = now;
      return { allowed: true };
    }
    var remaining = Math.ceil((BLOCK_DURATION - (now - bucket.blockedAt)) / 1000);
    return { allowed: false, reason: 'Blocked for ' + remaining + 's' };
  }
  if (now - bucket.firstReq > RATE_WINDOW) {
    bucket.count = 1; bucket.firstReq = now;
    return { allowed: true };
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT) return { allowed: false, reason: 'Rate limit exceeded' };
  return { allowed: true };
}

function recordFail(ip) {
  var bucket = rateBuckets[ip];
  if (!bucket) {
    rateBuckets[ip] = { count: 1, firstReq: Date.now(), blocked: false, blockedAt: 0, fails: 1 };
    return;
  }
  bucket.fails++;
  if (bucket.fails >= BLOCK_THRESHOLD) {
    bucket.blocked = true;
    bucket.blockedAt = Date.now();
  }
}

// Clean stale entries every 10 minutes
setInterval(function () {
  var now = Date.now();
  Object.keys(rateBuckets).forEach(function (k) {
    if (!rateBuckets[k].blocked && now - rateBuckets[k].firstReq > RATE_WINDOW * 5) delete rateBuckets[k];
  });
}, 600000);

// ─── Nonce Tracker ──────────────────────────────────────
var usedNonces = new Set();
var nonceTimestamps = {};
var MAX_TIMESTAMP_AGE = 60000;

function validateNonce(nonce, timestamp) {
  if (!nonce || typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64)
    return { valid: false, reason: 'Invalid nonce format' };
  var ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return { valid: false, reason: 'Invalid timestamp' };
  var age = Math.abs(Date.now() - ts);
  if (age > MAX_TIMESTAMP_AGE) return { valid: false, reason: 'Request expired (' + Math.round(age / 1000) + 's old)' };
  if (usedNonces.has(nonce)) return { valid: false, reason: 'Duplicate nonce (replay attempt)' };
  usedNonces.add(nonce);
  nonceTimestamps[nonce] = Date.now();
  return { valid: true };
}

setInterval(function () {
  var now = Date.now();
  Object.keys(nonceTimestamps).forEach(function (n) {
    if (now - nonceTimestamps[n] > MAX_TIMESTAMP_AGE * 3) { usedNonces.delete(n); delete nonceTimestamps[n]; }
  });
}, 120000);

// ─── Security Logger ────────────────────────────────────
function secLog(event, details) {
  var entry = '[' + new Date().toISOString() + '] ' + event;
  if (details) {
    var safe = {};
    Object.keys(details).forEach(function (k) {
      var v = details[k];
      if (k === 'key' && typeof v === 'string' && v.length > 8) safe[k] = v.substring(0, 4) + '****';
      else if (k === 'token' && typeof v === 'string') safe[k] = '***';
      else if (k === 'deviceId' && typeof v === 'string' && v.length > 16) safe[k] = v.substring(0, 8) + '...';
      else safe[k] = v;
    });
    entry += ' ' + JSON.stringify(safe);
  }
  entry += '\n';
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      try { fs.unlinkSync(LOG_FILE + '.1'); } catch (e) {}
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
  } catch (e) {}
  // Also console log for service debugging
  console.log(entry.trim());
}

// ─── Input Validation ───────────────────────────────────
var KEY_REGEX = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
var DEVICE_ID_REGEX = /^[a-f0-9]{64}$/;

function validateKeyFormat(key) { return typeof key === 'string' && KEY_REGEX.test(key); }
function validateDeviceId(deviceId) { return typeof deviceId === 'string' && DEVICE_ID_REGEX.test(deviceId); }
function sanitizeString(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&\\]/g, '').substring(0, maxLen || 200).trim();
}

module.exports = {
  checkRateLimit, recordFail, validateNonce, secLog,
  validateKeyFormat, validateDeviceId, sanitizeString
};
