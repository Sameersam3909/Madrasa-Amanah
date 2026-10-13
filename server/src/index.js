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
import { connectDB } from "./db.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors({
  origin: (process.env.CLIENT_ORIGIN || "http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173").split(",").map(s => s.trim()),
  exposedHeaders: ["Content-Disposition"],
  credentials: false
}));
app.use(express.json({ limit: "10mb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

// Health Check — lightweight, credential-safe, fast (no DB queries)
const healthHandler = (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const httpStatus = dbReady ? 200 : 503;
  const isAtlas = !!(mongoose.connection.client?.s?.options?.srvHost || "").includes("mongodb.net");
  res.status(httpStatus).json({
    status: dbReady ? "healthy" : "unhealthy",
    service: "madrasa-attendance-api",
    database: {
      provider: isAtlas ? "MongoDB Atlas" : "MongoDB",
      state: dbReady ? "connected" : "disconnected"
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
  const filter = { active: true };
  if (req.query.classId) {
    if (!(await canAccessClass(req.user, req.query.classId))) return res.status(403).json({ message: "Class access denied." });
    filter.classId = req.query.classId;
  } else if (req.user.role !== "admin") {
    const classes = await Class.find({ $or: [{ teacherIds: req.user._id }, { _id: { $in: req.user.assignedClasses.map(c => c._id || c) } }] }).select("_id");
    filter.classId = { $in: classes.map(c => c._id) };
  }
  const students = await Student.find(filter).select("-faceDescriptor").populate("classId", "name section academicYear").sort({ name: 1 });
  res.json(students);
});

app.post("/api/students", async (req, res) => {
  const admissionNo = req.body.admissionNo || req.body.admissionNumber;
  const name = req.body.name || req.body.fullName;
  const classId = req.body.classId;
  const gender = req.body.gender;
  if (!admissionNo?.trim() || !name?.trim() || !classId) {
    return res.status(400).json({ message: "Admission number, name and class are required." });
  }
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });
  try {
    let photoUrl = String(req.body.photoUrl || "");
    if (req.body.photoDataUrl) photoUrl = await uploadImageDataUrl(req.body.photoDataUrl);
    const student = await Student.create({
      admissionNo: admissionNo.trim(),
      name: name.trim(),
      classId,
      guardianName: req.body.guardianName || "",
      guardianPhone: req.body.guardianPhone || "",
      photoUrl,
      consentGiven: req.body.consentGiven !== false,
      faceDescriptor: Array.isArray(req.body.faceDescriptor) ? req.body.faceDescriptor : undefined
    });
    await AuditLog.create({ actorId: req.user._id, action: "student.create", entityType: "Student", entityId: String(student._id) });
    const populated = await Student.findById(student._id).select("-faceDescriptor").populate("classId", "name section");
    const obj = populated.toObject();
    obj.fullName = obj.name;
    obj.admissionNumber = obj.admissionNo;
    obj.referencePhotoUrl = obj.photoUrl;
    res.status(201).json(obj);
  } catch (e) {
    res.status(400).json({ message: e.code === 11000 ? "Admission number already exists." : e.message });
  }
});

app.patch("/api/students/:id", async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) return res.status(404).json({ message: "Student not found." });
  if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });

  const fields = ["name", "guardianName", "guardianPhone", "photoUrl", "active", "consentGiven", "classId"];
  fields.forEach(k => { if (req.body[k] !== undefined) student[k] = req.body[k]; });
  if (req.body.photoDataUrl) {
    student.photoUrl = await uploadImageDataUrl(req.body.photoDataUrl);
  }
  if (Array.isArray(req.body.faceDescriptor)) {
    student.faceDescriptor = req.body.faceDescriptor;
  }
  await student.save();
  await AuditLog.create({ actorId: req.user._id, action: "student.update", entityType: "Student", entityId: String(student._id) });
  res.json(await Student.findById(student._id).select("-faceDescriptor").populate("classId", "name section"));
});

// Also support PUT as an alias for PATCH (some clients send PUT)
app.put("/api/students/:id", async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) return res.status(404).json({ message: "Student not found." });
  if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });
  const fields = ["name", "guardianName", "guardianPhone", "photoUrl", "active", "consentGiven", "classId"];
  fields.forEach(k => { if (req.body[k] !== undefined) student[k] = req.body[k]; });
  // Accept referencePhotoUrl alias for photoUrl
  if (req.body.referencePhotoUrl !== undefined) student.photoUrl = req.body.referencePhotoUrl;
  if (req.body.photoDataUrl) {
    student.photoUrl = await uploadImageDataUrl(req.body.photoDataUrl);
  }
  if (Array.isArray(req.body.faceDescriptor)) {
    student.faceDescriptor = req.body.faceDescriptor;
  }
  // Accept fullName alias for name
  if (req.body.fullName !== undefined) student.name = req.body.fullName;
  await student.save();
  await AuditLog.create({ actorId: req.user._id, action: "student.update", entityType: "Student", entityId: String(student._id) });
  const populated = await Student.findById(student._id).select("-faceDescriptor").populate("classId", "name section");
  // Return aliases for client compatibility
  const obj = populated.toObject();
  obj.fullName = obj.name;
  obj.admissionNumber = obj.admissionNo;
  obj.referencePhotoUrl = obj.photoUrl;
  res.json(obj);
});

// Get single student by ID
app.get("/api/students/:id", async (req, res) => {
  const student = await Student.findById(req.params.id).select("-faceDescriptor").populate("classId", "name section");
  if (!student) return res.status(404).json({ message: "Student not found." });
  if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });
  const obj = student.toObject();
  obj.fullName = obj.name;
  obj.admissionNumber = obj.admissionNo;
  obj.referencePhotoUrl = obj.photoUrl;
  res.json(obj);
});

// Delete student (test cleanup & admin use)
app.delete("/api/students/:id", async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) return res.status(404).json({ message: "Student not found." });
  if (!(await canAccessClass(req.user, student.classId))) return res.status(403).json({ message: "Class access denied." });
  // Remove associated attendance records for this student
  await Attendance.deleteMany({ studentId: student._id });
  await Student.deleteOne({ _id: student._id });
  await AuditLog.create({ actorId: req.user._id, action: "student.delete", entityType: "Student", entityId: String(student._id) });
  res.json({ message: "Student deleted.", id: String(student._id) });
});

// Attendance API
app.get("/api/attendance", async (req, res) => {
  const classId = req.query.classId;
  const dateKey = req.query.dateKey || req.query.date;
  const sessionKey = req.query.sessionKey || req.query.session || "morning";
  if (!classId || !dateKey) return res.status(400).json({ message: "classId and dateKey are required." });
  if (!(await canAccessClass(req.user, classId))) return res.status(403).json({ message: "Class access denied." });
  const records = await Attendance.find({ classId, dateKey, sessionKey }).populate("studentId", "name admissionNo photoUrl").sort({ studentId: 1 });
  res.json(records);
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

  for (const r of records) {
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
  res.json({
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
  });
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

    for (const r of records) {
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
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
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
  const adminPass = process.env.ADMIN_PASSWORD || "Admin12345678!";
  const hash = await bcrypt.hash(adminPass, 12);
  const adminUser = await User.create({
    name: adminName,
    email: adminEmail,
    role: "admin",
    passwordHash: hash
  });
  console.log(`[BOOTSTRAP] Initial admin created: ${adminEmail} (password: ${adminPass})`);

  const c1 = await Class.create({ name: "Hifz Class", section: "Morning", academicYear: "1447-1448 / 2026", teacherIds: [adminUser._id] });
  const c2 = await Class.create({ name: "Nazira Class", section: "Evening", academicYear: "1447-1448 / 2026", teacherIds: [adminUser._id] });
  console.log(`[BOOTSTRAP] Created default classes: ${c1.name}, ${c2.name}`);

  await Student.create([
    { admissionNo: "ADM-101", name: "Muhammad Zaid", classId: c1._id, guardianName: "Farooq Khan", guardianPhone: "9876543210", consentGiven: true },
    { admissionNo: "ADM-102", name: "Abdullah Umar", classId: c1._id, guardianName: "Umar Farooq", guardianPhone: "9876543211", consentGiven: true },
    { admissionNo: "ADM-103", name: "Fatima Zahra", classId: c1._id, guardianName: "Hassan Ali", guardianPhone: "9876543212", consentGiven: true },
    { admissionNo: "ADM-104", name: "Bilal Habashi", classId: c1._id, guardianName: "Ibrahim", guardianPhone: "9876543213", consentGiven: true },
    { admissionNo: "ADM-105", name: "Mariam Siddiq", classId: c1._id, guardianName: "Abu Bakr", guardianPhone: "9876543214", consentGiven: true }
  ]);
  console.log("[BOOTSTRAP] Created 5 sample students.");
}

app.listen(port, () => {
  console.log(`\n=================================================`);
  console.log(`  مَدْرَسَة  •  MADRASA AMANAH ATTENDANCE API`);
  console.log(`  Running on: http://localhost:${port}`);
  console.log(`=================================================\n`);
});
