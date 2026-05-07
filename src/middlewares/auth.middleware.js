const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt.config');
const logger = require('../utils/logger');
const { checkSubscription } = require('./subscription.middleware');

/**
 * Verify JWT token middleware
 * Extracts and validates the access token from Authorization header
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access token required',
        code: 'TOKEN_MISSING',
      });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, jwtConfig.secret, {
        algorithms: [jwtConfig.algorithm],
        issuer: jwtConfig.issuer,
      });

      // Attach user info to request
      req.user = {
        userId: decoded.userId,
        uuid: decoded.uuid,
        email: decoded.email,
        roles: decoded.roles || [],
        outletId: decoded.outletId,
      };

      // Subscription check — fast Redis-first, skips master & payment routes
      const subCheck = await checkSubscription(req, res);
      if (subCheck.responseSent) {
        return; // 403 already sent by subscription middleware
      }

      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Access token expired',
          code: 'TOKEN_EXPIRED',
        });
      }

      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid access token',
          code: 'TOKEN_INVALID',
        });
      }

      throw jwtError;
    }
  } catch (error) {
    logger.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

/**
 * Optional authentication - continues even if no token
 * Useful for endpoints that behave differently for authenticated users
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, jwtConfig.secret, {
      algorithms: [jwtConfig.algorithm],
      issuer: jwtConfig.issuer,
    });

    req.user = {
      userId: decoded.userId,
      uuid: decoded.uuid,
      email: decoded.email,
      roles: decoded.roles || [],
      outletId: decoded.outletId,
    };
  } catch (error) {
    req.user = null;
  }

  next();
};

/**
 * Role-based access control middleware
 * @param {...string} allowedRoles - Roles that can access the route
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        code: 'NOT_AUTHENTICATED',
      });
    }

    const userRoles = req.user.roles || [];

    // Master and Super admin have access to everything
    if (userRoles.includes('master') || userRoles.includes('super_admin')) {
      return next();
    }

    // Check if user has any of the allowed roles
    const hasRole = allowedRoles.some(role => userRoles.includes(role));

    if (!hasRole) {
      logger.warn(`Access denied for user ${req.user.userId}. Required: ${allowedRoles.join(', ')}, Has: ${userRoles.join(', ')}`);
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access this resource',
        code: 'FORBIDDEN',
      });
    }

    next();
  };
};

/**
 * Permission-based access control middleware
 * @param {...string} requiredPermissions - Permissions required (any one)
 */
const requirePermission = (...requiredPermissions) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        code: 'NOT_AUTHENTICATED',
      });
    }

    // Master and Super admin have all permissions
    if (req.user.roles.includes('master') || req.user.roles.includes('super_admin')) {
      return next();
    }

    try {
      // Get user permissions from service
      const authService = require('../services/auth.service');
      const userDetails = await authService.getCurrentUser(req.user.userId);
      
      const userPermissions = userDetails.permissions || [];

      // Check if user has any of the required permissions
      const hasPermission = requiredPermissions.some(perm => userPermissions.includes(perm));

      if (!hasPermission) {
        logger.warn(`Permission denied for user ${req.user.userId}. Required: ${requiredPermissions.join(', ')}`);
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to perform this action',
          code: 'PERMISSION_DENIED',
        });
      }

      // Attach permissions to request for later use
      req.user.permissions = userPermissions;
      next();
    } catch (error) {
      logger.error('Permission check failed:', error);
      next(error);
    }
  };
};

/**
 * Require all specified permissions (AND logic)
 */
const requireAllPermissions = (...requiredPermissions) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (req.user.roles.includes('master') || req.user.roles.includes('super_admin')) {
      return next();
    }

    try {
      const authService = require('../services/auth.service');
      const userDetails = await authService.getCurrentUser(req.user.userId);
      const userPermissions = userDetails.permissions || [];

      const hasAllPermissions = requiredPermissions.every(perm => userPermissions.includes(perm));

      if (!hasAllPermissions) {
        return res.status(403).json({
          success: false,
          message: 'You do not have all required permissions',
          code: 'PERMISSION_DENIED',
        });
      }

      req.user.permissions = userPermissions;
      next();
    } catch (error) {
      logger.error('Permission check failed:', error);
      next(error);
    }
  };
};

/**
 * Outlet-specific access control
 * Ensures user has access to the outlet specified in the request
 */
const requireOutletAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }

  // Master, Super admin and admin have access to all outlets
  if (req.user.roles.includes('master') || req.user.roles.includes('super_admin') || req.user.roles.includes('admin')) {
    return next();
  }

  const requestedOutletId = parseInt(
    req.params.outletId || req.body.outletId || req.query.outletId,
    10
  );

  // If user is bound to an outlet (from PIN login), verify it matches
  if (req.user.outletId && requestedOutletId && req.user.outletId !== requestedOutletId) {
    return res.status(403).json({
      success: false,
      message: 'You do not have access to this outlet',
      code: 'OUTLET_ACCESS_DENIED',
    });
  }

  next();
};

module.exports = {
  authenticate,
  optionalAuth,
  authorize,
  requirePermission,
  requireAllPermissions,
  requireOutletAccess,
};
