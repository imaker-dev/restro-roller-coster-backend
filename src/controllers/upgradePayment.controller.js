/**
 * Upgrade Payment Controller — Razorpay Pro plan upgrade flow.
 *
 * Flow:
 *   1. Flutter calls POST /api/v1/upgrade-payment/create-order with { license_id }
 *   2. Backend looks up restaurant details, creates Razorpay order, returns order_id + key
 *   3. Flutter opens Razorpay checkout (via InAppWebView)
 *   4. On payment success, Flutter calls POST /api/v1/upgrade-payment/verify
 *   5. Backend verifies HMAC signature, generates upgrade token, sends email + WhatsApp
 *   6. On cancel/dismiss, Flutter calls POST /api/v1/upgrade-payment/cancel
 *
 * Env vars required:
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 *   RAZORPAY_UPGRADE_AMOUNT_PAISE  (default: 299900 = ₹2999)
 */
const crypto  = require('crypto');
const Razorpay = require('razorpay');
const { getPool } = require('../database');
const logger  = require('../utils/logger');
const { internalGenerateUpgradeToken } = require('./tokenGeneration.controller');

// ─── Razorpay instance (lazy) ────────────────────────────────────────────────
let _razorpay = null;

const getRazorpay = () => {
  if (_razorpay) return _razorpay;
  const key_id     = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error('Razorpay not configured (set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env)');
  }
  _razorpay = new Razorpay({ key_id, key_secret });
  return _razorpay;
};

const UPGRADE_AMOUNT_PAISE = () =>
  parseInt(process.env.RAZORPAY_UPGRADE_AMOUNT_PAISE || '299900');

// ─── Notification helper ─────────────────────────────────────────────────────
const _tryNotify = async (fn, label) => {
  try {
    await fn();
    return true;
  } catch (e) {
    logger.warn(`[UpgradePayment] ${label} notification failed: ${e.message}`);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/upgrade-payment/create-order
 * Public — no auth required.
 * Body: { license_id }
 */
const createOrder = async (req, res) => {
  try {
    const { license_id } = req.body;

    if (!license_id?.trim()) {
      return res.status(400).json({ success: false, message: 'license_id is required' });
    }

    const pool = getPool();

    // Look up restaurant details from the activation log
    const [logRows] = await pool.query(
      `SELECT restaurant_name, email, phone, plan
       FROM token_generation_log
       WHERE license_id = ? AND token_type = 'activation'
       ORDER BY created_at DESC LIMIT 1`,
      [license_id.trim()]
    );

    if (!logRows.length) {
      return res.status(404).json({
        success: false,
        message: 'License ID not found. Please enter your current Free plan license ID.',
      });
    }

    const record = logRows[0];
    if (record.plan === 'pro') {
      return res.status(409).json({
        success: false,
        message: 'This license is already on the Pro plan.',
      });
    }

    // Prevent duplicate completed upgrade for the same license
    const [alreadyPaid] = await pool.query(
      `SELECT id FROM upgrade_payments WHERE license_id = ? AND status = 'paid' LIMIT 1`,
      [license_id.trim()]
    );
    if (alreadyPaid.length) {
      return res.status(409).json({
        success: false,
        message: 'A Pro upgrade has already been completed for this license. Check your email for the upgrade key.',
      });
    }

    const razorpay = getRazorpay();
    const amount   = UPGRADE_AMOUNT_PAISE();

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `upg_${license_id.trim().replace(/-/g, '').slice(0, 10)}_${Date.now()}`,
      notes: {
        license_id:  license_id.trim(),
        restaurant:  record.restaurant_name || '',
        type:        'pro_upgrade',
      },
    });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;

    // Build callback URL for Razorpay Payment Link redirect
    const callbackBase = `${req.protocol}://${req.get('host')}`;
    const callbackUrl  = `${callbackBase}/api/v1/upgrade-payment/payment-callback`;

    // Create a Razorpay Payment Link — gives us a hosted checkout page URL
    // that works in WebView without any iframe/modal issues.
    let paymentLinkUrl = '';
    try {
      const plink = await razorpay.paymentLink.create({
        amount,
        currency: 'INR',
        description: `RestroPOS Pro Upgrade — ${record.restaurant_name || license_id.trim()}`,
        reference_id: order.id,
        customer: {
          name:    record.restaurant_name || '',
          email:   record.email  || '',
          contact: record.phone  || '',
        },
        notify: { sms: false, email: false },
        callback_url: callbackUrl,
        callback_method: 'get',
        notes: {
          license_id: license_id.trim(),
          order_id:   order.id,
          type:       'pro_upgrade',
        },
      });
      paymentLinkUrl = plink.short_url || '';
      logger.info(`[UpgradePayment] Payment Link created: ${plink.id} | url=${paymentLinkUrl}`);
    } catch (plinkErr) {
      logger.warn(`[UpgradePayment] Payment Link creation failed (falling back): ${plinkErr.message}`);
    }

    await pool.query(
      `INSERT INTO upgrade_payments
         (license_id, restaurant_name, email, phone, razorpay_order_id, amount_paise, currency, status, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, 'INR', 'created', ?)`,
      [
        license_id.trim(),
        record.restaurant_name || null,
        record.email  || null,
        record.phone  || null,
        order.id,
        amount,
        ip,
      ]
    );

    logger.info(`[UpgradePayment] Order created: ${order.id} | license=${license_id} | amount=₹${amount / 100}`);

    return res.json({
      success: true,
      data: {
        orderId:    order.id,
        amount,
        currency:   'INR',
        keyId:      process.env.RAZORPAY_KEY_ID,
        restaurant: record.restaurant_name || '',
        email:      record.email  || '',
        phone:      record.phone  || '',
        paymentUrl: paymentLinkUrl,
      },
    });

  } catch (err) {
    logger.error('[UpgradePayment] createOrder error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to create payment order: ' + err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/upgrade-payment/verify
 * Public — no auth required.
 * Body: { razorpay_payment_id, razorpay_order_id, razorpay_signature }
 *
 * Verifies Razorpay HMAC-SHA256 signature, generates Pro upgrade token,
 * and dispatches email + WhatsApp notifications.
 */
const verifyAndUpgrade = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing payment fields: razorpay_payment_id, razorpay_order_id, razorpay_signature',
      });
    }

    // Verify HMAC-SHA256 signature
    const secret      = process.env.RAZORPAY_KEY_SECRET;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      logger.warn(`[UpgradePayment] Signature mismatch — order=${razorpay_order_id}`);
      return res.status(400).json({ success: false, message: 'Payment verification failed. Invalid signature.' });
    }

    const pool = getPool();

    // Find the payment record
    const [rows] = await pool.query(
      `SELECT * FROM upgrade_payments WHERE razorpay_order_id = ? LIMIT 1`,
      [razorpay_order_id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Payment order not found.' });
    }

    const payment = rows[0];

    // Idempotency — already processed
    if (payment.status === 'paid' && payment.upgrade_token) {
      logger.info(`[UpgradePayment] Idempotent re-verify for order ${razorpay_order_id}`);
      return res.json({
        success: true,
        message: 'Upgrade already processed. Check your email and WhatsApp for the upgrade key.',
        data: { newLicenseId: payment.new_license_id },
      });
    }

    // Generate Pro upgrade token
    const { token, newLicenseId } = await internalGenerateUpgradeToken({
      licenseId:   payment.license_id,
      restaurant:  payment.restaurant_name || '',
      email:       payment.email  || null,
      phone:       payment.phone  || null,
      maxOutlets:  3,
    });

    // Mark as paid
    await pool.query(
      `UPDATE upgrade_payments
       SET status = 'paid',
           razorpay_payment_id = ?,
           razorpay_signature  = ?,
           upgrade_token       = ?,
           new_license_id      = ?
       WHERE razorpay_order_id = ?`,
      [razorpay_payment_id, razorpay_signature, token, newLicenseId, razorpay_order_id]
    );

    // ── Notifications ───────────────────────────────────────────────────────
    const notifData = {
      restaurant:   payment.restaurant_name || '',
      token,
      newLicenseId,
      upgradesFrom: payment.license_id,
    };

    let emailSent     = false;
    let whatsappSent  = false;

    if (payment.email) {
      const { sendUpgradeTokenEmail } = require('../services/email.service');
      emailSent = await _tryNotify(
        () => sendUpgradeTokenEmail(payment.email, notifData),
        'Email'
      );
    }

    if (payment.phone) {
      const whatsapp = require('../services/whatsapp.service');
      const msg =
        `🚀 *RestroPOS Pro Upgrade Ready!*\n\n` +
        `Restaurant: ${notifData.restaurant || '—'}\n\n` +
        `Your Pro upgrade key:\n\n` +
        `\`${token}\`\n\n` +
        `Apply it in RestroPOS → *Settings → License → Upgrade to Pro*.\n\n` +
        `— iMaker Team`;
      whatsappSent = await _tryNotify(
        () => whatsapp.sendText(payment.phone, msg),
        'WhatsApp'
      );
    }

    // Save notification status
    await pool.query(
      `UPDATE upgrade_payments SET notified_email = ?, notified_whatsapp = ? WHERE razorpay_order_id = ?`,
      [emailSent ? 1 : 0, whatsappSent ? 1 : 0, razorpay_order_id]
    );

    logger.info(
      `[UpgradePayment] Done: order=${razorpay_order_id} newLid=${newLicenseId} ` +
      `email=${emailSent} wa=${whatsappSent}`
    );

    return res.json({
      success: true,
      message: 'Payment verified. Your Pro upgrade key has been sent to your email and WhatsApp.',
      data: {
        newLicenseId,
        notifications: {
          email:     emailSent    ? 'sent' : (payment.email  ? 'failed' : 'no_email'),
          whatsapp:  whatsappSent ? 'sent' : (payment.phone  ? 'failed' : 'no_phone'),
        },
      },
    });

  } catch (err) {
    logger.error('[UpgradePayment] verifyAndUpgrade error:', err);
    return res.status(500).json({
      success: false,
      message: 'Payment verification failed: ' + err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/upgrade-payment/cancel
 * Public — mark a 'created' order as 'cancelled'.
 * Body: { razorpay_order_id }
 */
const cancelOrder = async (req, res) => {
  try {
    const { razorpay_order_id } = req.body;
    if (!razorpay_order_id) {
      return res.status(400).json({ success: false, message: 'razorpay_order_id is required' });
    }

    const pool = getPool();
    await pool.query(
      `UPDATE upgrade_payments SET status = 'cancelled'
       WHERE razorpay_order_id = ? AND status = 'created'`,
      [razorpay_order_id]
    );

    logger.info(`[UpgradePayment] Order cancelled: ${razorpay_order_id}`);
    return res.json({ success: true, message: 'Order cancelled.' });

  } catch (err) {
    logger.error('[UpgradePayment] cancelOrder error:', err);
    return res.status(500).json({ success: false, message: 'Failed to cancel order.' });
  }
};

/**
 * GET /api/v1/upgrade-payment/pricing
 * Public — returns the current upgrade price (driven by RAZORPAY_UPGRADE_AMOUNT_PAISE env var).
 */
const getPricing = (req, res) => {
  const amountPaise = UPGRADE_AMOUNT_PAISE();
  const amountInr   = amountPaise / 100;
  return res.json({
    success: true,
    data: {
      amount_paise: amountPaise,
      amount_inr:   amountInr,
      currency:     'INR',
      label:        `₹${amountInr.toLocaleString('en-IN')}`,
      note:         'Includes all applicable taxes. One-time payment.',
    },
  });
};

/**
 * GET /api/v1/upgrade-payment/checkout-page
 * Serves an HTML page that auto-submits a Razorpay checkout form.
 * Uses callback_url (redirect) mode instead of modal overlay — this avoids
 * iframe rendering issues on Windows WebView2.
 * Query params: order_id, key_id, amount, restaurant, email, phone
 */
const checkoutPage = (req, res) => {
  const { order_id, key_id, amount, restaurant, email, phone } = req.query;

  if (!order_id || !key_id) {
    return res.status(400).json({ success: false, message: 'Missing order_id or key_id' });
  }

  const s = (v) => (v || '').replace(/[<>'"&]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;', '&': '&amp;' }[c]));

  // Build the callback URL that Razorpay will redirect to after payment
  const callbackBase = `${req.protocol}://${req.get('host')}`;
  const callbackUrl  = `${callbackBase}/api/v1/upgrade-payment/payment-callback`;
  const cancelUrl    = `${callbackBase}/api/v1/upgrade-payment/payment-callback?status=dismissed`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secure Payment</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: linear-gradient(135deg, #1a1a3e 0%, #2d2d5e 100%);
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; font-family: -apple-system, sans-serif;
    }
    .loader { text-align:center; color:#fff; }
    .spinner {
      width:44px; height:44px; border:3px solid rgba(255,255,255,.2);
      border-top-color:#fff; border-radius:50%;
      animation: spin .8s linear infinite; margin:0 auto 16px;
    }
    @keyframes spin { to { transform:rotate(360deg); } }
    p { font-size:14px; opacity:.7; }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <p>Redirecting to payment gateway&hellip;</p>
  </div>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var options = {
      key:          '${s(key_id)}',
      order_id:     '${s(order_id)}',
      amount:       ${parseInt(amount) || 2499900},
      currency:     'INR',
      name:         'RestroPOS Pro Upgrade',
      description:  'Lifetime Pro Plan',
      image:        'https://imakerrestro.com/logo.png',
      callback_url: '${callbackUrl}',
      cancel_url:   '${cancelUrl}',
      redirect:     true,
      prefill: {
        name:    '${s(restaurant)}',
        email:   '${s(email)}',
        contact: '${s(phone)}'
      },
      theme: { color: '#1a1a3e' }
    };
    var rzp = new Razorpay(options);
    // Auto-open immediately — Razorpay will redirect the entire page
    setTimeout(function() { rzp.open(); }, 300);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};

/**
 * POST|GET /api/v1/upgrade-payment/payment-callback
 * Razorpay redirects here after payment success/failure/cancel.
 * Renders an HTML page that sends the result back to Flutter via JS bridge.
 */
const paymentCallback = (req, res) => {
  // Razorpay POSTs on success, GETs on cancel
  const data = { ...req.query, ...req.body };

  // Check if this is a dismissal / cancel
  if (data.status === 'dismissed' || (!data.razorpay_payment_id && !data.razorpay_order_id)) {
    const html = _buildCallbackHtml({ status: 'dismissed' }, 'Payment Cancelled');
    return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Success data from Razorpay
  const result = {
    status:     'success',
    payment_id: data.razorpay_payment_id  || '',
    order_id:   data.razorpay_order_id    || '',
    signature:  data.razorpay_signature   || '',
  };

  const html = _buildCallbackHtml(result, 'Payment Successful');
  res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
};

/**
 * Helper — builds the HTML page shown after Razorpay redirect.
 * Sends the result to Flutter via window.flutter_inappwebview JS bridge.
 */
function _buildCallbackHtml(resultObj, title) {
  const jsonStr = JSON.stringify(resultObj).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: linear-gradient(135deg, #1a1a3e 0%, #2d2d5e 100%);
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; font-family: -apple-system, sans-serif;
    }
    .msg { text-align:center; color:#fff; }
    .spinner {
      width:44px; height:44px; border:3px solid rgba(255,255,255,.2);
      border-top-color:#fff; border-radius:50%;
      animation: spin .8s linear infinite; margin:0 auto 16px;
    }
    @keyframes spin { to { transform:rotate(360deg); } }
    p { font-size:14px; opacity:.7; }
  </style>
</head>
<body>
  <div class="msg">
    <div class="spinner"></div>
    <p>Processing&hellip;</p>
  </div>
  <script>
    (function() {
      var data = '${jsonStr}';
      function send() {
        if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
          window.flutter_inappwebview.callHandler('paymentResult', data);
        } else {
          setTimeout(send, 200);
        }
      }
      send();
    })();
  </script>
</body>
</html>`;
}

module.exports = { createOrder, verifyAndUpgrade, cancelOrder, getPricing, checkoutPage, paymentCallback };
