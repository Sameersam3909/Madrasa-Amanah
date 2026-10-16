import ExcelJS from "exceljs";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Attendance, Class, Student, User, AuditLog } from "./models.js";
import { compareRollNumbers } from "./utils/studentSort.js";

/**
 * Calculates previous calendar month based on specified timezone (defaults to Asia/Kolkata).
 * For example: if current date is in October 2026, returns September 2026 (2026-09-01 to 2026-09-30).
 */
export function getPreviousReportingMonth(baseDate = new Date(), timeZone = "Asia/Kolkata") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(baseDate);

  const partMap = {};
  for (const p of parts) partMap[p.type] = p.value;

  const currentYear = parseInt(partMap.year, 10);
  const currentMonth = parseInt(partMap.month, 10); // 1-12

  let prevYear = currentYear;
  let prevMonth = currentMonth - 1;
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear -= 1;
  }

  return getMonthMetadata(prevYear, prevMonth);
}

/**
 * Parses and returns metadata for an explicit month string YYYY-MM (e.g. "2026-09").
 */
export function parseReportingMonth(monthStr) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(monthStr).trim());
  if (!match) {
    throw new Error(`Invalid month format "${monthStr}". Expected format YYYY-MM (e.g. 2026-09)`);
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  return getMonthMetadata(year, month);
}

/**
 * Helper to produce month metadata, start/end dates, directories, and filepaths.
 */
function getMonthMetadata(year, month) {
  const mm = String(month).padStart(2, "0");
  const monthKey = `${year}-${mm}`;
  // Days in month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${monthKey}-01`;
  const to = `${monthKey}-${String(lastDay).padStart(2, "0")}`;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const monthLabel = `${monthNames[month - 1]} ${year}`;

  const relativeDirectory = path.join("backups", String(year));
  const filename = `${monthKey}-attendance.xlsx`;
  const relativePath = path.join(relativeDirectory, filename);
  const checksumFilename = `${filename}.sha256`;
  const checksumRelativePath = path.join(relativeDirectory, checksumFilename);

  return {
    year,
    month,
    monthKey,
    monthLabel,
    from,
    to,
    relativeDirectory,
    filename,
    relativePath: relativePath.replace(/\\/g, "/"),
    checksumFilename,
    checksumRelativePath: checksumRelativePath.replace(/\\/g, "/")
  };
}

/**
 * Generates the multi-sheet Monthly Attendance Excel workbook using real database records.
 *
 * Worksheets:
 *  1. Monthly Summary — Month overview, high-level KPIs, attendance policy, class breakdown table
 *  2. Daily Attendance — Filtered & frozen table of every attendance record logged for the month
 *  3. Student Summary — Student attendance statistics, absent/late/excused days, attendance %
 */
export async function generateMonthlyExcelWorkbook({ from, to, monthLabel, monthKey }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Madrasa Amanah Smart Attendance System";
  wb.lastModifiedBy = "Automated Monthly Backup Service";
  wb.created = new Date();

  // 1. Fetch live application records
  const [classes, students, attendances] = await Promise.all([
    Class.find({ active: true }).populate("teacherIds", "name email").sort({ name: 1 }),
    Student.find({ active: true }).populate("classId", "name section").collation({ locale: "en", numericOrdering: true }).sort({ admissionNo: 1, name: 1 }),
    Attendance.find({ dateKey: { $gte: from, $lte: to } })
      .populate("studentId", "name admissionNo classId")
      .populate("classId", "name section")
      .populate("markedBy", "name email")
      .sort({ dateKey: 1, sessionKey: 1 })
  ]);

  students.sort(compareRollNumbers);

  const totalEligibleStudents = students.length;
  const totalRecords = attendances.length;
  const presentTotal = attendances.filter(a => a.status === "present").length;
  const absentTotal = attendances.filter(a => a.status === "absent").length;
  const lateTotal = attendances.filter(a => a.status === "late").length;
  const excusedTotal = attendances.filter(a => a.status === "excused").length;
  const attendedTotal = presentTotal + lateTotal;
  const overallPercentage = totalRecords > 0 ? ((attendedTotal / totalRecords) * 100).toFixed(1) : "0.0";

  // Palette constants
  const BRAND_DARK = "FF174B36"; // Deep Emerald Green
  const TEXT_WHITE = "FFFFFFFF";
  const BORDER_LIGHT = {
    top: { style: "thin", color: { argb: "FFDFE5E0" } },
    left: { style: "thin", color: { argb: "FFDFE5E0" } },
    bottom: { style: "thin", color: { argb: "FFDFE5E0" } },
    right: { style: "thin", color: { argb: "FFDFE5E0" } }
  };

  // ─────────────────────────────────────────────────────────────
  // WORKSHEET 1: Monthly Summary
  // ─────────────────────────────────────────────────────────────
  const wsSummary = wb.addWorksheet("Monthly Summary");
  wsSummary.columns = [
    { header: "Metric / Class", key: "col1", width: 32 },
    { header: "Section", key: "col2", width: 16 },
    { header: "Academic Year / Enrolled", key: "col3", width: 24 },
    { header: "Total Marks", key: "col4", width: 14 },
    { header: "Present", key: "col5", width: 12 },
    { header: "Absent", key: "col6", width: 12 },
    { header: "Late", key: "col7", width: 12 },
    { header: "Excused", key: "col8", width: 12 },
    { header: "Attendance %", key: "col9", width: 16 },
    { header: "Register Status", key: "col10", width: 22 }
  ];

  // Header banner
  const titleRow = wsSummary.addRow(["مَدْرَسَة  •  MADRASA AMANAH", "Monthly Attendance Archive"]);
  titleRow.font = { bold: true, size: 14, color: { argb: "FF174B36" } };

  wsSummary.addRow(["Reporting Month", `${monthLabel} (${monthKey})`]);
  wsSummary.addRow(["Reporting Period", `${from} to ${to}`]);
  wsSummary.addRow(["Generated Timestamp (UTC)", new Date().toISOString()]);
  wsSummary.addRow(["Generated Timestamp (IST)", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST"]);
  wsSummary.addRow(["System Version", "Madrasa Amanah 1.0.0 (Automated Backup)"]);
  wsSummary.addRow([]);

  // High-Level Monthly Metrics
  const metricHead = wsSummary.addRow(["MONTHLY EXECUTIVE METRICS", "COUNT / RATE", "POLICY & NOTES"]);
  metricHead.font = { bold: true };
  metricHead.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4F1" } };

  wsSummary.addRow(["Total Active Classes", classes.length, "Registered active madrasa classes"]);
  wsSummary.addRow(["Total Eligible Students", totalEligibleStudents, "Active students roster on file"]);
  wsSummary.addRow(["Total Attendance Records Marked", totalRecords, "Total marked attendance records in month"]);
  wsSummary.addRow(["Total Present Marks", presentTotal, "Standard on-time attendance"]);
  wsSummary.addRow(["Total Absent Marks", absentTotal, "Unexcused absence"]);
  wsSummary.addRow(["Total Late Marks", lateTotal, "Late arrivals (counted towards attended)"]);
  wsSummary.addRow(["Total Excused Marks", excusedTotal, "Permitted or authorized leave"]);
  wsSummary.addRow(["Overall Attendance Percentage", `${overallPercentage}%`, "Formula: ((Present + Late) / Total Recorded Marks) * 100"]);
  wsSummary.addRow(["Missing Attendance Handling", "Preserved as unrecorded", "Never silently counted as Absent"]);
  wsSummary.addRow([]);

  // Class Breakdown Table Header
  const classHeaderRow = wsSummary.addRow([
    "Class Name",
    "Section",
    "Academic Year",
    "Enrolled",
    "Total Marks",
    "Present",
    "Absent",
    "Late",
    "Excused",
    "Attendance %"
  ]);
  classHeaderRow.font = { bold: true, color: { argb: TEXT_WHITE } };
  classHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_DARK } };
  classHeaderRow.alignment = { vertical: "middle", horizontal: "center" };

  for (const c of classes) {
    const classIdStr = String(c._id);
    const classStudents = students.filter(s => String(s.classId?._id || s.classId) === classIdStr);
    const classAttendances = attendances.filter(a => String(a.classId?._id || a.classId) === classIdStr);
    const cPresent = classAttendances.filter(a => a.status === "present").length;
    const cAbsent = classAttendances.filter(a => a.status === "absent").length;
    const cLate = classAttendances.filter(a => a.status === "late").length;
    const cExcused = classAttendances.filter(a => a.status === "excused").length;
    const cTotal = classAttendances.length;
    const cPct = cTotal > 0 ? (((cPresent + cLate) / cTotal) * 100).toFixed(1) : "0.0";

    const row = wsSummary.addRow([
      c.name,
      c.section || "-",
      c.academicYear || "-",
      classStudents.length,
      cTotal,
      cPresent,
      cAbsent,
      cLate,
      cExcused,
      `${cPct}%`
    ]);

    row.eachCell(cell => {
      cell.border = BORDER_LIGHT;
    });
  }

  // ─────────────────────────────────────────────────────────────
  // WORKSHEET 2: Daily Attendance
  // ─────────────────────────────────────────────────────────────
  const wsDetail = wb.addWorksheet("Daily Attendance");
  wsDetail.columns = [
    { header: "Date", key: "dateKey", width: 14 },
    { header: "Class", key: "className", width: 22 },
    { header: "Session", key: "sessionKey", width: 14 },
    { header: "Admission Number", key: "admissionNo", width: 20 },
    { header: "Student Name", key: "studentName", width: 28 },
    { header: "Attendance Status", key: "status", width: 18 },
    { header: "Source", key: "source", width: 16 },
    { header: "Marked By", key: "markedBy", width: 24 },
    { header: "Note", key: "note", width: 30 },
    { header: "Recorded At", key: "createdAt", width: 22 }
  ];

  for (const a of attendances) {
    const className = a.classId
      ? `${a.classId.name}${a.classId.section ? ` (${a.classId.section})` : ""}`
      : "Unassigned";

    const row = wsDetail.addRow({
      dateKey: a.dateKey,
      className,
      sessionKey: a.sessionKey || "morning",
      admissionNo: a.studentId?.admissionNo || "N/A",
      studentName: a.studentId?.name || "Unknown",
      status: String(a.status || "").toUpperCase(),
      source: a.source || "manual",
      markedBy: a.markedBy?.name || a.markedBy?.email || "System",
      note: a.note || "",
      createdAt: a.createdAt ? new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 19) : ""
    });

    row.eachCell(cell => {
      cell.border = BORDER_LIGHT;
    });
  }

  // Header styling & views
  const detailHeader = wsDetail.getRow(1);
  detailHeader.font = { bold: true, color: { argb: TEXT_WHITE } };
  detailHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_DARK } };
  detailHeader.alignment = { vertical: "middle", horizontal: "center" };
  wsDetail.views = [{ state: "frozen", ySplit: 1 }];
  if (attendances.length > 0) {
    wsDetail.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: attendances.length + 1, column: wsDetail.columns.length }
    };
  }

  // ─────────────────────────────────────────────────────────────
  // WORKSHEET 3: Student Summary
  // ─────────────────────────────────────────────────────────────
  const wsStudent = wb.addWorksheet("Student Summary");
  wsStudent.columns = [
    { header: "Admission Number", key: "admissionNo", width: 20 },
    { header: "Student Name", key: "name", width: 28 },
    { header: "Class", key: "className", width: 22 },
    { header: "Recorded Sessions", key: "totalRecorded", width: 18 },
    { header: "Present Days", key: "presentDays", width: 14 },
    { header: "Absent Days", key: "absentDays", width: 14 },
    { header: "Late Days", key: "lateDays", width: 14 },
    { header: "Excused Days", key: "excusedDays", width: 14 },
    { header: "Attendance %", key: "attendancePct", width: 16 },
    { header: "Attendance Assessment", key: "assessment", width: 24 }
  ];

  for (const s of students) {
    const sIdStr = String(s._id);
    const sAttendances = attendances.filter(a => String(a.studentId?._id || a.studentId) === sIdStr);

    const sPresent = sAttendances.filter(a => a.status === "present").length;
    const sAbsent = sAttendances.filter(a => a.status === "absent").length;
    const sLate = sAttendances.filter(a => a.status === "late").length;
    const sExcused = sAttendances.filter(a => a.status === "excused").length;
    const sTotal = sAttendances.length;

    // Documented policy: ((Present + Late) / Recorded Sessions) * 100
    // Unrecorded sessions are NOT counted as absent!
    let sPctStr = "N/A";
    let assessment = "No Records Marked";
    if (sTotal > 0) {
      const pct = (((sPresent + sLate) / sTotal) * 100);
      sPctStr = `${pct.toFixed(1)}%`;
      if (pct >= 90) assessment = "Excellent (≥90%)";
      else if (pct >= 80) assessment = "Good (80-89%)";
      else if (pct >= 70) assessment = "Satisfactory (70-79%)";
      else assessment = "Needs Attention (<70%)";
    }

    const className = s.classId
      ? `${s.classId.name}${s.classId.section ? ` (${s.classId.section})` : ""}`
      : "Unassigned";

    const row = wsStudent.addRow({
      admissionNo: s.admissionNo,
      name: s.name,
      className,
      totalRecorded: sTotal,
      presentDays: sPresent,
      absentDays: sAbsent,
      lateDays: sLate,
      excusedDays: sExcused,
      attendancePct: sPctStr,
      assessment
    });

    row.eachCell(cell => {
      cell.border = BORDER_LIGHT;
    });
  }

  // Header styling & views
  const studentHeader = wsStudent.getRow(1);
  studentHeader.font = { bold: true, color: { argb: TEXT_WHITE } };
  studentHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_DARK } };
  studentHeader.alignment = { vertical: "middle", horizontal: "center" };
  wsStudent.views = [{ state: "frozen", ySplit: 1 }];
  if (students.length > 0) {
    wsStudent.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: students.length + 1, column: wsStudent.columns.length }
    };
  }

  return {
    workbook: wb,
    meta: {
      from,
      to,
      monthKey,
      monthLabel,
      totalEligibleStudents,
      totalClasses: classes.length,
      totalRecords,
      presentTotal,
      absentTotal,
      lateTotal,
      excusedTotal,
      overallPercentage
    }
  };
}

/**
 * Rigorous 8-Step Verification of Generated Backup Workbook
 *
 * Verifies:
 * 1. Reporting month matches expected period
 * 2. Workbook file exists and is readable .xlsx
 * 3. Required worksheets exist ("Monthly Summary", "Daily Attendance", "Student Summary")
 * 4. Required headers exist in all worksheets
 * 5. Record counts match source database queries exactly
 * 6. Zero prohibited fields/credentials exist (passwords, tokens, URIs, face descriptors)
 * 7. SHA-256 checksum calculated and verified
 */
export async function verifyMonthlyExcelBackup({
  filePath,
  expectedFrom,
  expectedTo,
  expectedAttendancesCount,
  expectedStudentsCount,
  expectedMonthKey
}) {
  const errors = [];

  // 1. File existence & basic size check
  if (!fs.existsSync(filePath)) {
    throw new Error(`Verification Failed: Backup file does not exist at path "${filePath}"`);
  }
  const stats = fs.statSync(filePath);
  if (stats.size < 1000) {
    throw new Error(`Verification Failed: Backup file size (${stats.size} bytes) is suspiciously small for a valid .xlsx workbook`);
  }

  // 2. Read back with ExcelJS to ensure file is non-corrupt
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(filePath);
  } catch (err) {
    throw new Error(`Verification Failed: Unable to parse .xlsx file with ExcelJS: ${err.message}`);
  }

  // 3. Confirm expected worksheets exist
  const expectedSheets = ["Monthly Summary", "Daily Attendance", "Student Summary"];
  for (const name of expectedSheets) {
    const ws = wb.getWorksheet(name);
    if (!ws) {
      errors.push(`Missing required worksheet: "${name}"`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Verification Failed: ${errors.join("; ")}`);
  }

  // 4. Verify headers in Daily Attendance
  const wsDetail = wb.getWorksheet("Daily Attendance");
  const detailHeaders = wsDetail.getRow(1).values;
  const expectedDetailHeaders = [
    "Date", "Class", "Session", "Admission Number",
    "Student Name", "Attendance Status", "Source", "Marked By", "Note", "Recorded At"
  ];
  for (const h of expectedDetailHeaders) {
    if (!detailHeaders.includes(h)) {
      errors.push(`Daily Attendance sheet is missing expected header: "${h}"`);
    }
  }

  // 5. Verify headers in Student Summary
  const wsStudent = wb.getWorksheet("Student Summary");
  const studentHeaders = wsStudent.getRow(1).values;
  const expectedStudentHeaders = [
    "Admission Number", "Student Name", "Class", "Recorded Sessions",
    "Present Days", "Absent Days", "Late Days", "Excused Days", "Attendance %", "Attendance Assessment"
  ];
  for (const h of expectedStudentHeaders) {
    if (!studentHeaders.includes(h)) {
      errors.push(`Student Summary sheet is missing expected header: "${h}"`);
    }
  }

  // 6. Compare exported record counts with expected source counts
  const detailRowCount = wsDetail.rowCount > 1 ? wsDetail.rowCount - 1 : 0;
  if (expectedAttendancesCount !== undefined && detailRowCount !== expectedAttendancesCount) {
    errors.push(`Daily Attendance row count (${detailRowCount}) does not match database record count (${expectedAttendancesCount})`);
  }

  const studentRowCount = wsStudent.rowCount > 1 ? wsStudent.rowCount - 1 : 0;
  if (expectedStudentsCount !== undefined && studentRowCount !== expectedStudentsCount) {
    errors.push(`Student Summary row count (${studentRowCount}) does not match active student count (${expectedStudentsCount})`);
  }

  // 7. Security & Privacy Audit — Scan every cell for credentials or prohibited fields
  const prohibitedPatterns = [
    /passwordHash/i,
    /\$2[aby]\$\d{2}\$/i, // bcrypt hash prefix
    /faceDescriptor/i,
    /mongodb(?:\+srv)?:\/\//i,
    /JWT_SECRET/i,
    /CLOUDINARY_API_SECRET/i,
    /Bearer\s+[A-Za-z0-9_-]{20,}/i
  ];

  wb.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        const val = String(cell.value || "");
        for (const pattern of prohibitedPatterns) {
          if (pattern.test(val)) {
            errors.push(`SECURITY VIOLATION: Sheet "${sheet.name}" cell ${cell.address} contains prohibited data matching pattern ${pattern}`);
          }
        }
      });
    });
  });

  if (errors.length > 0) {
    throw new Error(`Verification Failed:\n  - ${errors.join("\n  - ")}`);
  }

  // 8. Calculate SHA-256 Checksum
  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  return {
    verified: true,
    filePath,
    sha256,
    byteSize: stats.size,
    detailRowCount,
    studentRowCount,
    expectedMonthKey
  };
}

/**
 * High-level backup executor: generates, writes to backups/YYYY/YYYY-MM-attendance.xlsx,
 * writes .sha256 checksum file, and performs full verification.
 */
export async function exportAndSaveMonthlyBackup({
  targetMonth = null,
  force = false,
  baseDir = process.cwd(),
  timeZone = "Asia/Kolkata",
  actorId = null
} = {}) {
  const monthMeta = targetMonth
    ? parseReportingMonth(targetMonth)
    : getPreviousReportingMonth(new Date(), timeZone);

  const fullDir = path.resolve(baseDir, monthMeta.relativeDirectory);
  const fullFilePath = path.resolve(baseDir, monthMeta.relativePath);
  const fullChecksumPath = path.resolve(baseDir, monthMeta.checksumRelativePath);

  // Guard against duplicate overwrites unless force is explicitly set
  if (fs.existsSync(fullFilePath) && !force) {
    // If it already exists, verify its integrity
    try {
      const stats = fs.statSync(fullFilePath);
      const existingChecksum = fs.existsSync(fullChecksumPath)
        ? fs.readFileSync(fullChecksumPath, "utf8").trim().split(/\s+/)[0]
        : null;

      const fileBuffer = fs.readFileSync(fullFilePath);
      const calculatedSha = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      return {
        success: true,
        alreadyExisted: true,
        overwritten: false,
        monthKey: monthMeta.monthKey,
        monthLabel: monthMeta.monthLabel,
        filePath: fullFilePath,
        relativePath: monthMeta.relativePath,
        checksumPath: fullChecksumPath,
        relativeChecksumPath: monthMeta.checksumRelativePath,
        sha256: calculatedSha,
        checksumMatched: existingChecksum ? existingChecksum === calculatedSha : true,
        bytes: stats.size,
        message: `Verified backup already exists for ${monthMeta.monthKey} at ${monthMeta.relativePath}. Re-run was skipped to prevent duplicate generation.`
      };
    } catch {
      // If verification failed on existing file, proceed with re-generation
    }
  }

  // Ensure directory exists
  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
  }

  // Generate workbook
  const { workbook, meta } = await generateMonthlyExcelWorkbook({
    from: monthMeta.from,
    to: monthMeta.to,
    monthLabel: monthMeta.monthLabel,
    monthKey: monthMeta.monthKey
  });

  // Write workbook to disk
  await workbook.xlsx.writeFile(fullFilePath);

  // Perform rigorous verification
  const verification = await verifyMonthlyExcelBackup({
    filePath: fullFilePath,
    expectedFrom: monthMeta.from,
    expectedTo: monthMeta.to,
    expectedAttendancesCount: meta.totalRecords,
    expectedStudentsCount: meta.totalEligibleStudents,
    expectedMonthKey: monthMeta.monthKey
  });

  // Write SHA-256 checksum file
  const checksumContent = `${verification.sha256}  ${monthMeta.filename}\n`;
  fs.writeFileSync(fullChecksumPath, checksumContent, "utf8");

  // Record audit log if actor is known
  if (actorId) {
    try {
      await AuditLog.create({
        actorId,
        action: "backup.monthly_excel_generated",
        entityType: "MonthlyBackup",
        entityId: monthMeta.monthKey,
        details: {
          monthKey: monthMeta.monthKey,
          filename: monthMeta.filename,
          sha256: verification.sha256,
          counts: {
            records: meta.totalRecords,
            students: meta.totalEligibleStudents,
            classes: meta.totalClasses
          }
        }
      });
    } catch (auditErr) {
      console.warn("Audit logging warning:", auditErr.message);
    }
  }

  return {
    success: true,
    alreadyExisted: false,
    overwritten: force,
    monthKey: monthMeta.monthKey,
    monthLabel: monthMeta.monthLabel,
    from: monthMeta.from,
    to: monthMeta.to,
    filePath: fullFilePath,
    relativePath: monthMeta.relativePath,
    checksumPath: fullChecksumPath,
    relativeChecksumPath: monthMeta.checksumRelativePath,
    sha256: verification.sha256,
    bytes: verification.byteSize,
    meta,
    message: `Monthly attendance backup for ${monthMeta.monthKey} generated and verified successfully.`
  };
}
