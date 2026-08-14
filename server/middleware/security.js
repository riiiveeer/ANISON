import compression from 'compression';
import helmet from 'helmet';

const IMAGE_SOURCES = [
  "'self'",
  'data:',
  'https://*.music.126.net',
  'https://*.music.127.net',
  'https://*.music.163.com',
];

export function createCompressionMiddleware(options = {}) {
  return compression(options);
}

export function createSecurityMiddleware(options = {}) {
  const cspMode = normalizeCspMode(options.cspMode ?? process.env.CSP_MODE);
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || 'development';
  const helmetMiddleware = helmet({
    contentSecurityPolicy: {
      reportOnly: cspMode !== 'enforce',
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: IMAGE_SOURCES,
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        workerSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: false,
  });

  return function securityMiddleware(request, response, next) {
    helmetMiddleware(request, response, error => {
      if (error) {
        next(error);
        return;
      }
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (nodeEnv === 'production' && request.secure) {
        response.setHeader('Strict-Transport-Security', 'max-age=15552000');
      }
      next();
    });
  };
}

export function normalizeCspMode(value) {
  const mode = String(value || 'report-only').trim().toLowerCase();
  if (!['report-only', 'enforce'].includes(mode)) {
    throw new Error('CSP_MODE 必须是 report-only 或 enforce');
  }
  return mode;
}

export const __testables__ = { IMAGE_SOURCES };
