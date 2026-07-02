/**
 * HALEEM Activation Server v2.0 (Linux Edition)
 * Persistent background daemon supporting WhatsApp Bot & Ngrok Tunnel.
 */
'use strict';
var https = require('https');
var http = require('http');
var fs = require('fs-extra');
var path = require('path');
var crypto = require('crypto');
var os = require('os');
var { spawn } = require('child_process');

// ════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════
var PORT = parseInt(process.env.HALEEM_PORT, 10) || 9847;
var BIND = process.env.HALEEM_BIND || '0.0.0.0';
var DATA_DIR = process.env.HALEEM_DATA || path.join(os.homedir(), '.haleem-server');
var RATE_LIMIT_WINDOW = 60000;
var RATE_LIMIT_MAX = 30;
var NONCE_TTL = 120000; // 2 min
var TIMESTAMP_TOLERANCE = 60000; // 60s
var MAX_BODY = 1048576; // 1MB (to support KB saving)

// ════════════════════════════════════════════════════════
// DATA PATHS
// ════════════════════════════════════════════════════════
var SSL_DIR = path.join(DATA_DIR, 'ssl');
var RSA_DIR = path.join(DATA_DIR, 'rsa');
var DB_PATH = path.join(DATA_DIR, 'data', 'licenses.enc');
var CONFIG_PATH = path.join(DATA_DIR, 'config.json');
var AFFILIATE_DB_PATH = path.join(DATA_DIR, 'data', 'affiliates.enc');

// ════════════════════════════════════════════════════════
// CRYPTO ENGINE
// ════════════════════════════════════════════════════════
var _storageKey = null;
var _rsaPrivate = null;
var _rsaPublic = null;
var _adminToken = '';
var _pairedDevice = null;
var _licenses = [];
var _affiliateData = { affiliates: [], referrals: [] };
var _nonces = new Map(); // nonce -> expiry timestamp
var _rateLimits = new Map(); // ip -> { count, resetAt }
var _startTime = Date.now();

// WhatsApp Bot state variables
var waBot = null;
var waLogs = [];
var waQrCode = null;
var waBotStatus = 'disconnected';
var tunnelUrl = '';
var tunnelInstance = null;

function ensureDirs() {
  [DATA_DIR, SSL_DIR, RSA_DIR, path.join(DATA_DIR, 'data')].forEach(function (d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// AES-256-GCM encryption
function encrypt(text, key) {
  var iv = crypto.randomBytes(16);
  var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  var enc = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  var tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + enc;
}

function decrypt(data, key) {
  var parts = data.split(':');
  if (parts.length < 3) throw new Error('Invalid encrypted data');
  var iv = Buffer.from(parts[0], 'hex');
  var tag = Buffer.from(parts[1], 'hex');
  var enc = parts.slice(2).join(':');
  var decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, 'hex', 'utf8') + decipher.final('utf8');
}

// RSA key pair
function loadOrCreateRSA() {
  var privPath = path.join(RSA_DIR, 'private.pem');
  var pubPath = path.join(RSA_DIR, 'public.pem');
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    _rsaPrivate = fs.readFileSync(privPath, 'utf8');
    _rsaPublic = fs.readFileSync(pubPath, 'utf8');
  } else {
    var pair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    _rsaPrivate = pair.privateKey;
    _rsaPublic = pair.publicKey;
    fs.writeFileSync(privPath, _rsaPrivate);
    fs.writeFileSync(pubPath, _rsaPublic);
  }
}

// Sign license data with RSA private key
function signLicense(key, deviceId, timestamp) {
  var data = key + '|' + deviceId + '|' + timestamp;
  var signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  return signer.sign(_rsaPrivate, 'hex');
}

// HMAC-SHA256
function hmac(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// ════════════════════════════════════════════════════════
// CONFIG & STORAGE
// ════════════════════════════════════════════════════════
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    var cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _adminToken = cfg.adminToken || '';
    _storageKey = Buffer.from(cfg.storageKey, 'hex');
    _pairedDevice = cfg.pairedDevice || null;
    return;
  }
  _adminToken = crypto.randomBytes(32).toString('hex');
  _storageKey = crypto.randomBytes(32);
  _pairedDevice = null;
  saveConfig();
}

function saveConfig() {
  var cfg = {
    adminToken: _adminToken,
    storageKey: _storageKey.toString('hex'),
    pairedDevice: _pairedDevice
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function loadLicenses() {
  if (!fs.existsSync(DB_PATH)) { _licenses = []; return; }
  try {
    var raw = fs.readFileSync(DB_PATH, 'utf8');
    _licenses = JSON.parse(decrypt(raw, _storageKey));
  } catch (e) {
    _licenses = [];
    log('DB_LOAD_ERROR', { error: e.message });
  }
}

function saveLicenses() {
  var enc = encrypt(JSON.stringify(_licenses), _storageKey);
  fs.writeFileSync(DB_PATH, enc);
}

// ════════════════════════════════════════════════════════
// AFFILIATE STORAGE (isolated from licenses)
// ════════════════════════════════════════════════════════
function loadAffiliates() {
  if (!fs.existsSync(AFFILIATE_DB_PATH)) { _affiliateData = { affiliates: [], referrals: [] }; return; }
  try {
    var raw = fs.readFileSync(AFFILIATE_DB_PATH, 'utf8');
    _affiliateData = JSON.parse(decrypt(raw, _storageKey));
    if (!_affiliateData.affiliates) _affiliateData.affiliates = [];
    if (!_affiliateData.referrals) _affiliateData.referrals = [];
  } catch (e) {
    _affiliateData = { affiliates: [], referrals: [] };
    log('AFFILIATE_DB_LOAD_ERROR', { error: e.message });
  }
}

function saveAffiliates() {
  var enc = encrypt(JSON.stringify(_affiliateData), _storageKey);
  fs.writeFileSync(AFFILIATE_DB_PATH, enc);
}

function generateAffiliateCode() {
  return 'AFF-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateReferralId() {
  return 'ref_' + crypto.randomBytes(6).toString('hex');
}

// ════════════════════════════════════════════════════════
// KEY GENERATION
// ════════════════════════════════════════════════════════
function generateKey() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var segments = [];
  for (var s = 0; s < 4; s++) {
    var seg = '';
    for (var c = 0; c < 4; c++) {
      seg += chars[crypto.randomInt(chars.length)];
    }
    segments.push(seg);
  }
  return segments.join('-');
}

function createLicenseKey(customerName, phone) {
  var key;
  var existingKeys = new Set(_licenses.map(function (l) { return l.key; }));
  do { key = generateKey(); } while (existingKeys.has(key));
  var license = {
    key: key,
    customer_name: customerName || '',
    phone: phone || '',
    status: 'unused',
    device_id: null,
    created_at: new Date().toISOString(),
    activated_at: null,
    last_ip: '',
    signature: null,
    sign_timestamp: null
  };
  _licenses.push(license);
  saveLicenses();
  return license;
}

// ════════════════════════════════════════════════════════
// SECURITY: Rate Limiting & Nonce
// ════════════════════════════════════════════════════════
function checkRateLimit(ip) {
  var now = Date.now();
  var entry = _rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

function validateNonce(nonce) {
  if (!nonce || nonce.length < 8) return false;
  var now = Date.now();
  _nonces.forEach(function (expiry, key) {
    if (now > expiry) _nonces.delete(key);
  });
  if (_nonces.has(nonce)) return false;
  _nonces.set(nonce, now + NONCE_TTL);
  return true;
}

function validateAdminRequest(req, body) {
  var auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + _adminToken) return 'Invalid token';

  var ts = req.headers['x-timestamp'];
  if (!ts) return 'Missing timestamp';
  var diff = Math.abs(Date.now() - parseInt(ts, 10));
  if (diff > TIMESTAMP_TOLERANCE) return 'Timestamp expired';

  var nonce = req.headers['x-nonce'];
  if (!validateNonce(nonce)) return 'Invalid or reused nonce';

  var sig = req.headers['x-signature'];
  if (!sig) return 'Missing signature';
  var method = req.method;
  var urlPath = req.url.split('?')[0];
  var message = method + ':' + urlPath + ':' + ts + ':' + nonce + ':' + (body || '');
  var expected = hmac(message, _adminToken);
  if (sig !== expected) return 'Invalid signature';

  if (_pairedDevice) {
    var deviceFp = req.headers['x-device-id'];
    if (deviceFp !== _pairedDevice.fingerprint) return 'Unpaired device';
  }

  return null;
}

function validateClientRequest(body) {
  if (!body || !body.key || !body.device_id) return 'Missing key or device_id';
  if (!body.timestamp || !body.signature) return 'Missing timestamp or signature';
  var diff = Math.abs(Date.now() - parseInt(body.timestamp, 10));
  if (diff > TIMESTAMP_TOLERANCE) return 'Timestamp expired';
  var message = body.key + ':' + body.device_id + ':' + body.timestamp;
  var expected = hmac(message, body.key);
  if (body.signature !== expected) return 'Invalid client signature';
  return null;
}

// ════════════════════════════════════════════════════════
// LOGGING
// ════════════════════════════════════════════════════════
function log(event, data) {
  var entry = { ts: new Date().toISOString(), event: event, data: data || {} };
  console.log('[HALEEM] ' + JSON.stringify(entry));
  if (process.send) process.send({ type: 'log', payload: entry });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
}

function sendJSON(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000'
  });
  res.end(body);
}

function readBody(req, cb) {
  var chunks = [];
  var size = 0;
  req.on('data', function (chunk) {
    size += chunk.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', function () {
    cb(Buffer.concat(chunks).toString());
  });
}

// ════════════════════════════════════════════════════════
// STANDALONE NGROK TUNNEL FOR BACKGROUND DAEMON
// ════════════════════════════════════════════════════════
function startTunnel() {
  try {
    log('TUNNEL_STARTING', { port: PORT + 1 });
    tunnelInstance = spawn('ngrok', ['http', String(PORT + 1), '--log', 'stdout', '--log-level', 'info']);
    
    tunnelInstance.stdout.on('data', function (data) {
      var line = data.toString();
      var match = line.match(/url=(https:\/\/[a-z0-9\-]+\.ngrok[a-z\-]*\.[a-z]+)/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[1];
        log('TUNNEL_CONNECTED', { url: tunnelUrl });
      }
    });

    tunnelInstance.on('exit', function (code) {
      log('TUNNEL_DISCONNECTED', { code: code });
      tunnelUrl = '';
      tunnelInstance = null;
      setTimeout(startTunnel, 5000);
    });

    tunnelInstance.on('error', function (err) {
      log('TUNNEL_ERROR', { error: err.message });
    });
  } catch (e) {
    log('TUNNEL_INIT_FAILED', { error: e.message });
    setTimeout(startTunnel, 5000);
  }
}

// ════════════════════════════════════════════════════════
// STANDALONE WHATSAPP BOT DAEMON
// ════════════════════════════════════════════════════════
function initWhatsApp() {
  try {
    var WhatsAppBot = require('../whatsapp/WhatsAppBot');
    waBot = new WhatsAppBot(
      function(msg) {
        var entry = { time: new Date().toLocaleTimeString(), msg: String(msg) };
        waLogs.push(entry);
        if (waLogs.length > 300) waLogs.shift();
        log('WA_LOG', { msg: msg });
      },
      function(qr) {
        waQrCode = qr;
      },
      function(st) {
        waBotStatus = st;
        log('WA_STATUS', { status: st });
      }
    );
    
    waBot._createKeyFn = function(name, phone) {
      return new Promise(function(resolve) {
        var lic = createLicenseKey(name, phone);
        resolve(lic.key);
      });
    };
    waBot._getTunnelUrlFn = function() { return tunnelUrl; };

    log('WA_AUTO_CONNECT', {});
    waBot.connect().catch(function(e) {
      log('WA_CONNECT_ERR', { error: e.message });
    });
  } catch (e) {
    log('WA_INIT_FAILED', { error: e.message });
  }
}

// ════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════
function handleStatus(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var stats = { total: 0, unused: 0, pending: 0, activated: 0, revoked: 0 };
  _licenses.forEach(function (l) {
    stats.total++;
    stats[l.status] = (stats[l.status] || 0) + 1;
  });

  sendJSON(res, 200, {
    status: 'running',
    version: '2.0.0',
    uptime: Math.floor((Date.now() - _startTime) / 1000),
    stats: stats,
    paired: _pairedDevice ? { name: _pairedDevice.name, pairedAt: _pairedDevice.pairedAt } : null,
    tunnelUrl: tunnelUrl
  });
}

function handleClients(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var safe = _licenses.map(function (l) {
    return {
      key: l.key, customer_name: l.customer_name, phone: l.phone,
      status: l.status, device_id: l.device_id,
      created_at: l.created_at, activated_at: l.activated_at, last_ip: l.last_ip
    };
  });
  sendJSON(res, 200, { clients: safe });
}

function handleRequests(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var pending = _licenses.filter(function (l) { return l.status === 'pending'; }).map(function (l) {
    return {
      key: l.key, customer_name: l.customer_name, phone: l.phone,
      device_id: l.device_id, created_at: l.created_at, last_ip: l.last_ip
    };
  });
  sendJSON(res, 200, { requests: pending });
}

function handleActivate(req, res, ip, bodyStr) {
  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

  var isAdmin = (req.headers['authorization'] || '').indexOf('Bearer ') === 0;

  if (isAdmin) {
    var err = validateAdminRequest(req, bodyStr);
    if (err) { sendJSON(res, 401, { error: err }); return; }
    if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

    var lic = _licenses.find(function (l) { return l.key === body.key; });
    if (!lic) { sendJSON(res, 404, { error: 'Key not found' }); return; }
    if (lic.status === 'revoked') { sendJSON(res, 403, { error: 'Key is revoked' }); return; }
    if (lic.status === 'activated') { sendJSON(res, 200, { message: 'Already activated' }); return; }

    var ts = Date.now().toString();
    lic.status = 'activated';
    lic.activated_at = new Date().toISOString();
    lic.sign_timestamp = ts;
    lic.signature = signLicense(lic.key, lic.device_id || 'unbound', ts);
    lic.last_ip = ip;
    saveLicenses();
    log('KEY_ACTIVATED', { key: lic.key, ip: ip });
    sendJSON(res, 200, { message: 'Activated', key: lic.key, status: 'activated' });

  } else {
    var cerr = validateClientRequest(body);
    if (cerr) { sendJSON(res, 401, { error: cerr }); return; }

    var lic = _licenses.find(function (l) { return l.key === body.key; });
    if (!lic) { sendJSON(res, 404, { error: 'Key not found' }); return; }
    if (lic.status === 'revoked') { sendJSON(res, 403, { error: 'License revoked' }); return; }

    if (lic.device_id && lic.device_id !== body.device_id) {
      sendJSON(res, 403, { error: 'License bound to another device' });
      return;
    }

    lic.device_id = body.device_id;
    lic.last_ip = ip;

    if (lic.status === 'activated') {
      lic.last_seen = new Date().toISOString();
      saveLicenses();
      sendJSON(res, 200, {
        status: 'activated',
        key: lic.key,
        device_id: lic.device_id,
        signature: lic.signature,
        timestamp: lic.sign_timestamp,
        public_key: _rsaPublic
      });
    } else if (lic.status === 'unused' || lic.status === 'pending') {
      lic.status = 'pending';
      lic.requested_at = new Date().toISOString();
      saveLicenses();
      log('ACTIVATION_REQUEST', { key: lic.key, device_id: lic.device_id, ip: ip });
      sendJSON(res, 202, { message: 'Activation request submitted. Waiting for approval.', status: 'pending' });
    }
  }
}

function handleRevoke(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

  var lic = _licenses.find(function (l) { return l.key === body.key; });
  if (!lic) { sendJSON(res, 404, { error: 'Key not found' }); return; }

  lic.status = 'revoked';
  lic.signature = null;
  lic.sign_timestamp = null;
  saveLicenses();
  log('KEY_REVOKED', { key: lic.key, ip: ip });
  sendJSON(res, 200, { message: 'Revoked', key: lic.key });
}

function handleReactivate(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

  var lic = _licenses.find(function (l) { return l.key === body.key; });
  if (!lic) { sendJSON(res, 404, { error: 'Key not found' }); return; }

  lic.status = 'unused';
  lic.device_id = null;
  lic.signature = null;
  lic.sign_timestamp = null;
  lic.activated_at = null;
  saveLicenses();
  log('KEY_REACTIVATED', { key: lic.key, ip: ip });
  sendJSON(res, 200, { message: 'Reactivated', key: lic.key });
}

function handleCreateKey(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  
  var lic = createLicenseKey(body.customerName || '', body.phone || '');
  if (process.send) process.send({ type: 'key-created', license: lic });
  log('KEY_CREATED', { key: lic.key, ip: ip });
  sendJSON(res, 200, { message: 'Key created', license: lic });
}

function handleDeleteKey(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

  _licenses = _licenses.filter(function (l) { return l.key !== body.key; });
  saveLicenses();
  if (process.send) process.send({ type: 'key-deleted', key: body.key });
  log('KEY_DELETED', { key: body.key, ip: ip });
  sendJSON(res, 200, { message: 'Key deleted' });
}

function handlePairDevice(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.fingerprint) { sendJSON(res, 400, { error: 'Missing fingerprint' }); return; }

  _pairedDevice = { fingerprint: body.fingerprint, name: body.deviceName || 'Remote', pairedAt: new Date().toISOString() };
  saveConfig();
  if (process.send) process.send({ type: 'device-paired', device: _pairedDevice });
  sendJSON(res, 200, { message: 'Device paired', device: _pairedDevice });
}

function handleUnpairDevice(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  _pairedDevice = null;
  saveConfig();
  if (process.send) process.send({ type: 'device-unpaired' });
  sendJSON(res, 200, { message: 'Device unpaired' });
}

// ════════════════════════════════════════════════════════
// AFFILIATE HANDLERS (isolated module)
// ════════════════════════════════════════════════════════
function parseQueryParams(urlStr) {
  var q = {};
  var idx = urlStr.indexOf('?');
  if (idx < 0) return q;
  urlStr.substring(idx + 1).split('&').forEach(function (p) {
    var kv = p.split('=');
    if (kv[0]) q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
  });
  return q;
}

function handleAffiliateList(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var list = _affiliateData.affiliates.map(function (a) {
    var refs = _affiliateData.referrals.filter(function (r) { return r.affiliate_user_key === a.user_key; });
    var pending = 0, paid = 0;
    refs.forEach(function (r) {
      if (r.status === 'paid') paid += r.commission;
      else pending += r.commission;
    });
    var lic = _licenses.find(function (l) { return l.key === a.user_key; });
    return {
      user_key: a.user_key,
      customer_name: lic ? lic.customer_name : '',
      phone: lic ? lic.phone : '',
      affiliate_code: a.affiliate_code,
      commission_pct: a.commission_pct,
      status: a.status,
      total_referrals: refs.length,
      pending_balance: pending,
      paid_balance: paid,
      created_at: a.created_at
    };
  });
  sendJSON(res, 200, { affiliates: list });
}

function handleAffiliateEnable(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

  var lic = _licenses.find(function (l) { return l.key === body.key; });
  if (!lic) { sendJSON(res, 404, { error: 'License key not found' }); return; }

  var existing = _affiliateData.affiliates.find(function (a) { return a.user_key === body.key; });
  if (existing) {
    existing.status = 'enabled';
    if (body.commission_pct !== undefined) existing.commission_pct = parseFloat(body.commission_pct) || 25;
  } else {
    var code;
    var existingCodes = new Set(_affiliateData.affiliates.map(function (a) { return a.affiliate_code; }));
    do { code = generateAffiliateCode(); } while (existingCodes.has(code));
    _affiliateData.affiliates.push({
      user_key: body.key,
      affiliate_code: code,
      commission_pct: parseFloat(body.commission_pct) || 25,
      status: 'enabled',
      created_at: new Date().toISOString()
    });
  }
  saveAffiliates();
  if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
  log('AFFILIATE_ENABLED', { key: body.key, ip: ip });
  sendJSON(res, 200, { message: 'Affiliate enabled', key: body.key });
}

function handleAffiliateDisable(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

  var aff = _affiliateData.affiliates.find(function (a) { return a.user_key === body.key; });
  if (!aff) { sendJSON(res, 404, { error: 'Affiliate not found' }); return; }

  aff.status = 'disabled';
  saveAffiliates();
  if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
  log('AFFILIATE_DISABLED', { key: body.key, ip: ip });
  sendJSON(res, 200, { message: 'Affiliate disabled', key: body.key });
}

function handleAffiliateDashboard(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var params = parseQueryParams(req.url);
  var key = params.key;
  if (!key) { sendJSON(res, 400, { error: 'Missing key parameter' }); return; }

  var aff = _affiliateData.affiliates.find(function (a) { return a.user_key === key; });
  if (!aff) { sendJSON(res, 404, { error: 'Affiliate not found' }); return; }

  var refs = _affiliateData.referrals.filter(function (r) { return r.affiliate_user_key === key; });
  var pending = 0, paid = 0;
  refs.forEach(function (r) {
    if (r.status === 'paid') paid += r.commission;
    else pending += r.commission;
  });

  sendJSON(res, 200, {
    affiliate_code: aff.affiliate_code,
    referral_link: 'https://haleem.app/ref/' + aff.affiliate_code,
    pending_balance: pending,
    paid_balance: paid,
    total_referrals: refs.length,
    commission_pct: aff.commission_pct,
    status: aff.status
  });
}

function handleAffiliateReferrals(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var params = parseQueryParams(req.url);
  var key = params.key;
  if (!key) { sendJSON(res, 400, { error: 'Missing key parameter' }); return; }

  var refs = _affiliateData.referrals.filter(function (r) { return r.affiliate_user_key === key; });
  var enriched = refs.map(function (r) {
    var refLic = _licenses.find(function (l) { return l.key === r.referred_user_key; });
    return {
      id: r.id,
      referred_customer: refLic ? refLic.customer_name : r.referred_user_key,
      referred_key: r.referred_user_key,
      order_id: r.order_id,
      commission: r.commission,
      status: r.status,
      created_at: r.created_at
    };
  });
  sendJSON(res, 200, { referrals: enriched });
}

function handleAffiliateMarkPaid(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.id) { sendJSON(res, 400, { error: 'Missing referral id' }); return; }

  var ref = _affiliateData.referrals.find(function (r) { return r.id === body.id; });
  if (!ref) { sendJSON(res, 404, { error: 'Referral not found' }); return; }

  ref.status = 'paid';
  ref.paid_at = new Date().toISOString();
  saveAffiliates();
  if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
  log('REFERRAL_PAID', { id: body.id, ip: ip });
  sendJSON(res, 200, { message: 'Marked as paid', id: body.id });
}

function handleAffiliatePayAll(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.key) { sendJSON(res, 400, { error: 'Missing affiliate key' }); return; }

  var aff = _affiliateData.affiliates.find(function (a) { return a.user_key === body.key; });
  if (!aff) { sendJSON(res, 404, { error: 'Affiliate not found' }); return; }

  var paidCount = 0;
  var paidTotal = 0;
  _affiliateData.referrals.forEach(function (r) {
    if (r.affiliate_user_key === body.key && r.status !== 'paid') {
      r.status = 'paid';
      r.paid_at = new Date().toISOString();
      paidCount++;
      paidTotal += r.commission;
    }
  });
  saveAffiliates();
  if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
  log('AFFILIATE_PAY_ALL', { key: body.key, count: paidCount, total: paidTotal, ip: ip });
  sendJSON(res, 200, { message: 'All referrals paid', count: paidCount, total: paidTotal });
}

function handleAffiliateRegisterReferral(req, res, ip, bodyStr) {
  var err = validateAdminRequest(req, bodyStr);
  if (err) { sendJSON(res, 401, { error: err }); return; }

  var body;
  try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
  if (!body.affiliate_key || !body.referred_key) {
    sendJSON(res, 400, { error: 'Missing affiliate_key or referred_key' });
    return;
  }

  var aff = _affiliateData.affiliates.find(function (a) { return a.user_key === body.affiliate_key && a.status === 'enabled'; });
  if (!aff) { sendJSON(res, 404, { error: 'Active affiliate not found' }); return; }

  var orderValue = parseFloat(body.order_value) || 0;
  var commission = orderValue * (aff.commission_pct / 100);

  var referral = {
    id: generateReferralId(),
    affiliate_user_key: body.affiliate_key,
    referred_user_key: body.referred_key,
    order_id: body.order_id || '',
    commission: commission,
    status: body.status || 'pending',
    created_at: new Date().toISOString()
  };
  _affiliateData.referrals.push(referral);
  saveAffiliates();
  if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
  log('REFERRAL_REGISTERED', { affiliate: body.affiliate_key, referred: body.referred_key, commission: commission });
  sendJSON(res, 200, { message: 'Referral registered', referral: referral });
}

// ════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════
function handleRequest(req, res) {
  var ip = getClientIP(req);
  var url = req.url.split('?')[0];
  var method = req.method;

  if (!checkRateLimit(ip)) {
    sendJSON(res, 429, { error: 'Rate limit exceeded' });
    return;
  }

  var origin = req.headers['origin'] || '*';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Timestamp, X-Nonce, X-Signature, X-Device-Id, Bypass-Tunnel-Reminder, ngrok-skip-browser-warning',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Timestamp, X-Nonce, X-Signature, X-Device-Id');

  // PUBLIC UN-AUTHENTICATED PING ENDPOINT
  if (method === 'GET' && url === '/ping') {
    sendJSON(res, 200, { status: 'haleem-server' });
    return;
  }

  // PUBLIC QR CODE PAGE — open in browser to scan WhatsApp QR
  if (method === 'GET' && url === '/wa-qr') {
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>HALEEM WhatsApp QR</title>'
      + '<meta http-equiv="refresh" content="15">'
      + '<style>body{background:#0a0a0f;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}'
      + 'img{border-radius:12px;background:#fff;padding:16px} h2{margin-bottom:8px} .st{font-size:14px;opacity:.7;margin-bottom:20px}</style></head><body>';
    if (waBotStatus === 'ready') {
      html += '<h2>✅ واتساب متصل بنجاح!</h2>';
    } else if (waQrCode) {
      html += '<h2>📸 امسح الكود بواتساب</h2><p class="st">الصفحة تتحدث تلقائياً كل 15 ثانية</p>';
      html += '<img src="' + waQrCode + '" width="300">';
    } else {
      html += '<h2>⏳ جاري تهيئة واتساب...</h2><p class="st">انتظر قليلاً — الصفحة تتحدث تلقائياً</p>';
    }
    html += '</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  readBody(req, function (bodyStr) {
    // STRICT ROUTING
    if (method === 'GET' && url === '/status') return handleStatus(req, res, ip, bodyStr);
    if (method === 'GET' && url === '/clients') return handleClients(req, res, ip, bodyStr);
    if (method === 'GET' && url === '/requests') return handleRequests(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/activate') return handleActivate(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/revoke') return handleRevoke(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/reactivate') return handleReactivate(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/create-key') return handleCreateKey(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/delete-key') return handleDeleteKey(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/pair-device') return handlePairDevice(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/unpair-device') return handleUnpairDevice(req, res, ip, bodyStr);

    // ─── LEGACY PLUGIN API (v2 compatibility) ──────────────
    // Old plugin uses /api/activate and /api/check with APP_TOKEN signing
    var _APP_TOKEN = 'HU_APP_2026_' + crypto.createHash('md5').update('HALEEM-ULTRA-CLIENT').digest('hex').substring(0, 16);

    function validateAppToken(reqObj, rawBody) {
      var sig = reqObj.headers['x-signature'];
      var ts = reqObj.headers['x-timestamp'];
      var nonce = reqObj.headers['x-nonce'];
      if (!sig || !ts || !nonce) return false;
      var payload = rawBody + '|' + ts + '|' + nonce;
      var expected = crypto.createHmac('sha256', _APP_TOKEN).update(payload).digest('hex');
      return sig === expected;
    }

    if (method === 'POST' && url === '/api/activate') {
      var body;
      try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
      if (!validateAppToken(req, bodyStr)) { sendJSON(res, 401, { error: 'Invalid app signature' }); return; }
      if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

      var lic = _licenses.find(function (l) { return l.key === body.key; });
      if (!lic) { sendJSON(res, 404, { error: 'Key not found' }); return; }
      if (lic.status === 'revoked') { sendJSON(res, 200, { status: 'revoked' }); return; }

      // Bind device if not bound
      if (body.deviceId) {
        if (lic.device_id && lic.device_id !== body.deviceId) {
          sendJSON(res, 403, { error: 'License bound to another device' });
          return;
        }
        lic.device_id = body.deviceId;
      }
      lic.last_ip = ip;

      // Already activated on same device — allow
      if (lic.status === 'activated') {
        lic.last_seen = new Date().toISOString();
        saveLicenses();
        sendJSON(res, 200, { status: 'activated', bound: lic.device_id === body.deviceId });
        return;
      }

      // Set to pending — wait for admin approval
      if (lic.status === 'unused' || lic.status === 'pending') {
        lic.status = 'pending';
        lic.requested_at = new Date().toISOString();
        saveLicenses();
        log('ACTIVATION_REQUEST', { key: lic.key, device_id: lic.device_id, ip: ip });
        sendJSON(res, 200, { status: 'pending', message: 'Activation request sent. Waiting for admin approval.' });
        return;
      }

      sendJSON(res, 200, { status: lic.status });
      return;
    }

    if (method === 'POST' && url === '/api/check') {
      var body;
      try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
      if (!validateAppToken(req, bodyStr)) { sendJSON(res, 401, { error: 'Invalid app signature' }); return; }
      if (!body.key) { sendJSON(res, 400, { error: 'Missing key' }); return; }

      var lic = _licenses.find(function (l) { return l.key === body.key; });
      if (!lic) { sendJSON(res, 200, { status: 'revoked' }); return; }
      if (lic.status === 'revoked') { sendJSON(res, 200, { status: 'revoked' }); return; }
      if (lic.status === 'activated') {
        sendJSON(res, 200, { status: 'activated', bound: lic.device_id === body.deviceId });
        return;
      }
      sendJSON(res, 200, { status: lic.status });
      return;
    }

    // WHATSAPP BOT API
    if (method === 'GET' && url === '/wa-status') {
      var err = validateAdminRequest(req, bodyStr);
      if (err) { sendJSON(res, 401, { error: err }); return; }
      return sendJSON(res, 200, { status: waBotStatus, qr: waQrCode, logs: waLogs });
    }
    if (method === 'POST' && url === '/wa-start') {
      var err = validateAdminRequest(req, bodyStr);
      if (err) { sendJSON(res, 401, { error: err }); return; }
      if (waBot) {
        waBot.connect().then(function(r) { sendJSON(res, 200, r); }).catch(function(e) { sendJSON(res, 500, { error: e.message }); });
      } else {
        sendJSON(res, 500, { error: 'WhatsApp Bot not initialized' });
      }
      return;
    }
    if (method === 'POST' && url === '/wa-stop') {
      var err = validateAdminRequest(req, bodyStr);
      if (err) { sendJSON(res, 401, { error: err }); return; }
      if (waBot) {
        waBot.disconnect().then(function() { sendJSON(res, 200, { success: true }); }).catch(function(e) { sendJSON(res, 500, { error: e.message }); });
      } else {
        sendJSON(res, 500, { error: 'WhatsApp Bot not initialized' });
      }
      return;
    }
    if (method === 'GET' && url === '/wa-get-kb') {
      var err = validateAdminRequest(req, bodyStr);
      if (err) { sendJSON(res, 401, { error: err }); return; }
      if (waBot) { sendJSON(res, 200, waBot.getKB()); } else { sendJSON(res, 500, { error: 'WhatsApp Bot not initialized' }); }
      return;
    }
    if (method === 'POST' && url === '/wa-save-kb') {
      var err = validateAdminRequest(req, bodyStr);
      if (err) { sendJSON(res, 401, { error: err }); return; }
      var body;
      try { body = JSON.parse(bodyStr); } catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
      if (waBot) {
        waBot.saveKB(body);
        sendJSON(res, 200, { success: true });
      } else {
        sendJSON(res, 500, { error: 'WhatsApp Bot not initialized' });
      }
      return;
    }

    // ═══ AFFILIATE API (isolated module) ═══════════════════
    if (method === 'GET' && url === '/api/affiliate/list') return handleAffiliateList(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/api/affiliate/enable') return handleAffiliateEnable(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/api/affiliate/disable') return handleAffiliateDisable(req, res, ip, bodyStr);
    if (method === 'GET' && url.indexOf('/api/affiliate/dashboard') === 0) return handleAffiliateDashboard(req, res, ip, bodyStr);
    if (method === 'GET' && url.indexOf('/api/affiliate/referrals') === 0) return handleAffiliateReferrals(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/api/affiliate/mark-paid') return handleAffiliateMarkPaid(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/api/affiliate/register-referral') return handleAffiliateRegisterReferral(req, res, ip, bodyStr);
    if (method === 'POST' && url === '/api/affiliate/pay-all') return handleAffiliatePayAll(req, res, ip, bodyStr);

    sendJSON(res, 403, { error: 'Forbidden' });
  });
}

// ════════════════════════════════════════════════════════
// SERVER STARTUP
// ════════════════════════════════════════════════════════
function start(sslCert, sslKey) {
  ensureDirs();
  loadOrCreateRSA();
  loadConfig();
  loadLicenses();
  loadAffiliates();

  var httpPort = PORT + 1; // HTTP on 9848

  var httpServer = http.createServer(handleRequest);
  httpServer.listen(httpPort, BIND, function () {
    log('HTTP_LISTENING', { port: httpPort });
  });

  if (sslCert && sslKey) {
    var httpsServer = https.createServer({ cert: sslCert, key: sslKey }, handleRequest);
    httpsServer.listen(PORT, BIND, function () {
      log('HTTPS_LISTENING', { port: PORT });
    });
  }

  // Start background tunnel and WhatsApp Bot automatically
  startTunnel();
  initWhatsApp();

  if (process.on) {
    process.on('message', function (msg) {
      if (!msg || !msg.action) return;
      switch (msg.action) {
        case 'create-key':
          var lic = createLicenseKey(msg.customerName, msg.phone);
          if (process.send) process.send({ type: 'key-created', license: lic });
          break;
        case 'get-state':
          if (process.send) process.send({
            type: 'state',
            token: _adminToken,
            publicKey: _rsaPublic,
            paired: _pairedDevice,
            licenses: _licenses.map(function (l) {
              return {
                key: l.key, customer_name: l.customer_name, phone: l.phone,
                status: l.status, device_id: l.device_id,
                created_at: l.created_at, activated_at: l.activated_at
              };
            })
          });
          break;
        case 'delete-key':
          _licenses = _licenses.filter(function (l) { return l.key !== msg.key; });
          saveLicenses();
          if (process.send) process.send({ type: 'key-deleted', key: msg.key });
          break;
        // ═══ Affiliate IPC actions ═══════════════════════════
        case 'get-affiliate-data':
          if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
          break;
        case 'enable-affiliate':
          var existingAff = _affiliateData.affiliates.find(function (a) { return a.user_key === msg.key; });
          if (existingAff) {
            existingAff.status = 'enabled';
            if (msg.commission_pct !== undefined) existingAff.commission_pct = parseFloat(msg.commission_pct) || 25;
          } else {
            var affCode;
            var affCodes = new Set(_affiliateData.affiliates.map(function (a) { return a.affiliate_code; }));
            do { affCode = generateAffiliateCode(); } while (affCodes.has(affCode));
            _affiliateData.affiliates.push({
              user_key: msg.key,
              affiliate_code: affCode,
              commission_pct: parseFloat(msg.commission_pct) || 25,
              status: 'enabled',
              created_at: new Date().toISOString()
            });
          }
          saveAffiliates();
          if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
          break;
        case 'disable-affiliate':
          var dAff = _affiliateData.affiliates.find(function (a) { return a.user_key === msg.key; });
          if (dAff) { dAff.status = 'disabled'; saveAffiliates(); }
          if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
          break;
        case 'mark-referral-paid':
          var mRef = _affiliateData.referrals.find(function (r) { return r.id === msg.id; });
          if (mRef) { mRef.status = 'paid'; mRef.paid_at = new Date().toISOString(); saveAffiliates(); }
          if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
          break;
        case 'register-referral':
          var regAff = _affiliateData.affiliates.find(function (a) { return a.user_key === msg.affiliate_key && a.status === 'enabled'; });
          if (regAff) {
            var ordVal = parseFloat(msg.order_value) || 0;
            var comm = ordVal * (regAff.commission_pct / 100);
            _affiliateData.referrals.push({
              id: generateReferralId(),
              affiliate_user_key: msg.affiliate_key,
              referred_user_key: msg.referred_key,
              order_id: msg.order_id || '',
              commission: comm,
              status: 'pending',
              created_at: new Date().toISOString()
            });
            saveAffiliates();
          }
          if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
          break;
        case 'pay-all-affiliate':
          var payAllAff = _affiliateData.affiliates.find(function (a) { return a.user_key === msg.key; });
          if (payAllAff) {
            _affiliateData.referrals.forEach(function (r) {
              if (r.affiliate_user_key === msg.key && r.status !== 'paid') {
                r.status = 'paid';
                r.paid_at = new Date().toISOString();
              }
            });
            saveAffiliates();
          }
          if (process.send) process.send({ type: 'affiliate-update', data: _affiliateData });
          break;
      }
    });
  }
}

if (require.main === module) {
  var certPath = path.join(SSL_DIR, 'cert.pem');
  var keyPath = path.join(SSL_DIR, 'key.pem');
  ensureDirs();

  // Graceful shutdown: kill WhatsApp/Puppeteer and ngrok before exiting
  function gracefulShutdown(signal) {
    log('SHUTTING_DOWN', { signal: signal });
    var tasks = [];
    if (waBot && waBot.client) {
      tasks.push(waBot.disconnect().catch(function() {}));
    }
    if (tunnelInstance) {
      tunnelInstance.kill('SIGKILL');
      tunnelInstance = null;
    }
    Promise.all(tasks).then(function() {
      process.exit(0);
    }).catch(function() {
      process.exit(1);
    });
    // Force exit after 10s if cleanup hangs
    setTimeout(function() { process.exit(1); }, 10000);
  }
  process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
  process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    start(fs.readFileSync(certPath), fs.readFileSync(keyPath));
  } else {
    start(null, null);
  }
}

module.exports = { start: start };
