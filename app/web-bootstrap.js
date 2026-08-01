/**
 * HALEEM Browser Bootstrap & Fallback Layer
 * Allows index.html & app.js to work directly inside standard web browsers.
 * Replaces Electron IPC with signed HTTP Fetch calls.
 */

if (typeof window.Haleem === 'undefined') {
  window.Haleem = (function () {
    'use strict';

    var listeners = {
      'server-info': [],
      'log': [],
      'state-update': [],
      'key-created': [],
      'key-deleted': [],
      'device-paired': [],
      'device-unpaired': [],
      'tunnel-url': [],
      'affiliate-update': []
    };

    var seenLogs = new Set();
    var pollInterval = null;

    // Inject Glassmorphic Overlay for Admin Token Entry
    function injectStyles() {
      var style = document.createElement('style');
      style.textContent = `
        .token-overlay {
          position: fixed;
          top: 0; left: 0; width: 100vw; height: 100vh;
          background: rgba(10, 10, 15, 0.95);
          backdrop-filter: blur(8px);
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Inter', sans-serif;
        }
        .token-box {
          background: #1e1e2e;
          border: 1px solid #2a2a3e;
          border-radius: 12px;
          padding: 30px;
          width: 90%;
          max-width: 400px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.5);
          text-align: center;
        }
        .token-box h2 {
          color: #FFD700;
          margin-bottom: 8px;
          font-size: 20px;
          font-weight: 700;
        }
        .token-box p {
          color: #a0a0b0;
          font-size: 13px;
          margin-bottom: 20px;
          line-height: 1.5;
        }
        .token-box input {
          width: 100%;
          background: #12121a;
          border: 1px solid #2a2a3e;
          border-radius: 8px;
          color: #e0e0e0;
          padding: 12px;
          font-size: 14px;
          margin-bottom: 16px;
          text-align: center;
        }
        .token-box input:focus {
          outline: none;
          border-color: #FFD700;
        }
        .token-box button {
          width: 100%;
          padding: 12px;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          background: linear-gradient(135deg, #FFD700, #FFA500);
          color: #000;
          transition: transform 0.15s;
        }
        .token-box button:hover {
          transform: translateY(-1px);
          filter: brightness(1.1);
        }
      `;
      document.head.appendChild(style);
    }

    function showTokenOverlay() {
      if (document.getElementById('token-prompt-overlay')) return;
      
      var overlay = document.createElement('div');
      overlay.id = 'token-prompt-overlay';
      overlay.className = 'token-overlay';
      
      var box = document.createElement('div');
      box.className = 'token-box';
      
      var h2 = document.createElement('h2');
      h2.textContent = '🔒 HALEEM Admin Connection';
      
      var p = document.createElement('p');
      p.textContent = 'Please enter your Admin Token to access the dashboard. This token can be found in your server configuration file.';
      
      var input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'Enter Admin Token';
      input.id = 'admin-token-input';
      
      var button = document.createElement('button');
      button.textContent = 'Connect Dashboard';
      button.onclick = function () {
        var token = input.value.trim();
        if (token) {
          localStorage.setItem('haleem_admin_token', token);
          overlay.remove();
          // Trigger initial refresh
          Haleem.refreshState();
          startBackgroundPolling();
        } else {
          alert('Token cannot be empty!');
        }
      };

      input.onkeydown = function(e) {
        if (e.key === 'Enter') button.click();
      };
      
      box.appendChild(h2);
      box.appendChild(p);
      box.appendChild(input);
      box.appendChild(button);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }

    // ─── HMAC-SHA256 Javascript Browser Cryptography ───
    function hmacSHA256(message, key) {
      var blockSize = 64;
      var keyBytes = stringToBytes(key);
      if (keyBytes.length > blockSize) keyBytes = sha256Bytes(keyBytes);
      while (keyBytes.length < blockSize) keyBytes.push(0);
      var opad = keyBytes.map(function (b) { return b ^ 0x5c; });
      var ipad = keyBytes.map(function (b) { return b ^ 0x36; });
      var inner = sha256Bytes(ipad.concat(stringToBytes(message)));
      var hmacBytes = sha256Bytes(opad.concat(inner));
      return bytesToHex(hmacBytes);
    }

    function stringToBytes(str) {
      var bytes = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 128) bytes.push(c);
        else if (c < 2048) { bytes.push(192 | (c >> 6)); bytes.push(128 | (c & 63)); }
        else { bytes.push(224 | (c >> 12)); bytes.push(128 | ((c >> 6) & 63)); bytes.push(128 | (c & 63)); }
      }
      return bytes;
    }

    // SHA-256 (minimal pure JS implementation)
    function sha256Bytes(msgBytes) {
      var K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
      ];
      function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
      var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
      var msg = msgBytes.slice();
      var l = msg.length * 8;
      msg.push(0x80);
      while (msg.length % 64 !== 56) msg.push(0);
      msg.push(0); msg.push(0); msg.push(0); msg.push(0);
      msg.push((l >>> 24) & 0xff); msg.push((l >>> 16) & 0xff); msg.push((l >>> 8) & 0xff); msg.push(l & 0xff);

      for (var offset = 0; offset < msg.length; offset += 64) {
        var W = [];
        for (var t = 0; t < 16; t++) {
          W[t] = (msg[offset + t*4] << 24) | (msg[offset + t*4+1] << 16) | (msg[offset + t*4+2] << 8) | msg[offset + t*4+3];
        }
        for (var t = 16; t < 64; t++) {
          var s0 = rr(W[t-15],7) ^ rr(W[t-15],18) ^ (W[t-15] >>> 3);
          var s1 = rr(W[t-2],17) ^ rr(W[t-2],19) ^ (W[t-2] >>> 2);
          W[t] = (W[t-16] + s0 + W[t-7] + s1) | 0;
        }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (var t = 0; t < 64; t++) {
          var S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
          var ch = (e & f) ^ (~e & g);
          var temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
          var S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
          var maj = (a & b) ^ (a & c) ^ (b & c);
          var temp2 = (S0 + maj) | 0;
          h=g; g=f; f=e; e=(d+temp1)|0; d=c; c=b; b=a; a=(temp1+temp2)|0;
        }
        H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
        H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
      }
      var result = [];
      H.forEach(function (h) {
        result.push((h >>> 24) & 0xff); result.push((h >>> 16) & 0xff);
        result.push((h >>> 8) & 0xff); result.push(h & 0xff);
      });
      return result;
    }

    function bytesToHex(bytes) {
      return bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    // ─── Signed Web Request Core ───
    function makeFetchRequest(method, urlPath, bodyObj) {
      var token = localStorage.getItem('haleem_admin_token');
      if (!token) {
        showTokenOverlay();
        return Promise.reject(new Error('No token'));
      }

      var body = bodyObj ? JSON.stringify(bodyObj) : '';
      var ts = Date.now().toString();
      
      // Random 32-character hex string for nonce
      var nonce = '';
      var chars = '0123456789abcdef';
      for (var i = 0; i < 32; i++) {
        nonce += chars[Math.floor(Math.random() * chars.length)];
      }

      var message = method + ':' + urlPath + ':' + ts + ':' + nonce + ':' + body;
      var sig = hmacSHA256(message, token);

      var headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'x-timestamp': ts,
        'x-nonce': nonce,
        'x-signature': sig
      };

      return fetch(urlPath, {
        method: method,
        headers: headers,
        body: bodyObj ? body : undefined
      }).then(function (res) {
        if (res.status === 401) {
          localStorage.removeItem('haleem_admin_token');
          showTokenOverlay();
          throw new Error('Unauthorized');
        }
        if (!res.ok) {
          return res.json().then(function(errObj) {
            throw new Error(errObj.error || 'Request failed');
          });
        }
        return res.json();
      });
    }

    // Event trigger helper
    function trigger(event, data) {
      if (listeners[event]) {
        listeners[event].forEach(function (cb) {
          try { cb(data); } catch(e) { console.error('Listener callback error:', e); }
        });
      }
    }

    function startBackgroundPolling() {
      if (pollInterval) return;
      pollInterval = setInterval(function() {
        pollLogs();
      }, 5000);
      pollLogs();
    }

    function pollLogs() {
      makeFetchRequest('GET', '/logs').then(function (res) {
        if (res && res.logs) {
          res.logs.forEach(function (l) {
            var key = l.time + '||' + l.msg;
            if (!seenLogs.has(key)) {
              seenLogs.add(key);
              trigger('log', l);
            }
          });
        }
      }).catch(function(e) {
        console.warn('Logs poll fail:', e);
      });
    }

    // Initialize overlay and styling
    window.addEventListener('DOMContentLoaded', function () {
      injectStyles();
      var token = localStorage.getItem('haleem_admin_token');
      if (!token) {
        showTokenOverlay();
      } else {
        startBackgroundPolling();
      }
    });

    // Expose APIs
    return {
      getServerInfo: function () {
        return makeFetchRequest('GET', '/status').then(function (res) {
          return {
            running: res.status === 'running',
            port: 9847,
            httpPort: 9848,
            token: localStorage.getItem('haleem_admin_token') || '',
            publicKey: '',
            localIPs: [window.location.hostname],
            paired: res.paired,
            tunnelUrl: res.tunnelUrl
          };
        });
      },
      createKey: function (name, phone) {
        return makeFetchRequest('POST', '/create-key', { customerName: name, phone: phone }).then(function (res) {
          trigger('key-created', res.license);
          return res;
        });
      },
      deleteKey: function (key) {
        return makeFetchRequest('POST', '/delete-key', { key: key }).then(function (res) {
          trigger('key-deleted', key);
          return res;
        });
      },
      activateKey: function (key) {
        return makeFetchRequest('POST', '/activate', { key: key });
      },
      revokeKey: function (key) {
        return makeFetchRequest('POST', '/revoke', { key: key });
      },
      reactivateKey: function (key) {
        return makeFetchRequest('POST', '/reactivate', { key: key });
      },
      pairDevice: function (fingerprint, name) {
        return makeFetchRequest('POST', '/pair-device', { fingerprint: fingerprint, deviceName: name }).then(function (res) {
          trigger('device-paired', res.device);
          return res;
        });
      },
      unpairDevice: function () {
        return makeFetchRequest('POST', '/unpair-device', null).then(function (res) {
          trigger('device-unpaired');
          return res;
        });
      },
      refreshState: function () {
        Haleem.getServerInfo().then(function (info) {
          trigger('server-info', info);
        }).catch(function(){});

        makeFetchRequest('GET', '/clients').then(function (res) {
          trigger('state-update', {
            licenses: res.clients,
            token: localStorage.getItem('haleem_admin_token') || '',
            publicKey: '',
            paired: null
          });
        }).catch(function(){});

        Haleem.getAffiliates().then(function (data) {
          trigger('affiliate-update', data);
        }).catch(function(){});
      },
      copyText: function (text) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text);
        } else {
          var input = document.createElement('textarea');
          input.value = text;
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          document.body.removeChild(input);
        }
        return Promise.resolve();
      },
      exportData: function () {
        return makeFetchRequest('GET', '/clients').then(function (res) {
          if (!res || !res.clients) return { error: 'Failed to fetch clients' };
          var blob = new Blob([JSON.stringify(res.clients, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'haleem_clients_export.json';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          return { success: true };
        });
      },
      getPublicIP: function () {
        return makeFetchRequest('GET', '/status').then(function(res) {
          return res.publicIP || 'Unknown';
        });
      },
      onServerInfo: function (cb) { listeners['server-info'].push(cb); },
      onLog: function (cb) { listeners['log'].push(cb); },
      onStateUpdate: function (cb) { listeners['state-update'].push(cb); },
      onKeyCreated: function (cb) { listeners['key-created'].push(cb); },
      onKeyDeleted: function (cb) { listeners['key-deleted'].push(cb); },
      onDevicePaired: function (cb) { listeners['device-paired'].push(cb); },
      onDeviceUnpaired: function (cb) { listeners['device-unpaired'].push(cb); },
      onTunnelUrl: function (cb) { listeners['tunnel-url'].push(cb); },
      onAffiliateUpdate: function (cb) { listeners['affiliate-update'].push(cb); },

      // ─── Affiliate ───
      getAffiliates: function () {
        return makeFetchRequest('GET', '/api/affiliate/list').then(function (res) {
          return {
            affiliates: res.affiliates || [],
            referrals: res.referrals || []
          };
        });
      },
      enableAffiliate: function (key, pct) {
        return makeFetchRequest('POST', '/api/affiliate/enable', { key: key, commission_pct: pct }).then(function(res) {
          Haleem.getAffiliates().then(function (data) { trigger('affiliate-update', data); });
          return res;
        });
      },
      disableAffiliate: function (key) {
        return makeFetchRequest('POST', '/api/affiliate/disable', { key: key }).then(function(res) {
          Haleem.getAffiliates().then(function (data) { trigger('affiliate-update', data); });
          return res;
        });
      },
      markReferralPaid: function (id) {
        return makeFetchRequest('POST', '/api/affiliate/mark-paid', { id: id }).then(function(res) {
          Haleem.getAffiliates().then(function (data) { trigger('affiliate-update', data); });
          return res;
        });
      },
      registerReferral: function (data) {
        return makeFetchRequest('POST', '/api/affiliate/register-referral', data).then(function(res) {
          Haleem.getAffiliates().then(function (data) { trigger('affiliate-update', data); });
          return res;
        });
      },
      payAllAffiliate: function (key) {
        return makeFetchRequest('POST', '/api/affiliate/pay-all', { key: key }).then(function(res) {
          Haleem.getAffiliates().then(function (data) { trigger('affiliate-update', data); });
          return res;
        });
      },

      // ─── WhatsApp Bot ───
      waStatus: function () {
        return makeFetchRequest('GET', '/wa-status');
      },
      waStart: function () {
        return makeFetchRequest('POST', '/wa-start', {});
      },
      waStop: function () {
        return makeFetchRequest('POST', '/wa-stop', {});
      },
      waSaveKB: function (text) {
        return makeFetchRequest('POST', '/wa-save-kb', { kb: text });
      }
    };
  })();
}
