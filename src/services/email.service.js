const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT) || 587,
    secure: parseInt(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return transporter;
};

const sendMail = async (to, subject, html, text = '') => {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env)');
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const domain = from.split('@')[1] || 'restropos.com';
  const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`;

  await transport.sendMail({
    from: `"RestroPOS" <${from}>`,
    to,
    replyTo: from,
    subject,
    messageId: msgId,
    headers: {
      'X-Mailer': 'RestroPOS Notification System',
      'X-Entity-Ref-ID': msgId,
      'Precedence': 'transactional',
      'List-Unsubscribe': `<mailto:support@${domain}>`,
    },
    html,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  });

  logger.info(`[Email] Sent: "${subject}" → ${to}`);
};

const sendActivationTokenEmail = async (to, { restaurant, licenseId, token, plan, adminEmail, adminPassword, maxOutlets }) => {
  const planLabel = plan === 'pro' ? '🚀 Pro' : '🆓 Free';
  const maxOutletsText = maxOutlets > 1 ? `${maxOutlets} outlets` : '1 outlet';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <div style="background:#1a73e8;padding:24px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:22px">🎉 Welcome to RestroPOS!</h1>
    </div>
    <div style="padding:32px">
      <p style="color:#333;font-size:16px">Dear <strong>${restaurant}</strong>,</p>
      <p style="color:#555;line-height:1.6">Your RestroPOS activation token is ready. Use it in the app to activate your license.</p>

      <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#f8f9fa;border-radius:6px">
        <tr><td style="padding:10px 16px;color:#888;font-size:13px;border-bottom:1px solid #eee;width:40%">Restaurant</td><td style="padding:10px 16px;font-weight:bold;border-bottom:1px solid #eee">${restaurant}</td></tr>
        <tr><td style="padding:10px 16px;color:#888;font-size:13px;border-bottom:1px solid #eee">Plan</td><td style="padding:10px 16px;border-bottom:1px solid #eee">${planLabel} — ${maxOutletsText}</td></tr>
        <tr><td style="padding:10px 16px;color:#888;font-size:13px;border-bottom:1px solid #eee">License ID</td><td style="padding:10px 16px;font-size:12px;font-family:monospace;border-bottom:1px solid #eee">${licenseId}</td></tr>
        <tr><td style="padding:10px 16px;color:#888;font-size:13px;border-bottom:1px solid #eee">Admin Email</td><td style="padding:10px 16px;border-bottom:1px solid #eee">${adminEmail}</td></tr>
        <tr><td style="padding:10px 16px;color:#888;font-size:13px">Admin Password</td><td style="padding:10px 16px;font-family:monospace;font-weight:bold">${adminPassword}</td></tr>
      </table>

      <p style="color:#333;font-weight:bold;margin-top:24px;margin-bottom:8px">🔑 Activation Token:</p>
      <div style="background:#1e1e1e;border-radius:6px;padding:16px">
        <code style="color:#4fc3f7;font-size:11px;word-break:break-all;white-space:pre-wrap;display:block">${token}</code>
      </div>

      <p style="color:#555;font-size:13px;margin-top:16px;line-height:1.6">
        Copy the token above and paste it in the RestroPOS app on the <strong>Activation</strong> screen.
      </p>
      <p style="color:#e53935;font-size:13px">⚠️ Keep this token confidential. Do not share it with anyone outside your team.</p>
    </div>
    <div style="background:#f8f9fa;padding:16px;text-align:center;color:#aaa;font-size:12px">
      RestroPOS &bull; Powered by iMaker
    </div>
  </div>
</body>
</html>`;

  const subject = `RestroPOS License Ready — ${restaurant}`;

  const text =
    `Welcome to RestroPOS!\n\n` +
    `Restaurant : ${restaurant}\n` +
    `Plan       : ${plan === 'pro' ? 'Pro' : 'Free'} — ${maxOutletsText}\n` +
    `License ID : ${licenseId}\n` +
    `Admin Email: ${adminEmail}\n` +
    `Password   : ${adminPassword}\n\n` +
    `--- ACTIVATION KEY ---\n${token}\n--- END ---\n\n` +
    `Copy the key above and paste it in the RestroPOS Activation screen.\n` +
    `Keep this email confidential.\n\n` +
    `RestroPOS | Powered by iMaker`;

  return sendMail(to, subject, html, text);
};

const sendUpgradeTokenEmail = async (to, { restaurant, newLicenseId, token, upgradesFrom }) => {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <div style="background:#6a1b9a;padding:24px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:22px">🚀 RestroPOS Pro Upgrade</h1>
    </div>
    <div style="padding:32px">
      <p style="color:#333;font-size:16px">Dear <strong>${restaurant || 'Valued Customer'}</strong>,</p>
      <p style="color:#555;line-height:1.6">Your Pro upgrade token is ready. Apply it in the app to unlock all Pro features.</p>

      <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#f8f9fa;border-radius:6px">
        <tr><td style="padding:10px 16px;color:#888;font-size:13px;border-bottom:1px solid #eee;width:40%">Restaurant</td><td style="padding:10px 16px;font-weight:bold;border-bottom:1px solid #eee">${restaurant || '—'}</td></tr>
        <tr><td style="padding:10px 16px;color:#888;font-size:13px;border-bottom:1px solid #eee">New License ID</td><td style="padding:10px 16px;font-size:12px;font-family:monospace;border-bottom:1px solid #eee">${newLicenseId}</td></tr>
        <tr><td style="padding:10px 16px;color:#888;font-size:13px">Upgraded From</td><td style="padding:10px 16px;font-size:12px;font-family:monospace">${upgradesFrom}</td></tr>
      </table>

      <p style="color:#333;font-weight:bold;margin-top:24px;margin-bottom:8px">🔑 Pro Upgrade Token:</p>
      <div style="background:#1e1e1e;border-radius:6px;padding:16px">
        <code style="color:#ce93d8;font-size:11px;word-break:break-all;white-space:pre-wrap;display:block">${token}</code>
      </div>

      <p style="color:#555;font-size:13px;margin-top:16px;line-height:1.6">
        Apply this token in RestroPOS under <strong>Settings → License → Upgrade to Pro</strong>.
      </p>
      <p style="color:#e53935;font-size:13px">⚠️ This token is bound to your license. Keep it confidential.</p>
    </div>
    <div style="background:#f8f9fa;padding:16px;text-align:center;color:#aaa;font-size:12px">
      RestroPOS &bull; Powered by iMaker
    </div>
  </div>
</body>
</html>`;

  const subject = `RestroPOS Pro License Ready — ${restaurant || 'RestroPOS'}`;

  const text =
    `RestroPOS Pro Upgrade\n\n` +
    `Restaurant  : ${restaurant || '—'}\n` +
    `New License : ${newLicenseId}\n` +
    `Upgraded From: ${upgradesFrom}\n\n` +
    `--- PRO UPGRADE KEY ---\n${token}\n--- END ---\n\n` +
    `Apply this key in RestroPOS under Settings > License > Upgrade to Pro.\n` +
    `Keep this email confidential.\n\n` +
    `RestroPOS | Powered by iMaker`;

  return sendMail(to, subject, html, text);
};

module.exports = { sendMail, sendActivationTokenEmail, sendUpgradeTokenEmail };
