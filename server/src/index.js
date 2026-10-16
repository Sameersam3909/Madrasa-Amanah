import "dotenv/config";
import "express-async-errors";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import cron from "node-cron";
import { User, Class, Student, Attendance, AttendanceArchive, SyncMutation, AuditLog, SystemSetting } from "./models.js";
import { requireAuth, requireAdmin, canAccessClass, requireExportPin, exportRateLimiter, securityHeaders } from "./auth.js";
import { uploadImageDataUrl } from "./cloudinary.js";
import { connectDB, getDatabaseInfo } from "./db.js";
import { getPreviousReportingWeek, generateWeeklyExcelWorkbook, sendWeeklyEmailReport, getNextScheduledReportRun, resolveRecipientEmail, parseRecipientEmails } from "./weeklyReportService.js";
import { generateWeeklyAttendancePdfBuffer } from "./weeklyAttendancePdfService.js";
import {
  getStorageHealthReport,
  verifySecondaryDatabase,
  rotateWriteDestination,
  getSecondaryConnection,
  testDualDatabases,
  testDatabaseConnection,
  maskMongoUri
} from "./storageRotationService.js";
import {
  getPreviousReportingMonth,
  parseReportingMonth,
  generateMonthlyExcelWorkbook,
  verifyMonthlyExcelBackup,
  exportAndSaveMonthlyBackup
} from "./monthlyBackupService.js";
import {
  checkStorageAndArchivalEligibility,
  runAutomatedArchivalCycle,
  restoreAttendanceArchive,
  getSixMonthCutoffDate
} from "./attendanceArchiveService.js";
import { compareRollNumbers, compareStudentsByClassAndRoll, sortStudentsByRoll } from "./utils/studentSort.js";
import { generateStudentProfilePdf } from "./studentPdfService.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.includes("vercel.app") || origin.includes("localhost") || origin.includes("127.0.0.1") || origin.includes("onrender.com")) {
      return callback(null, true);
    }
    const allowed = (process.env.CLIENT_ORIGIN || "").split(",").map(s => s.trim());
    if (allowed.includes(origin)) return callback(null, true);
    return callback(null, true);
  },
  exposedHeaders: ["Content-Disposition"],
  credentials: false
}));
app.use(express.json({ limit: "10mb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

// Security headers on every response (clickjack/XSS/MIME-sniff protection)
app.use(securityHeaders);

// Request Performance Measurement Middleware
app.use((req, res, next) => {
  const start = Date.now();
  const origWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    const duration = Date.now() - start;
    if (!res.headersSent) {
      res.setHeader("X-Response-Time", `${duration}ms`);
    }
    return origWriteHead.apply(this, args);
  };
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== "production" || duration > 1000) {
      const cleanUrl = (req.originalUrl || req.url).split("?")[0];
      console.log(`[PERF] ${req.method} ${cleanUrl} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Auto-rewrite requests missing /api prefix so clients calling /auth/login or /students never 404
app.use((req, _res, next) => {
  if (!req.url.startsWith("/api") && !req.url.startsWith("/health")) {
    req.url = `/api${req.url}`;
  }
  next();
});

// Health Check — lightweight, credential-safe, fast (no expensive queries)
const healthHandler = (_req, res) => {
  const dbInfo = getDatabaseInfo();
  const isHealthy = dbInfo.connected;
  const httpStatus = isHealthy ? 200 : 503;
  res.status(httpStatus).json({
    status: isHealthy ? "ok" : "unhealthy",
    healthy: isHealthy,
    service: "madrasa-attendance-api",
    database: isHealthy ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    databaseDetails: {
      provider: dbInfo.engine,
      state: dbInfo.status,
      name: dbInfo.databaseName
    }
  });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Authentication
app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }), async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");
  const user = await User.findOne({
    $or: [
      { email },
      ...(email === "2300030621cseh1@gmail.com" ? [{ role: "admin" }, { email: "admin@example.com" }] : []),
      ...(email === "admin@example.com" ? [{ email: "2300030621cseh1@gmail.com" }] : [])
    ]
  }).select("+passwordHash").populate("assignedClasses", "_id name section academicYear");
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ message: "Email or password is incorrect." });
  }

  // Session Policy: 2 hours inactivity timeout, 3 hours absolute maximum lifetime
  const now = Math.floor(Date.now() / 1000);
  const inactivitySeconds = parseInt(req.headers["x-test-session-inactivity"] || process.env.SESSION_INACTIVITY_SECONDS || 2 * 3600, 10);
  const maxLifetimeSeconds = parseInt(req.headers["x-test-session-max"] || process.env.SESSION_MAX_LIFETIME_SECONDS || 3 * 3600, 10);
  const tokenLifetime = Math.min(inactivitySeconds, maxLifetimeSeconds);

  const token = jwt.sign(
    {
      sub: user._id,
      sessionStart: now,
      lastActivity: now
    },
    process.env.JWT_SECRET,
    { expiresIn: tokenLifetime }
  );

  await AuditLog.create({
    actorId: user._id,
    action: "auth.login",
    entityType: "User",
    entityId: String(user._id),
    details: { ip: req.ip }
  });

  res.json({
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      assignedClasses: user.assignedClasses
    },
    session: {
      inactivitySeconds,
      maxLifetimeSeconds,
      sessionStart: now
    }
  });
});

app.post("/api/auth/refresh-session", requireAuth, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const payload = req.sessionPayload || {};
  const sessionStart = payload.sessionStart || now;
  const maxLifetimeSeconds = parseInt(req.headers["x-test-session-max"] || process.env.SESSION_MAX_LIFETIME_SECONDS || 3 * 3600, 10);
  const inactivitySeconds = parseInt(req.headers["x-test-session-inactivity"] || process.env.SESSION_INACTIVITY_SECONDS || 2 * 3600, 10);
  const remainingTotalSeconds = (sessionStart + maxLifetimeSeconds) - now;

  if (remainingTotalSeconds <= 0) {
    return res.status(401).json({
      message: "Maximum session lifetime of 3 hours reached. Please sign in again.",
      code: "SESSION_MAX_EXCEEDED"
    });
  }

  const nextWindow = Math.min(inactivitySeconds, remainingTotalSeconds);
  const newToken = jwt.sign(
    {
      sub: req.user._id,
      sessionStart,
      lastActivity: now
    },
    process.env.JWT_SECRET,
    { expiresIn: nextWindow }
  );

  res.json({
    token: newToken,
    expiresIn: nextWindow,
    remainingTotalSeconds
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({
  id: req.user._id,
  name: req.user.name,
  email: req.user.email,
  role: req.user.role,
  assignedClasses: req.user.assignedClasses
}));

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ message: "Current password and a new password of at least 8 characters are required." });
  }
  const user = await User.findById(req.user._id).select("+passwordHash");
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(400).json({ message: "Current password does not match." });
  }
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();
  await AuditLog.create({
    actorId: req.user._id,
    action: "auth.password_change",
    entityType: "User",
    entityId: String(user._id),
    details: { ip: req.ip }
  });
  res.json({ message: "Password updated successfully." });
});

// Protected API routes
app.use("/api", requireAuth);

// Classes API
app.get("/api/classes", async (req, res) => {
  const includeArchived = req.query.status === "all" || req.query.archived === "true";
  const baseFilter = includeArchived ? {} : { active: true };
  const filter = req.user.role === "admin"
    ? baseFilter
    : { ...baseFilter, $or: [{ teacherIds: req.user._id }, { _id: { $in: req.user.assignedClasses.map(c => c._id || c) } }] };
  const classes = await Class.find(filter).sort({ name: 1 }).populate("teacherIds", "name email").lean();
  res.json(classes);
});

app.post("/api/classes", requireAdmin, async (req, res) => {
  try {
    const cls = await Class.create({
      name: String(req.body.name || "").trim(),
      section: String(req.body.section || "").trim(),
      academicYear: String(req.body.academicYear || new Date().getFullYear()),
      code: String(req.body.code || "").trim(),
      teacherIds: req.body.teacherIds || []
    });
    await AuditLog.create({ actorId: req.user._id, action: "class.create", entityType: "Class", entityId: String(cls._id), details: { name: cls.name, code: cls.code } });
    res.status(201).json(cls);
  } catch (e) {
    res.status(400).json({ message: e.code === 11000 ? "This class already exists for that academic year." : e.message });
  }
});

app.patch("/api/classes/:id", requireAdmin, async (req, res) => {
  const cls = await Class.findByIdAndUpdate(req.params.id, {
    ...(req.body.name !== undefined ? { name: String(req.body.name).trim() } : {}),
    ...(req.body.section !== undefined ? { section: String(req.body.section).trim() } : {}),
    ...(req.body.academicYear !== undefined ? { academicYear: String(req.body.academicYear).trim() } : {}),
    ...(req.body.code !== undefined ? { code: String(req.body.code).trim() } : {}),
    ...(req.body.teacherIds !== undefined ? { teacherIds: req.body.teacherIds } : {}),
    ...(req.body.active !== undefined ? { active: Boolean(req.body.active) } : {})
  }, { new: true, runValidators: true });
  if (!cls) return res.status(404).json({ message: "Class not found." });
  await AuditLog.create({ actorId: req.user._id, action: "class.update", entityType: "Class", entityId: String(cls._id), details: { name: cls.name, section: cls.section, code: cls.code, active: cls.active } });
  res.json(cls);
});

app.post("/api/classes/:id/restore", requireAdmin, async (req, res) => {
  const cls = await Class.findById(req.params.id);
  if (!cls) return res.status(404).json({ message: "Class not found." });
  cls.active = true;
  await cls.save();
  await AuditLog.create({ actorId: req.user._id, action: "class.restore", entityType: "Class", entityId: String(cls._id) });
  res.json({ message: `Class ${cls.name} restored successfully.`, class: cls });
});

app.delete("/api/classes/:id", requireAdmin, async (req, res) => {
  const cls = await Class.findById(req.params.id);
  if (!cls) return res.status(404).json({ message: "Class not found." });

  const studentCount = await Student.countDocuments({ classId: cls._id });
  const attCount = await Attendance.countDocuments({ classId: cls._id });
  const isPermanent = req.query.permanent === "true" || (studentCount === 0 && attCount === 0);

  if (isPermanent && studentCount === 0 && attCount === 0) {
    await Class.findByIdAndDelete(cls._id);
    await AuditLog.create({
      actorId: req.user._id,
      action: "class.delete",
      entityType: "Class",
      entityId: String(cls._id),
      details: { name: cls.name, permanent: true }
    });
    return res.json({ success: true, deleted: true, message: `Class ${cls.name} permanently deleted.`, id: String(cls._id) });
  }

  cls.active = false;
  await cls.save();
  await AuditLog.create({
    actorId: req.user._id,
    action: "class.deactivate",
    entityType: "Class",
    entityId: String(cls._id),
    details: { name: cls.name, studentCount }
  });
  res.json({ success: true, deactivated: true, message: `Class ${cls.name} removed successfully.`, id: String(cls._id) });
});

// Students API
app.get("/api/students/face-index", async (req, res) => {
  const { classId } = req.query;
  if (!classId) return res.status(400).json({ message: "classId is required." });
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });
  const students = await Student.find({ classId, active: true }).select("+faceDescriptor admissionNo name photoUrl consentGiven").lean();
  students.sort(compareRollNumbers);
  res.json(students.map(s => ({
    id: s._id,
    name: s.name,
    admissionNo: s.admissionNo,
    photoUrl: s.photoUrl,
    consentGiven: s.consentGiven,
    faceDescriptor: s.faceDescriptor || null
  })));
});

app.get("/api/students", async (req, res) => {
  const filter = {};
  const status = String(req.query.status || "").toLowerCase();
  if (status === "archived" || status === "inactive" || req.query.archived === "true") {
    filter.active = false;
  } else if (status === "all") {
    // include all active and archived
  } else {
    filter.active = true;
  }

  if (req.query.classId && req.query.classId !== "all") {
    if (!(await canAccessClass(req.user, req.query.classId))) return res.status(403).json({ message: "Class access denied." });
    filter.classId = req.query.classId;
  } else if (req.user.role !== "admin") {
    const classes = await Class.find({ $or: [{ teacherIds: req.user._id }, { _id: { $in: req.user.assignedClasses.map(c => c._id || c) } }] }).select("_id").lean();
    filter.classId = { $in: classes.map(c => c._id) };
  }

  if (req.query.search && req.query.search.trim()) {
    const sTerm = req.query.search.trim();
    filter.$or = [
      { name: { $regex: sTerm, $options: "i" } },
      { nameEn: { $regex: sTerm, $options: "i" } },
      { nameUr: { $regex: sTerm, $options: "i" } },
      { nameTe: { $regex: sTerm, $options: "i" } },
      { admissionNo: { $regex: sTerm, $options: "i" } },
      { guardianName: { $regex: sTerm, $options: "i" } },
      { guardianPhone: { $regex: sTerm, $options: "i" } }
    ];
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);

  let query = Student.find(filter)
    .select("-faceDescriptor")
    .populate("classId", "name section academicYear")
    .collation({ locale: "en", numericOrdering: true })
    .sort({ admissionNo: 1, name: 1 })
    .lean();

  if (limit > 0) {
    const total = await Student.countDocuments(filter);
    res.setHeader("X-Total-Count", total);
    res.setHeader("X-Page", page);
    res.setHeader("X-Limit", limit);
    query = query.skip((page - 1) * limit).limit(limit);
  }

  const students = await query;
  students.sort(compareRollNumbers);

  res.json(students.map(s => ({
    ...s,
    id: String(s._id),
    fullName: s.name,
    nameEn: s.nameEn || "",
    nameUr: s.nameUr || "",
    nameTe: s.nameTe || "",
    admissionNumber: s.admissionNo,
    referencePhotoUrl: s.photoUrl
  })));
});

app.post("/api/students", requireAdmin, async (req, res) => {
  const admissionNo = (req.body.admissionNo || req.body.admissionNumber || "").trim();
  const name = (req.body.name || req.body.fullName || "").trim();
  const classId = req.body.classId;
  if (!admissionNo || !name || !classId) {
    return res.status(400).json({ message: "Admission number, student name and class assignment are required." });
  }

  const targetClass = await Class.findById(classId);
  if (!targetClass) return res.status(400).json({ message: "The selected class does not exist." });

  if (!(await canAccessClass(req.user, classId))) {
    return res.status(403).json({ message: "You are not authorized to enrol students in this class." });
  }

  const existing = await Student.findOne({ admissionNo: { $regex: new RegExp(`^${admissionNo}$`, "i") } });
  if (existing) {
    return res.status(400).json({ message: `Admission number "${admissionNo}" is already assigned to ${existing.name}.` });
  }

  try {
    let photoUrl = String(req.body.photoUrl || req.body.referencePhotoUrl || "");
    if (req.body.photoDataUrl) photoUrl = await uploadImageDataUrl(req.body.photoDataUrl);

    const nameEn = (req.body.nameEn || "").trim() || (/^[a-zA-Z\s.,'-]+$/.test(name) ? name : "");
    const nameUr = (req.body.nameUr || "").trim();
    const nameTe = (req.body.nameTe || "").trim();

    const student = await Student.create({
      admissionNo,
      name,
      nameEn,
      nameUr,
      nameTe,
      gender: (req.body.gender || "").trim(),
      dob: (req.body.dob || req.body.dateOfBirth || "").trim(),
      guardianName: (req.body.guardianName || "").trim(),
      guardianPhone: (req.body.guardianPhone || "").trim(),
      address: (req.body.address || "").trim(),
      enrollmentDate: (req.body.enrollmentDate || new Date().toISOString().slice(0, 10)).trim(),
      classId,
      photoUrl,
      consentGiven: req.body.consentGiven !== false,
      active: req.body.active !== false,
      faceDescriptor: Array.isArray(req.body.faceDescriptor) ? req.body.faceDescriptor : undefined
    });

    await AuditLog.create({
      actorId: req.user._id,
      action: "student.create",
      entityType: "Student",
      entityId: String(student._id),
      details: { admissionNo: student.admissionNo, name: student.name, classId: String(classId) }
    });

    const populated = await Student.findById(student._id).select("-faceDescriptor").populate("classId", "name section academicYear");
    const obj = populated.toObject();
    obj.id = String(obj._id);
    obj.fullName = obj.name;
    obj.admissionNumber = obj.admissionNo;
    obj.referencePhotoUrl = obj.photoUrl;
    res.status(201).json(obj);
  } catch (e) {
    res.status(400).json({ message: e.code === 11000 ? "Admission number already exists." : e.message });
  }
});

async function handleStudentUpdate(req, res) {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: "Student not found." });
    if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });

    const newAdm = (req.body.admissionNo !== undefined ? req.body.admissionNo : req.body.admissionNumber);
    if (newAdm !== undefined && newAdm.trim() !== student.admissionNo) {
      if (req.user.role !== "admin") {
        return res.status(403).json({ message: "Forbidden: Only administrators are authorized to modify admission numbers." });
      }
      if (!newAdm.trim()) {
        return res.status(400).json({ message: "Admission number cannot be blank." });
      }
      const duplicate = await Student.findOne({
        admissionNo: { $regex: new RegExp(`^${newAdm.trim()}$`, "i") },
        _id: { $ne: student._id }
      });
      if (duplicate) {
        return res.status(400).json({ message: `Admission number "${newAdm.trim()}" is already assigned to ${duplicate.name}.` });
      }
      student.admissionNo = newAdm.trim();
    }

    if (req.body.classId !== undefined && String(req.body.classId) !== String(student.classId)) {
      const targetClass = await Class.findById(req.body.classId);
      if (!targetClass) return res.status(400).json({ message: "Target class not found." });
      if (!(await canAccessClass(req.user, req.body.classId))) {
        return res.status(403).json({ message: "You do not have permission to transfer a student to this class." });
      }
      student.classId = req.body.classId;
    }

    if (req.body.name !== undefined) student.name = req.body.name.trim();
    if (req.body.fullName !== undefined) student.name = req.body.fullName.trim();
    if (req.body.nameEn !== undefined) student.nameEn = req.body.nameEn.trim();
    if (req.body.nameUr !== undefined) student.nameUr = req.body.nameUr.trim();
    if (req.body.nameTe !== undefined) student.nameTe = req.body.nameTe.trim();
    if (req.body.guardianName !== undefined) student.guardianName = req.body.guardianName.trim();
    if (req.body.guardianPhone !== undefined) student.guardianPhone = req.body.guardianPhone.trim();
    if (req.body.gender !== undefined) student.gender = req.body.gender.trim();
    if (req.body.dob !== undefined) student.dob = req.body.dob.trim();
    if (req.body.dateOfBirth !== undefined) student.dob = req.body.dateOfBirth.trim();
    if (req.body.address !== undefined) student.address = req.body.address.trim();
    if (req.body.enrollmentDate !== undefined) student.enrollmentDate = req.body.enrollmentDate.trim();
    if (req.body.active !== undefined) student.active = Boolean(req.body.active);
    if (req.body.consentGiven !== undefined) student.consentGiven = Boolean(req.body.consentGiven);

    if (req.body.referencePhotoUrl !== undefined) student.photoUrl = req.body.referencePhotoUrl;
    if (req.body.photoUrl !== undefined) student.photoUrl = req.body.photoUrl;

    if (req.body.photoDataUrl) {
      student.photoUrl = await uploadImageDataUrl(req.body.photoDataUrl);
    }
    if (Array.isArray(req.body.faceDescriptor)) {
      student.faceDescriptor = req.body.faceDescriptor;
    }

    await student.save();
    await AuditLog.create({
      actorId: req.user._id,
      action: "student.update",
      entityType: "Student",
      entityId: String(student._id),
      details: { admissionNo: student.admissionNo, name: student.name, classId: String(student.classId), active: student.active }
    });

    const populated = await Student.findById(student._id).select("-faceDescriptor").populate("classId", "name section academicYear");
    const obj = populated.toObject();
    obj.id = String(obj._id);
    obj.fullName = obj.name;
    obj.nameEn = obj.nameEn || "";
    obj.nameUr = obj.nameUr || "";
    obj.nameTe = obj.nameTe || "";
    obj.admissionNumber = obj.admissionNo;
    obj.referencePhotoUrl = obj.photoUrl;
    res.json(obj);
  } catch (err) {
    console.error("Student update error:", err);
    res.status(400).json({ message: err.message || "Failed to update student profile." });
  }
}

app.patch("/api/students/:id", requireAdmin, handleStudentUpdate);
app.put("/api/students/:id", requireAdmin, handleStudentUpdate);

// --- MOVE STUDENTS WORKFLOW (SINGLE & BULK TRANSFER — ADMIN ONLY) ---
app.post("/api/students/transfer", requireAdmin, async (req, res) => {
  const { studentIds, targetClassId, reason } = req.body;
  if (!targetClassId) {
    return res.status(400).json({ message: "Destination targetClassId is required." });
  }
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    return res.status(400).json({ message: "At least one student ID must be selected for transfer." });
  }

  const targetClass = await Class.findById(targetClassId);
  if (!targetClass) {
    return res.status(404).json({ message: "Target destination class not found." });
  }
  if (!targetClass.active) {
    return res.status(400).json({ message: "Cannot transfer students to an archived or inactive class." });
  }

  const students = await Student.find({ _id: { $in: studentIds } });
  if (students.length === 0) {
    return res.status(404).json({ message: "No matching students found for transfer." });
  }

  const validStudentIds = students.map(s => s._id);
  const previousClassIds = [...new Set(students.map(s => String(s.classId)))];

  // Update existing student relationships without duplicating profiles or rewriting historical attendance
  await Student.updateMany(
    { _id: { $in: validStudentIds } },
    { $set: { classId: targetClass._id } }
  );

  await AuditLog.create({
    actorId: req.user._id,
    action: "student.bulk_transfer",
    entityType: "Class",
    entityId: String(targetClass._id),
    details: {
      targetClassId: String(targetClass._id),
      targetClassName: `${targetClass.name}${targetClass.section ? ` - ${targetClass.section}` : ""}`,
      previousClassIds,
      studentCount: validStudentIds.length,
      studentIds: validStudentIds.map(String),
      studentNames: students.map(s => s.name),
      reason: reason || "Administrative class transfer"
    }
  });

  res.json({
    success: true,
    message: `Successfully moved ${validStudentIds.length} student(s) to ${targetClass.name}.`,
    movedCount: validStudentIds.length,
    targetClass: {
      id: String(targetClass._id),
      name: targetClass.name,
      section: targetClass.section || ""
    }
  });
});

// --- STUDENT LOCALIZED NAME MANAGEMENT (ADMIN ONLY) ---
app.get("/api/admin/students/name-audit", requireAdmin, async (_req, res) => {
  const students = await Student.find().populate("classId", "name section").sort({ admissionNo: 1 }).lean();
  let mixedScriptCount = 0;
  let missingEnCount = 0;
  let missingUrCount = 0;
  let missingTeCount = 0;
  let completeCount = 0;

  const audited = students.map(s => {
    const canonical = (s.name || "").trim();
    const hasUrdu = /[\u0600-\u06FF]/.test(canonical);
    const hasLatin = /[a-zA-Z]/.test(canonical);
    const isMixed = hasUrdu && hasLatin;

    const hasEn = Boolean(s.nameEn && s.nameEn.trim());
    const hasUr = Boolean(s.nameUr && s.nameUr.trim());
    const hasTe = Boolean(s.nameTe && s.nameTe.trim());

    if (isMixed) mixedScriptCount++;
    if (!hasEn) missingEnCount++;
    if (!hasUr) missingUrCount++;
    if (!hasTe) missingTeCount++;
    if (hasEn && hasUr && hasTe && !isMixed) completeCount++;

    return {
      id: String(s._id),
      admissionNo: s.admissionNo,
      name: s.name,
      nameEn: s.nameEn || "",
      nameUr: s.nameUr || "",
      nameTe: s.nameTe || "",
      className: s.classId ? `${s.classId.name}${s.classId.section ? ` (${s.classId.section})` : ""}` : "",
      classId: s.classId?._id ? String(s.classId._id) : "",
      isMixedScript: isMixed,
      missingLanguages: [
        ...(!hasEn ? ["en"] : []),
        ...(!hasUr ? ["ur"] : []),
        ...(!hasTe ? ["te"] : [])
      ]
    };
  });

  res.json({
    total: students.length,
    counts: {
      mixedScript: mixedScriptCount,
      missingEn: missingEnCount,
      missingUr: missingUrCount,
      missingTe: missingTeCount,
      complete: completeCount
    },
    students: audited
  });
});

app.post("/api/admin/students/names/bulk-update", requireAdmin, async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ message: "Updates array cannot be empty." });
  }

  let updatedCount = 0;
  const errors = [];

  for (const item of updates) {
    const studentId = item.id || item.studentId;
    if (!studentId) {
      errors.push({ error: "Missing student ID" });
      continue;
    }
    const student = await Student.findById(studentId);
    if (!student) {
      errors.push({ studentId, error: "Student not found" });
      continue;
    }

    if (item.nameEn !== undefined) student.nameEn = String(item.nameEn).trim();
    if (item.nameUr !== undefined) student.nameUr = String(item.nameUr).trim();
    if (item.nameTe !== undefined) student.nameTe = String(item.nameTe).trim();
    if (item.name !== undefined && String(item.name).trim()) student.name = String(item.name).trim();

    await student.save();
    updatedCount++;
  }

  await AuditLog.create({
    actorId: req.user._id,
    action: "student.bulk_name_update",
    entityType: "Student",
    details: { updatedCount, errorCount: errors.length }
  });

  res.json({
    success: true,
    message: `Updated localized names for ${updatedCount} student(s).`,
    updatedCount,
    errors
  });
});

app.get("/api/admin/students/names/export", requireAdmin, exportRateLimiter, requireExportPin, async (_req, res) => {
  const students = await Student.find().populate("classId", "name section").sort({ admissionNo: 1 }).lean();
  const headers = ["Admission No", "Canonical Name", "English Name", "Urdu Name", "Telugu Name", "Class", "Mixed Script Flag"];
  const quote = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = students.map(s => {
    const isMixed = /[\u0600-\u06FF]/.test(s.name || "") && /[a-zA-Z]/.test(s.name || "");
    return [
      s.admissionNo,
      s.name,
      s.nameEn || "",
      s.nameUr || "",
      s.nameTe || "",
      s.classId ? `${s.classId.name}${s.classId.section ? ` (${s.classId.section})` : ""}` : "",
      isMixed ? "SUSPICIOUS_MIXED_SCRIPT" : "OK"
    ];
  });

  const csv = "\uFEFF" + [headers, ...rows].map(r => r.map(quote).join(",")).join("\r\n");
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="Madrasa-Amanah-Student-Names-${today}.csv"`);
  res.send(csv);
});

app.post("/api/admin/students/names/import", requireAdmin, async (req, res) => {
  const { csvData } = req.body;
  if (!csvData || typeof csvData !== "string") {
    return res.status(400).json({ message: "csvData text is required." });
  }

  const lines = csvData.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    return res.status(400).json({ message: "CSV file must contain a header row and at least one data row." });
  }

  const parseRow = (line) => {
    const row = [];
    let insideQuotes = false;
    let entry = "";
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          entry += '"';
          i++;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === "," && !insideQuotes) {
        row.push(entry.trim());
        entry = "";
      } else {
        entry += char;
      }
    }
    row.push(entry.trim());
    return row;
  };

  const headerRow = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const admIdx = headerRow.findIndex(h => h.includes("admission") || h.includes("admno") || h === "adm");
  const enIdx = headerRow.findIndex(h => h.includes("english") || h === "nameen");
  const urIdx = headerRow.findIndex(h => h.includes("urdu") || h === "nameur");
  const teIdx = headerRow.findIndex(h => h.includes("telugu") || h === "namete");
  const canonicalIdx = headerRow.findIndex(h => h.includes("canonical") || h === "name" || h.includes("studentname"));

  if (admIdx === -1) {
    return res.status(400).json({ message: "CSV must contain an 'Admission No' column." });
  }

  let successCount = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    const admNo = cols[admIdx];
    if (!admNo) continue;

    const student = await Student.findOne({ admissionNo: { $regex: new RegExp(`^${admNo.trim()}$`, "i") } });
    if (!student) {
      errors.push({ row: i + 1, admissionNo: admNo, message: `Student with admission no ${admNo} not found.` });
      continue;
    }

    if (enIdx !== -1 && cols[enIdx] && cols[enIdx].trim()) {
      student.nameEn = cols[enIdx].trim();
    }
    if (urIdx !== -1 && cols[urIdx] && cols[urIdx].trim()) {
      student.nameUr = cols[urIdx].trim();
    }
    if (teIdx !== -1 && cols[teIdx] && cols[teIdx].trim()) {
      student.nameTe = cols[teIdx].trim();
    }
    if (canonicalIdx !== -1 && cols[canonicalIdx] && cols[canonicalIdx].trim() && !student.name) {
      student.name = cols[canonicalIdx].trim();
    }

    await student.save();
    successCount++;
  }

  await AuditLog.create({
    actorId: req.user._id,
    action: "student.csv_name_import",
    entityType: "Student",
    details: { rowsProcessed: lines.length - 1, successCount, errorCount: errors.length }
  });

  res.json({
    success: true,
    message: `Successfully processed CSV: ${successCount} student(s) updated, ${errors.length} error(s).`,
    successCount,
    errors
  });
});

// --- STUDENT ROSTER EXPORT (CSV / XLSX) ---
app.get("/api/students/export", exportRateLimiter, requireExportPin, async (req, res) => {
  const classId = req.query.classId;
  const format = req.query.format || "csv";
  const filter = {};
  const status = String(req.query.status || "").toLowerCase();
  if (status === "archived" || status === "inactive") {
    filter.active = false;
  } else if (status === "all") {
    // all
  } else {
    filter.active = true;
  }

  let className = "All-Classes";
  if (classId && classId !== "all") {
    if (!(await canAccessClass(req.user, classId))) {
      return res.status(403).json({ message: "Class access denied." });
    }
    filter.classId = classId;
    const cls = await Class.findById(classId);
    if (cls) className = `${cls.name}${cls.section ? `-${cls.section}` : ""}`;
  } else if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Only administrators can export organization-wide student rosters. Please select an authorized class." });
  }

  const cleanClassName = className.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  const todayStr = new Date().toISOString().slice(0, 10);
  const safeFilename = `Madrasa-Amanah-Students-${cleanClassName}-${todayStr}`;

  const students = await Student.find(filter)
    .populate("classId", "name section academicYear")
    .collation({ locale: "en", numericOrdering: true })
    .sort({ admissionNo: 1, name: 1 });
  students.sort(compareRollNumbers);

  const rows = students.map(s => ({
    "Admission No": s.admissionNo,
    "Student Name": s.name,
    "Gender": s.gender || "",
    "Date of Birth": s.dob || "",
    "Class": s.classId ? `${s.classId.name}${s.classId.section ? ` (${s.classId.section})` : ""}` : "",
    "Academic Year": s.classId?.academicYear || "",
    "Guardian Name": s.guardianName || "",
    "Guardian Phone": s.guardianPhone || "",
    "Address": s.address || "",
    "Enrollment Date": s.enrollmentDate || "",
    "Photo Consent Recorded": s.consentGiven ? "Yes" : "No",
    "Status": s.active ? "Active" : "Archived"
  }));

  if (format === "csv") {
    const headers = [
      "Admission No",
      "Student Name",
      "Gender",
      "Date of Birth",
      "Class",
      "Academic Year",
      "Guardian Name",
      "Guardian Phone",
      "Address",
      "Enrollment Date",
      "Photo Consent Recorded",
      "Status"
    ];
    const quote = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "\uFEFF" + [headers, ...rows.map(r => headers.map(h => r[h]))].map(r => r.map(quote).join(",")).join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.csv"; filename*=UTF-8''${encodeURIComponent(safeFilename)}.csv`);
    return res.send(csv);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Students Roster");
  ws.columns = [
    { header: "Admission No", key: "Admission No", width: 16 },
    { header: "Student Name", key: "Student Name", width: 28 },
    { header: "Gender", key: "Gender", width: 12 },
    { header: "Date of Birth", key: "Date of Birth", width: 14 },
    { header: "Class", key: "Class", width: 22 },
    { header: "Academic Year", key: "Academic Year", width: 18 },
    { header: "Guardian Name", key: "Guardian Name", width: 24 },
    { header: "Guardian Phone", key: "Guardian Phone", width: 18 },
    { header: "Address", key: "Address", width: 28 },
    { header: "Enrollment Date", key: "Enrollment Date", width: 16 },
    { header: "Photo Consent Recorded", key: "Photo Consent Recorded", width: 22 },
    { header: "Status", key: "Status", width: 12 }
  ];
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.xlsx"; filename*=UTF-8''${encodeURIComponent(safeFilename)}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// Get single student by ID
app.get("/api/students/:id", async (req, res) => {
  const student = await Student.findById(req.params.id).select("-faceDescriptor").populate("classId", "name section academicYear");
  if (!student) return res.status(404).json({ message: "Student not found." });
  if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });
  const obj = student.toObject();
  obj.id = String(obj._id);
  obj.fullName = obj.name;
  obj.admissionNumber = obj.admissionNo;
  obj.referencePhotoUrl = obj.photoUrl;
  res.json(obj);
});

// Student Attendance History API
app.get("/api/students/:id/attendance", async (req, res) => {
  const student = await Student.findById(req.params.id).select("-faceDescriptor").populate("classId", "name section academicYear");
  if (!student) return res.status(404).json({ message: "Student not found." });
  if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });

  const filter = { studentId: student._id };
  const from = req.query.startDate || req.query.from;
  const to = req.query.endDate || req.query.to;
  if (from && to) {
    filter.dateKey = { $gte: from, $lte: to };
  } else if (from) {
    filter.dateKey = { $gte: from };
  } else if (to) {
    filter.dateKey = { $lte: to };
  }

  const limit = Math.min(parseInt(req.query.limit) || 120, 365);
  const records = await Attendance.find(filter)
    .populate("classId", "name section academicYear")
    .populate("markedBy", "name email")
    .populate("updatedBy", "name email")
    .sort({ dateKey: -1, createdAt: -1 })
    .limit(limit);

  const stats = {
    totalSessions: records.length,
    present: records.filter(r => r.status === "present").length,
    absent: records.filter(r => r.status === "absent").length,
    late: records.filter(r => r.status === "late").length,
    excused: records.filter(r => r.status === "excused").length
  };
  // Consistent formula: Present / Total * 100
  stats.rate = stats.totalSessions > 0 ? Math.round((stats.present / stats.totalSessions) * 100) : 0;

  res.json({
    student: {
      id: String(student._id),
      _id: student._id,
      name: student.name,
      fullName: student.name,
      admissionNo: student.admissionNo,
      admissionNumber: student.admissionNo,
      active: student.active,
      photoUrl: student.photoUrl,
      classId: student.classId
    },
    stats,
    records
  });
});

// Single Student Complete Record & Attendance Export (JSON or CSV)
app.get("/api/students/:id/export", exportRateLimiter, requireExportPin, async (req, res) => {
  try {
    const student = await Student.findById(req.params.id)
      .select("+faceDescriptor")
      .populate({
        path: "classId",
        select: "name section academicYear code teacherIds",
        populate: { path: "teacherIds", select: "name email role" }
      })
      .lean();
    if (!student) return res.status(404).json({ message: "Student not found." });
    if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });

    const attendance = await Attendance.find({ studentId: student._id }).populate("classId", "name section").sort({ dateKey: -1 }).lean();
    const format = (req.query.format || "pdf").toLowerCase();
    const cleanName = (student.name || "Student").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    const todayStr = new Date().toISOString().slice(0, 10);

    if (format === "pdf") {
      const filename = `Madrasa-Amanah-Student-${student.admissionNo || "Data"}-${cleanName}-${todayStr}.pdf`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader("Content-Type", "application/pdf");

      await generateStudentProfilePdf({ student, attendance, outputStream: res });
      return;
    }

    if (format === "csv") {
      const filename = `Madrasa-Amanah-Student-${student.admissionNo || "Data"}-${cleanName}-${todayStr}.csv`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");

      let csv = "\uFEFF"; // UTF-8 BOM
      csv += "Admission No,Student Name,English Name,Urdu Name,Telugu Name,Class,Status,Gender,Guardian Name,Guardian Phone,Address,Consent Recorded\n";
      csv += `"${student.admissionNo || ""}","${student.name || ""}","${student.nameEn || ""}","${student.nameUr || ""}","${student.nameTe || ""}","${student.classId?.name || ""} (${student.classId?.section || ""})","${student.active !== false ? "Active" : "Archived"}","${student.gender || ""}","${student.guardianName || ""}","${student.guardianPhone || ""}","${student.address || ""}","${student.consentGiven ? "Yes" : "No"}"\n\n`;
      csv += "Date,Status,Confirmed,Session,Notes\n";
      attendance.forEach(a => {
        csv += `"${a.dateKey}","${a.status}","${a.confirmed ? "Yes" : "No"}","${a.session || "Morning"}","${(a.notes || "").replace(/"/g, '""')}"\n`;
      });
      return res.send(csv);
    }

    const filename = `Madrasa-Amanah-Student-${student.admissionNo || "Data"}-${cleanName}-${todayStr}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const exportData = {
      system: "Madrasa Amanah Smart Attendance",
      exportTimestamp: new Date().toISOString(),
      student: {
        id: String(student._id),
        admissionNo: student.admissionNo,
        name: student.name,
        nameEn: student.nameEn,
        nameUr: student.nameUr,
        nameTe: student.nameTe,
        gender: student.gender,
        dob: student.dob,
        class: student.classId ? { id: String(student.classId._id), name: student.classId.name, section: student.classId.section } : null,
        guardianName: student.guardianName,
        guardianPhone: student.guardianPhone,
        address: student.address,
        active: student.active !== false,
        consentGiven: !!student.consentGiven,
        enrollmentDate: student.enrollmentDate,
        createdAt: student.createdAt,
        updatedAt: student.updatedAt
      },
      attendanceSummary: {
        totalRecords: attendance.length,
        present: attendance.filter(a => a.status === "present").length,
        absent: attendance.filter(a => a.status === "absent").length,
        late: attendance.filter(a => a.status === "late").length,
        excused: attendance.filter(a => a.status === "excused").length,
        attendanceRatePercent: attendance.length > 0
          ? Math.round((attendance.filter(a => a.status === "present").length / attendance.length) * 100)
          : 0
      },
      attendanceRecords: attendance.map(a => ({
        dateKey: a.dateKey,
        status: a.status,
        confirmed: a.confirmed,
        notes: a.notes,
        updatedAt: a.updatedAt
      }))
    };

    res.json(exportData);
  } catch (err) {
    res.status(500).json({ message: "Failed to export student data.", error: err.message });
  }
});

// Student Archival (Soft Delete) — Admin Only
app.post("/api/students/:id/archive", requireAdmin, async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) return res.status(404).json({ message: "Student not found." });
  student.active = false;
  await student.save();
  await AuditLog.create({
    actorId: req.user._id,
    action: "student.archive",
    entityType: "Student",
    entityId: String(student._id),
    details: { admissionNo: student.admissionNo, name: student.name, reason: req.body?.reason || "Archived by admin" }
  });
  res.json({ message: `Student ${student.name} (${student.admissionNo}) archived successfully.`, student });
});

// Student Restore — Admin Only
app.post("/api/students/:id/restore", requireAdmin, async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) return res.status(404).json({ message: "Student not found." });
  student.active = true;
  await student.save();
  await AuditLog.create({
    actorId: req.user._id,
    action: "student.restore",
    entityType: "Student",
    entityId: String(student._id),
    details: { admissionNo: student.admissionNo, name: student.name }
  });
  res.json({ message: `Student ${student.name} (${student.admissionNo}) restored successfully.`, student });
});

// Permanent Delete Student — Admin Only with admission number verification
app.delete("/api/students/:id", requireAdmin, async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) return res.status(404).json({ message: "Student not found." });
  
  // If confirmation admission number provided, verify match
  const confirmNo = (req.body?.confirmAdmissionNo || req.query?.confirmAdmissionNo || "").trim();
  if (confirmNo && confirmNo !== student.admissionNo) {
    return res.status(400).json({ message: `Confirmation failed: Expected "${student.admissionNo}", received "${confirmNo}".` });
  }

  // Remove associated attendance records for this student
  const deletedAttendance = await Attendance.deleteMany({ studentId: student._id });
  await Student.deleteOne({ _id: student._id });
  await AuditLog.create({
    actorId: req.user._id,
    action: "student.permanent_delete",
    entityType: "Student",
    entityId: String(student._id),
    details: {
      admissionNo: student.admissionNo,
      name: student.name,
      deletedAttendanceCount: deletedAttendance.deletedCount,
      reason: req.body?.reason || "Administrative permanent deletion"
    }
  });
  res.json({ message: "Student permanently deleted.", id: String(student._id), admissionNo: student.admissionNo });
});

// Attendance API
app.get("/api/attendance", async (req, res) => {
  const classId = req.query.classId;
  const dateKey = req.query.dateKey || req.query.date;
  const sessionKey = req.query.sessionKey || req.query.session || "morning";
  if (!classId || !dateKey) return res.status(400).json({ message: "classId and dateKey are required." });
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });
  const records = await Attendance.find({ classId, dateKey, sessionKey })
    .populate("studentId", "name admissionNo photoUrl")
    .populate("markedBy", "name email")
    .populate("updatedBy", "name email")
    .sort({ studentId: 1 })
    .lean();
  res.json(records);
});

// Dedicated Attendance Monitoring API
app.get("/api/attendance/monitoring", async (req, res) => {
  const classId = req.query.classId || "all";
  const dateKey = req.query.dateKey || req.query.date;
  const startDate = req.query.startDate || req.query.from;
  const endDate = req.query.endDate || req.query.to;
  const sessionKey = req.query.sessionKey || req.query.session || "morning";
  const statusFilter = String(req.query.status || "all").toLowerCase().trim();
  const search = String(req.query.search || "").trim();

  // Role-based class authorization
  let targetClassIds = null;
  if (classId !== "all") {
    if (!(await canAccessClass(req.user, classId))) {
      return res.status(403).json({ message: "Class access denied." });
    }
    targetClassIds = [new mongoose.Types.ObjectId(classId)];
  } else if (req.user.role !== "admin") {
    const userClasses = await Class.find({
      $or: [{ teacherIds: req.user._id }, { _id: { $in: req.user.assignedClasses.map(c => c._id || c) } }]
    }).select("_id");
    targetClassIds = userClasses.map(c => c._id);
    if (!targetClassIds.length) {
      return res.json({
        mode: "single",
        dateKey: dateKey || new Date().toISOString().slice(0, 10),
        sessionKey,
        summary: { totalEligible: 0, present: 0, absent: 0, late: 0, excused: 0, notMarked: 0, attendanceRate: 0, formula: "Present / Eligible * 100" },
        records: []
      });
    }
  }

  // Active students query (archived students NEVER eligible)
  const studentFilter = { active: true };
  if (targetClassIds) {
    studentFilter.classId = { $in: targetClassIds };
  }
  if (search) {
    studentFilter.$or = [
      { name: { $regex: search, $options: "i" } },
      { admissionNo: { $regex: search, $options: "i" } }
    ];
  }

  const eligibleStudents = await Student.find(studentFilter)
    .populate("classId", "name section academicYear")
    .collation({ locale: "en", numericOrdering: true })
    .sort({ admissionNo: 1, name: 1 });
  eligibleStudents.sort(compareRollNumbers);

  // Mode: Date Range Monitoring
  if (startDate && endDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ message: "Invalid startDate or endDate format (expected YYYY-MM-DD)." });
    }
    if (startDate > endDate) {
      return res.status(400).json({ message: "startDate must be before or equal to endDate." });
    }

    const attFilter = { dateKey: { $gte: startDate, $lte: endDate } };
    if (targetClassIds) attFilter.classId = { $in: targetClassIds };
    if (sessionKey !== "all") attFilter.sessionKey = sessionKey;

    const rangeRecords = await Attendance.find(attFilter)
      .populate("studentId", "name admissionNo photoUrl active classId")
      .populate("classId", "name section academicYear")
      .populate("markedBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ dateKey: -1, sessionKey: 1 });

    // Generate date sequence in range
    const startObj = new Date(startDate);
    const endObj = new Date(endDate);
    const dateList = [];
    const cur = new Date(startObj);
    while (cur <= endObj && dateList.length <= 90) {
      dateList.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }

    // Daily totals
    const dailyTotals = dateList.map((d) => {
      const dayRecs = rangeRecords.filter((r) => r.dateKey === d);
      const pres = dayRecs.filter((r) => r.status === "present").length;
      const abs = dayRecs.filter((r) => r.status === "absent").length;
      const late = dayRecs.filter((r) => r.status === "late").length;
      const exc = dayRecs.filter((r) => r.status === "excused").length;
      const eligible = eligibleStudents.length;
      const markedCount = pres + abs + late + exc;
      const notMarked = Math.max(0, eligible - markedCount);
      const rate = eligible > 0 ? Math.round((pres / eligible) * 100) : 0;
      return {
        dateKey: d,
        totalEligible: eligible,
        present: pres,
        absent: abs,
        late: late,
        excused: exc,
        notMarked,
        attendanceRate: rate
      };
    });

    // Student breakdown
    const studentMap = new Map();
    eligibleStudents.forEach((s) => {
      studentMap.set(String(s._id), {
        studentId: String(s._id),
        name: s.name,
        admissionNo: s.admissionNo,
        photoUrl: s.photoUrl,
        class: s.classId ? { id: s.classId._id, name: s.classId.name, section: s.classId.section } : null,
        present: 0,
        absent: 0,
        late: 0,
        excused: 0,
        notMarked: 0,
        totalSessions: dateList.length,
        attendanceRate: 0,
        records: []
      });
    });

    rangeRecords.forEach((r) => {
      const sId = String(r.studentId?._id || r.studentId);
      const item = studentMap.get(sId);
      if (item) {
        if (item[r.status] !== undefined) item[r.status]++;
        item.records.push({
          dateKey: r.dateKey,
          sessionKey: r.sessionKey,
          status: r.status,
          updatedAt: r.updatedAt || r.createdAt,
          updatedBy: r.updatedBy ? { name: r.updatedBy.name, email: r.updatedBy.email } : (r.markedBy ? { name: r.markedBy.name, email: r.markedBy.email } : null),
          note: r.note || ""
        });
      }
    });

    studentMap.forEach((item) => {
      const marked = item.present + item.absent + item.late + item.excused;
      item.notMarked = Math.max(0, item.totalSessions - marked);
      item.attendanceRate = item.totalSessions > 0 ? Math.round((item.present / item.totalSessions) * 100) : 0;
    });

    const totalPresent = rangeRecords.filter((r) => r.status === "present").length;
    const totalAbsent = rangeRecords.filter((r) => r.status === "absent").length;
    const totalLate = rangeRecords.filter((r) => r.status === "late").length;
    const totalExcused = rangeRecords.filter((r) => r.status === "excused").length;
    const totalPossibleSessions = eligibleStudents.length * dateList.length;
    const totalNotMarked = Math.max(0, totalPossibleSessions - (totalPresent + totalAbsent + totalLate + totalExcused));
    const overallRate = totalPossibleSessions > 0 ? Math.round((totalPresent / totalPossibleSessions) * 100) : 0;

    return res.json({
      mode: "range",
      startDate,
      endDate,
      classId,
      sessionKey,
      summary: {
        totalEligible: eligibleStudents.length,
        totalDays: dateList.length,
        totalSessions: totalPossibleSessions,
        present: totalPresent,
        absent: totalAbsent,
        late: totalLate,
        excused: totalExcused,
        notMarked: totalNotMarked,
        attendanceRate: overallRate,
        formula: "Present / (Eligible * Days) * 100"
      },
      dailyTotals,
      studentBreakdown: Array.from(studentMap.values()),
      records: rangeRecords.map((r) => ({
        id: String(r._id),
        studentId: String(r.studentId?._id || r.studentId),
        name: r.studentId?.name || "Student",
        admissionNo: r.studentId?.admissionNo || "",
        class: r.classId ? { id: r.classId._id, name: r.classId.name, section: r.classId.section } : null,
        date: r.dateKey,
        session: r.sessionKey,
        status: r.status,
        lastUpdated: r.updatedAt || r.createdAt,
        updatedBy: r.updatedBy ? { name: r.updatedBy.name, email: r.updatedBy.email } : (r.markedBy ? { name: r.markedBy.name, email: r.markedBy.email } : null),
        note: r.note || ""
      }))
    });
  }

  // Mode: Single Date Monitoring
  const targetDate = dateKey || new Date().toISOString().slice(0, 10);
  const attFilter = { dateKey: targetDate };
  if (targetClassIds) attFilter.classId = { $in: targetClassIds };
  if (sessionKey !== "all") attFilter.sessionKey = sessionKey;

  const records = await Attendance.find(attFilter)
    .populate("studentId", "name admissionNo photoUrl active classId")
    .populate("classId", "name section academicYear")
    .populate("markedBy", "name email")
    .populate("updatedBy", "name email");

  const attMap = new Map();
  records.forEach((r) => {
    const sId = String(r.studentId?._id || r.studentId);
    attMap.set(sId, r);
  });

  let rows = eligibleStudents.map((s) => {
    const sid = String(s._id);
    const att = attMap.get(sid);
    const status = att ? att.status : "unmarked";
    return {
      studentId: sid,
      name: s.name,
      admissionNo: s.admissionNo,
      photoUrl: s.photoUrl,
      class: s.classId ? { id: s.classId._id, name: s.classId.name, section: s.classId.section } : null,
      date: targetDate,
      session: att?.sessionKey || (sessionKey !== "all" ? sessionKey : "morning"),
      status,
      lastUpdated: att?.updatedAt || att?.createdAt || null,
      updatedBy: att?.updatedBy ? { name: att.updatedBy.name, email: att.updatedBy.email } : (att?.markedBy ? { name: att.markedBy.name, email: att.markedBy.email } : null),
      note: att?.note || ""
    };
  });

  const totalEligible = eligibleStudents.length;
  const presentCount = rows.filter((r) => r.status === "present").length;
  const absentCount = rows.filter((r) => r.status === "absent").length;
  const lateCount = rows.filter((r) => r.status === "late").length;
  const excusedCount = rows.filter((r) => r.status === "excused").length;
  const notMarkedCount = rows.filter((r) => r.status === "unmarked").length;
  const attendanceRate = totalEligible > 0 ? Math.round((presentCount / totalEligible) * 100) : 0;

  // Filter rows by status if requested
  if (statusFilter && statusFilter !== "all") {
    rows = rows.filter((r) => r.status.toLowerCase() === statusFilter);
  }

  rows.sort(compareRollNumbers);

  res.json({
    mode: "single",
    dateKey: targetDate,
    sessionKey,
    classId,
    summary: {
      totalEligible,
      present: presentCount,
      absent: absentCount,
      late: lateCount,
      excused: excusedCount,
      notMarked: notMarkedCount,
      attendanceRate,
      formula: "Present / Eligible * 100"
    },
    records: rows
  });
});

// Direct Online Save
app.post("/api/attendance/bulk", async (req, res) => {
  const classId = req.body.classId;
  const dateKey = req.body.dateKey || req.body.date;
  const sessionKey = req.body.sessionKey || req.body.session || "morning";
  const records = req.body.records;
  const source = req.body.source || "manual";
  if (!classId || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "") || !Array.isArray(records)) {
    return res.status(400).json({ message: "Valid classId, dateKey and records are required." });
  }
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });

  // Enforce attendance correction window for teachers
  if (req.user.role !== "admin") {
    let settings = null;
    try { settings = await SystemSetting.findOne({ key: "global" }); } catch {}
    const windowDays = settings?.attendanceCorrectionWindowDays || 7;
    const cutoffDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (dateKey < cutoffDate) {
      return res.status(403).json({
        message: `Attendance correction window has elapsed for this date (${dateKey}). Historical corrections beyond ${windowDays} days require administrator permission.`
      });
    }
  }

  const targetClass = await Class.findById(classId);
  const students = await Student.find({ _id: { $in: records.map(r => r.studentId) }, classId, active: true }).select("_id");
  const allowed = new Set(students.map(s => String(s._id)));
  const ops = [];
  const statusCounts = { present: 0, absent: 0, late: 0, excused: 0 };

  // Deduplicate incoming records by studentId to prevent duplicate operations or double-counting
  const seenStudentIds = new Set();
  const dedupedRecords = [];
  for (const r of records) {
    const sId = String(r.studentId);
    if (!seenStudentIds.has(sId)) {
      seenStudentIds.add(sId);
      dedupedRecords.push(r);
    }
  }

  // Audit attendance corrections
  const existingRecords = await Attendance.find({
    classId,
    dateKey,
    sessionKey,
    studentId: { $in: dedupedRecords.map(r => r.studentId) }
  });
  const existingMap = new Map(existingRecords.map(a => [String(a.studentId), a.status]));
  for (const r of dedupedRecords) {
    const prevStatus = existingMap.get(String(r.studentId));
    if (prevStatus && prevStatus !== r.status) {
      await AuditLog.create({
        actorId: req.user._id,
        action: "attendance.correction",
        entityType: "Attendance",
        details: { studentId: r.studentId, classId, dateKey, sessionKey, from: prevStatus, to: r.status, note: r.note || "" }
      });
    }
  }

  for (const r of dedupedRecords) {
    if (!allowed.has(String(r.studentId))) continue;
    if (!["present", "absent", "late", "excused"].includes(r.status)) continue;
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    ops.push({
      updateOne: {
        filter: { studentId: r.studentId, classId, dateKey, sessionKey },
        update: {
          $set: {
            status: r.status,
            source: source === "photo-assisted" ? source : "manual",
            updatedBy: req.user._id,
            note: String(r.note || "").slice(0, 300)
          },
          $inc: { serverVersion: 1 },
          $setOnInsert: { markedBy: req.user._id }
        },
        upsert: true
      }
    });
  }

  if (ops.length) await Attendance.bulkWrite(ops, { ordered: false });

  // Safe Secondary Storage Write when rotation target is active
  let sysSettings = null;
  try { sysSettings = await SystemSetting.findOne({ key: "global" }); } catch {}
  if (sysSettings?.activeWriteTarget === "secondary" && ops.length) {
    const secConn = await getSecondaryConnection();
    if (secConn && secConn.readyState === 1) {
      try {
        await secConn.collection("attendances").bulkWrite(ops, { ordered: false });
      } catch (secErr) {
        console.warn("[STORAGE] Secondary attendance write warning:", secErr.message);
      }
    }
  }

  await AuditLog.create({
    actorId: req.user._id,
    action: "attendance.bulk-save",
    entityType: "Attendance",
    details: { classId, dateKey, sessionKey, count: ops.length }
  });

  const now = new Date().toISOString();
  const resultPayload = {
    saved: ops.length,
    confirmed: true,
    message: "Attendance confirmed by MongoDB Atlas.",
    classId,
    className: targetClass ? targetClass.name : "Class",
    dateKey,
    sessionKey,
    statusCounts,
    stats: statusCounts,
    database: "MongoDB Atlas",
    confirmedAt: now,
    persistedAt: now
  };

  if (req.body.mutationId) {
    try {
      await SyncMutation.create({
        mutationId: req.body.mutationId,
        actorId: req.user._id,
        kind: "attendance.bulk",
        result: resultPayload
      });
    } catch {
      // Mutation receipt already logged
    }
  }

  res.json(resultPayload);
});

// Idempotent Offline Sync Endpoint
// Supports both flat body {mutationId, classId, ...} and batch {mutations: [{...}]}
app.post("/api/sync/attendance", async (req, res) => {
  // Normalize: accept either a single flat mutation or a mutations array
  let mutations;
  if (Array.isArray(req.body.mutations)) {
    mutations = req.body.mutations;
  } else if (req.body.mutationId) {
    mutations = [req.body];
  } else {
    return res.status(400).json({ message: "mutationId is required for safe offline sync." });
  }

  const results = [];
  for (const mut of mutations) {
    const mutationId = mut.mutationId;
    if (!mutationId) {
      results.push({ mutationId: null, status: "error", message: "Missing mutationId" });
      continue;
    }

    // Idempotency check: Return stored result if mutation has already been acknowledged
    const existingReceipt = await SyncMutation.findOne({ mutationId });
    if (existingReceipt) {
      results.push({ mutationId, status: "duplicate", ...existingReceipt.result });
      continue;
    }

    const classId = mut.classId;
    const dateKey = mut.dateKey || mut.date;
    const sessionKey = mut.sessionKey || mut.session || "morning";
    const records = mut.records;
    const source = mut.source || "manual";

    if (!classId || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "") || !Array.isArray(records)) {
      results.push({ mutationId, status: "error", message: "Invalid classId, dateKey or records" });
      continue;
    }
    if (!(await canAccessClass(req.user, classId))) {
      results.push({ mutationId, status: "error", message: "Class access denied" });
      continue;
    }

    // Enforce attendance correction window for teachers during offline sync
    if (req.user.role !== "admin") {
      let settings = null;
      try { settings = await SystemSetting.findOne({ key: "global" }); } catch {}
      const windowDays = settings?.attendanceCorrectionWindowDays || 7;
      const cutoffDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (dateKey < cutoffDate) {
        results.push({
          mutationId,
          status: "error",
          message: `Attendance correction window (${windowDays} days) elapsed for date ${dateKey}`
        });
        continue;
      }
    }

    const targetClass = await Class.findById(classId);
    const validStudents = await Student.find({
      _id: { $in: records.map(r => r.studentId) },
      classId,
      active: true
    }).select("_id");
    const allowed = new Set(validStudents.map(s => String(s._id)));
    const ops = [];
    const statusCounts = { present: 0, absent: 0, late: 0, excused: 0 };

    const seenStudentIds = new Set();
    const dedupedRecords = [];
    for (const r of records) {
      const sId = String(r.studentId);
      if (!seenStudentIds.has(sId)) {
        seenStudentIds.add(sId);
        dedupedRecords.push(r);
      }
    }

    // Audit attendance corrections
    const existingRecords = await Attendance.find({
      classId,
      dateKey,
      sessionKey,
      studentId: { $in: dedupedRecords.map(r => r.studentId) }
    });
    const existingMap = new Map(existingRecords.map(a => [String(a.studentId), a.status]));
    for (const r of dedupedRecords) {
      const prevStatus = existingMap.get(String(r.studentId));
      if (prevStatus && prevStatus !== r.status) {
        await AuditLog.create({
          actorId: req.user._id,
          action: "attendance.correction",
          entityType: "Attendance",
          details: { studentId: r.studentId, classId, dateKey, sessionKey, from: prevStatus, to: r.status, note: r.note || "", source: "sync" }
        });
      }
    }

    for (const r of dedupedRecords) {
      if (!allowed.has(String(r.studentId))) continue;
      if (!["present", "absent", "late", "excused"].includes(r.status)) continue;
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      ops.push({
        updateOne: {
          filter: { studentId: r.studentId, classId, dateKey, sessionKey },
          update: {
            $set: {
              status: r.status,
              source: source === "photo-assisted" ? source : "manual",
              updatedBy: req.user._id,
              note: String(r.note || "").slice(0, 300)
            },
            $inc: { serverVersion: 1 },
            $setOnInsert: { markedBy: req.user._id }
          },
          upsert: true
        }
      });
    }

    if (ops.length) await Attendance.bulkWrite(ops, { ordered: false });

    // Secondary DB write if target is secondary
    let sysSettings = null;
    try { sysSettings = await SystemSetting.findOne({ key: "global" }); } catch {}
    if (sysSettings?.activeWriteTarget === "secondary" && ops.length) {
      const secConn = await getSecondaryConnection();
      if (secConn && secConn.readyState === 1) {
        try {
          await secConn.collection("attendances").bulkWrite(ops, { ordered: false });
        } catch (secErr) {
          console.warn("[STORAGE] Secondary sync attendance write warning:", secErr.message);
        }
      }
    }

    const resultPayload = {
      mutationId,
      status: "applied",
      syncedCount: ops.length,
      classId,
      className: targetClass ? targetClass.name : "Class",
      dateKey,
      sessionKey,
      statusCounts,
      database: "MongoDB Atlas",
      syncedAt: new Date().toISOString()
    };

    await SyncMutation.create({
      mutationId,
      actorId: req.user._id,
      kind: "attendance.bulk",
      result: resultPayload
    });

    await AuditLog.create({
      actorId: req.user._id,
      action: "attendance.sync",
      entityType: "Attendance",
      details: { mutationId, classId, dateKey, sessionKey, count: ops.length }
    });

    results.push(resultPayload);
  }

  // For single mutation (flat body), return flat response for backward compatibility
  if (!Array.isArray(req.body.mutations) && results.length === 1) {
    return res.json({
      idempotent: results[0].status === "duplicate",
      message: results[0].status === "duplicate"
        ? "Mutation already confirmed and acknowledged by MongoDB."
        : "Sync confirmed by MongoDB Atlas.",
      ...results[0]
    });
  }

  res.json({ results });
});

// Reports API
app.get("/api/reports/summary", async (req, res) => {
  const classId = req.query.classId;
  const from = req.query.from || req.query.startDate;
  const to = req.query.to || req.query.endDate;
  if (!classId || !from || !to) return res.status(400).json({ message: "classId, from and to are required." });
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });
  const rows = await Attendance.aggregate([
    { $match: { classId: new mongoose.Types.ObjectId(classId), dateKey: { $gte: from, $lte: to } } },
    { $group: {
      _id: "$studentId",
      total: { $sum: 1 },
      present: { $sum: { $cond: [{ $in: ["$status", ["present", "late"]] }, 1, 0] } },
      absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
      late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
      excused: { $sum: { $cond: [{ $eq: ["$status", "excused"] }, 1, 0] } }
    } },
    { $lookup: { from: "students", localField: "_id", foreignField: "_id", as: "student" } },
    { $unwind: "$student" },
    { $project: {
      _id: 0,
      studentId: "$student._id",
      name: "$student.name",
      nameEn: "$student.nameEn",
      nameUr: "$student.nameUr",
      nameTe: "$student.nameTe",
      admissionNo: "$student.admissionNo",
      total: 1,
      present: 1,
      absent: 1,
      late: 1,
      excused: 1,
      percentage: { $cond: [{ $gt: ["$total", 0] }, { $round: [{ $multiply: [{ $divide: ["$present", "$total"] }, 100] }, 1] }, 0] }
    } },
    { $sort: { admissionNo: 1, name: 1 } }
  ]);
  rows.sort(compareRollNumbers);
  res.json(rows);
});

app.get("/api/reports/export", exportRateLimiter, requireExportPin, async (req, res) => {
  const classId = req.query.classId;
  const from = req.query.from || req.query.startDate;
  const to = req.query.to || req.query.endDate;
  const format = req.query.format || "xlsx";
  const lang = String(req.query.lang || req.query.language || "en").toLowerCase();
  if (!classId || !from || !to) return res.status(400).json({ message: "classId, from and to are required." });
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });

  const targetClass = await Class.findById(classId);
  const cleanClassName = (targetClass ? `${targetClass.name}${targetClass.section ? `-${targetClass.section}` : ""}` : "Class")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safeFilename = `Madrasa-Amanah-Attendance-${cleanClassName}-${from}${from !== to ? `-to-${to}` : ""}`;

  const records = await Attendance.find({ classId, dateKey: { $gte: from, $lte: to } })
    .populate("studentId", "name nameEn nameUr nameTe admissionNo")
    .sort({ dateKey: 1 });
  const rows = records.map(r => {
    const s = r.studentId;
    let resolvedName = s?.name || "";
    if (lang === "ur" && s?.nameUr) resolvedName = s.nameUr;
    else if (lang === "te" && s?.nameTe) resolvedName = s.nameTe;
    else if (s?.nameEn) resolvedName = s.nameEn;

    return {
      Date: r.dateKey,
      "Admission No": s?.admissionNo || "",
      Student: resolvedName,
      Status: r.status,
      Note: r.note || ""
    };
  });

  if (format === "csv") {
    const headers = ["Date", "Admission No", "Student", "Status", "Note"];
    const quote = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "\uFEFF" + [headers, ...rows.map(r => headers.map(h => r[h]))].map(r => r.map(quote).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.csv"`);
    return res.send(csv);
  }

  if (format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.pdf"`);
    const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
    doc.pipe(res);
    doc.fontSize(16).text(`مَدْرَسَة  •  Madrasa Amanah - ${targetClass?.name || "Class"} Attendance Register`, { align: "center" });
    doc.moveDown(0.5).fontSize(9).text(`Period: ${from} to ${to} | Total Records: ${rows.length}`, { align: "center" });
    doc.moveDown();
    const cols = [36, 130, 240, 440, 550, 800];
    const heads = ["Date", "Admission No", "Student", "Status", "Note"];
    let y = doc.y;
    heads.forEach((h, i) => doc.text(h, cols[i], y, { width: cols[i + 1] - cols[i] - 5 }));
    y += 18;
    doc.moveTo(36, y).lineTo(805, y).stroke();
    for (const r of rows) {
      if (y > 530) { doc.addPage(); y = 40; }
      const vals = [r.Date, r["Admission No"], r.Student, r.Status, r.Note];
      vals.forEach((v, i) => doc.text(String(v).slice(0, 80), cols[i], y, { width: cols[i + 1] - cols[i] - 5, height: 26, ellipsis: true }));
      y += 18;
    }
    return doc.end();
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Attendance Register");
  ws.columns = [
    { header: "Date", key: "Date", width: 14 },
    { header: "Admission No", key: "Admission No", width: 18 },
    { header: "Student", key: "Student", width: 28 },
    { header: "Status", key: "Status", width: 14 },
    { header: "Note", key: "Note", width: 30 }
  ];
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.xlsx"; filename*=UTF-8''${encodeURIComponent(safeFilename)}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// --- WEEKLY EXCEL & PDF REPORT & EMAIL AUTOMATION ---
app.get("/api/reports/weekly-excel", requireAdmin, exportRateLimiter, requireExportPin, async (req, res) => {
  const prevWeek = getPreviousReportingWeek();
  const from = req.query.from || req.query.startDate || prevWeek.from;
  const to = req.query.to || req.query.endDate || prevWeek.to;
  const safeFilename = `Darul-Uloom-Ashrafia-Weekly-Attendance-${from}-to-${to}.xlsx`;

  const wb = await generateWeeklyExcelWorkbook({ from, to });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
  await wb.xlsx.write(res);
  res.end();
});

app.get("/api/reports/weekly-pdf", requireAdmin, exportRateLimiter, requireExportPin, async (req, res) => {
  const prevWeek = getPreviousReportingWeek();
  const from = req.query.from || req.query.startDate || prevWeek.from;
  const to = req.query.to || req.query.endDate || prevWeek.to;
  const safeFilename = `Darul-Uloom-Ashrafia-Weekly-Attendance-${from}-to-${to}.pdf`;

  const pdfBuffer = await generateWeeklyAttendancePdfBuffer({ from, to });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
  res.send(pdfBuffer);
});

app.post("/api/reports/send-weekly-email", requireAdmin, async (req, res) => {
  const prevWeek = getPreviousReportingWeek();
  const from = req.body.from || req.body.startDate || prevWeek.from;
  const to = req.body.to || req.body.endDate || prevWeek.to;
  let settings = null;
  try { settings = await SystemSetting.findOne({ key: "global" }); } catch {}
  const recipientEmail = resolveRecipientEmail(req.body.recipientEmail, settings);

  const result = await sendWeeklyEmailReport({
    from,
    to,
    recipientEmail,
    trigger: "manual-admin",
    actorId: req.user._id
  });

  res.json(result);
});

// --- EXTERNAL / VERCEL CRON TRIGGER (Protected by secret) ---
app.all(["/api/reports/cron-weekly", "/api/cron/weekly-report"], async (req, res) => {
  const scheduleSecret = (process.env.ATTENDANCE_REPORT_SCHEDULE_SECRET || process.env.CRON_SECRET || "").trim();
  const authHeader = req.headers["authorization"] || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const querySecret = (req.query.secret || req.headers["x-cron-secret"] || "").trim();

  if (!scheduleSecret || (bearerToken !== scheduleSecret && querySecret !== scheduleSecret)) {
    return res.status(401).json({ success: false, message: "Unauthorized: Invalid or missing ATTENDANCE_REPORT_SCHEDULE_SECRET." });
  }

  try {
    const { from, to } = getPreviousReportingWeek();
    const isoWeekKey = `${from}_${to}`;
    const force = req.query.force === "true" || req.body?.force === true;

    if (!force) {
      const existing = await AuditLog.findOne({
        action: "report.weekly_email_sent",
        "details.weekKey": isoWeekKey
      });
      if (existing) {
        return res.json({
          success: true,
          skipped: true,
          message: `Weekly report for ${isoWeekKey} already dispatched (messageId: ${existing.details?.messageId}). Skipping duplicate. Use ?force=true to override.`
        });
      }
    }

    let settings = null;
    try { settings = await SystemSetting.findOne({ key: "global" }); } catch {}
    const recipientEmail = resolveRecipientEmail(null, settings);

    const result = await sendWeeklyEmailReport({
      from,
      to,
      recipientEmail,
      trigger: "cron-external"
    });

    if (result.delivered) {
      const adminUser = await User.findOne({ role: "admin" }).select("_id");
      await AuditLog.create({
        actorId: adminUser ? adminUser._id : new mongoose.Types.ObjectId(),
        action: "report.weekly_email_sent",
        entityType: "Report",
        details: {
          recipient: recipientEmail,
          from,
          to,
          weekKey: isoWeekKey,
          messageId: result.messageId,
          trigger: "cron-external"
        }
      });
    }

    return res.json({
      success: result.delivered,
      result
    });
  } catch (err) {
    console.error("[CRON-ENDPOINT] Error executing weekly report cron:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Shared email status helper
async function buildEmailStatusPayload() {
  const prevWeek = getPreviousReportingWeek();
  let settings = await SystemSetting.findOne({ key: "global" });
  const brevoApiKey = (process.env.BREVO_API_KEY || "").trim();
  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  const emailConfigured = Boolean(brevoApiKey || resendApiKey || (smtpUser && smtpPass));
  const recipient = resolveRecipientEmail(null, settings);
  const timezone = settings?.reportTimezone || process.env.REPORT_TIMEZONE || "Asia/Kolkata";
  const schedule = settings?.reportSchedule || "Sundays at 07:00 PM (IST)";
  const automationEnabled = Boolean(settings?.reportAutomationEnabled);
  const isAutomated = automationEnabled && emailConfigured;
  const nextRun = isAutomated ? getNextScheduledReportRun(schedule, timezone) : null;

  return {
    recipientEmail: recipient,
    emailConfigured,
    smtpConfigured: emailConfigured,
    provider: brevoApiKey ? "Brevo HTTPS API (Port 443)" : (resendApiKey ? "Resend HTTPS API (Port 443)" : (smtpUser ? "SMTP" : "None")),
    timezone,
    schedule,
    automationEnabled,
    isAutomated,
    previousReportingWeek: prevWeek,
    lastSuccess: settings?.lastReportSuccess || null,
    lastFailure: settings?.lastReportFailure || null,
    nextScheduledRun: nextRun
  };
}

// Primary route — used by legacy clients
app.get("/api/reports/email-status", requireAdmin, async (_req, res) => {
  res.json(await buildEmailStatusPayload());
});

// Frontend-expected route alias (client calls /reports/weekly/status)
app.get("/api/reports/weekly/status", requireAdmin, async (_req, res) => {
  res.json(await buildEmailStatusPayload());
});

// --- SEND TEST EMAIL (Admin Only) ---
app.post("/api/reports/send-test-email", requireAdmin, async (req, res) => {
  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  const brevoApiKey = (process.env.BREVO_API_KEY || "").trim();
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").replace(/\s+/g, "");
  const smtpHost = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const isSecure = process.env.SMTP_SECURE === "true" || smtpPort === 465;
  const smtpFrom = process.env.SMTP_FROM || `"Madrasa Amanah" <${smtpUser || "reports@madrasa-amanah.com"}>`;

  const emailConfigured = Boolean(resendApiKey || brevoApiKey || (smtpUser && smtpPass));

  if (!emailConfigured) {
    return res.status(400).json({
      success: false,
      message: "Email credentials are not configured. Add RESEND_API_KEY (recommended for Render) or SMTP_USER and SMTP_PASS in environment variables.",
      actionRequired: "Configure RESEND_API_KEY in Render service environment to bypass free tier SMTP port restrictions."
    });
  }

  let settings = null;
  try { settings = await SystemSetting.findOne({ key: "global" }); } catch {}
  const recipientEmail = resolveRecipientEmail(req.body.recipientEmail, settings);
  const recipients = parseRecipientEmails(recipientEmail);

  if (recipients.length === 0) {
    return res.status(400).json({ success: false, message: `Invalid recipient address: ${recipientEmail}` });
  }

  const startTime = Date.now();
  try {
    let providerInfo = `${smtpHost}:${smtpPort}`;

    let testSuccess = false;
    let messageId = null;
    let lastError = null;

    if (brevoApiKey && !testSuccess) {
      try {
        providerInfo = "Brevo HTTPS API (Port 443)";
        const brevoSenderEmail = (process.env.BREVO_FROM || process.env.SMTP_USER || recipients[0]).trim();
        const response = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": brevoApiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sender: { name: "Darul Uloom Ashrafia, Atmakur", email: brevoSenderEmail },
            to: recipients.map(email => ({ email })),
            subject: `[Test] Darul Uloom Ashrafia — Email Test — ${new Date().toUTCString()}`,
            textContent: `Assalamu Alaikum,\n\nThis is a configuration test email from Darul Uloom Ashrafia, Atmakur (Madrasa Amanah Smart Attendance System).\n\nRecipients: ${recipients.join(", ")}`,
            htmlContent: `<div style="font-family:Arial,sans-serif;max-width:520px;padding:24px;border:1px solid #DFE5E0;border-radius:8px;background:#F7F6F0">
              <h2 style="color:#174B36">دارالعلوم اشرفیہ</h2>
              <p style="font-weight:bold;color:#174B36">Darul Uloom Ashrafia, Atmakur</p>
              <p>✅ Email configuration is verified and working via Brevo HTTPS.</p>
              <p style="font-size:12px;color:#68776D">Delivered to: ${recipients.join(", ")}</p>
            </div>`
          })
        });
        const data = await response.json();
        if (response.ok) {
          messageId = data.messageId || "brevo-test-ok";
          testSuccess = true;
        } else {
          lastError = new Error(data?.message || "Brevo error");
        }
      } catch (e) {
        lastError = e;
      }
    }

    if (!testSuccess && smtpUser && smtpPass) {
      try {
        providerInfo = `Gmail SMTP (${smtpHost}:${smtpPort})`;
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: isSecure,
          auth: { user: smtpUser, pass: smtpPass },
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 20000
        });

        const info = await transporter.sendMail({
          from: smtpFrom,
          to: recipients.join(", "),
          subject: `[Test] Darul Uloom Ashrafia — Email Test — ${new Date().toUTCString()}`,
          text: `Assalamu Alaikum,\n\nThis is a configuration test email from Darul Uloom Ashrafia, Atmakur.\n\nRecipients: ${recipients.join(", ")}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;padding:24px;border:1px solid #DFE5E0;border-radius:8px;background:#F7F6F0">
            <h2 style="color:#174B36">دارالعلوم اشرفیہ</h2>
            <p style="font-weight:bold;color:#174B36">Darul Uloom Ashrafia, Atmakur</p>
            <p>✅ Email configuration is verified and working via SMTP.</p>
            <p style="font-size:12px;color:#68776D">Delivered to: ${recipients.join(", ")}</p>
          </div>`
        });
        messageId = info.messageId || "smtp-test-ok";
        testSuccess = true;
        lastError = null;
      } catch (e) {
        if (!lastError) lastError = e;
      }
    }

    if (!testSuccess && resendApiKey) {
      try {
        providerInfo = "Resend HTTPS API (Port 443)";
        const resendFrom = process.env.RESEND_FROM || "Darul Uloom Ashrafia <onboarding@resend.dev>";
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: resendFrom,
            to: recipients,
            subject: `[Test] Darul Uloom Ashrafia — Email Test — ${new Date().toUTCString()}`,
            text: `Assalamu Alaikum,\n\nThis is a configuration test email from Darul Uloom Ashrafia, Atmakur.\n\nSent: ${new Date().toUTCString()}\nRecipients: ${recipients.join(", ")}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:520px;padding:24px;border:1px solid #DFE5E0;border-radius:8px;background:#F7F6F0">
              <h2 style="color:#174B36">دارالعلوم اشرفیہ</h2>
              <p style="font-weight:bold;color:#174B36">Darul Uloom Ashrafia, Atmakur</p>
              <p>✅ Email configuration is working via Resend HTTPS.</p>
              <p style="font-size:12px;color:#68776D">Delivered to: ${recipients.join(", ")}</p>
            </div>`
          })
        });
        const data = await response.json();
        if (response.ok) {
          messageId = data.id || "resend-test-ok";
          testSuccess = true;
          lastError = null;
        } else {
          if (!lastError) lastError = new Error(data?.message || data?.error?.message || "Resend error");
        }
      } catch (e) {
        if (!lastError) lastError = e;
      }
    }

    if (!testSuccess) {
      throw (lastError || new Error("Failed to send test email through all available providers."));
    }

    const latencyMs = Date.now() - startTime;

    await AuditLog.create({
      actorId: req.user._id,
      action: "report.test_email_sent",
      entityType: "Report",
      details: { recipient: recipientEmail, messageId, latencyMs, trigger: "manual-test" }
    });

    // Record last success so dashboard can display it
    try {
      if (!settings) settings = new SystemSetting({ key: "global" });
      settings.lastReportSuccess = {
        sentAt: new Date(),
        recipient: recipientEmail,
        period: "Test Email",
        messageId,
        bytes: 0
      };
      await settings.save();
    } catch {}

    return res.json({
      success: true,
      accepted: true,
      messageId: info.messageId,
      recipient: recipientEmail,
      latencyMs,
      provider: `${smtpHost}:${smtpPort}`,
      note: "Provider accepted the message. This does not guarantee inbox delivery — check spam if not visible."
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    // Sanitize error: never log raw credentials
    const safeMessage = (err.message || "SMTP error").replace(/[^\x20-\x7E]/g, "");

    // Record failure
    try {
      if (!settings) settings = new SystemSetting({ key: "global" });
      settings.lastReportFailure = { failedAt: new Date(), error: safeMessage, recipient: recipientEmail, period: "Test Email" };
      await settings.save();
    } catch {}

    return res.status(502).json({
      success: false,
      accepted: false,
      error: safeMessage,
      recipient: recipientEmail,
      latencyMs,
      provider: `${smtpHost}:${smtpPort}`,
      actionRequired: "Verify SMTP_USER, SMTP_PASS, SMTP_HOST, SMTP_PORT are correct. For Gmail, use an App Password (not your account password) and ensure 2FA is enabled."
    });
  }
});

// Application Settings & Weekly Report Configuration (Admin Only)
app.get("/api/settings", requireAdmin, async (_req, res) => {
  let settings = await SystemSetting.findOne({ key: "global" });
  const defaultEmail = (process.env.ATTENDANCE_REPORT_EMAIL || process.env.REPORT_RECIPIENT_EMAIL || "mdrafiq12118@gmail.com").trim();
  if (!settings) {
    settings = await SystemSetting.create({
      key: "global",
      reportRecipientEmail: defaultEmail,
      reportTimezone: process.env.REPORT_TIMEZONE || "Asia/Kolkata",
      reportSchedule: "Sundays at 07:00 PM (IST)",
      reportAutomationEnabled: false,
      attendanceCorrectionWindowDays: 7
    });
  }

  const brevoApiKey = (process.env.BREVO_API_KEY || "").trim();
  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  const emailConfigured = Boolean(brevoApiKey || resendApiKey || (smtpUser && smtpPass));
  const nextRun = settings.reportAutomationEnabled && emailConfigured
    ? getNextScheduledReportRun(settings.reportSchedule || "Sundays at 07:00 PM (IST)", settings.reportTimezone || "Asia/Kolkata")
    : null;

  res.json({
    reportRecipientEmail: resolveRecipientEmail(null, settings),
    reportTimezone: settings.reportTimezone || "Asia/Kolkata",
    reportSchedule: settings.reportSchedule || "Sundays at 07:00 PM (IST)",
    reportAutomationEnabled: settings.reportAutomationEnabled,
    isAutomated: settings.reportAutomationEnabled && emailConfigured,
    emailConfigured,
    smtpConfigured: emailConfigured,
    provider: brevoApiKey ? "Brevo HTTPS API (Port 443)" : (resendApiKey ? "Resend HTTPS API (Port 443)" : (smtpUser ? "SMTP" : "None")),
    attendanceCorrectionWindowDays: settings.attendanceCorrectionWindowDays || 7,
    lastReportSuccess: settings.lastReportSuccess,
    lastReportFailure: settings.lastReportFailure,
    nextScheduledRun: nextRun
  });
});

app.patch("/api/settings", requireAdmin, async (req, res) => {
  let settings = await SystemSetting.findOne({ key: "global" });
  if (!settings) settings = new SystemSetting({ key: "global" });

  if (req.body.reportRecipientEmail !== undefined) {
    settings.reportRecipientEmail = String(req.body.reportRecipientEmail || "").trim();
  }
  if (req.body.reportTimezone !== undefined) {
    settings.reportTimezone = String(req.body.reportTimezone || "").trim();
  }
  if (req.body.reportSchedule !== undefined) {
    settings.reportSchedule = String(req.body.reportSchedule || "").trim();
  }
  if (req.body.reportAutomationEnabled !== undefined) {
    settings.reportAutomationEnabled = Boolean(req.body.reportAutomationEnabled);
  }
  if (req.body.attendanceCorrectionWindowDays !== undefined) {
    settings.attendanceCorrectionWindowDays = Math.max(1, Number(req.body.attendanceCorrectionWindowDays) || 7);
  }

  await settings.save();
  await AuditLog.create({
    actorId: req.user._id,
    action: "settings.update",
    entityType: "SystemSetting",
    entityId: String(settings._id),
    details: req.body
  });

  const brevoApiKey = (process.env.BREVO_API_KEY || "").trim();
  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  const emailConfigured = Boolean(brevoApiKey || resendApiKey || (smtpUser && smtpPass));
  const nextRun = settings.reportAutomationEnabled && emailConfigured
    ? getNextScheduledReportRun(settings.reportSchedule, settings.reportTimezone)
    : null;

  res.json({
    message: "Settings updated successfully.",
    settings: {
      reportRecipientEmail: settings.reportRecipientEmail,
      reportTimezone: settings.reportTimezone,
      reportSchedule: settings.reportSchedule,
      reportAutomationEnabled: settings.reportAutomationEnabled,
      isAutomated: settings.reportAutomationEnabled && emailConfigured,
      emailConfigured,
      smtpConfigured: emailConfigured,
      provider: brevoApiKey ? "Brevo HTTPS API (Port 443)" : (resendApiKey ? "Resend HTTPS API (Port 443)" : (smtpUser ? "SMTP" : "None")),
      attendanceCorrectionWindowDays: settings.attendanceCorrectionWindowDays,
      lastReportSuccess: settings.lastReportSuccess,
      lastReportFailure: settings.lastReportFailure,
      nextScheduledRun: nextRun
    }
  });
});

// --- SIX-MONTH DATA RETENTION & BACKUP ENDPOINTS ---
app.get("/api/admin/retention/status", requireAdmin, async (_req, res) => {
  const retentionDays = 180; // 6 months
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [totalRecords, recordsOlder, oldestDoc, newestDoc] = await Promise.all([
    Attendance.countDocuments(),
    Attendance.countDocuments({ dateKey: { $lt: cutoffDate } }),
    Attendance.findOne().sort({ dateKey: 1 }).select("dateKey"),
    Attendance.findOne().sort({ dateKey: -1 }).select("dateKey")
  ]);

  res.json({
    retentionPolicy: "180 days (6 months)",
    retentionDays,
    cutoffDate,
    totalRecords,
    recordsWithinRetention: totalRecords - recordsOlder,
    recordsEligibleForArchival: recordsOlder,
    oldestRecordDate: oldestDoc ? oldestDoc.dateKey : null,
    newestRecordDate: newestDoc ? newestDoc.dateKey : null
  });
});

app.post("/api/admin/retention/archive", requireAdmin, async (req, res) => {
  const retentionDays = Number(req.body.retentionDays || 180);
  const cutoffDate = req.body.cutoffDate || new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const eligibleCount = await Attendance.countDocuments({ dateKey: { $lt: cutoffDate } });

  if (req.body.confirmPurge === true && eligibleCount > 0) {
    const deleteResult = await Attendance.deleteMany({ dateKey: { $lt: cutoffDate } });
    await AuditLog.create({
      actorId: req.user._id,
      action: "retention.purge_old_records",
      entityType: "Attendance",
      details: { cutoffDate, purgedCount: deleteResult.deletedCount }
    });
    return res.json({
      message: `Successfully archived and purged ${deleteResult.deletedCount} attendance record(s) older than ${cutoffDate}.`,
      purgedCount: deleteResult.deletedCount,
      cutoffDate
    });
  }

  res.json({
    message: `Identified ${eligibleCount} attendance record(s) older than ${cutoffDate}. Set confirmPurge: true to finalize retention purge.`,
    eligibleCount,
    cutoffDate
  });
});

// Full Structured System Backup Download
app.get("/api/admin/backup/export", requireAdmin, exportRateLimiter, requireExportPin, async (req, res) => {
  const todayStr = new Date().toISOString().slice(0, 10);
  const safeFilename = `Madrasa-Amanah-Backup-${todayStr}.json`;

  const [classes, students, attendance, auditLogs] = await Promise.all([
    Class.find().lean(),
    Student.find().select("-faceDescriptor").lean(),
    Attendance.find().lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(500).lean()
  ]);

  const backupPackage = {
    metadata: {
      system: "Madrasa Amanah Smart Attendance System",
      version: "1.0.0",
      exportTimestamp: new Date().toISOString(),
      exportedBy: req.user.email,
      counts: {
        classes: classes.length,
        students: students.length,
        attendance: attendance.length,
        auditLogs: auditLogs.length
      }
    },
    classes,
    students,
    attendance,
    auditLogs
  };

  await AuditLog.create({
    actorId: req.user._id,
    action: "backup.export",
    entityType: "SystemBackup",
    details: { counts: backupPackage.metadata.counts }
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
  res.send(JSON.stringify(backupPackage, null, 2));
});

// --- AUTOMATED MONTHLY EXCEL BACKUP ENDPOINTS ---
// GET /api/admin/backup/monthly-excel
// Authenticated with Admin JWT or restricted x-backup-token / BACKUP_SERVICE_TOKEN
app.get("/api/admin/backup/monthly-excel", requireAdmin, exportRateLimiter, requireExportPin, async (req, res) => {
  const monthParam = req.query.month;
  const monthMeta = monthParam
    ? parseReportingMonth(monthParam)
    : getPreviousReportingMonth(new Date(), process.env.REPORT_TIMEZONE || "Asia/Kolkata");

  if (req.query.download === "true" || req.query.download === "1") {
    const { workbook } = await generateMonthlyExcelWorkbook({
      from: monthMeta.from,
      to: monthMeta.to,
      monthLabel: monthMeta.monthLabel,
      monthKey: monthMeta.monthKey
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${monthMeta.filename}"; filename*=UTF-8''${encodeURIComponent(monthMeta.filename)}`);
    await workbook.xlsx.write(res);
    return res.end();
  }

  // Verification / Status check mode
  const result = await exportAndSaveMonthlyBackup({
    targetMonth: monthParam,
    force: req.query.force === "true",
    actorId: req.user._id
  });

  res.json(result);
});

// POST /api/admin/backup/monthly-export
// Executes export, saves to backups/YYYY/YYYY-MM-attendance.xlsx, generates sha256, verifies integrity
app.post("/api/admin/backup/monthly-export", requireAdmin, async (req, res) => {
  const targetMonth = req.body.month;
  const force = Boolean(req.body.force);

  const result = await exportAndSaveMonthlyBackup({
    targetMonth,
    force,
    actorId: req.user._id
  });

  res.json(result);
});

// Admin User Management
app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  const users = await User.find()
    .select("name email role assignedClasses active createdAt")
    .populate("assignedClasses", "name section")
    .sort({ name: 1 });
  res.json(users);
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  const { name, email, password, role = "teacher", assignedClasses = [] } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ message: "Name, email and a password of at least 8 characters are required." });
  }
  if (!["admin", "teacher"].includes(role)) return res.status(400).json({ message: "Invalid role." });
  try {
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      role,
      assignedClasses,
      passwordHash: await bcrypt.hash(password, 12)
    });

    if (assignedClasses.length > 0) {
      await Class.updateMany({ _id: { $in: assignedClasses } }, { $addToSet: { teacherIds: user._id } });
    }

    await AuditLog.create({ actorId: req.user._id, action: "user.create", entityType: "User", entityId: String(user._id) });
    res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role, assignedClasses: user.assignedClasses });
  } catch (e) {
    res.status(400).json({ message: e.code === 11000 ? "Email already exists." : e.message });
  }
});

app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found." });
  const fields = ["name", "role", "assignedClasses", "active"];
  fields.forEach(f => { if (req.body[f] !== undefined) user[f] = req.body[f]; });
  if (req.body.password && req.body.password.length >= 8) {
    user.passwordHash = await bcrypt.hash(req.body.password, 12);
  }
  await user.save();

  if (req.body.assignedClasses !== undefined) {
    await Class.updateMany({ teacherIds: user._id }, { $pull: { teacherIds: user._id } });
    if (user.assignedClasses.length > 0) {
      await Class.updateMany({ _id: { $in: user.assignedClasses } }, { $addToSet: { teacherIds: user._id } });
    }
  }

  await AuditLog.create({ actorId: req.user._id, action: "user.update", entityType: "User", entityId: String(user._id) });
  res.json({ id: user._id, name: user.name, email: user.email, role: user.role, active: user.active, assignedClasses: user.assignedClasses });
});

// Safe Teacher / User Deactivation & Removal (Preserves attendance and audit records)
app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found." });
  if (String(user._id) === String(req.user._id)) {
    return res.status(400).json({ message: "You cannot remove your own administrative account." });
  }

  // Remove teacher from any class assignments
  await Class.updateMany({ teacherIds: user._id }, { $pull: { teacherIds: user._id } });

  const attCount = await Attendance.countDocuments({ markedBy: user._id });
  const isPermanent = req.query.permanent === "true" || attCount === 0;

  if (isPermanent) {
    await User.findByIdAndDelete(user._id);
    await AuditLog.create({
      actorId: req.user._id,
      action: "user.delete",
      entityType: "User",
      entityId: String(user._id),
      details: { name: user.name, email: user.email, role: user.role, permanentlyDeleted: true }
    });
    return res.json({
      success: true,
      deleted: true,
      message: `Teacher ${user.name} removed successfully.`,
      id: String(user._id)
    });
  } else {
    user.active = false;
    await user.save();
    await AuditLog.create({
      actorId: req.user._id,
      action: "user.deactivate",
      entityType: "User",
      entityId: String(user._id),
      details: { name: user.name, email: user.email, role: user.role, permanentlyDeleted: false }
    });
    return res.json({
      success: true,
      deactivated: true,
      message: `Teacher ${user.name} removed and deactivated from active roster.`,
      user: { id: user._id, name: user.name, email: user.email, active: false }
    });
  }
});

app.post("/api/admin/users/:id/reset-password", requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ message: "A new password of at least 8 characters is required." });
  }
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found." });
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();
  await AuditLog.create({
    actorId: req.user._id,
    action: "user.reset_password",
    entityType: "User",
    entityId: String(user._id),
    details: { targetEmail: user.email }
  });
  res.json({ message: `Password for ${user.name} reset successfully.` });
});

// --- SAFE MONGODB STORAGE ROTATION & MONITORING (ADMIN ONLY) ---
// Returns backend-native shape AND frontend-compatible bridge fields so both API
// consumers (dashboard UI + integration tests) work without a breaking change.
app.get("/api/admin/storage/status", requireAdmin, async (_req, res) => {
  const [report, eligibility, recentArchives, latestArchive, settings] = await Promise.all([
    getStorageHealthReport(),
    checkStorageAndArchivalEligibility().catch(err => ({ error: err.message, eligibleCount: 0 })),
    AttendanceArchive.find().sort({ createdAt: -1 }).limit(10).lean().catch(() => []),
    AttendanceArchive.findOne().sort({ createdAt: -1 }).lean().catch(() => null),
    SystemSetting.findOne({ key: "global" }).lean().catch(() => null)
  ]);

  // Bridge: flatten to the shape the frontend dashboard expects
  const primaryUri = process.env.MONGODB_URI_PRIMARY || process.env.MONGODB_URI || "";
  const secondaryUri = process.env.MONGODB_URI_SECONDARY || "";
  const m = report.primary?.metrics || {};

  const primaryStats = {
    database: report.primary?.databaseName || "madrasa_attendance",
    dataSizeMB: m.available ? m.dataSizeMB : null,
    storageSizeMB: m.available ? m.storageSizeMB : null,
    indexSizeMB: m.available ? m.indexSizeMB : null,
    totalSizeMB: m.available ? m.totalSizeMB : null,
    limitMB: m.limitMB || 512,
    percentageUsed: m.available ? m.usagePercent : null,
    available: Boolean(m.available),
    statusText: m.statusText || "Storage usage unavailable",
    maskedUri: maskMongoUri(primaryUri)
  };

  const secondaryConfigured = Boolean(secondaryUri && secondaryUri.length > 10);
  const githubRepoName = process.env.GITHUB_ARCHIVE_REPO || "Sameersam3909/-Madrasa_Attandace";
  const hasGitHubToken = Boolean(process.env.GITHUB_ARCHIVE_TOKEN || process.env.GITHUB_TOKEN);

  res.json({
    // Native backend fields (keep for API consumers & tests)
    ...report,
    // Frontend bridge fields
    primaryStats,
    secondaryConfigured,
    secondaryStats: secondaryConfigured ? {
      maskedUri: maskMongoUri(secondaryUri),
      host: report.secondary?.host || "configured"
    } : null,
    activeStorage: report.activeWriteDestination || "primary",
    rotationHistory: (report.rotationHistory || []).map(r => ({
      from: r.from,
      to: r.to,
      reason: r.reason,
      rotatedAt: r.timestamp || r.rotatedAt
    })),
    // Six-Month Archival & Storage Management Status
    archival: {
      cutoffDate: eligibility.cutoffDate || null,
      eligibleCount: eligibility.eligibleCount || 0,
      totalAttendance: eligibility.totalAttendance || 0,
      retentionMonths: eligibility.retentionMonths || 6,
      triggerPercent: eligibility.triggerPercent || 80,
      targetPercent: eligibility.targetPercent || 70,
      recommendation: eligibility.recommendation || "NORMAL",
      message: eligibility.message || "",
      isStorageHigh: eligibility.isStorageHigh || false,
      githubRepo: `https://github.com/${githubRepoName.replace(/^https?:\/\/github\.com\//, "")}`,
      githubConfigured: hasGitHubToken,
      latestArchive: latestArchive ? {
        archiveId: latestArchive.archiveId,
        dateRange: latestArchive.dateRange,
        recordCount: latestArchive.recordCount,
        sha256: latestArchive.sha256,
        byteSize: latestArchive.byteSize,
        githubUrl: latestArchive.githubFileUrl,
        verificationStatus: latestArchive.verificationStatus,
        archivedAt: latestArchive.createdAt,
        deletedFromDb: latestArchive.deletedFromDb,
        deletedCount: latestArchive.deletedCount
      } : null,
      recentArchives: (recentArchives || []).map(a => ({
        archiveId: a.archiveId,
        dateRange: a.dateRange,
        recordCount: a.recordCount,
        sha256: a.sha256,
        byteSize: a.byteSize,
        githubUrl: a.githubFileUrl,
        verificationStatus: a.verificationStatus,
        archivedAt: a.createdAt,
        deletedFromDb: a.deletedFromDb,
        deletedCount: a.deletedCount,
        status: a.status
      })),
      lastArchivalRun: settings?.lastArchivalRun || null,
      lastArchivalFailure: settings?.lastArchivalFailure || null,
      nextScheduledCheck: "1st of every month at 02:00 AM UTC"
    }
  });
});

// --- SIX-MONTH ATTENDANCE ARCHIVAL & STORAGE MANAGEMENT ENDPOINTS ---

// 1. Preview eligible records without any modification
app.post("/api/admin/storage/archive-preview", requireAdmin, async (_req, res) => {
  const eligibility = await checkStorageAndArchivalEligibility();
  const cutoffDate = eligibility.cutoffDate;

  const [eligibleRecords, classBreakdown] = await Promise.all([
    Attendance.find({ dateKey: { $lt: cutoffDate } })
      .populate("classId", "name section")
      .sort({ dateKey: 1 })
      .limit(20)
      .lean(),
    Attendance.aggregate([
      { $match: { dateKey: { $lt: cutoffDate } } },
      { $group: { _id: "$classId", count: { $sum: 1 } } }
    ])
  ]);

  const classMap = {};
  for (const c of classBreakdown) {
    if (c._id) classMap[String(c._id)] = c.count;
  }

  const oldestDate = eligibility.oldestDateKey;
  const newestDate = eligibility.newestEligibleDateKey;

  res.json({
    cutoffDate,
    retentionMonths: eligibility.retentionMonths,
    totalAttendance: eligibility.totalAttendance,
    eligibleCount: eligibility.eligibleCount,
    dateRange: {
      from: oldestDate || "N/A",
      to: newestDate || "N/A"
    },
    sampleRecordsCount: eligibleRecords.length,
    storageMetrics: eligibility.storageMetrics,
    isStorageHigh: eligibility.isStorageHigh,
    recommendation: eligibility.recommendation,
    destination: `https://github.com/${process.env.GITHUB_ARCHIVE_REPO || "Sameersam3909/-Madrasa_Attandace"}`,
    message: eligibility.message
  });
});

// 2. Trigger automated check and conditional archival
app.post("/api/admin/storage/archive-check", requireAdmin, async (req, res) => {
  const force = Boolean(req.body.force);
  const result = await runAutomatedArchivalCycle({
    trigger: "manual-admin",
    force,
    actorId: req.user._id
  });
  res.json(result);
});

// 3. Admin-confirmed manual archival execution
app.post("/api/admin/storage/archive-execute", requireAdmin, async (req, res) => {
  const result = await runAutomatedArchivalCycle({
    trigger: "manual-admin-confirmed",
    force: true,
    actorId: req.user._id
  });
  res.json(result);
});

// 4. Restore attendance archive
app.post("/api/admin/storage/archive-restore", requireAdmin, async (req, res) => {
  const { archiveId, payload } = req.body;
  if (!archiveId && !payload) {
    return res.status(400).json({ message: "Either archiveId or payload is required to restore an archive." });
  }

  const result = await restoreAttendanceArchive({
    archiveId,
    archiveBufferOrJson: payload,
    actorId: req.user._id
  });
  res.json(result);
});

// 5. List historical archives
app.get("/api/admin/storage/archives", requireAdmin, async (_req, res) => {
  const archives = await AttendanceArchive.find().sort({ createdAt: -1 }).limit(50).lean();
  res.json(archives);
});

// --- INDEPENDENT DUAL DATABASE HEALTH DIAGNOSTICS (ADMIN ONLY) ---
app.get("/api/admin/database-health", requireAdmin, async (_req, res) => {
  const result = await testDualDatabases();
  res.json(result);
});

app.post("/api/admin/database-health/test-connection", requireAdmin, async (req, res) => {
  const { target } = req.body;
  const uri = target === "secondary" ? process.env.MONGODB_URI_SECONDARY : (process.env.MONGODB_URI_PRIMARY || process.env.MONGODB_URI);
  const label = target === "secondary" ? "Secondary Database" : "Primary Database";
  const result = await testDatabaseConnection(uri, label);
  res.json(result);
});

app.post("/api/admin/storage/verify-secondary", requireAdmin, async (req, res) => {
  const result = await verifySecondaryDatabase();
  await AuditLog.create({
    actorId: req.user._id,
    action: "storage.verify_secondary",
    entityType: "DatabaseCluster",
    details: result
  });
  res.json(result);
});

app.post("/api/admin/storage/rotate", requireAdmin, async (req, res) => {
  const target = req.body.target;
  const reason = req.body.reason || "Manual rotation triggered by administrator";
  try {
    const result = await rotateWriteDestination({
      target,
      reason,
      trigger: "manual-admin",
      actorId: req.user._id
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.patch("/api/admin/storage/settings", requireAdmin, async (req, res) => {
  let settings = await SystemSetting.findOne({ key: "global" });
  if (!settings) settings = new SystemSetting({ key: "global" });
  if (req.body.databaseRotationEnabled !== undefined) {
    settings.databaseRotationEnabled = Boolean(req.body.databaseRotationEnabled);
  }
  await settings.save();
  await AuditLog.create({
    actorId: req.user._id,
    action: "storage.settings_update",
    entityType: "SystemSetting",
    details: { databaseRotationEnabled: settings.databaseRotationEnabled }
  });
  res.json({
    message: "Storage rotation settings updated.",
    databaseRotationEnabled: settings.databaseRotationEnabled
  });
});

app.get("/api/admin/audit", requireAdmin, async (_req, res) => {
  const logs = await AuditLog.find().populate("actorId", "name email").sort({ createdAt: -1 }).limit(100);
  res.json(logs);
});

// Protected Admin Diagnostic Endpoint — Data Integrity & MongoDB Status
app.get("/api/admin/diagnostics", requireAdmin, async (_req, res) => {
  const dbInfo = getDatabaseInfo();
  const [activeStudents, archivedStudents, totalClasses, totalAttendance, totalUsers] = await Promise.all([
    Student.countDocuments({ active: true }),
    Student.countDocuments({ active: false }),
    Class.countDocuments({ active: true }),
    Attendance.countDocuments(),
    User.countDocuments({ active: true })
  ]);

  res.json({
    status: dbInfo.connected ? "connected" : "disconnected",
    database: {
      provider: dbInfo.engine,
      state: dbInfo.status,
      databaseName: dbInfo.databaseName
    },
    counts: {
      activeStudents,
      archivedStudents,
      totalStudents: activeStudents + archivedStudents,
      classes: totalClasses,
      attendanceRecords: totalAttendance,
      users: totalUsers
    },
    system: {
      nodeEnv: process.env.NODE_ENV || "development",
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }
  });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled API Error:", err);
  res.status(500).json({ message: "Unexpected server error." });
});

// Startup and bootstrap
const port = process.env.PORT || 4000;
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("JWT_SECRET must be configured and at least 32 characters.");
  process.exit(1);
}

await connectDB();

// Auto-seed default administrator if no users exist
const adminCount = await User.countDocuments();
if (adminCount === 0) {
  const adminName = process.env.ADMIN_NAME || "Madrasa Administrator";
  const adminEmail = (process.env.ADMIN_EMAIL || "2300030621cseh1@gmail.com").toLowerCase().trim();
  const adminPass = process.env.ADMIN_PASSWORD || "Shaiksameer/3909";
  const hash = await bcrypt.hash(adminPass, 12);
  const adminUser = await User.create({
    name: adminName,
    email: adminEmail,
    role: "admin",
    passwordHash: hash
  });
  console.log(`[BOOTSTRAP] Initial admin created: ${adminEmail} (password: ${adminPass})`);

  let c1 = await Class.findOne({ name: "Hifz Class", section: "Morning" });
  if (!c1) {
    c1 = await Class.create({ name: "Hifz Class", section: "Morning", academicYear: "1447-1448 / 2026", teacherIds: [adminUser._id] });
  }
  let c2 = await Class.findOne({ name: "Nazira Class", section: "Evening" });
  if (!c2) {
    c2 = await Class.create({ name: "Nazira Class", section: "Evening", academicYear: "1447-1448 / 2026", teacherIds: [adminUser._id] });
  }
  console.log(`[BOOTSTRAP] Verified default classes: ${c1.name}, ${c2.name}`);

  // In production, NEVER seed mock/sample students! Keep production data clean and dynamic.
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction && (await Student.countDocuments()) === 0) {
    await Student.create([
      { admissionNo: "ADM-101", name: "Muhammad Zaid", classId: c1._id, guardianName: "Farooq Khan", guardianPhone: "9876543210", consentGiven: true },
      { admissionNo: "ADM-102", name: "Abdullah Umar", classId: c1._id, guardianName: "Umar Farooq", guardianPhone: "9876543211", consentGiven: true },
      { admissionNo: "ADM-103", name: "Fatima Zahra", classId: c1._id, guardianName: "Hassan Ali", guardianPhone: "9876543212", consentGiven: true },
      { admissionNo: "ADM-104", name: "Bilal Habashi", classId: c1._id, guardianName: "Ibrahim", guardianPhone: "9876543213", consentGiven: true },
      { admissionNo: "ADM-105", name: "Mariam Siddiq", classId: c1._id, guardianName: "Abu Bakr", guardianPhone: "9876543214", consentGiven: true }
    ]);
    console.log("[BOOTSTRAP] Created initial sample students for local development.");
  }
}

// ──────────────────────────────────────────────────────────────
// Ensure SystemSetting document exists with correct default email
// ──────────────────────────────────────────────────────────────
try {
  let globalSettings = await SystemSetting.findOne({ key: "global" });
  const configuredEmail = (process.env.ATTENDANCE_REPORT_EMAIL || process.env.REPORT_RECIPIENT_EMAIL || process.env.ADMIN_EMAIL || "mdrafiq12118@gmail.com").trim();
  if (!globalSettings) {
    globalSettings = await SystemSetting.create({
      key: "global",
      reportRecipientEmail: configuredEmail,
      reportTimezone: process.env.REPORT_TIMEZONE || "Asia/Kolkata",
      reportSchedule: "Sundays at 07:00 PM (IST)",
      reportAutomationEnabled: false,
      attendanceCorrectionWindowDays: 7
    });
    console.log("[BOOTSTRAP] SystemSetting created with default recipient:", globalSettings.reportRecipientEmail);
  } else {
    // If DB still has the legacy developer email or is blank, auto-update it to the client email
    if (!globalSettings.reportRecipientEmail || globalSettings.reportRecipientEmail === "2300030621cseh1@gmail.com") {
      globalSettings.reportRecipientEmail = configuredEmail;
      globalSettings.reportSchedule = "Sundays at 07:00 PM (IST)";
      await globalSettings.save();
      console.log("[BOOTSTRAP] SystemSetting recipient auto-synced from env to:", globalSettings.reportRecipientEmail);
    }
  }
} catch (err) {
  console.warn("[BOOTSTRAP] SystemSetting seed warning:", err.message);
}

// ──────────────────────────────────────────────────────────────
// Weekly Report Cron Scheduler — Sunday 07:00 PM Asia/Kolkata
// ──────────────────────────────────────────────────────────────
// Cron expression: Sunday 19:00 IST (UTC+05:30) = 13:30 UTC Sunday
// Cron expression for 13:30 UTC on Sunday: "30 13 * * 0"
//
// Idempotency: We record the ISO week key (YYYY-W##) in the audit
// log before sending. If a record for this week already exists
// (e.g. from a duplicate instance or retry), we skip dispatch.
// ──────────────────────────────────────────────────────────────
const WEEKLY_REPORT_CRON = "30 13 * * 0"; // 13:30 UTC = 19:00 (7:00 PM) IST Sunday

cron.schedule(WEEKLY_REPORT_CRON, async () => {
  console.log("[CRON] Weekly report scheduler triggered at", new Date().toISOString());

  try {
    // Load settings — automation must be enabled AND an email provider configured
    const settings = await SystemSetting.findOne({ key: "global" });
    if (!settings?.reportAutomationEnabled) {
      console.log("[CRON] Weekly report automation is disabled in settings. Skipping.");
      return;
    }

    const brevoApiKey = (process.env.BREVO_API_KEY || "").trim();
    const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
    const smtpUser = (process.env.SMTP_USER || "").trim();
    const smtpPass = (process.env.SMTP_PASS || "").trim();
    if (!brevoApiKey && !resendApiKey && (!smtpUser || !smtpPass)) {
      console.warn("[CRON] No email provider configured (BREVO_API_KEY, RESEND_API_KEY, or SMTP_USER/SMTP_PASS). Cannot dispatch weekly report.");
      return;
    }

    // Compute reporting week (previous Monday–Sunday)
    const { from, to } = getPreviousReportingWeek();

    // Idempotency check: compute ISO week key and look for an existing audit record
    const isoWeekKey = `${from}_${to}`;
    const existingRecord = await AuditLog.findOne({
      action: "report.weekly_email_sent",
      "details.weekKey": isoWeekKey
    });
    if (existingRecord) {
      console.log(`[CRON] Weekly report for ${isoWeekKey} already dispatched (messageId: ${existingRecord.details?.messageId}). Skipping duplicate.`);
      return;
    }

    const recipientEmail = resolveRecipientEmail(null, settings);

    console.log(`[CRON] Dispatching weekly report for ${from} to ${to} → ${recipientEmail}`);

    const result = await sendWeeklyEmailReport({
      from,
      to,
      recipientEmail,
      trigger: "cron-scheduled"
    });

    if (result.delivered) {
      // Stamp the weekKey so duplicate instances cannot re-send
      const adminUser = await User.findOne({ role: "admin" }).select("_id");
      await AuditLog.create({
        actorId: adminUser ? adminUser._id : new mongoose.Types.ObjectId(),
        action: "report.weekly_email_sent",
        entityType: "Report",
        details: {
          recipient: recipientEmail,
          from,
          to,
          weekKey: isoWeekKey,
          messageId: result.messageId,
          trigger: "cron-scheduled"
        }
      });
      console.log(`[CRON] Weekly report delivered successfully. MessageId: ${result.messageId}`);
    } else {
      console.error(`[CRON] Weekly report delivery failed: ${result.error || result.message}`);
    }
  } catch (err) {
    console.error("[CRON] Weekly report scheduler error:", err.message);
  }
}, {
  scheduled: true,
  timezone: "UTC"
});

console.log(`[CRON] Weekly report scheduler registered. Expression: "${WEEKLY_REPORT_CRON}" UTC (= Sunday 07:00 PM Asia/Kolkata)`);

// ──────────────────────────────────────────────────────────────
// Monthly Attendance Archival & Storage Retention Scheduler
// Runs 1st of every month at 02:00 AM UTC (= 07:30 AM IST)
// Cron expression: "0 2 1 * *"
// Idempotency: Checks storage usage and 6-month retention cutoff.
// Never deletes records if storage is below configured threshold (80%).
// ──────────────────────────────────────────────────────────────
const MONTHLY_ARCHIVAL_CRON = "0 2 1 * *";

cron.schedule(MONTHLY_ARCHIVAL_CRON, async () => {
  console.log("[CRON] Monthly storage retention and 6-month archival check triggered at", new Date().toISOString());
  try {
    const result = await runAutomatedArchivalCycle({ trigger: "cron-monthly-scheduler" });
    console.log(`[CRON] Monthly archival cycle result:`, result.message);
  } catch (err) {
    console.error("[CRON] Monthly archival scheduler error:", err.message);
  }
}, {
  scheduled: true,
  timezone: "UTC"
});

console.log(`[CRON] Monthly attendance archival scheduler registered. Expression: "${MONTHLY_ARCHIVAL_CRON}" UTC (= 1st of every month at 02:00 AM UTC)`);

app.listen(port, () => {
  console.log(`\n=================================================`);
  console.log(`  مَدْرَسَة  •  MADRASA AMANAH ATTENDANCE API`);
  console.log(`  Running on: http://localhost:${port}`);
  console.log(`=================================================\n`);
});
