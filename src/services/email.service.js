/**
 * Email notification service — uses nodemailer with SMTP.
 * Requires: npm install nodemailer
 * Env vars:  SMTP_HOST, SMTP_PORT (default 465), SMTP_USER, SMTP_PASS, SMTP_FROM
 */
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// Lazily created transport so missing SMTP config doesn't crash startup
let _transport = null;

const getTransport = () => {
  if (_transport) return _transport;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  const port   = parseInt(process.env.SMTP_PORT || '465');
  const secure = port === 465;

  _transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });

  return _transport;
};

/**
 * Core send helper.
 * Throws if SMTP is not configured or send fails.
 */
const sendMail = async (to, subject, html, text) => {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env)');
  }

  const from   = process.env.SMTP_FROM || process.env.SMTP_USER;
  const domain = from.split('@')[1] || 'imakerrestro.com';
  const msgId  = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`;

  await transport.sendMail({
    from:    `"iMaker RestroPOS" <${from}>`,
    to,
    replyTo: from,
    subject,
    messageId: msgId,
    headers: {
      'X-Mailer':        'RestroPOS Notification System',
      'X-Entity-Ref-ID': msgId,
      'Precedence':      'transactional',
      'List-Unsubscribe': `<mailto:support@${domain}>`,
    },
    html,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  });

  logger.info(`[Email] Sent to ${to}: ${subject}`);
};

/**
 * Send email with a PDF attachment.
 */
const sendMailWithAttachment = async (to, subject, html, text, attachment) => {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env)');
  }

  const from   = process.env.SMTP_FROM || process.env.SMTP_USER;
  const domain = from.split('@')[1] || 'imakerrestro.com';
  const msgId  = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`;

  await transport.sendMail({
    from:    `"iMaker RestroPOS" <${from}>`,
    to,
    replyTo: from,
    subject,
    messageId: msgId,
    headers: {
      'X-Mailer':        'RestroPOS Notification System',
      'X-Entity-Ref-ID': msgId,
      'Precedence':      'transactional',
      'List-Unsubscribe': `<mailto:support@${domain}>`,
    },
    html,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    attachments: attachment ? [{
      filename: attachment.filename || 'document.pdf',
      content: attachment.buffer,
      contentType: attachment.contentType || 'application/pdf',
    }] : undefined,
  });

  logger.info(`[Email] Sent with attachment to ${to}: ${subject}`);
};

/**
 * Send subscription payment receipt email with PDF attachment.
 */
const sendSubscriptionReceiptEmail = async (to, receiptData) => {
  if (!to) return;

  const { receiptNo, date, outletName, baseAmount, gstAmount, totalAmount, gstPercentage, subscriptionStart, subscriptionEnd, paymentMode, paymentId, orderId } = receiptData;

  const amountStr = `₹${parseFloat(totalAmount || 0).toFixed(2)}`;
  const subject = `iMakerRestro — Subscription Receipt`;

  const html = `
<div style="font-family:Arial,sans-serif;background:#1A1A2E;color:#ffffff;padding:32px;border-radius:12px;max-width:560px;margin:0 auto">
  <div style="text-align:center;margin-bottom:24px">
    <h1 style="color:#E91E63;margin:0;font-size:28px">iMakerRestro</h1>
    <p style="color:#aaa;margin:4px 0 0;font-size:14px">Smart Restaurant Management</p>
    <h2 style="color:#22c55e;margin:16px 0 0;font-size:20px">✓ Subscription Payment Received</h2>
    <p style="color:#aaa;margin:8px 0 0;font-size:14px">Receipt #${receiptNo || 'N/A'}</p>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr><td style="color:#888;padding:6px 0;width:140px">Restaurant</td><td style="color:#fff">${outletName || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Base Amount</td><td style="color:#fff">₹${parseFloat(baseAmount || 0).toFixed(2)}</td></tr>
    <tr><td style="color:#888;padding:6px 0">GST (${gstPercentage || 18}%)</td><td style="color:#fff">₹${parseFloat(gstAmount || 0).toFixed(2)}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Total Paid</td><td style="color:#22c55e;font-weight:bold;font-size:16px">${amountStr}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Valid From</td><td style="color:#fff">${subscriptionStart || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Expires On</td><td style="color:#fff">${subscriptionEnd || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Payment Mode</td><td style="color:#fff">${paymentMode || 'Online (Razorpay)'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Payment ID</td><td style="color:#fff;font-family:monospace;font-size:12px">${paymentId || '—'}</td></tr>
  </table>
  <p style="color:#555;font-size:11px;margin-top:24px;text-align:center">
    This is a computer-generated receipt. No signature required.<br>
    iMakerRestro • Powered by iMaker Technology • support@imakerrestro.com
  </p>
</div>`;

  const text =
    `iMakerRestro — SUBSCRIPTION RECEIPT\n` +
    `========================================\n\n` +
    `Receipt No   : ${receiptNo || 'N/A'}\n` +
    `Restaurant   : ${outletName || '—'}\n` +
    `Base Amount  : ₹${parseFloat(baseAmount || 0).toFixed(2)}\n` +
    `GST (${gstPercentage || 18}%)   : ₹${parseFloat(gstAmount || 0).toFixed(2)}\n` +
    `Total Paid   : ${amountStr}\n` +
    `Valid From   : ${subscriptionStart || '—'}\n` +
    `Expires On   : ${subscriptionEnd || '—'}\n` +
    `Payment Mode : ${paymentMode || 'Online (Razorpay)'}\n` +
    `Payment ID   : ${paymentId || '—'}\n\n` +
    `This is a computer-generated receipt. No signature required.\n` +
    `iMakerRestro | Powered by iMaker Technology | support@imakerrestro.com`;

  return sendMailWithAttachment(to, subject, html, text, receiptData.attachment);
};

/**
 * Send Pro upgrade token email.
 */
const sendUpgradeTokenEmail = async (to, { restaurant, token, newLicenseId, upgradesFrom }) => {
  if (!to) return;

  const subject = `RestroPOS Pro License Ready — ${restaurant || 'RestroPOS'}`;

  const html = `
<div style="font-family:Arial,sans-serif;background:#1A1A2E;color:#ffffff;padding:32px;border-radius:12px;max-width:560px;margin:0 auto">
  <div style="text-align:center;margin-bottom:24px">
    <h2 style="color:#E53935;margin:0;font-size:22px">RestroPOS Pro Upgrade</h2>
    <p style="color:#aaa;margin:8px 0 0;font-size:14px">Your Pro plan is ready to activate</p>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr><td style="color:#888;padding:6px 0;width:130px">Restaurant</td><td style="color:#fff">${restaurant || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">New License</td><td style="color:#fff;font-family:monospace;font-size:12px">${newLicenseId}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Upgraded From</td><td style="color:#fff;font-family:monospace;font-size:12px">${upgradesFrom}</td></tr>
  </table>
  <div style="background:#22243A;border:1px solid #E53935;border-radius:8px;padding:16px;margin:16px 0">
    <p style="color:#aaa;margin:0 0 8px;font-size:11px;letter-spacing:1px">PRO UPGRADE KEY</p>
    <p style="color:#ffffff;word-break:break-all;font-family:monospace;font-size:11px;margin:0;line-height:1.6">${token}</p>
  </div>
  <p style="color:#aaa;font-size:13px;line-height:1.6">
    Apply this key in RestroPOS under <strong>Settings &rsaquo; License &rsaquo; Upgrade to Pro</strong>.<br>
    Keep this email confidential.
  </p>
  <p style="color:#555;font-size:11px;margin-top:24px;text-align:center">RestroPOS &bull; Powered by iMaker Technology</p>
</div>`;

  const text =
    `RestroPOS Pro Upgrade\n\n` +
    `Restaurant  : ${restaurant || '—'}\n` +
    `New License : ${newLicenseId}\n` +
    `Upgraded From: ${upgradesFrom}\n\n` +
    `--- PRO UPGRADE KEY ---\n${token}\n--- END ---\n\n` +
    `Apply this key in RestroPOS under Settings > License > Upgrade to Pro.\n` +
    `Keep this email confidential.\n\n` +
    `RestroPOS | Powered by iMaker Technology`;

  return sendMail(to, subject, html, text);
};

/**
 * Send payment invoice email for Pro upgrade.
 */
const sendPaymentInvoiceEmail = async (to, { restaurant, paymentId, orderId, amount, currency, date, token, newLicenseId, upgradesFrom }) => {
  if (!to) return;

  const amountStr = currency === 'INR'
    ? `₹${(amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    : `${amount / 100} ${currency}`;
  const dateStr = date || new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

  const subject = `Payment Receipt — RestroPOS Pro Upgrade — ${restaurant || 'RestroPOS'}`;

  const html = `
<div style="font-family:Arial,sans-serif;background:#1A1A2E;color:#ffffff;padding:32px;border-radius:12px;max-width:560px;margin:0 auto">
  <div style="text-align:center;margin-bottom:24px">
    <h2 style="color:#22c55e;margin:0;font-size:22px">✓ Payment Successful</h2>
    <p style="color:#aaa;margin:8px 0 0;font-size:14px">RestroPOS Pro Upgrade — Invoice</p>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr><td style="color:#888;padding:6px 0;width:140px">Restaurant</td><td style="color:#fff">${restaurant || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Amount Paid</td><td style="color:#22c55e;font-weight:bold;font-size:16px">${amountStr}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Payment ID</td><td style="color:#fff;font-family:monospace;font-size:12px">${paymentId || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Order ID</td><td style="color:#fff;font-family:monospace;font-size:12px">${orderId || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Date</td><td style="color:#fff">${dateStr}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Plan</td><td style="color:#fff">Pro (Lifetime)</td></tr>
  </table>
  <hr style="border:none;border-top:1px solid #2E3155;margin:20px 0">
  <div style="text-align:center;margin-bottom:16px">
    <p style="color:#aaa;font-size:12px;letter-spacing:1px;margin:0 0 8px">YOUR PRO UPGRADE KEY</p>
  </div>
  <div style="background:#22243A;border:1px solid #E53935;border-radius:8px;padding:16px;margin:8px 0">
    <p style="color:#ffffff;word-break:break-all;font-family:monospace;font-size:11px;margin:0;line-height:1.6">${token}</p>
  </div>
  <p style="color:#aaa;font-size:13px;line-height:1.6;margin-top:16px">
    Apply this key in RestroPOS under <strong>Settings &rsaquo; License &rsaquo; Upgrade to Pro</strong>.<br>
    Your upgrade will activate all Pro features including Captain, Inventory, and Advanced Reports modules.
  </p>
  <p style="color:#555;font-size:11px;margin-top:24px;text-align:center">
    This is a computer-generated receipt. No signature required.<br>
    RestroPOS &bull; Powered by iMaker Technology &bull; support@imaker.technology
  </p>
</div>`;

  const text =
    `PAYMENT RECEIPT — RestroPOS Pro Upgrade\n` +
    `========================================\n\n` +
    `Restaurant  : ${restaurant || '—'}\n` +
    `Amount Paid : ${amountStr}\n` +
    `Payment ID  : ${paymentId || '—'}\n` +
    `Order ID    : ${orderId || '—'}\n` +
    `Date        : ${dateStr}\n` +
    `Plan        : Pro (Lifetime)\n\n` +
    `--- PRO UPGRADE KEY ---\n${token}\n--- END ---\n\n` +
    `Apply this key in RestroPOS under Settings > License > Upgrade to Pro.\n\n` +
    `This is a computer-generated receipt. No signature required.\n` +
    `RestroPOS | Powered by iMaker Technology | support@imaker.technology`;

  return sendMail(to, subject, html, text);
};

/**
 * Send offline activation token email.
 */
const sendActivationTokenEmail = async (to, data) => {
  if (!to) return;

  const { token, licenseId, restaurant, subscriptionExpiry, gracePeriodEnd, adminEmail, adminPassword } = data;
  const subject = `RestroPOS Offline Activation Token — ${restaurant || 'Your Restaurant'}`;

  const html = `
<div style="font-family:Arial,sans-serif;background:#1A1A2E;color:#ffffff;padding:32px;border-radius:12px;max-width:560px;margin:0 auto">
  <div style="text-align:center;margin-bottom:24px">
    <h2 style="color:#FFC107;margin:0;font-size:22px">RestroPOS Offline Activation</h2>
    <p style="color:#aaa;margin:8px 0 0;font-size:14px">Your annual subscription token is ready</p>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr><td style="color:#888;padding:6px 0;width:160px">Restaurant</td><td style="color:#fff">${restaurant || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">License ID</td><td style="color:#fff;font-family:monospace;font-size:12px">${licenseId || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Subscription Expiry</td><td style="color:#fff">${subscriptionExpiry || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Grace Period End</td><td style="color:#fff">${gracePeriodEnd || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Admin Email</td><td style="color:#fff">${adminEmail || '—'}</td></tr>
    <tr><td style="color:#888;padding:6px 0">Admin Password</td><td style="color:#fff;font-family:monospace">${adminPassword || '—'}</td></tr>
  </table>
  <div style="background:#22243A;border:1px solid #FFC107;border-radius:8px;padding:16px;margin:16px 0">
    <p style="color:#aaa;margin:0 0 8px;font-size:11px;letter-spacing:1px">OFFLINE ACTIVATION TOKEN</p>
    <p style="color:#ffffff;word-break:break-all;font-family:monospace;font-size:11px;margin:0;line-height:1.6">${token || '—'}</p>
  </div>
  <p style="color:#aaa;font-size:13px;line-height:1.6">
    Paste this token in the RestroPOS activation screen on your offline device.<br>
    <strong>Keep this token confidential. Do not share it.</strong>
  </p>
  <p style="color:#555;font-size:11px;margin-top:24px;text-align:center">RestroPOS &bull; Powered by iMaker Technology</p>
</div>`;

  const text =
    `RestroPOS Offline Activation Token\n` +
    `====================================\n\n` +
    `Restaurant         : ${restaurant || '—'}\n` +
    `License ID         : ${licenseId || '—'}\n` +
    `Subscription Expiry: ${subscriptionExpiry || '—'}\n` +
    `Grace Period End   : ${gracePeriodEnd || '—'}\n` +
    `Admin Email        : ${adminEmail || '—'}\n` +
    `Admin Password     : ${adminPassword || '—'}\n\n` +
    `--- OFFLINE ACTIVATION TOKEN ---\n${token || '—'}\n--- END ---\n\n` +
    `Paste this token in the RestroPOS activation screen on your offline device.\n` +
    `Keep this token confidential. Do not share it.\n\n` +
    `RestroPOS | Powered by iMaker Technology`;

  return sendMail(to, subject, html, text);
};

module.exports = { sendMail, sendMailWithAttachment, sendUpgradeTokenEmail, sendPaymentInvoiceEmail, sendSubscriptionReceiptEmail, sendActivationTokenEmail };
