import mongoose from "mongoose";
import { SystemSetting, AuditLog, Class, Student, Attendance, SyncMutation } from "./models.js";

let secondaryConnection = null;
let lastHealthCheck = null;

export function maskMongoUri(uri) {
  if (!uri) return "";
  try {
    return uri.replace(/\/\/[^:]+:[^@]+@/, "//****:****@");
  } catch {
    return "mongodb://****:****@cluster";
  }
}

export function extractHostFromUri(uri) {
  if (!uri) return "Not configured";
  try {
    const match = uri.match(/@([^/?#]+)/);
    return match ? match[1] : "configured";
  } catch {
    return "configured";
  }
}

export async function getSecondaryConnection() {
  const secondaryUri = process.env.MONGODB_URI_SECONDARY;
  if (!secondaryUri) return null;

  if (secondaryConnection && secondaryConnection.readyState === 1) {
    return secondaryConnection;
  }

  try {
    secondaryConnection = await mongoose.createConnection(secondaryUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000
    }).asPromise();
    return secondaryConnection;
  } catch (err) {
    console.warn("[STORAGE] Secondary MongoDB connection attempt failed:", err.message);
    return null;
  }
}

export async function verifySecondaryDatabase() {
  const secondaryUri = process.env.MONGODB_URI_SECONDARY;
  if (!secondaryUri) {
    return {
      success: false,
      configured: false,
      message: "Secondary database URI (MONGODB_URI_SECONDARY) is not configured in server environment."
    };
  }

  const startTime = Date.now();
  let conn = null;
  try {
    conn = await mongoose.createConnection(secondaryUri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    }).asPromise();

    // Ping check
    await conn.db.command({ ping: 1 });
    const pingMs = Date.now() - startTime;

    // Verify and ensure indexes on secondary database
    const classCol = conn.collection("classes");
    await classCol.createIndex({ name: 1, section: 1, academicYear: 1 }, { unique: true });

    const studentCol = conn.collection("students");
    await studentCol.createIndex({ admissionNo: 1 }, { unique: true });
    await studentCol.createIndex({ classId: 1, active: 1 });

    const attCol = conn.collection("attendances");
    await attCol.createIndex({ studentId: 1, classId: 1, dateKey: 1, sessionKey: 1 }, { unique: true });
    await attCol.createIndex({ classId: 1, dateKey: 1, sessionKey: 1 });
    await attCol.createIndex({ dateKey: -1 });

    const syncCol = conn.collection("syncmutations");
    await syncCol.createIndex({ mutationId: 1 }, { unique: true });

    const auditCol = conn.collection("auditlogs");
    await auditCol.createIndex({ createdAt: -1 });

    secondaryConnection = conn;

    return {
      success: true,
      configured: true,
      host: extractHostFromUri(secondaryUri),
      database: conn.name || "madrasa_attendance",
      pingMs,
      indexesVerified: true,
      verifiedAt: new Date().toISOString(),
      message: "Secondary database verified successfully with all schemas and indexes initialized."
    };
  } catch (err) {
    return {
      success: false,
      configured: true,
      host: extractHostFromUri(secondaryUri),
      error: err.message,
      verifiedAt: new Date().toISOString(),
      message: `Secondary database connection or verification failed: ${err.message}`
    };
  }
}

export async function getStorageMetrics() {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return { available: false, statusText: "Database disconnected" };
    }

    const stats = await mongoose.connection.db.command({ dbStats: 1, scale: 1024 * 1024 });
    const dataSizeMB = +(stats.dataSize || 0).toFixed(2);
    const storageSizeMB = +(stats.storageSize || 0).toFixed(2);
    const indexSizeMB = +(stats.indexSize || 0).toFixed(2);
    const totalSizeMB = +(storageSizeMB + indexSizeMB).toFixed(2);

    // Standard Atlas M0 quota is 512 MB. Configurable via PRIMARY_STORAGE_LIMIT_MB.
    const limitMB = Number(process.env.PRIMARY_STORAGE_LIMIT_MB || 512);
    const usagePercent = limitMB > 0 ? Math.min(100, Math.round((totalSizeMB / limitMB) * 100)) : 0;

    return {
      available: true,
      dataSizeMB,
      storageSizeMB,
      indexSizeMB,
      totalSizeMB,
      limitMB,
      usagePercent,
      objectsCount: stats.objects || 0,
      collectionsCount: stats.collections || 0,
      statusText: `${totalSizeMB} MB of ${limitMB} MB (${usagePercent}%)`
    };
  } catch (err) {
    // Per requirements: If storage metrics cannot be retrieved, display "Storage usage unavailable" rather than inventing a percentage
    return {
      available: false,
      statusText: "Storage usage unavailable",
      error: err.message
    };
  }
}

export async function getStorageHealthReport() {
  lastHealthCheck = new Date().toISOString();

  const primaryUri = process.env.MONGODB_URI_PRIMARY || process.env.MONGODB_URI || "";
  const secondaryUri = process.env.MONGODB_URI_SECONDARY || "";
  const warningPercent = Number(process.env.DATABASE_STORAGE_WARNING_PERCENT || 70);
  const criticalPercent = Number(process.env.DATABASE_STORAGE_CRITICAL_PERCENT || 85);
  const rotationConfigured = process.env.DATABASE_ROTATION_ENABLED === "true";

  // System settings
  let settings = null;
  try {
    settings = await SystemSetting.findOne({ key: "global" });
  } catch {
    // If not yet seeded, continue with defaults
  }

  const activeWriteTarget = settings?.activeWriteTarget || "primary";
  const databaseRotationEnabled = settings?.databaseRotationEnabled ?? rotationConfigured;
  const rotationHistory = settings?.rotationHistory || [];

  // Storage Metrics
  const primaryMetrics = await getStorageMetrics();

  // Status evaluation
  let storageStatus = "normal";
  if (primaryMetrics.available) {
    if (primaryMetrics.usagePercent >= criticalPercent) {
      storageStatus = "critical";
    } else if (primaryMetrics.usagePercent >= warningPercent) {
      storageStatus = "warning";
    }
  }

  // Secondary status
  const secondaryConfigured = Boolean(secondaryUri && secondaryUri.length > 10);
  const secondaryConnected = Boolean(secondaryConnection && secondaryConnection.readyState === 1);

  // Check last backup
  let lastBackupLog = null;
  try {
    lastBackupLog = await AuditLog.findOne({
      action: { $in: ["backup.monthly_export", "backup.export"] }
    }).sort({ createdAt: -1 });
  } catch {}

  return {
    timestamp: lastHealthCheck,
    primary: {
      status: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      host: extractHostFromUri(primaryUri),
      databaseName: mongoose.connection.name || "madrasa_attendance",
      metrics: primaryMetrics,
      warningThresholdPercent: warningPercent,
      criticalThresholdPercent: criticalPercent,
      storageStatus
    },
    secondary: {
      configured: secondaryConfigured,
      status: secondaryConnected ? "connected" : (secondaryConfigured ? "configured" : "not_configured"),
      host: extractHostFromUri(secondaryUri),
      databaseName: secondaryConnection?.name || "madrasa_attendance"
    },
    activeWriteDestination: activeWriteTarget,
    rotationEnabled: databaseRotationEnabled,
    rotationHistory,
    lastBackup: lastBackupLog ? {
      action: lastBackupLog.action,
      timestamp: lastBackupLog.createdAt,
      details: lastBackupLog.details
    } : null
  };
}

export async function rotateWriteDestination({ target, reason, trigger = "admin", actorId = null }) {
  if (!["primary", "secondary"].includes(target)) {
    throw new Error("Invalid rotation destination. Expected 'primary' or 'secondary'.");
  }

  if (target === "secondary") {
    const verifyRes = await verifySecondaryDatabase();
    if (!verifyRes.success) {
      throw new Error(`Cannot rotate to secondary database: ${verifyRes.message}`);
    }
  }

  let settings = await SystemSetting.findOne({ key: "global" });
  if (!settings) {
    settings = new SystemSetting({ key: "global" });
  }

  const previousTarget = settings.activeWriteTarget || "primary";
  settings.activeWriteTarget = target;
  settings.rotationHistory.push({
    timestamp: new Date(),
    from: previousTarget,
    to: target,
    reason: reason || `Storage rotation triggered by ${trigger}`,
    trigger
  });

  await settings.save();

  if (actorId) {
    await AuditLog.create({
      actorId,
      action: "storage.rotate",
      entityType: "SystemSetting",
      entityId: String(settings._id),
      details: { from: previousTarget, to: target, reason, trigger }
    });
  }

  return {
    success: true,
    previousDestination: previousTarget,
    activeWriteDestination: target,
    rotatedAt: new Date().toISOString()
  };
}
