/**
 * HALEEM Activation Server — XPay Payment & Order Service
 * Server-authoritative checkout sessions, webhook verification,
 * encrypted orders storage, and affiliate referral management.
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var https = require('https');

// ════════════════════════════════════════════════════════
// PRICING CONFIGURATION (SERVER-SIDE SOURCE OF TRUTH)
// ════════════════════════════════════════════════════════
var PRODUCTS = {
  'HALEEM-B-FACE': {
    name: 'HALEEM-B-FACE Lifetime License',
    currencies: {
      USD: {
        normal: { unitAmount: 2500, vatRate: 1500, feePassThrough: true, displayAmount: 25 },
        affiliate: { unitAmount: 2000, vatRate: 1500, feePassThrough: true, displayAmount: 20, discount: 5 }
      },
      EGP: {
        normal: { unitAmount: 100000, vatRate: 0, feePassThrough: false, displayAmount: 1000 },
        affiliate: { unitAmount: 75000, vatRate: 0, feePassThrough: false, displayAmount: 750, discount: 250 }
      }
    }
  }
};
// Alias for HALEEM-ULTRA
PRODUCTS['HALEEM-ULTRA'] = PRODUCTS['HALEEM-B-FACE'];

function PaymentService(options) {
  this.dataDir = options.dataDir;
  this.storageKey = options.storageKey;
  this.encryptFn = options.encryptFn;
  this.decryptFn = options.decryptFn;
  this.createLicenseKeyFn = options.createLicenseKeyFn;
  this.affiliateDataRef = options.affiliateDataRef; // reference to _affiliateData
  this.licensesRef = options.licensesRef;           // reference to _licenses
  this.saveAffiliatesFn = options.saveAffiliatesFn;
  this.logFn = options.logFn || function () {};

  this.ordersDbPath = path.join(this.dataDir, 'data', 'orders.enc');
  this.eventsDbPath = path.join(this.dataDir, 'data', 'processed_events.enc');

  this._orders = [];
  this._processedEvents = [];

  this.init();
}

PaymentService.prototype.init = function () {
  this.loadOrders();
  this.loadEvents();
};

PaymentService.prototype.getSecretKey = function () {
  return process.env.XPAY_SECRET_KEY || '';
};

PaymentService.prototype.getWebhookSecret = function () {
  return process.env.XPAY_WEBHOOK_SECRET || '';
};

PaymentService.prototype.getApiBase = function () {
  return process.env.XPAY_API_BASE || 'https://api.xpay.app';
};

PaymentService.prototype.loadOrders = function () {
  if (!fs.existsSync(this.ordersDbPath)) {
    this._orders = [];
    return;
  }
  try {
    var raw = fs.readFileSync(this.ordersDbPath, 'utf8');
    var decrypted = JSON.parse(this.decryptFn(raw, this.storageKey));
    this._orders = decrypted.orders || [];
  } catch (e) {
    this._orders = [];
    this.logFn('ORDERS_DB_LOAD_ERROR', { error: e.message });
  }
};

PaymentService.prototype.saveOrders = function () {
  try {
    var data = { orders: this._orders };
    var enc = this.encryptFn(JSON.stringify(data), this.storageKey);
    fs.writeFileSync(this.ordersDbPath, enc);
  } catch (e) {
    this.logFn('ORDERS_DB_SAVE_ERROR', { error: e.message });
  }
};

PaymentService.prototype.loadEvents = function () {
  if (!fs.existsSync(this.eventsDbPath)) {
    this._processedEvents = [];
    return;
  }
  try {
    var raw = fs.readFileSync(this.eventsDbPath, 'utf8');
    var decrypted = JSON.parse(this.decryptFn(raw, this.storageKey));
    this._processedEvents = decrypted.events || [];
  } catch (e) {
    this._processedEvents = [];
    this.logFn('EVENTS_DB_LOAD_ERROR', { error: e.message });
  }
};

PaymentService.prototype.saveEvents = function () {
  try {
    var data = { events: this._processedEvents };
    var enc = this.encryptFn(JSON.stringify(data), this.storageKey);
    fs.writeFileSync(this.eventsDbPath, enc);
  } catch (e) {
    this.logFn('EVENTS_DB_SAVE_ERROR', { error: e.message });
  }
};

PaymentService.prototype.generateOrderId = function () {
  var d = new Date();
  var dateStr = d.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  return 'ORD-' + dateStr + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
};

/**
 * Validate Affiliate Code against current affiliates and license status
 */
PaymentService.prototype.validateAffiliate = function (code, product, clientKey) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'كود الإحالة مطلوب' };
  }
  var cleanCode = code.trim().toUpperCase();
  var affData = this.affiliateDataRef();
  var aff = affData.affiliates.find(function (a) {
    return a.affiliate_code.toUpperCase() === cleanCode;
  });

  if (!aff) {
    return { valid: false, error: 'كود الإحالة غير صالح أو غير نشط.' };
  }

  if (aff.status !== 'enabled') {
    return { valid: false, error: 'كود الإحالة غير صالح أو غير نشط.' };
  }

  // Prevent user from referring themselves
  if (clientKey && aff.user_key === clientKey) {
    return { valid: false, error: 'لا يمكن استخدام كود الإحالة الخاص بك.' };
  }

  // Check if affiliate user key exists and is not revoked in licenses
  var licenses = this.licensesRef();
  var lic = licenses.find(function (l) { return l.key === aff.user_key; });
  if (!lic || lic.status === 'revoked') {
    return { valid: false, error: 'كود الإحالة غير صالح أو غير نشط.' };
  }

  return {
    valid: true,
    affiliate: aff
  };
};

/**
 * Create XPay Checkout Session and local pending order
 */
PaymentService.prototype.createPaymentSession = function (options, callback) {
  var self = this;
  var product = (options.product || 'HALEEM-B-FACE').trim();
  var currency = (options.currency || 'EGP').trim().toUpperCase();
  var affiliateCode = options.affiliateCode ? options.affiliateCode.trim().toUpperCase() : null;
  var clientKey = options.clientKey || null;

  if (currency !== 'USD' && currency !== 'EGP') {
    return callback(new Error('عملة غير مدعومة. العملات المدعومة: USD, EGP'));
  }

  var prodConfig = PRODUCTS[product];
  if (!prodConfig) {
    return callback(new Error('منتج غير معروف: ' + product));
  }

  var curConfig = prodConfig.currencies[currency];
  if (!curConfig) {
    return callback(new Error('العملة غير مدعومة لهذا المنتج: ' + currency));
  }

  var aff = null;
  var pricing = null;
  var pricingType = 'normal';

  if (affiliateCode) {
    var val = this.validateAffiliate(affiliateCode, product, clientKey);
    if (!val.valid) {
      return callback(new Error(val.error));
    }
    aff = val.affiliate;
    pricing = curConfig.affiliate;
    pricingType = 'affiliate';
  } else {
    pricing = curConfig.normal;
    pricingType = 'normal';
  }

  var secretKey = this.getSecretKey();
  if (!secretKey) {
    return callback(new Error('XPAY_SECRET_KEY غير مهيأ على السيرفر'));
  }

  var internalOrderId = this.generateOrderId();
  var idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

  // Build XPay payload
  var lineItemName = prodConfig.name;
  if (pricingType === 'affiliate') {
    lineItemName += (currency === 'EGP' ? ' (خصم كود الإحالة 250 ج.م)' : ' (Affiliate Discount $5)');
  }

  var returnUrl = process.env.XPAY_RETURN_URL || 'https://haleem.app/payment-success?order_id={CHECKOUT_SESSION_ID}';

  var payload = {
    currency: currency,
    mode: 'payment',
    uiMode: 'hosted',
    lineItems: [
      {
        priceData: {
          currency: currency,
          unitAmount: pricing.unitAmount,
          productData: {
            name: lineItemName
          }
        },
        quantity: 1
      }
    ],
    nameCollection: true,
    phoneNumberCollection: true,
    feeConfig: {
      vatCollectionEnabled: pricing.vatRate > 0,
      vatCollectionRate: pricing.vatRate || 0,
      feesPassThrough: pricing.feePassThrough || false
    },
    afterCompletion: {
      type: 'redirect',
      redirect: {
        url: returnUrl
      }
    },
    metadata: {
      internalOrderId: internalOrderId,
      product: product,
      currency: currency,
      pricingType: pricingType,
      affiliateCode: aff ? aff.affiliate_code : '',
      affiliateUserKey: aff ? aff.user_key : ''
    }
  };

  var payloadStr = JSON.stringify(payload);
  var apiBase = this.getApiBase();
  var urlObj = new URL(apiBase + '/checkout/sessions');

  var reqOptions = {
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + secretKey,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'Content-Length': Buffer.byteLength(payloadStr)
    }
  };

  var req = https.request(reqOptions, function (res) {
    var resData = '';
    res.on('data', function (chunk) { resData += chunk; });
    res.on('end', function () {
      var body;
      try { body = JSON.parse(resData); } catch (e) {
        return callback(new Error('Invalid response from XPay API: ' + resData));
      }

      if (res.statusCode >= 200 && res.statusCode < 300 && body.url) {
        // Record order in internal storage
        var order = {
          internal_order_id: internalOrderId,
          xpay_session_id: body.id,
          payment_intent_id: null,
          product: product,
          currency: currency,
          unit_amount: pricing.unitAmount,
          total_charged: body.amountTotal || pricing.unitAmount,
          pricing_type: pricingType,
          affiliate_code: aff ? aff.affiliate_code : null,
          affiliate_user_key: aff ? aff.user_key : null,
          customer_name: '',
          phone: '',
          license_key: null,
          status: 'pending',
          created_at: new Date().toISOString(),
          paid_at: null
        };

        self._orders.push(order);
        self.saveOrders();

        self.logFn('PAYMENT_SESSION_CREATED', {
          orderId: internalOrderId,
          sessionId: body.id,
          product: product,
          currency: currency,
          pricingType: pricingType,
          amount: pricing.unitAmount
        });

        callback(null, {
          success: true,
          orderId: internalOrderId,
          checkoutUrl: body.url
        });
      } else {
        var errMsg = (body.error && body.error.message) || body.message || ('XPay error ' + res.statusCode);
        self.logFn('XPAY_API_ERROR', { status: res.statusCode, error: errMsg });
        callback(new Error(errMsg));
      }
    });
  });

  req.on('error', function (err) {
    self.logFn('XPAY_NETWORK_ERROR', { error: err.message });
    callback(err);
  });

  req.write(payloadStr);
  req.end();
};

/**
 * Verify Webhook Signature according to XPay official specifications
 */
PaymentService.prototype.verifyWebhookSignature = function (rawBody, signatureHeader) {
  var webhookSecret = this.getWebhookSecret();
  if (!webhookSecret) {
    throw new Error('XPAY_WEBHOOK_SECRET غير مهيأ على السيرفر');
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    throw new Error('Missing XPay-Signature header');
  }

  var parts = {};
  signatureHeader.split(',').forEach(function (p) {
    var kv = p.split('=');
    if (kv[0]) parts[kv[0].trim()] = (kv.slice(1).join('=') || '').trim();
  });

  var timestamp = parseInt(parts.t, 10);
  var receivedSignature = parts.v1;

  if (!timestamp || !receivedSignature) {
    throw new Error('Invalid XPay-Signature format');
  }

  // Replay protection: reject events older than 300 seconds (5 min)
  var currentSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(currentSeconds - timestamp) > 300) {
    throw new Error('Webhook timestamp outside tolerance window');
  }

  var signedPayload = timestamp + '.' + rawBody;
  var computedSignature = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

  var a = Buffer.from(computedSignature, 'utf8');
  var b = Buffer.from(receivedSignature, 'utf8');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Bad webhook signature');
  }

  return true;
};

/**
 * Process verified webhook event
 */
PaymentService.prototype.processWebhookEvent = function (rawBody, signatureHeader) {
  this.verifyWebhookSignature(rawBody, signatureHeader);

  var event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    throw new Error('Invalid webhook JSON body');
  }

  var eventId = event.id;
  var eventType = event.type;

  // Idempotency check on event ID
  if (eventId && this._processedEvents.indexOf(eventId) !== -1) {
    this.logFn('WEBHOOK_DUPLICATE_IGNORED', { eventId: eventId, type: eventType });
    return { success: true, duplicate: true };
  }

  // Only handle completion events
  if (eventType !== 'checkout.session.completed' && eventType !== 'checkout.session.async_payment_succeeded') {
    this.logFn('WEBHOOK_EVENT_IGNORED', { eventId: eventId, type: eventType });
    return { success: true, ignored: true };
  }

  var session = event.data && event.data.object;
  if (!session) {
    throw new Error('Missing data.object in webhook payload');
  }

  // Check paymentStatus
  if (session.paymentStatus !== 'paid') {
    this.logFn('WEBHOOK_PAYMENT_NOT_PAID', { eventId: eventId, status: session.paymentStatus });
    return { success: true, pendingPayment: true };
  }

  var sessionId = session.id;
  var metadata = session.metadata || {};
  var internalOrderId = metadata.internalOrderId;

  // Find order in storage
  var order = this._orders.find(function (o) {
    return (internalOrderId && o.internal_order_id === internalOrderId) || o.xpay_session_id === sessionId;
  });

  if (!order) {
    // If order record wasn't created prior (e.g. direct link), build new order
    order = {
      internal_order_id: internalOrderId || this.generateOrderId(),
      xpay_session_id: sessionId,
      payment_intent_id: (session.paymentIntent && session.paymentIntent.id) || session.paymentIntent || '',
      product: metadata.product || 'HALEEM-B-FACE',
      currency: session.currency || 'EGP',
      unit_amount: session.amountTotal || 0,
      total_charged: session.amountTotal || 0,
      pricing_type: metadata.pricingType || 'normal',
      affiliate_code: metadata.affiliateCode || null,
      affiliate_user_key: metadata.affiliateUserKey || null,
      customer_name: '',
      phone: '',
      license_key: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      paid_at: null
    };
    this._orders.push(order);
  }

  // Prevent double fulfillment
  if (order.status === 'paid' && order.license_key) {
    this.logFn('ORDER_ALREADY_PAID', { orderId: order.internal_order_id, licenseKey: order.license_key });
    if (eventId) {
      this._processedEvents.push(eventId);
      this.saveEvents();
    }
    return { success: true, order: order, alreadyFulfilled: true };
  }

  // Extract customer details collected by XPay
  var custDetails = session.customerDetails || (typeof session.customer === 'object' ? session.customer : {}) || {};
  var customerName = custDetails.name || metadata.customerName || 'Customer';
  var customerPhone = custDetails.phone || '';

  // Generate License
  var lic = this.createLicenseKeyFn(customerName, customerPhone);

  // Update order
  order.status = 'paid';
  order.paid_at = new Date().toISOString();
  order.payment_intent_id = (session.paymentIntent && session.paymentIntent.id) || session.paymentIntent || '';
  order.license_key = lic.key;
  order.customer_name = customerName;
  order.phone = customerPhone;
  this.saveOrders();

  // Handle Affiliate Referral Recording
  if (order.affiliate_code && order.affiliate_user_key) {
    var affData = this.affiliateDataRef();
    var alreadyReferred = affData.referrals.find(function (r) {
      return r.referred_user_key === lic.key || (r.order_id && r.order_id === order.internal_order_id);
    });

    if (!alreadyReferred) {
      var refId = 'ref_' + crypto.randomBytes(6).toString('hex');
      var commissionAmount = order.currency === 'USD' ? 5 : 250; // 5 USD or 250 EGP
      var referral = {
        id: refId,
        affiliate_user_key: order.affiliate_user_key,
        referred_user_key: lic.key,
        order_id: order.internal_order_id,
        commission: commissionAmount,
        currency: order.currency,
        status: 'pending', // Earned but pending manual payout
        created_at: new Date().toISOString()
      };

      affData.referrals.push(referral);
      this.saveAffiliatesFn();
      this.logFn('AFFILIATE_REFERRAL_EARNED', {
        affiliateKey: order.affiliate_user_key,
        referredKey: lic.key,
        commission: commissionAmount,
        orderId: order.internal_order_id
      });
    }
  }

  // Mark event as processed for idempotency
  if (eventId) {
    this._processedEvents.push(eventId);
    if (this._processedEvents.length > 5000) {
      this._processedEvents.shift();
    }
    this.saveEvents();
  }

  this.logFn('ORDER_FULFILLED_SUCCESS', {
    orderId: order.internal_order_id,
    licenseKey: lic.key,
    customerName: customerName
  });

  return {
    success: true,
    order: order,
    license: lic
  };
};

PaymentService.prototype.getOrderStatus = function (orderId) {
  if (!orderId) return null;
  var order = this._orders.find(function (o) {
    return o.internal_order_id === orderId || o.xpay_session_id === orderId;
  });
  if (!order) return null;

  return {
    status: order.status,
    orderId: order.internal_order_id,
    product: order.product,
    currency: order.currency,
    licenseKey: order.license_key,
    customerName: order.customer_name,
    paidAt: order.paid_at
  };
};

module.exports = PaymentService;
