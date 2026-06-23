/**
 * HALEEM Activation Manager — Electron Desktop App for Linux
 * Auto-detects and connects to background systemd service.
 * Otherwise, forks the local HTTPS server.
 */
const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { fork } = require('child_process');

let mainWindow = null;
let serverProcess = null;
let adminToken = '';
let publicKey = '';
let pairedDevice = null;
let serverLogs = [];
let tunnelUrl = '';
let tunnelInstance = null;
let useBackgroundApi = false;

const PORT = 9847;
let httpPort = PORT + 1;
const DATA_DIR = path.join(os.homedir(), '.haleem-server');
const SSL_DIR = path.join(DATA_DIR, 'ssl');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SERVER_SCRIPT = path.join(__dirname, 'server', 'server.js');

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', function () {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// Check if port is in use (implies background service is active)
function checkPortInUse(port, host, cb) {
  const net = require('net');
  const server = net.createServer();
  server.once('error', function(err) {
    if (err.code === 'EADDRINUSE') { cb(true); }
    else { cb(false); }
  });
  server.once('listening', function() {
    server.close();
    cb(false);
  });
  server.listen(port, host);
}

// Load local config and rsa keys directly from shared ~/.haleem-server folder
function loadConfigAndState() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      adminToken = cfg.adminToken || '';
      pairedDevice = cfg.pairedDevice || null;
    }
    const pubPath = path.join(DATA_DIR, 'rsa', 'public.pem');
    if (fs.existsSync(pubPath)) {
      publicKey = fs.readFileSync(pubPath, 'utf8');
    }
  } catch (e) {
    addLog('❌ Failed to load credentials from background server: ' + e.message);
  }
}

// Sign and make HTTP requests to the background server local API
function makeAdminRequest(method, urlPath, bodyObj, cb) {
  var body = bodyObj ? JSON.stringify(bodyObj) : '';
  var ts = Date.now().toString();
  var nonce = crypto.randomBytes(16).toString('hex');
  
  // Calculate signature
  var message = method + ':' + urlPath + ':' + ts + ':' + nonce + ':' + body;
  var sig = crypto.createHmac('sha256', adminToken).update(message).digest('hex');
  
  var options = {
    hostname: '127.0.0.1',
    port: PORT + 1, // HTTP port is 9848
    path: urlPath,
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + adminToken,
      'x-timestamp': ts,
      'x-nonce': nonce,
      'x-signature': sig
    }
  };
  
  var req = http.request(options, function(res) {
    var data = '';
    res.on('data', function(chunk) { data += chunk; });
    res.on('end', function() {
      try {
        var json = JSON.parse(data);
        cb(null, json);
      } catch(e) {
        cb(new Error('Invalid JSON response: ' + data));
      }
    });
  });
  req.on('error', function(err) { cb(err); });
  if (body) req.write(body);
  req.end();
}

function refreshStateBackground() {
  makeAdminRequest('GET', '/clients', null, function(err, res) {
    if (!err && res && res.clients) {
      loadConfigAndState();
      if (mainWindow) {
        mainWindow.webContents.send('state-update', {
          licenses: res.clients,
          token: adminToken,
          publicKey: publicKey,
          paired: pairedDevice
        });
      }
    }
  });
}

// ─── SSL Certificate Generation (For local development/fallback) ────────────────
function ensureSSLCert(cb) {
  var certPath = path.join(SSL_DIR, 'cert.pem');
  var keyPath = path.join(SSL_DIR, 'key.pem');

  if (!fs.existsSync(SSL_DIR)) fs.mkdirSync(SSL_DIR, { recursive: true });

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return cb(fs.readFileSync(certPath, 'utf8'), fs.readFileSync(keyPath, 'utf8'));
  }

  var forge = require('node-forge');
  var pki = forge.pki;
  var keys = pki.rsa.generateKeyPair(2048);
  var cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  var attrs = [{ name: 'commonName', value: 'HALEEM Activation Server' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  var ips = getLocalIPs();
  var altNames = [{ type: 2, value: 'localhost' }];
  ips.forEach(function (ip) { altNames.push({ type: 7, ip: ip }); });
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: altNames }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  var pemCert = pki.certificateToPem(cert);
  var pemKey = pki.privateKeyToPem(keys.privateKey);
  fs.writeFileSync(certPath, pemCert);
  fs.writeFileSync(keyPath, pemKey);
  cb(pemCert, pemKey);
}

// ─── Network ───────────────────────────────────────────
function getLocalIPs() {
  var ips = [];
  var nets = os.networkInterfaces();
  for (var name in nets) {
    for (var i = 0; i < nets[name].length; i++) {
      var net = nets[name][i];
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// ─── Start Server / Connect Background ──────────────────
function initializeServer() {
  checkPortInUse(PORT + 1, '127.0.0.1', function(inUse) {
    if (inUse) {
      useBackgroundApi = true;
      loadConfigAndState();
      addLog('🟢 Connected to HALEEM Activation Server running in background');
      updateUI();
      // Try to check if tunnel is active on backend or start local tunnel
      startTunnel();
    } else {
      addLog('ℹ️ Starting HALEEM Server locally...');
      startServer();
    }
  });
}

function startServer() {
  ensureSSLCert(function (cert, key) {
    serverProcess = fork(SERVER_SCRIPT, [], {
      env: Object.assign({}, process.env, {
        HALEEM_PORT: String(PORT),
        HALEEM_BIND: '0.0.0.0',
        HALEEM_DATA: DATA_DIR
      }),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    serverProcess.stdout.on('data', function (d) {
      var msg = d.toString().trim();
      if (msg) addLog(msg);
    });
    serverProcess.stderr.on('data', function (d) {
      addLog('[ERR] ' + d.toString().trim());
    });

    serverProcess.on('message', function (msg) {
      if (!msg) return;
      switch (msg.type) {
        case 'ready':
          adminToken = msg.token;
          publicKey = msg.publicKey;
          pairedDevice = msg.paired;
          httpPort = msg.httpPort || (PORT + 1);
          addLog('✅ HTTPS:' + PORT + ' HTTP:' + httpPort);
          updateUI();
          startTunnel();
          break;
        case 'log':
          addLog(msg.payload.event + ': ' + JSON.stringify(msg.payload.data));
          break;
        case 'key-created':
          if (mainWindow) mainWindow.webContents.send('key-created', msg.license);
          break;
        case 'state':
          if (mainWindow) mainWindow.webContents.send('state-update', msg);
          break;
        case 'device-paired':
          pairedDevice = msg.device;
          if (mainWindow) mainWindow.webContents.send('device-paired', msg.device);
          break;
        case 'device-unpaired':
          pairedDevice = null;
          if (mainWindow) mainWindow.webContents.send('device-unpaired');
          break;
        case 'key-deleted':
          if (mainWindow) mainWindow.webContents.send('key-deleted', msg.key);
          break;
      }
    });

    serverProcess.on('exit', function (code) {
      addLog('⚠️ Local Server stopped (code: ' + code + ')');
      serverProcess = null;
    });
  });
}

function addLog(msg) {
  var entry = { time: new Date().toLocaleTimeString(), msg: String(msg) };
  serverLogs.push(entry);
  if (serverLogs.length > 300) serverLogs.shift();
  if (mainWindow) mainWindow.webContents.send('log', entry);
}

function updateUI() {
  if (!mainWindow) return;
  mainWindow.webContents.send('server-info', {
    running: useBackgroundApi || !!serverProcess,
    port: PORT,
    httpPort: httpPort,
    token: adminToken,
    publicKey: publicKey,
    localIPs: getLocalIPs(),
    paired: pairedDevice,
    tunnelUrl: tunnelUrl
  });
}

// ─── Ngrok Tunnel (Global Access) ──────────────────────
function startTunnel() {
  try {
    addLog('🌐 Starting Ngrok tunnel...');
    var { spawn } = require('child_process');
    tunnelInstance = spawn('ngrok', ['http', String(httpPort), '--log', 'stdout', '--log-level', 'info'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    tunnelInstance.stdout.on('data', function (data) {
      var line = data.toString();
      var match = line.match(/url=(https:\/\/[a-z0-9\-]+\.ngrok[a-z\-]*\.[a-z]+)/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[1];
        addLog('🌍 Global URL: ' + tunnelUrl);
        if (mainWindow) mainWindow.webContents.send('tunnel-url', tunnelUrl);
        updateUI();
      }
    });

    tunnelInstance.on('exit', function (code) {
      addLog('⚠️ Tunnel stopped (code: ' + code + '), reconnecting in 5s...');
      tunnelUrl = '';
      tunnelInstance = null;
      updateUI();
      setTimeout(startTunnel, 5000);
    });

    tunnelInstance.on('error', function (err) {
      addLog('❌ Tunnel error: ' + err.message);
    });
  } catch (e) {
    addLog('❌ Tunnel failed: ' + e.message + ' — retrying in 5s...');
    setTimeout(startTunnel, 5000);
  }
}

// ─── IPC Handlers ──────────────────────────────────────
ipcMain.handle('get-server-info', function () {
  return {
    running: useBackgroundApi || !!serverProcess, port: PORT, token: adminToken,
    publicKey: publicKey, localIPs: getLocalIPs(), paired: pairedDevice,
    tunnelUrl: tunnelUrl
  };
});

ipcMain.handle('create-key', function (e, data) {
  if (useBackgroundApi) {
    makeAdminRequest('POST', '/create-key', { customerName: data.name, phone: data.phone }, function(err, res) {
      if (!err && res && res.license) {
        if (mainWindow) mainWindow.webContents.send('key-created', res.license);
      } else if (err) {
        addLog('❌ Create Key API Failed: ' + err.message);
      }
    });
  } else if (serverProcess) {
    serverProcess.send({ action: 'create-key', customerName: data.name, phone: data.phone });
  }
});

ipcMain.handle('delete-key', function (e, key) {
  if (useBackgroundApi) {
    makeAdminRequest('POST', '/delete-key', { key: key }, function(err, res) {
      if (!err && mainWindow) mainWindow.webContents.send('key-deleted', key);
    });
  } else if (serverProcess) {
    serverProcess.send({ action: 'delete-key', key: key });
  }
});

ipcMain.handle('activate-key', function (e, key) {
  if (useBackgroundApi) {
    makeAdminRequest('POST', '/activate', { key: key }, function(err, res) {
      setTimeout(refreshStateBackground, 200);
    });
  } else if (serverProcess) {
    serverProcess.send({ action: 'activate-key', key: key });
  }
});

ipcMain.handle('revoke-key', function (e, key) {
  if (useBackgroundApi) {
    makeAdminRequest('POST', '/revoke', { key: key }, function(err, res) {
      setTimeout(refreshStateBackground, 200);
    });
  } else if (serverProcess) {
    serverProcess.send({ action: 'revoke-key', key: key });
  }
});

ipcMain.handle('reactivate-key', function (e, key) {
  if (useBackgroundApi) {
    makeAdminRequest('POST', '/reactivate', { key: key }, function(err, res) {
      setTimeout(refreshStateBackground, 200);
    });
  } else if (serverProcess) {
    serverProcess.send({ action: 'reactivate-key', key: key });
  }
});

ipcMain.handle('pair-device', function (e, data) {
  if (useBackgroundApi) {
    makeAdminRequest('POST', '/pair-device', { fingerprint: data.fingerprint, deviceName: data.name }, function(err, res) {
      if (!err && res && res.device) {
        pairedDevice = res.device;
        if (mainWindow) mainWindow.webContents.send('device-paired', res.device);
      }
    });
  } else if (serverProcess) {
    serverProcess.send({ action: 'pair-device', fingerprint: data.fingerprint, name: data.name });
  }
});

ipcMain.handle('unpair-device', function () {
  if (useBackgroundApi) {
    makeAdminRequest('POST', '/unpair-device', null, function(err, res) {
      pairedDevice = null;
      if (mainWindow) mainWindow.webContents.send('device-unpaired');
    });
  } else if (serverProcess) {
    serverProcess.send({ action: 'unpair-device' });
  }
});

ipcMain.handle('refresh-state', function () {
  if (useBackgroundApi) {
    refreshStateBackground();
  } else if (serverProcess) {
    serverProcess.send({ action: 'get-state' });
  }
});

ipcMain.handle('copy-text', function (e, text) {
  clipboard.writeText(text);
});

ipcMain.handle('export-data', async function () {
  if (useBackgroundApi) {
    return new Promise((resolve) => {
      makeAdminRequest('GET', '/clients', null, async function(err, res) {
        if (err || !res || !res.clients) return resolve({ error: err ? err.message : 'Failed to fetch state' });
        
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Export Clients Data',
          defaultPath: 'haleem_clients_export.json',
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        
        if (canceled || !filePath) return resolve({ canceled: true });
        
        try {
          fs.writeFileSync(filePath, JSON.stringify(res.clients, null, 2), 'utf8');
          resolve({ success: true, path: filePath });
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
  } else if (serverProcess) {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Clients Data',
      defaultPath: 'haleem_clients_export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    
    if (canceled || !filePath) return { canceled: true };
    
    return new Promise((resolve) => {
      serverProcess.send({ action: 'get-state' });
      const listener = (msg) => {
        if (msg && msg.type === 'state') {
          serverProcess.removeListener('message', listener);
          try {
            fs.writeFileSync(filePath, JSON.stringify(msg.licenses, null, 2), 'utf8');
            resolve({ success: true, path: filePath });
          } catch (e) {
            resolve({ error: e.message });
          }
        }
      };
      serverProcess.on('message', listener);
    });
  }
  return { error: 'Server not running' };
});

function getPublicIP(cb) {
  try {
    var https = require('https');
    https.get('https://api.ipify.org', function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { cb(data.trim()); });
    }).on('error', function() { cb('unknown'); });
  } catch(e) { cb('unknown'); }
}

ipcMain.handle('get-public-ip', function () {
  return new Promise(function (resolve) { getPublicIP(resolve); });
});

// ─── Window ────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0a0a0f',
    title: 'HALEEM Activation Server',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  mainWindow.on('closed', function () { mainWindow = null; });
  mainWindow.webContents.on('did-finish-load', function () {
    updateUI();
    serverLogs.forEach(function (l) { mainWindow.webContents.send('log', l); });
    if (useBackgroundApi) {
      refreshStateBackground();
    } else if (serverProcess) {
      serverProcess.send({ action: 'get-state' });
    }
  });
}

// ─── App Lifecycle ─────────────────────────────────────
app.whenReady().then(function () {
  initializeServer();
  createWindow();
});

app.on('window-all-closed', function () {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', function () {
  if (serverProcess) serverProcess.kill();
});
