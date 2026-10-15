import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["admin", "teacher"], default: "teacher" },
  assignedClasses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Class" }],
  active: { type: Boolean, default: true }
}, { timestamps: true });

const classSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  section: { type: String, trim: true, default: "" },
  academicYear: { type: String, required: true },
  teacherIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  active: { type: Boolean, default: true }
}, { timestamps: true });
classSchema.index({ name: 1, section: 1, academicYear: 1 }, { unique: true });

const studentSchema = new mongoose.Schema({
  admissionNo: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  gender: { type: String, trim: true, default: "" },
  dob: { type: String, trim: true, default: "" },
  guardianName: { type: String, trim: true, default: "" },
  guardianPhone: { type: String, trim: true, default: "" },
  address: { type: String, trim: true, default: "" },
  enrollmentDate: { type: String, trim: true, default: "" },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true, index: true },
  photoUrl: { type: String, default: "" },
  // Face descriptors are sensitive biometric data: store only with appropriate guardian consent
  faceDescriptor: { type: [Number], select: false, default: undefined },
  consentGiven: { type: Boolean, default: true },
  active: { type: Boolean, default: true, index: true }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
  dateKey: { type: String, required: true }, // YYYY-MM-DD
  sessionKey: { type: String, default: "morning", trim: true },
  status: { type: String, enum: ["present", "absent", "late", "excused"], required: true },
  source: { type: String, enum: ["manual", "photo-assisted"], default: "manual" },
  markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  note: { type: String, trim: true, default: "" },
  serverVersion: { type: Number, default: 1 }
}, { timestamps: true });
attendanceSchema.index({ studentId: 1, classId: 1, dateKey: 1, sessionKey: 1 }, { unique: true });
attendanceSchema.index({ classId: 1, dateKey: 1, sessionKey: 1 });
attendanceSchema.index({ dateKey: -1 });
attendanceSchema.index({ studentId: 1, dateKey: -1 });

const syncMutationSchema = new mongoose.Schema({
  mutationId: { type: String, required: true, unique: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  kind: { type: String, required: true, default: "attendance.bulk" },
  result: { type: mongoose.Schema.Types.Mixed, default: {} },
  receivedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const auditSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  action: { type: String, required: true },
  entityType: { type: String, required: true },
  entityId: { type: String, default: "" },
  details: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const systemSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "global" },
  reportRecipientEmail: { type: String, default: "" },
  reportTimezone: { type: String, default: "Asia/Kolkata" },
  reportSchedule: { type: String, default: "Mondays at 06:00 AM" },
  reportAutomationEnabled: { type: Boolean, default: false },
  lastReportSuccess: { type: mongoose.Schema.Types.Mixed, default: null },
  lastReportFailure: { type: mongoose.Schema.Types.Mixed, default: null },
  nextReportRun: { type: String, default: "" },
  attendanceCorrectionWindowDays: { type: Number, default: 7 },
  activeWriteTarget: { type: String, enum: ["primary", "secondary"], default: "primary" },
  databaseRotationEnabled: { type: Boolean, default: false },
  rotationHistory: [{
    timestamp: { type: Date, default: Date.now },
    from: String,
    to: String,
    reason: String,
    trigger: String
  }]
}, { timestamps: true });

export const User = mongoose.model("User", userSchema);
export const Class = mongoose.model("Class", classSchema);
export const Student = mongoose.model("Student", studentSchema);
export const Attendance = mongoose.model("Attendance", attendanceSchema);
export const SyncMutation = mongoose.model("SyncMutation", syncMutationSchema);
export const AuditLog = mongoose.model("AuditLog", auditSchema);
export const SystemSetting = mongoose.model("SystemSetting", systemSettingSchema);
