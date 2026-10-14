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
import { User, Class, Student, Attendance, SyncMutation, AuditLog } from "./models.js";
import { requireAuth, requireAdmin, canAccessClass } from "./auth.js";
import { uploadImageDataUrl } from "./cloudinary.js";
import { connectDB, getDatabaseInfo } from "./db.js";
import { getPreviousReportingWeek, generateWeeklyExcelWorkbook, sendWeeklyEmailReport } from "./weeklyReportService.js";
import {
  getPreviousReportingMonth,
  parseReportingMonth,
  generateMonthlyExcelWorkbook,
  verifyMonthlyExcelBackup,
  exportAndSaveMonthlyBackup
} from "./monthlyBackupService.js";

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
  const httpStatus = dbInfo.connected ? 200 : 503;
  res.status(httpStatus).json({
    status: dbInfo.connected ? "healthy" : "unhealthy",
    service: "madrasa-attendance-api",
    database: {
      provider: dbInfo.engine,
      state: dbInfo.status,
      name: dbInfo.databaseName
    },
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Authentication
app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }), async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");
  const user = await User.findOne({ email }).select("+passwordHash");
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ message: "Email or password is incorrect." });
  }
  const token = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: "12h" });
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
    }
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({
  id: req.user._id,
  name: req.user.name,
  email: req.user.email,
  role: req.user.role,
  assignedClasses: req.user.assignedClasses
}));

// Protected API routes
app.use("/api", requireAuth);

// Classes API
app.get("/api/classes", async (req, res) => {
  const filter = req.user.role === "admin"
    ? { active: true }
    : { active: true, $or: [{ teacherIds: req.user._id }, { _id: { $in: req.user.assignedClasses.map(c => c._id || c) } }] };
  const classes = await Class.find(filter).sort({ name: 1 }).populate("teacherIds", "name email");
  res.json(classes);
});

app.post("/api/classes", requireAdmin, async (req, res) => {
  try {
    const cls = await Class.create({
      name: String(req.body.name || "").trim(),
      section: String(req.body.section || "").trim(),
      academicYear: String(req.body.academicYear || new Date().getFullYear()),
      teacherIds: req.body.teacherIds || []
    });
    await AuditLog.create({ actorId: req.user._id, action: "class.create", entityType: "Class", entityId: String(cls._id) });
    res.status(201).json(cls);
  } catch (e) {
    res.status(400).json({ message: e.code === 11000 ? "This class already exists for that academic year." : e.message });
  }
});

app.patch("/api/classes/:id", requireAdmin, async (req, res) => {
  const cls = await Class.findByIdAndUpdate(req.params.id, {
    ...(req.body.name !== undefined ? { name: req.body.name } : {}),
    ...(req.body.section !== undefined ? { section: req.body.section } : {}),
    ...(req.body.academicYear !== undefined ? { academicYear: req.body.academicYear } : {}),
    ...(req.body.teacherIds !== undefined ? { teacherIds: req.body.teacherIds } : {}),
    ...(req.body.active !== undefined ? { active: req.body.active } : {})
  }, { new: true, runValidators: true });
  if (!cls) return res.status(404).json({ message: "Class not found." });
  await AuditLog.create({ actorId: req.user._id, action: "class.update", entityType: "Class", entityId: String(cls._id) });
  res.json(cls);
});

// Students API
app.get("/api/students/face-index", async (req, res) => {
  const { classId } = req.query;
  if (!classId) return res.status(400).json({ message: "classId is required." });
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });
  const students = await Student.find({ classId, active: true }).select("+faceDescriptor admissionNo name photoUrl consentGiven");
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
    const classes = await Class.find({ $or: [{ teacherIds: req.user._id }, { _id: { $in: req.user.assignedClasses.map(c => c._id || c) } }] }).select("_id");
    filter.classId = { $in: classes.map(c => c._id) };
  }

  if (req.query.search && req.query.search.trim()) {
    const sTerm = req.query.search.trim();
    filter.$or = [
      { name: { $regex: sTerm, $options: "i" } },
      { admissionNo: { $regex: sTerm, $options: "i" } },
      { guardianName: { $regex: sTerm, $options: "i" } },
      { guardianPhone: { $regex: sTerm, $options: "i" } }
    ];
  }

  const students = await Student.find(filter)
    .select("-faceDescriptor")
    .populate("classId", "name section academicYear")
    .sort({ name: 1 });

  res.json(students.map(s => {
    const obj = s.toObject();
    obj.id = String(obj._id);
    obj.fullName = obj.name;
    obj.admissionNumber = obj.admissionNo;
    obj.referencePhotoUrl = obj.photoUrl;
    return obj;
  }));
});

app.post("/api/students", async (req, res) => {
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

    const student = await Student.create({
      admissionNo,
      name,
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
    obj.admissionNumber = obj.admissionNo;
    obj.referencePhotoUrl = obj.photoUrl;
    res.json(obj);
  } catch (err) {
    console.error("Student update error:", err);
    res.status(400).json({ message: err.message || "Failed to update student profile." });
  }
}

app.patch("/api/students/:id", handleStudentUpdate);
app.put("/api/students/:id", handleStudentUpdate);

// --- STUDENT ROSTER EXPORT (CSV / XLSX) ---
app.get("/api/students/export", async (req, res) => {
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
    const classes = await Class.find({ $or: [{ teacherIds: req.user._id }, { _id: { $in: req.user.assignedClasses.map(c => c._id || c) } }] }).select("_id");
    filter.classId = { $in: classes.map(c => c._id) };
  }

  const cleanClassName = className.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  const todayStr = new Date().toISOString().slice(0, 10);
  const safeFilename = `Madrasa-Amanah-Students-${cleanClassName}-${todayStr}`;

  const students = await Student.find(filter)
    .populate("classId", "name section academicYear")
    .sort({ name: 1 });

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
app.delete("/api/students/:id", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden: Only administrators are authorized to permanently delete student records." });
  }
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
    .sort({ studentId: 1 });
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
    .sort({ name: 1 });

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
      admissionNo: "$student.admissionNo",
      total: 1,
      present: 1,
      absent: 1,
      late: 1,
      excused: 1,
      percentage: { $cond: [{ $gt: ["$total", 0] }, { $round: [{ $multiply: [{ $divide: ["$present", "$total"] }, 100] }, 1] }, 0] }
    } },
    { $sort: { name: 1 } }
  ]);
  res.json(rows);
});

app.get("/api/reports/export", async (req, res) => {
  const classId = req.query.classId;
  const from = req.query.from || req.query.startDate;
  const to = req.query.to || req.query.endDate;
  const format = req.query.format || "xlsx";
  if (!classId || !from || !to) return res.status(400).json({ message: "classId, from and to are required." });
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });

  const targetClass = await Class.findById(classId);
  const cleanClassName = (targetClass ? `${targetClass.name}${targetClass.section ? `-${targetClass.section}` : ""}` : "Class")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safeFilename = `Madrasa-Amanah-Attendance-${cleanClassName}-${from}${from !== to ? `-to-${to}` : ""}`;

  const records = await Attendance.find({ classId, dateKey: { $gte: from, $lte: to } })
    .populate("studentId", "name admissionNo")
    .sort({ dateKey: 1 });
  const rows = records.map(r => ({
    Date: r.dateKey,
    "Admission No": r.studentId?.admissionNo || "",
    Student: r.studentId?.name || "",
    Status: r.status,
    Note: r.note || ""
  }));

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

// --- WEEKLY EXCEL REPORT & EMAIL AUTOMATION ---
app.get("/api/reports/weekly-excel", async (req, res) => {
  const prevWeek = getPreviousReportingWeek();
  const from = req.query.from || req.query.startDate || prevWeek.from;
  const to = req.query.to || req.query.endDate || prevWeek.to;
  const safeFilename = `Madrasa-Amanah-Weekly-Attendance-${from}-to-${to}.xlsx`;

  const wb = await generateWeeklyExcelWorkbook({ from, to });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
  await wb.xlsx.write(res);
  res.end();
});

app.post("/api/reports/send-weekly-email", requireAdmin, async (req, res) => {
  const prevWeek = getPreviousReportingWeek();
  const from = req.body.from || req.body.startDate || prevWeek.from;
  const to = req.body.to || req.body.endDate || prevWeek.to;
  const recipientEmail = req.body.recipientEmail || process.env.REPORT_RECIPIENT_EMAIL || "2300030621cseh1@gmail.com";

  const result = await sendWeeklyEmailReport({
    from,
    to,
    recipientEmail,
    trigger: "manual-admin",
    actorId: req.user._id
  });

  res.json(result);
});

app.get("/api/reports/email-status", requireAdmin, async (_req, res) => {
  const prevWeek = getPreviousReportingWeek();
  const lastSentLog = await AuditLog.findOne({ action: "report.weekly_email_sent" }).sort({ createdAt: -1 });

  res.json({
    recipientEmail: process.env.REPORT_RECIPIENT_EMAIL || "2300030621cseh1@gmail.com",
    smtpConfigured: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
    smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
    smtpPort: process.env.SMTP_PORT || 587,
    timezone: process.env.REPORT_TIMEZONE || "Asia/Kolkata",
    previousReportingWeek: prevWeek,
    lastSentLog: lastSentLog ? {
      sentAt: lastSentLog.createdAt,
      recipient: lastSentLog.details?.recipient,
      period: `${lastSentLog.details?.from} to ${lastSentLog.details?.to}`,
      messageId: lastSentLog.details?.messageId
    } : null
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
app.get("/api/admin/backup/export", requireAdmin, async (req, res) => {
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
app.get("/api/admin/backup/monthly-excel", requireAdmin, async (req, res) => {
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
  await AuditLog.create({ actorId: req.user._id, action: "user.update", entityType: "User", entityId: String(user._id) });
  res.json({ id: user._id, name: user.name, email: user.email, role: user.role, active: user.active, assignedClasses: user.assignedClasses });
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
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase().trim();
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

app.listen(port, () => {
  console.log(`\n=================================================`);
  console.log(`  مَدْرَسَة  •  MADRASA AMANAH ATTENDANCE API`);
  console.log(`  Running on: http://localhost:${port}`);
  console.log(`=================================================\n`);
});
