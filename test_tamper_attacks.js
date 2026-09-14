/**
 * Anti-Tamper & Security Penetration Test Suite for HALEEM XPay Integration
 */
'use strict';

var assert = require('assert');
var crypto = require('crypto');
var path = require('path');
var os = require('os');
var fs = require('fs');
var PaymentService = require('./server/payment-service');

var testDir = path.join(os.tmpdir(), 'haleem_tamper_test_' + Date.now());
fs.mkdirSync(path.join(testDir, 'data'), { recursive: true });

var storageKey = crypto.randomBytes(32);
var testWebhookSecret = 'whsec_tamper_proof_secret_9999';
process.env.XPAY_SECRET_KEY = 'sk_test_tamper_key';
process.env.XPAY_WEBHOOK_SECRET = testWebhookSecret;

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

var mockLicenses = [
  { key: 'AAAA-1111-2222-3333', customer_name: 'Legit User', phone: '+201000000001', status: 'activated' }
];

var mockAffiliateData = {
  affiliates: [
    { user_key: 'AAAA-1111-2222-3333', affiliate_code: 'VALID-AFF', commission_pct: 25, status: 'enabled' }
  ],
  referrals: []
};

var createdLicensesCount = 0;
function mockCreateLicenseKey(name, phone) {
  createdLicensesCount++;
  var lic = { key: 'GEN-' + createdLicensesCount, customer_name: name, phone: phone, status: 'unused' };
  mockLicenses.push(lic);
  return lic;
}

var https = require('https');
var origHttpsRequest = https.request;
https.request = function (options, callback) {
  var emitter = new (require('events').EventEmitter)();
  emitter.write = function () {};
  emitter.end = function () {
    var res = new (require('events').EventEmitter)();
    res.statusCode = 200;
    setTimeout(function () {
      callback(res);
      res.emit('data', JSON.stringify({
        id: 'cs_test_mock_session_999',
        url: 'https://checkout.xpay.app/c/cs_test_mock_session_999',
        amountTotal: 100000
      }));
      res.emit('end');
    }, 10);
  };
  return emitter;
};

var paymentService = new PaymentService({
  dataDir: testDir,
  storageKey: storageKey,
  encryptFn: encrypt,
  decryptFn: decrypt,
  createLicenseKeyFn: mockCreateLicenseKey,
  affiliateDataRef: function () { return mockAffiliateData; },
  licensesRef: function () { return mockLicenses; },
  saveAffiliatesFn: function () {}
});

console.log('--- Starting Attack & Penetration Test Suite (PHASE 40) ---');

// Attack 1: Client tries to inject custom amount: amount=1, amount=0, amount=-100
console.log('[Attack 1] Client attempts to force custom amount (1, 0, -100)...');
paymentService.createPaymentSession({
  product: 'HALEEM-B-FACE',
  currency: 'EGP',
  amount: 1,
  unitAmount: 0,
  price: -100
}, function (err, res) {
  // Even if client passes custom amounts, server uses its internal constant (100000 piastres)
  // Let's inspect the created order in _orders
  var order = paymentService._orders[0];
  assert.strictEqual(order.unit_amount, 100000, 'Server MUST ignore client amount and enforce 100000');
  console.log('✅ Attack 1 Blocked: Server ignored custom amount and enforced official pricing.');
});

// Attack 2: Client tries invalid currency (e.g. BTC, EUR, USD with invalid format)
console.log('[Attack 2] Client attempts unsupported currency (EUR, BITCOIN)...');
paymentService.createPaymentSession({
  product: 'HALEEM-B-FACE',
  currency: 'BITCOIN'
}, function (err, res) {
  assert.ok(err, 'Invalid currency must be rejected with an error');
  console.log('✅ Attack 2 Blocked: Invalid currency rejected:', err.message);
});

// Attack 3: Client tries invalid product (other-product)
console.log('[Attack 3] Client attempts fake product (other-product)...');
paymentService.createPaymentSession({
  product: 'FAKE-PREMIUM-PRODUCT',
  currency: 'USD'
}, function (err, res) {
  assert.ok(err, 'Fake product must be rejected');
  console.log('✅ Attack 3 Blocked: Fake product rejected:', err.message);
});

// Attack 4: Client passes discount=999999
console.log('[Attack 4] Client attempts custom discount (discount=999999)...');
paymentService.createPaymentSession({
  product: 'HALEEM-B-FACE',
  currency: 'EGP',
  discount: 999999,
  pricingType: 'affiliate'
}, function (err, res) {
  var order = paymentService._orders[paymentService._orders.length - 1];
  assert.strictEqual(order.pricing_type, 'normal', 'Without valid affiliateCode, pricingType must stay normal');
  assert.strictEqual(order.unit_amount, 100000, 'Unit amount must remain full normal price');
  console.log('✅ Attack 4 Blocked: Custom discount ignored.');
});

// Attack 5: Client passes non-existent affiliateCode
console.log('[Attack 5] Client attempts non-existent affiliateCode...');
paymentService.createPaymentSession({
  product: 'HALEEM-B-FACE',
  currency: 'EGP',
  affiliateCode: 'HACKER-CODE-999'
}, function (err, res) {
  assert.ok(err, 'Non-existent affiliateCode must fail');
  assert.strictEqual(err.message, 'كود الإحالة غير صالح أو غير نشط.');
  console.log('✅ Attack 5 Blocked: Non-existent code rejected with proper message.');
});

// Attack 6: Forged Webhook with forged orderId or missing signature
console.log('[Attack 6] Attacker sends forged Webhook without signature...');
assert.throws(function () {
  paymentService.processWebhookEvent('{"id":"evt_hack"}', '');
}, /Missing XPay-Signature/);
console.log('✅ Attack 6 Blocked: Forged webhook without signature rejected.');

// Attack 7: Attacker sends Webhook with unpaid status (paymentStatus: 'unpaid')
console.log('[Attack 7] Attacker sends Webhook with paymentStatus="unpaid"...');
var fakeEvt = JSON.stringify({
  id: 'evt_unpaid_123',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_unpaid', paymentStatus: 'unpaid' } }
});
var nowSec = Math.floor(Date.now() / 1000);
var sig = crypto.createHmac('sha256', testWebhookSecret).update(nowSec + '.' + fakeEvt).digest('hex');
var header = 't=' + nowSec + ',v1=' + sig;
var unpaidRes = paymentService.processWebhookEvent(fakeEvt, header);
assert.strictEqual(unpaidRes.pendingPayment, true, 'Unpaid payment must NOT trigger fulfillment');
assert.strictEqual(createdLicensesCount, 0, 'No license created for unpaid payment');
console.log('✅ Attack 7 Blocked: Unpaid webhook ignored, no license granted.');

setTimeout(function () {
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n🔒 ALL PENETRATION & TAMPER TESTS PASSED! ZERO VULNERABILITIES DETECTED.');
}, 50);
