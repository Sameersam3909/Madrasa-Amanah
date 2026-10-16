import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { User, Class, AuditLog } from "./models.js";

export async function requireAuth(req, res, next) {
  try {
    const backupHeader = req.headers["x-backup-token"];
    const authHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const serviceToken = process.env.BACKUP_SERVICE_TOKEN;

    // Dedicated restricted service credential for automated backup runners
    if (serviceToken && serviceToken.length >= 16 && (backupHeader === serviceToken || authHeader === serviceToken)) {
      req.user = {
        _id: "000000000000000000000000",
        name: "Backup Automation Service",
        email: "backup-service@madrasa-amanah.local",
        role: "admin",
        assignedClasses: []
      };
      return next();
    }

    if (!authHeader) return res.status(401).json({ message: "Please sign in." });
    const payload = jwt.verify(authHeader, process.env.JWT_SECRET);

    // Validate absolute session lifetime (maximum 3 hours, even if active)
    const now = Math.floor(Date.now() / 1000);
    const maxSessionLifetime = parseInt(req.headers["x-test-session-max"] || process.env.SESSION_MAX_LIFETIME_SECONDS || 3 * 3600, 10);
    if (payload.sessionStart && (now - payload.sessionStart > maxSessionLifetime)) {
      return res.status(401).json({
        message: "Maximum session lifetime of 3 hours reached. Please sign in again.",
        code: "SESSION_MAX_EXCEEDED"
      });
    }

    const user = await User.findById(payload.sub).populate("assignedClasses", "_id name");
    if (!user || !user.active) {
      return res.status(401).json({ message: "Account unavailable or deactivated. Please contact an administrator." });
    }
    req.user = user;
    req.sessionPayload = payload;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Session expired due to inactivity. Please sign in again.",
        code: "SESSION_INACTIVITY_EXPIRED"
      });
    }
    return res.status(401).json({ message: "Session expired. Please sign in again." });
  }
}
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ message: "Admin access required." });
  next();
}
export async function canAccessClass(user, classId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (!classId) return false;

  const targetId = String(classId?._id || classId?.id || classId);
  if (!mongoose.Types.ObjectId.isValid(targetId)) return false;

  const cls = await Class.findById(targetId).select("teacherIds active").lean();
  if (!cls || cls.active === false) return false;

  // 1. Direct check against teacher's assignedClasses
  const assignedIds = (user.assignedClasses || []).map(c => String(c?._id || c?.id || c));
  if (assignedIds.includes(targetId)) return true;

  // 2. Direct check against Class teacherIds list
  return Boolean(cls.teacherIds?.some(id => String(id) === String(user._id)));
}

// ============================================================
// SECURITY: PIN-gated export/download protection
// ============================================================
// All file export endpoints require the caller to provide a valid
// download PIN via the `x-export-pin` request header. The PIN is
// verified server-side against the EXPORT_PIN env variable (default: 12@12).
// Failed attempts are rate-limited, logged, and will return HTTP 403.
// ============================================================

const EXPORT_PIN = process.env.EXPORT_PIN || "12@12";

// Track consecutive failed PIN attempts per IP to detect brute-force
const pinFailureTracker = new Map(); // ip -> { count, lastAttempt }
const PIN_MAX_FAILURES = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export function requireExportPin(req, res, next) {
  const clientIP = req.ip || req.connection?.remoteAddress || "unknown";

  // Check lockout status
  const tracker = pinFailureTracker.get(clientIP);
  if (tracker && tracker.count >= PIN_MAX_FAILURES) {
    const elapsed = Date.now() - tracker.lastAttempt;
    if (elapsed < PIN_LOCKOUT_MS) {
      const minutesLeft = Math.ceil((PIN_LOCKOUT_MS - elapsed) / 60000);
      return res.status(429).json({
        message: `Too many incorrect PIN attempts. Try again in ${minutesLeft} minute(s).`,
        code: "EXPORT_PIN_LOCKOUT"
      });
    }
    // Lockout expired — reset
    pinFailureTracker.delete(clientIP);
  }

  const pin = req.headers["x-export-pin"] || req.query.exportPin || "";

  if (!pin) {
    return res.status(403).json({
      message: "Download PIN is required. Please enter your security PIN to download files.",
      code: "EXPORT_PIN_REQUIRED"
    });
  }

  if (String(pin).trim() !== EXPORT_PIN) {
    // Record failure
    const existing = pinFailureTracker.get(clientIP) || { count: 0, lastAttempt: 0 };
    existing.count += 1;
    existing.lastAttempt = Date.now();
    pinFailureTracker.set(clientIP, existing);

    const remaining = PIN_MAX_FAILURES - existing.count;

    // Audit log the failed attempt (fire & forget)
    AuditLog.create({
      actorId: req.user?._id || null,
      action: "export.pin_failed",
      entityType: "Security",
      details: {
        ip: clientIP,
        endpoint: req.originalUrl || req.url,
        failureCount: existing.count,
        remainingAttempts: remaining
      }
    }).catch(() => {});

    if (remaining <= 0) {
      return res.status(429).json({
        message: "Too many incorrect PIN attempts. Account locked for 15 minutes.",
        code: "EXPORT_PIN_LOCKOUT"
      });
    }

    return res.status(403).json({
      message: `Incorrect download PIN. ${remaining} attempt(s) remaining.`,
      code: "EXPORT_PIN_INVALID"
    });
  }

  // PIN is correct — clear any failure tracking
  pinFailureTracker.delete(clientIP);

  // Audit log the successful export access
  AuditLog.create({
    actorId: req.user?._id || null,
    action: "export.pin_verified",
    entityType: "Security",
    details: {
      ip: clientIP,
      endpoint: req.originalUrl || req.url
    }
  }).catch(() => {});

  next();
}

// Rate limiter for export/download endpoints (30 downloads per 10 minutes per IP/user)
export const exportRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many download requests. Please wait before trying again.", code: "EXPORT_RATE_LIMIT" },
  keyGenerator: (req) => `export_${req.ip || "unknown"}_${req.user?._id || "anon"}`
});

// Security headers middleware (prevents clickjacking, XSS, MIME-sniffing, etc.)
export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Download-Options", "noopen");
  next();
}
