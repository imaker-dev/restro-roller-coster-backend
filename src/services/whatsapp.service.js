const axios = require('axios');
const FormData = require('form-data');
const { generateInvoicePDF } = require('../utils/invoice-pdf');
const logger = require('../utils/logger');

const WA_API_URL = 'https://graph.facebook.com/v21.0';
const PHONE_NUMBER_ID = () => process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = () => process.env.WHATSAPP_ACCESS_TOKEN;

const getCredentials = () => {
  const phoneNumberId = PHONE_NUMBER_ID();
  const accessToken = ACCESS_TOKEN();
  if (!phoneNumberId || !accessToken) {
    throw new Error('WhatsApp API credentials not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN)');
  }
  return { phoneNumberId, accessToken };
};

/**
 * Normalize phone number to E.164 format (e.g. 919876543210)
 * Strips spaces, dashes, +, and leading zeros.
 */
const normalizePhone = (phone) => {
  if (!phone) return null;
  let normalized = phone.toString().replace(/[\s\-().]/g, '');
  if (normalized.startsWith('+')) normalized = normalized.slice(1);
  // If 10-digit Indian number, prepend country code
  if (/^\d{10}$/.test(normalized)) normalized = `91${normalized}`;
  return normalized;
};

/**
 * Core send function — sends any WhatsApp message payload via Cloud API.
 * @param {string} to - Recipient phone number (raw, will be normalized)
 * @param {object} messagePayload - WhatsApp message object (text/template/interactive etc.)
 * @returns {Promise<object>} API response data
 */
const sendMessage = async (to, messagePayload) => {
  const phone = normalizePhone(to);
  if (!phone) throw new Error('Invalid phone number');
  const { phoneNumberId, accessToken } = getCredentials();

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    ...messagePayload,
  };

  try {
    const response = await axios.post(
      `${WA_API_URL}/${phoneNumberId}/messages`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    logger.info(`WhatsApp message sent to ${phone}`, { messageId: response.data?.messages?.[0]?.id });
    return response.data;
  } catch (error) {
    const errData = error.response?.data || error.message;
    logger.error(`WhatsApp send failed to ${phone}:`, errData);
    throw new Error(typeof errData === 'object' ? JSON.stringify(errData) : errData);
  }
};

/**
 * Send a plain text message.
 * @param {string} to
 * @param {string} text
 */
const sendText = (to, text) =>
  sendMessage(to, { type: 'text', text: { body: text, preview_url: false } });

/**
 * Send a WhatsApp template message.
 * @param {string} to
 * @param {string} templateName - Approved template name in Meta Business Manager
 * @param {string} languageCode - e.g. 'en_US', 'en'
 * @param {Array}  components   - Template components array (header/body/button parameters)
 */
const sendTemplate = (to, templateName, languageCode = 'en', components = []) =>
  sendMessage(to, {
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 && { components }),
    },
  });

/**
 * Send an interactive list message.
 * @param {string} to
 * @param {string} bodyText
 * @param {string} buttonLabel
 * @param {Array}  sections    - Array of { title, rows: [{ id, title, description }] }
 */
const sendList = (to, bodyText, buttonLabel, sections) =>
  sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonLabel, sections },
    },
  });

/**
 * Send an interactive reply-button message.
 * @param {string} to
 * @param {string} bodyText
 * @param {Array}  buttons  - Array of { id, title } (max 3)
 */
const sendButtons = (to, bodyText, buttons) =>
  sendMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  });

/**
 * Send a document (e.g. PDF invoice) by public URL.
 * @param {string} to
 * @param {string} documentUrl - Publicly accessible URL
 * @param {string} filename
 * @param {string} caption
 */
const sendDocument = (to, documentUrl, filename = 'document.pdf', caption = '') =>
  sendMessage(to, {
    type: 'document',
    document: { link: documentUrl, filename, caption },
  });

/**
 * Upload a PDF buffer to WhatsApp's media API and return the media_id.
 * @param {Buffer} pdfBuffer
 * @param {string} filename
 * @returns {Promise<string>} media_id
 */
const uploadMedia = async (pdfBuffer, filename = 'invoice.pdf') => {
  const { phoneNumberId, accessToken } = getCredentials();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

  try {
    const response = await axios.post(
      `${WA_API_URL}/${phoneNumberId}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...form.getHeaders(),
        },
      }
    );
    logger.info(`WhatsApp media uploaded: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    const errData = error.response?.data || error.message;
    logger.error('WhatsApp media upload failed:', errData);
    throw new Error(typeof errData === 'object' ? JSON.stringify(errData) : errData);
  }
};

/**
 * Generate invoice PDF in memory and send it as a WhatsApp document.
 * @param {string} to
 * @param {object} invoice - Formatted invoice object from billing.service
 * @param {object} outlet  - { name, address, phone, email, gstin }
 * @param {string} caption - Optional caption text
 * @returns {Promise<object>} API response
 */
const sendBillingPDF = async (to, invoice, outlet = {}, caption = '') => {
  // Map logo_url to logoUrl for invoice-pdf.js
  const outletWithLogo = { ...outlet, logoUrl: outlet.logo_url || outlet.logoUrl };
  const pdfDoc = await generateInvoicePDF(invoice, outletWithLogo);

  const pdfBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    pdfDoc.on('data', (chunk) => chunks.push(chunk));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
  });

  const filename = `Invoice-${invoice.invoiceNumber || 'bill'}.pdf`;
  const mediaId = await uploadMedia(pdfBuffer, filename);

  const messageCaption = caption ||
    `🧾 Invoice *${invoice.invoiceNumber}* from *${outlet.name || 'Restaurant'}*\nTotal: ₹${parseFloat(invoice.grandTotal).toFixed(2)}\nThank you for dining with us! 🙏`;

  return sendMessage(to, {
    type: 'document',
    document: {
      id: mediaId,
      filename,
      caption: messageCaption,
    },
  });
};

/**
 * Send billing PDF via a template that has a DOCUMENT header.
 * The template must be approved in Meta Business Manager with:
 *   - Header type: DOCUMENT
 *   - Body variables: {{1}} = customer name, {{2}} = invoice number, {{3}} = amount
 *
 * @param {string} to
 * @param {object} invoice
 * @param {object} outlet
 * @param {string} templateName  - Approved template name (default: 'send_invoice')
 * @param {string} languageCode
 */
const sendBillingPDFTemplate = async (to, invoice, outlet = {}, templateName = 'send_invoice', languageCode = 'en') => {
  // Map logo_url to logoUrl for invoice-pdf.js
  const outletWithLogo = { ...outlet, logoUrl: outlet.logo_url || outlet.logoUrl };
  const pdfDoc = await generateInvoicePDF(invoice, outletWithLogo);

  const pdfBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    pdfDoc.on('data', (chunk) => chunks.push(chunk));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
  });

  const filename = `Invoice-${invoice.invoiceNumber || 'bill'}.pdf`;
  const mediaId = await uploadMedia(pdfBuffer, filename);

  const components = [
    {
      type: 'header',
      parameters: [
        { type: 'document', document: { id: mediaId, filename } },
      ],
    },
    {
      type: 'body',
      parameters: [
        { type: 'text', text: invoice.customerName || 'Customer' },
        { type: 'text', text: invoice.invoiceNumber || '' },
        { type: 'text', text: outlet.name || 'Restaurant' },
        { type: 'text', text: `₹${parseFloat(invoice.grandTotal).toFixed(2)}` },
        { type: 'text', text: invoice.paymentStatus === 'paid' ? 'Paid' : 'Pending' },
      ],
    },
  ];

  return sendTemplate(to, templateName, languageCode, components);
};

/**
 * Send an image by URL.
 * @param {string} to
 * @param {string} imageUrl
 * @param {string} caption
 */
const sendImage = (to, imageUrl, caption = '') =>
  sendMessage(to, {
    type: 'image',
    image: { link: imageUrl, caption },
  });

// ---------------------------------------------------------------------------
// Domain-specific helpers
// ---------------------------------------------------------------------------

/**
 * Send billing summary as a plain text WhatsApp message.
 * Works without any pre-approved template.
 *
 * @param {string} to - Customer phone number
 * @param {object} invoice - Invoice object (from billing.service formatInvoice)
 * @param {object} [outlet]  - { name, phone, address }
 */
const sendBillingSummary = async (to, invoice, outlet = {}) => {
  const {
    invoiceNumber,
    invoiceDate,
    customerName,
    orderNumber,
    tableName,
    floorName,
    subtotal,
    discountAmount,
    totalTax,
    serviceCharge,
    grandTotal,
    paymentStatus,
    amountInWords,
    items = [],
  } = invoice;

  const outletName = outlet.name || 'Restaurant';
  const outletPhone = outlet.phone ? `\nPhone: ${outlet.phone}` : '';
  const outletAddress = outlet.address ? `\n${outlet.address}` : '';

  const tableInfo = tableName ? `\nTable: ${tableName}${floorName ? ` (${floorName})` : ''}` : '';
  const customerInfo = customerName ? `\nCustomer: ${customerName}` : '';

  const itemLines = items.length
    ? items
        .map(
          (item) =>
            `  • ${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ''} — ₹${parseFloat(item.totalPrice || item.price * item.quantity).toFixed(2)}`
        )
        .join('\n')
    : '';

  const discount = parseFloat(discountAmount) > 0 ? `\nDiscount: -₹${parseFloat(discountAmount).toFixed(2)}` : '';
  const tax = parseFloat(totalTax) > 0 ? `\nTax: ₹${parseFloat(totalTax).toFixed(2)}` : '';
  const sc = parseFloat(serviceCharge) > 0 ? `\nService Charge: ₹${parseFloat(serviceCharge).toFixed(2)}` : '';
  const words = amountInWords ? `\n(${amountInWords})` : '';
  const status = paymentStatus === 'paid' ? '✅ PAID' : '⏳ PENDING';

  const message = [
    `🧾 *Bill from ${outletName}*${outletAddress}${outletPhone}`,
    ``,
    `Invoice: *${invoiceNumber}*`,
    `Date: ${invoiceDate || new Date().toLocaleDateString('en-IN')}`,
    `Order: ${orderNumber || '-'}${tableInfo}${customerInfo}`,
    ``,
    itemLines ? `*Items:*\n${itemLines}\n` : '',
    `Subtotal: ₹${parseFloat(subtotal).toFixed(2)}${discount}${tax}${sc}`,
    `*Total: ₹${parseFloat(grandTotal).toFixed(2)}*${words}`,
    ``,
    `Status: ${status}`,
    ``,
    `Thank you for dining with us! 🙏`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  return sendText(to, message);
};

/**
 * Send billing details via a pre-approved WhatsApp template (text-only, no PDF).
 *
 * Matches this template body:
 *   Dear {{1}}, your invoice *{{2}}* from *{{3}}* has been generated.
 *   🧾 *Bill Summary*
 *   Amount: *{{4}}*
 *   Status: {{5}}
 *   Thank you for dining with us! 🙏
 *
 * Template body variables:
 *   {{1}} = customer name
 *   {{2}} = invoice number
 *   {{3}} = outlet/restaurant name
 *   {{4}} = grand total (e.g. ₹450.00)
 *   {{5}} = payment status (Paid / Pending)
 *
 * @param {string} to
 * @param {object} invoice
 * @param {string} outletName
 * @param {string} templateName - Approved template name in Meta Business Manager
 * @param {string} languageCode
 */
const sendBillingTemplate = (to, invoice, outletName = 'Restaurant', templateName = 'send_invoice', languageCode = 'en') => {
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: invoice.customerName || 'Customer' },
        { type: 'text', text: invoice.invoiceNumber || '' },
        { type: 'text', text: outletName },
        { type: 'text', text: `₹${parseFloat(invoice.grandTotal).toFixed(2)}` },
        { type: 'text', text: invoice.paymentStatus === 'paid' ? 'Paid' : 'Pending' },
      ],
    },
  ];
  return sendTemplate(to, templateName, languageCode, components);
};

/**
 * Send an order status update as plain text.
 * @param {string} to
 * @param {object} order - { orderNumber, status, tableName, items }
 * @param {string} outletName
 */
const sendOrderUpdate = (to, order, outletName = 'Restaurant') => {
  const statusEmoji = {
    pending: '🕐',
    confirmed: '✅',
    preparing: '👨‍🍳',
    ready: '🔔',
    served: '🍽️',
    completed: '✅',
    cancelled: '❌',
  };

  const emoji = statusEmoji[order.status] || '📋';
  const table = order.tableName ? ` | Table: ${order.tableName}` : '';

  const message = [
    `${emoji} *Order Update — ${outletName}*`,
    ``,
    `Order: *${order.orderNumber}*${table}`,
    `Status: *${(order.status || '').toUpperCase()}*`,
    ``,
    `Thank you for your patience! 🙏`,
  ].join('\n');

  return sendText(to, message);
};

/**
 * Generate subscription receipt PDF in memory and send it as a WhatsApp document.
 * @param {string} to
 * @param {object} receiptData - { receiptNo, date, outletName, baseAmount, gstAmount, totalAmount, gstPercentage, subscriptionStart, subscriptionEnd, paymentMode, paymentId }
 * @param {object} outlet  - { name, address, phone, email, gstin }
 * @param {string} caption - Optional caption text
 */
const sendSubscriptionReceiptPDF = async (to, receiptData, outlet = {}, caption = '') => {
  const { generateSubscriptionReceiptPDF } = require('../utils/subscription-receipt-pdf');
  const pdfBuffer = await generateSubscriptionReceiptPDF(receiptData, outlet);

  const filename = `Subscription-Receipt-${receiptData.receiptNo || 'receipt'}.pdf`;
  const mediaId = await uploadMedia(pdfBuffer, filename);

  const messageCaption = caption ||
    `🧾 Subscription Receipt #${receiptData.receiptNo}\n` +
    `Amount Paid: ₹${parseFloat(receiptData.totalAmount).toFixed(2)}\n` +
    `Valid Until: ${receiptData.subscriptionEnd || 'N/A'}\n` +
    `Thank you!`;

  return sendMessage(to, {
    type: 'document',
    document: {
      id: mediaId,
      filename,
      caption: messageCaption,
    },
  });
};

module.exports = {
  sendMessage,
  sendText,
  sendTemplate,
  sendList,
  sendButtons,
  sendDocument,
  sendImage,
  uploadMedia,
  sendBillingPDF,
  sendBillingPDFTemplate,
  sendBillingSummary,
  sendBillingTemplate,
  sendOrderUpdate,
  sendSubscriptionReceiptPDF,
  normalizePhone,
};
