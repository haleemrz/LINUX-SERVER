/**
 * HALEEM Desktop Admin Panel
 * Communicates with server via Electron IPC. No HTTP calls needed.
 */
var UI = (function () {
  'use strict';

  var _licenses = [];
  var _token = '';
  var _toastTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[<>"'&]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  // ─── Toast ────────────────────────────────────────
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(function () { el.classList.add('show'); }, 10);
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.classList.add('hidden'); }, 300);
    }, 2500);
  }

  // ─── Tabs ─────────────────────────────────────────
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.remove('active'); });
    $('tab-' + name).classList.add('active');
    var tabs = ['dashboard', 'licenses', 'create', 'network', 'logs', 'affiliate', 'whatsapp'];
    var idx = tabs.indexOf(name);
    var btns = document.querySelectorAll('.nav-btn');
    if (btns[idx]) btns[idx].classList.add('active');
    if (name === 'licenses') refresh();
    if (name === 'affiliate') loadAffiliates();
    if (name === 'whatsapp') { waRefreshStatus(); waLoadKB(); }
  }

  // ─── Format ───────────────────────────────────────
  function formatDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // ─── Server Info ──────────────────────────────────
  function updateServerInfo(info) {
    var pill = $('status-pill');
    if (info.running) {
      pill.className = 'status-pill online';
      pill.textContent = '🟢 RUNNING';
    } else {
      pill.className = 'status-pill offline';
      pill.textContent = '🔴 STOPPED';
    }

    _token = info.token || '';
    $('v-token').textContent = _token;
    $('v-port').textContent = info.port;

    // LAN IPs
    if (info.localIPs && info.localIPs.length > 0) {
      $('v-lan').innerHTML = info.localIPs.map(function (ip) {
        return 'https://' + ip + ':' + info.port;
      }).join('<br>');
      $('pf-ip').textContent = info.localIPs[0];
      $('pf-port').textContent = info.port;
    }

    // Public IP
    if (info.publicIP) {
      $('v-wan').textContent = info.publicIP + ':' + info.port;
      $('pf-url').textContent = 'https://' + info.publicIP + ':' + info.port;
    } else {
      $('v-wan').textContent = 'Not detected';
      $('pf-url').textContent = 'https://YOUR_PUBLIC_IP:' + info.port;
    }

    // Tunnel URL
    if (info.tunnelUrl) {
      $('v-tunnel').textContent = info.tunnelUrl;
      $('v-tunnel').style.color = '#00e676';
    } else {
      $('v-tunnel').textContent = 'Connecting...';
      $('v-tunnel').style.color = '#ff6b35';
    }

    // Paired device
    if (info.paired) {
      $('paired-info').textContent = info.paired.name;
      $('pair-status').textContent = '✅ ' + info.paired.name + ' (paired ' + formatDate(info.paired.pairedAt) + ')';
      $('unpair-btn').style.display = 'inline-block';
    } else {
      $('paired-info').textContent = 'None';
      $('pair-status').textContent = 'No device paired. Connect from Android app to pair.';
      $('unpair-btn').style.display = 'none';
    }
  }

  // ─── State Update (licenses) ──────────────────────
  function updateState(state) {
    _licenses = state.licenses || [];
    _token = state.token || _token;

    // Stats
    var stats = { total: 0, unused: 0, pending: 0, activated: 0, revoked: 0 };
    _licenses.forEach(function (l) { stats.total++; stats[l.status] = (stats[l.status] || 0) + 1; });
    $('s-total').textContent = stats.total;
    $('s-activated').textContent = stats.activated;
    $('s-pending').textContent = stats.pending;
    $('s-revoked').textContent = stats.revoked;

    renderList();
  }

  // ─── Render Licenses ──────────────────────────────
  function renderList() {
    var container = $('license-list');
    var filtered = getFiltered();
    if (!filtered.length) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">No licenses found</div>';
      return;
    }
    filtered.sort(function (a, b) {
      var order = { pending: 0, unused: 1, activated: 2, revoked: 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
    var html = '';
    filtered.forEach(function (l) {
      html += '<div class="lic-card status-' + l.status + '">';
      html += '<div class="lic-header">';
      html += '<span class="lic-name">' + esc(l.customer_name || 'Unnamed') + '</span>';
      html += '<span class="lic-badge badge-' + l.status + '">' + l.status + '</span>';
      html += '</div>';
      html += '<div class="lic-key">🔑 ' + l.key + '</div>';
      if (l.phone) html += '<div class="lic-info">📞 ' + esc(l.phone) + '</div>';
      if (l.device_id) html += '<div class="lic-info">🖥️ ' + l.device_id.substring(0, 20) + '...</div>';
      html += '<div class="lic-info">📅 ' + formatDate(l.created_at) + '</div>';
      html += '<div class="lic-actions">';
      if (l.status === 'pending' || l.status === 'unused') {
        html += '<button class="btn btn-green btn-sm" onclick="UI.activateKey(\'' + l.key + '\')">✅ Activate</button>';
      }
      if (l.status === 'activated' || l.status === 'pending') {
        html += '<button class="btn btn-danger btn-sm" onclick="UI.revokeKey(\'' + l.key + '\')">🔴 Revoke</button>';
      }
      if (l.status === 'revoked') {
        html += '<button class="btn btn-green btn-sm" onclick="UI.reactivateKey(\'' + l.key + '\')">🔄 Reactivate</button>';
      }
      html += '<button class="btn btn-dark btn-sm" onclick="UI.copyText(\'' + l.key + '\')">📋</button>';
      html += '<button class="btn btn-dark btn-sm" onclick="UI.deleteKey(\'' + l.key + '\',\'' + esc(l.customer_name) + '\')">🗑️</button>';
      html += '</div></div>';
    });
    container.innerHTML = html;
  }

  function getFiltered() {
    var search = ($('search-input').value || '').toLowerCase();
    var status = $('filter-status').value;
    return _licenses.filter(function (l) {
      if (status && l.status !== status) return false;
      if (!search) return true;
      return (l.customer_name || '').toLowerCase().indexOf(search) >= 0 ||
        (l.phone || '').indexOf(search) >= 0 ||
        (l.key || '').toLowerCase().indexOf(search) >= 0;
    });
  }

  function filterList() { renderList(); }

  // ─── Actions (via IPC to server) ──────────────────
  function activateKey(key) {
    Haleem.activateKey(key);
    toast('✅ Activating...');
    setTimeout(refresh, 500);
  }

  function revokeKey(key) {
    if (!confirm('Revoke license for ' + key + '?')) return;
    Haleem.revokeKey(key);
    toast('🔴 Revoking...');
    setTimeout(refresh, 500);
  }

  function reactivateKey(key) {
    if (!confirm('Reactivate license for ' + key + '?')) return;
    Haleem.reactivateKey(key);
    toast('🔄 Reactivated');
    setTimeout(refresh, 500);
  }

  function createKey() {
    var name = $('new-name').value.trim();
    var phone = $('new-phone').value.trim();
    if (!name) { toast('Enter customer name'); return; }
    Haleem.createKey(name, phone);
  }

  function deleteKey(key, name) {
    if (!confirm('Delete ' + (name || key) + ' permanently?')) return;
    Haleem.deleteKey(key);
  }

  function copyToken() { Haleem.copyText(_token); toast('📋 Token copied!'); }
  function copyText(text) { Haleem.copyText(text); toast('📋 Copied!'); }
  function copyTunnel() { var url = $('v-tunnel').textContent; if (url && url !== 'Connecting...') { Haleem.copyText(url); toast('🌍 Global URL copied!'); } }

  function unpairDevice() {
    if (!confirm('Unpair the current device?')) return;
    Haleem.unpairDevice();
    toast('📱 Device unpaired');
  }

  async function exportData() {
    const res = await Haleem.exportData();
    if (res && res.success) {
      toast('💾 Exported successfully!');
    } else if (res && res.error) {
      alert('Export failed: ' + res.error);
    }
  }

  function refresh() { Haleem.refreshState(); }

  // ─── HMAC-SHA256 (browser) ────────────────────────
  function hmacSHA256(message, key) {
    // Use SubtleCrypto is async, so use a sync fallback
    // Simple HMAC implementation for browser
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

  function bytesToHex(bytes) {
    return bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
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
    for (var i = 56; i >= 0; i -= 8) msg.push((l >>> i) & 0xff);
    // Only handle messages < 2^32 bits
    msg.push(0); msg.push(0); msg.push(0); msg.push(0);
    // Fix: re-pad correctly
    msg = msgBytes.slice();
    l = msg.length * 8;
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

  // ─── Log ──────────────────────────────────────────
  function appendLog(entry) {
    var el = $('log-console');
    if (!el) return;
    var div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = '<span class="time">' + esc(entry.time) + '</span> ' + esc(entry.msg);
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // ─── Init ─────────────────────────────────────────
  if (window.Haleem) {
    Haleem.onServerInfo(updateServerInfo);
    Haleem.onStateUpdate(updateState);
    Haleem.onLog(appendLog);
    Haleem.onKeyCreated(function (lic) {
      toast('🔑 Key created: ' + lic.key);
      $('create-result').textContent = lic.key;
      $('create-result').classList.remove('hidden');
      $('new-name').value = '';
      $('new-phone').value = '';
      refresh();
    });
    Haleem.onKeyDeleted(function () { toast('🗑️ Deleted'); refresh(); });
    Haleem.onDevicePaired(function (d) { toast('📱 Paired: ' + d.name); });
    Haleem.onDeviceUnpaired(function () { toast('📱 Unpaired'); });

    // Affiliate data listener
    Haleem.onAffiliateUpdate(function (data) {
      _affiliateData = data;
      renderAffiliates();
    });

    // Initial load
    Haleem.getServerInfo().then(updateServerInfo);
    setTimeout(refresh, 1000);
    setInterval(refresh, 8000);
  }

  // ─── Affiliate ────────────────────────────────────
  var _affiliateData = { affiliates: [], referrals: [] };

  function loadAffiliates() {
    if (window.Haleem && Haleem.getAffiliates) {
      Haleem.getAffiliates().then(function (data) {
        if (data) { _affiliateData = data; renderAffiliates(); }
      });
    }
  }

  function renderAffiliates() {
    var affiliates = _affiliateData.affiliates || [];
    var referrals = _affiliateData.referrals || [];

    // Stats
    var totalPending = 0, totalPaid = 0, totalRefs = 0;
    affiliates.forEach(function (a) {
      totalRefs += (a.total_referrals || 0);
      totalPending += (a.pending_balance || 0);
      totalPaid += (a.paid_balance || 0);
    });
    if ($('aff-total')) $('aff-total').textContent = affiliates.length;
    if ($('aff-referrals')) $('aff-referrals').textContent = referrals.length;
    if ($('aff-pending')) $('aff-pending').textContent = totalPending.toFixed(0) + ' EGP';
    if ($('aff-paid')) $('aff-paid').textContent = totalPaid.toFixed(0) + ' EGP';

    // Affiliates list
    var container = $('affiliate-list');
    if (!container) return;
    if (!affiliates.length) {
      container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text3)">No affiliates yet. Affiliates are created automatically when a key is activated.</div>';
    } else {
      var html = '';
      affiliates.forEach(function (a) {
        var statusClass = a.status === 'enabled' ? 'status-activated' : 'status-revoked';
        var badgeClass = a.status === 'enabled' ? 'badge-activated' : 'badge-revoked';
        html += '<div class="lic-card ' + statusClass + '">';
        html += '<div class="lic-header">';
        html += '<span class="lic-name">' + esc(a.customer_name || a.user_key) + '</span>';
        html += '<span class="lic-badge ' + badgeClass + '">' + a.status + '</span>';
        html += '</div>';
        html += '<div class="lic-key">🔗 ' + a.affiliate_code + ' | Commission: 250 EGP/referral</div>';
        html += '<div class="lic-info">📊 Referrals: ' + (a.total_referrals || 0) + ' | Pending: ' + (a.pending_balance || 0).toFixed(0) + ' EGP | Paid: ' + (a.paid_balance || 0).toFixed(0) + ' EGP</div>';
        html += '<div class="lic-info">📅 ' + formatDate(a.created_at) + '</div>';
        html += '<div class="lic-info">🔗 https://haleem.app/ref/' + a.affiliate_code + '</div>';
        html += '<div class="lic-actions">';
        if (a.status === 'enabled') {
          html += '<button class="btn btn-danger btn-sm" onclick="UI.disableAffiliate(\'' + a.user_key + '\')">🔴 Disable</button>';
        } else {
          html += '<button class="btn btn-green btn-sm" onclick="UI.enableAffiliateKey(\'' + a.user_key + '\')">✅ Enable</button>';
        }
        if ((a.pending_balance || 0) > 0) {
          html += '<button class="btn btn-gold btn-sm" onclick="UI.payAllAffiliate(\'' + a.user_key + '\')">💰 Pay All ($' + (a.pending_balance || 0).toFixed(0) + ')</button>';
        }
        html += '<button class="btn btn-dark btn-sm" onclick="UI.copyText(\'' + a.affiliate_code + '\')">📋 Code</button>';
        html += '</div></div>';
      });
      container.innerHTML = html;
    }

    // Referrals list
    var refContainer = $('referral-list');
    if (!refContainer) return;
    // Flatten all referrals from affiliate data if not already flat
    var allRefs = referrals.length ? referrals : [];
    if (!allRefs.length) {
      refContainer.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text3)">No referrals recorded yet.</div>';
    } else {
      var rhtml = '';
      allRefs.forEach(function (r) {
        var statusColor = r.status === 'paid' ? 'badge-activated' : (r.status === 'approved' ? 'badge-activated' : 'badge-pending');
        var affOwner = affiliates.find(function(a) { return a.user_key === r.affiliate_user_key; });
        rhtml += '<div class="lic-card">';
        rhtml += '<div class="lic-header">';
        rhtml += '<span class="lic-name">' + esc(r.referred_customer || r.referred_key || 'Unknown') + '</span>';
        rhtml += '<span class="lic-badge ' + statusColor + '">' + r.status + '</span>';
        rhtml += '</div>';
        rhtml += '<div class="lic-key">🔑 Affiliate: ' + esc(affOwner ? (affOwner.customer_name || affOwner.user_key) : r.affiliate_user_key) + '</div>';
        if (r.order_id) rhtml += '<div class="lic-info">🧾 Order: ' + esc(r.order_id) + '</div>';
        rhtml += '<div class="lic-info">💰 Commission: ' + (r.commission || 250) + ' EGP | 📅 ' + formatDate(r.created_at) + '</div>';
        rhtml += '<div class="lic-actions">';
        if (r.status !== 'paid') {
          rhtml += '<button class="btn btn-green btn-sm" onclick="UI.markReferralPaid(\'' + r.id + '\')">💵 Mark Paid</button>';
        }
        rhtml += '</div></div>';
      });
      refContainer.innerHTML = rhtml;
    }
  }

  function enableAffiliate() {
    var key = ($('aff-enable-key').value || '').trim();
    var pct = parseInt($('aff-enable-pct').value) || 25;
    if (!key) { toast('Enter a license key'); return; }
    Haleem.enableAffiliate(key, pct);
    toast('✅ Enabling affiliate...');
    $('aff-enable-key').value = '';
    setTimeout(loadAffiliates, 500);
  }

  function enableAffiliateKey(key) {
    Haleem.enableAffiliate(key, 25);
    toast('✅ Re-enabling...');
    setTimeout(loadAffiliates, 500);
  }

  function disableAffiliate(key) {
    if (!confirm('Disable affiliate for ' + key + '?')) return;
    Haleem.disableAffiliate(key);
    toast('🔴 Disabling...');
    setTimeout(loadAffiliates, 500);
  }

  function markReferralPaid(id) {
    if (!confirm('Mark this referral as paid?')) return;
    Haleem.markReferralPaid(id);
    toast('💵 Marking as paid...');
    setTimeout(loadAffiliates, 500);
  }



  function payAllAffiliate(key) {
    if (!confirm('Pay ALL pending referrals for this affiliate and reset counter?')) return;
    Haleem.payAllAffiliate(key);
    toast('💰 Paying all pending...');
    setTimeout(loadAffiliates, 500);
  }

  // ─── WhatsApp Bot ────────────────────────────────
  var _waQrTimer = null;

  function waRefreshStatus() {
    if (window.Haleem && Haleem.waStatus) {
      Haleem.waStatus().then(function(data) {
        if (!data) return;
        var el = $('wa-status');
        if (el) {
          var s = data.status || 'unknown';
          el.textContent = s === 'connected' ? '🟢 Connected' : s === 'connecting' ? '🟡 Connecting' : '🔴 Disconnected';
        }
        var qrC = $('wa-qr-container');
        if (qrC) {
          if (data.qr) {
            qrC.innerHTML = '<img src="' + data.qr + '" style="max-width:260px;border-radius:8px">';
          } else if (data.status === 'ready' || data.status === 'connected') {
            qrC.innerHTML = '<div style="color:#2ecc71;font-size:14px;padding:20px;font-weight:600">✅ متصل بالواتساب وجاهز للعمل</div>';
          } else {
            qrC.innerHTML = '<div style="color:var(--text3);font-size:12px">اضغط Connect ثم امسح الكود</div>';
          }
        }
        // Logs
        if (data.logs && data.logs.length) {
          var logsEl = $('wa-logs');
          if (logsEl) {
            var lhtml = '';
            data.logs.slice(-50).forEach(function(l) {
              lhtml += '<div style="padding:3px 6px;border-bottom:1px solid rgba(255,255,255,0.05)">' + esc(l.time + ' — ' + l.msg) + '</div>';
            });
            logsEl.innerHTML = lhtml;
            logsEl.scrollTop = logsEl.scrollHeight;
          }
        }
      });
    }
  }

  function waConnect() {
    toast('▶️ Starting WhatsApp...');
    if (window.Haleem && Haleem.waStart) {
      Haleem.waStart().then(function() {
        toast('✅ WhatsApp connecting...');
        // Start QR polling
        if (_waQrTimer) clearInterval(_waQrTimer);
        _waQrTimer = setInterval(waRefreshStatus, 3000);
        setTimeout(waRefreshStatus, 1000);
      });
    }
  }

  function waDisconnect() {
    if (!confirm('Disconnect WhatsApp Bot?')) return;
    if (window.Haleem && Haleem.waStop) {
      Haleem.waStop().then(function() {
        toast('⏹️ WhatsApp disconnected');
        if (_waQrTimer) { clearInterval(_waQrTimer); _waQrTimer = null; }
        waRefreshStatus();
      });
    }
  }

  function waSaveKB() {
    var kb = $('wa-kb');
    if (!kb) return;
    var text = kb.value.trim();
    if (window.Haleem && Haleem.waSaveKB) {
      Haleem.waSaveKB(text).then(function() {
        toast('💾 KB saved!');
      });
    }
  }

  function waLoadKB() {
    if (window.Haleem && Haleem.waGetKB) {
      Haleem.waGetKB().then(function(data) {
        if (!data || data.error) return;
        var kb = $('wa-kb');
        if (kb) {
          // Format KB data as readable JSON
          kb.value = JSON.stringify(data, null, 2);
        }
      });
    }
  }

  function waReset() {
    if (!confirm('⚠️ تنبيه: سيقوم هذا الإجراء بفصل جلسة واتساب الحالية ومسح كاش الاتصال. سيتعين عليك مسح الرمز الجديد (QR Code) لتشغيل البوت.\n\nهل تريد الاستمرار؟')) return;
    toast('⏳ جاري إعادة تهيئة الجلسة...');
    if (window.Haleem && Haleem.waReset) {
      Haleem.waReset().then(function() {
        toast('✅ تم مسح الجلسة بنجاح! امسح الرمز الجديد.');
        if (_waQrTimer) clearInterval(_waQrTimer);
        _waQrTimer = setInterval(waRefreshStatus, 3000);
        setTimeout(waRefreshStatus, 1500);
      });
    }
  }

  return {
    switchTab: switchTab, filterList: filterList, refresh: refresh,
    activateKey: activateKey,
    revokeKey: revokeKey,
    reactivateKey: reactivateKey,
    createKey: createKey,
    deleteKey: deleteKey,
    unpairDevice: unpairDevice, copyText: copyText, copyToken: copyToken,
    copyTunnel: copyTunnel, exportData: exportData,
    // Affiliate
    enableAffiliateKey: enableAffiliateKey,
    disableAffiliate: disableAffiliate,
    markReferralPaid: markReferralPaid,
    payAllAffiliate: payAllAffiliate,
    loadAffiliates: loadAffiliates,
    // WhatsApp
    waConnect: waConnect,
    waDisconnect: waDisconnect,
    waRefreshStatus: waRefreshStatus,
    waSaveKB: waSaveKB,
    waReset: waReset,
    waLoadKB: waLoadKB
  };
})();
