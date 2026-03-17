module.exports = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, curl)
    // or any origin (for development/production flexibility)
    callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Device-Id',
    'X-Outlet-Id',
    'X-App-Version',
    'Accept',
    'Origin',
  ],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count'],
  credentials: true,
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
