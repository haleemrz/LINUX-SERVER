#!/usr/bin/env node
/**
 * HALEEM Activation Server — XPay Webhook Management Tool
 * Manage webhook endpoints (list, register, delete) directly with XPay API.
 *
 * Usage:
 *   node manage_webhook.js list
 *   node manage_webhook.js register https://<your-domain-or-ngrok>/api/payments/webhook
 *   node manage_webhook.js delete <webhook-endpoint-id>
 */
'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');

function getSecretKey() {
  if (process.env.XPAY_SECRET_KEY) {
    return process.env.XPAY_SECRET_KEY.trim();
  }
  var candidatePaths = [
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.haleem-server', 'server.env'),
    path.join(__dirname, '..', '.secrets'),
    path.join(__dirname, '..', 'server.env')
  ];
  for (var i = 0; i < candidatePaths.length; i++) {
    var p = candidatePaths[i];
    if (fs.existsSync(p)) {
      var content = fs.readFileSync(p, 'utf8');
      var m = content.match(/XPAY_SECRET_KEY=([^\r\n]+)/);
      if (m && m[1]) return m[1].trim();
    }
  }
  return null;
}

function requestXPay(endpoint, method, payload, callback) {
  var secretKey = getSecretKey();
  if (!secretKey) {
    console.error('❌ Error: XPAY_SECRET_KEY not found in environment or server.env');
    process.exit(1);
  }

  var options = {
    hostname: 'api.xpay.app',
    port: 443,
    path: endpoint,
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + secretKey,
      'Content-Type': 'application/json'
    }
  };

  var postData = payload ? JSON.stringify(payload) : null;
  if (postData) {
    options.headers['Content-Length'] = Buffer.byteLength(postData);
  }

  var req = https.request(options, function (res) {
    var data = '';
    res.on('data', function (chunk) { data += chunk; });
    res.on('end', function () {
      var parsed = null;
      if (data) {
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
      }
      callback(null, res.statusCode, parsed);
    });
  });

  req.on('error', function (err) {
    callback(err);
  });

  if (postData) {
    req.write(postData);
  }
  req.end();
}

var command = process.argv[2] || 'list';
var arg1 = process.argv[3];

if (command === 'list') {
  console.log('🔍 Fetching registered webhook endpoints from XPay...');
  requestXPay('/webhook-endpoints', 'GET', null, function (err, status, body) {
    if (err) {
      console.error('❌ Network error:', err.message);
      return;
    }
    if (status !== 200) {
      console.error('❌ XPay error (status ' + status + '):', body);
      return;
    }
    var list = (body && body.data) || [];
    console.log('📋 Registered webhooks count: ' + list.length);
    list.forEach(function (wh, idx) {
      console.log('--- [' + (idx + 1) + '] ---');
      console.log('  ID:      ' + wh.id);
      console.log('  URL:     ' + wh.url);
      console.log('  Status:  ' + wh.status);
      console.log('  Events:  ' + (wh.enabledEvents || []).join(', '));
      console.log('  Created: ' + wh.createdAt);
    });
  });
} else if (command === 'register') {
  if (!arg1) {
    console.error('❌ Usage: node manage_webhook.js register <https://your-domain.com/api/payments/webhook>');
    process.exit(1);
  }
  var webhookUrl = arg1.trim();
  if (webhookUrl.indexOf('http') !== 0) {
    console.error('❌ Webhook URL must start with http:// or https://');
    process.exit(1);
  }

  console.log('🚀 Registering webhook with XPay for URL: ' + webhookUrl + ' ...');
  var payload = {
    url: webhookUrl,
    enabledEvents: ['checkout.session.completed', 'checkout.session.async_payment_succeeded']
  };

  requestXPay('/webhook-endpoints', 'POST', payload, function (err, status, body) {
    if (err) {
      console.error('❌ Network error:', err.message);
      return;
    }
    if (status >= 200 && status < 300) {
      console.log('✅ Webhook endpoint registered successfully!');
      console.log('  ID:     ' + body.id);
      console.log('  URL:    ' + body.url);
      console.log('  Secret: ' + body.secret);
      console.log('\n👉 Add the following to your ~/.haleem-server/server.env on Linux:');
      console.log('XPAY_WEBHOOK_SECRET=' + body.secret);
      console.log('\nThen restart the server daemon:');
      console.log('sudo systemctl restart haleem-server\n');
    } else {
      console.error('❌ Failed to register webhook (status ' + status + '):', body);
    }
  });
} else if (command === 'delete') {
  if (!arg1) {
    console.error('❌ Usage: node manage_webhook.js delete <webhook-endpoint-id>');
    process.exit(1);
  }
  var endpointId = arg1.trim();
  console.log('🗑️ Deleting webhook endpoint: ' + endpointId + ' ...');
  requestXPay('/webhook-endpoints/' + endpointId, 'DELETE', null, function (err, status, body) {
    if (err) {
      console.error('❌ Network error:', err.message);
      return;
    }
    if (status === 204 || status === 200) {
      console.log('✅ Webhook endpoint deleted successfully!');
    } else {
      console.error('❌ Failed to delete webhook (status ' + status + '):', body);
    }
  });
} else {
  console.log('Unknown command. Available commands: list, register <url>, delete <id>');
}
