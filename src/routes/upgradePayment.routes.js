const express = require('express');
const router  = express.Router();
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { createOrder, verifyAndUpgrade, cancelOrder, getPricing, checkoutPage, paymentCallback } = require('../controllers/upgradePayment.controller');

// 10 order attempts per IP per 15 min
const orderLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many requests. Please try again after 15 minutes.' },
});

// 5 verify attempts per IP per 5 min (stricter — prevents brute-force signature guessing)
const verifyLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many verification attempts. Please try again.' },
});

/**
 * @route   GET  /api/v1/upgrade-payment/pricing
 * @desc    Get current upgrade price (dynamic, from env)
 * @access  Public
 */
router.get('/pricing', getPricing);

/**
 * @route   GET  /api/v1/upgrade-payment/checkout-page
 * @desc    Serves the Razorpay checkout HTML from a real HTTPS URL (fixes WebView2 cross-origin iframe)
 * @access  Public
 * @query   order_id, key_id, amount, restaurant, email, phone
 */
router.get('/checkout-page', checkoutPage);

/**
 * @route   POST|GET  /api/v1/upgrade-payment/payment-callback
 * @desc    Razorpay redirects here after payment; renders result page for Flutter JS bridge
 * @access  Public
 */
router.post('/payment-callback', paymentCallback);
router.get('/payment-callback', paymentCallback);

/**
 * @route   POST /api/v1/upgrade-payment/create-order
 * @desc    Create a Razorpay order for a Pro plan upgrade
 * @access  Public
 * @body    { license_id }
 */
router.post('/create-order', orderLimiter, createOrder);

/**
 * @route   POST /api/v1/upgrade-payment/verify
 * @desc    Verify Razorpay payment, generate upgrade token, send notifications
 * @access  Public
 * @body    { razorpay_payment_id, razorpay_order_id, razorpay_signature }
 */
router.post('/verify', verifyLimiter, verifyAndUpgrade);

/**
 * @route   POST /api/v1/upgrade-payment/cancel
 * @desc    Mark a created order as cancelled
 * @access  Public
 * @body    { razorpay_order_id }
 */
router.post('/cancel', orderLimiter, cancelOrder);

module.exports = router;
