import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import { Attendance, Class, Student, User, AuditLog, SystemSetting } from "./models.js";
import { compareRollNumbers } from "./utils/studentSort.js";
import { generateWeeklyAttendancePdfBuffer } from "./weeklyAttendancePdfService.js";

/**
 * Calculates previous Monday through Sunday in YYYY-MM-DD format
 */
export function getPreviousReportingWeek(baseDate = new Date()) {
  const d = new Date(baseDate);
  // Current day of week: 0 (Sun) to 6 (Sat)
  const currentDay = d.getDay();
  // Calculate distance to previous Sunday
  const diffToPrevSunday = currentDay === 0 ? 7 : currentDay;
  const prevSunday = new Date(d);
  prevSunday.setDate(d.getDate() - diffToPrevSunday);

  const prevMonday = new Date(prevSunday);
  prevMonday.setDate(prevSunday.getDate() - 6);

  const to = prevSunday.toISOString().slice(0, 10);
  const from = prevMonday.toISOString().slice(0, 10);
  return { from, to, weekLabel: `${from} to ${to}` };
}

/**
 * Returns all dates in range YYYY-MM-DD inclusive
 */
export function getDatesInRange(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/**
 * Generates the multi-sheet weekly attendance Excel workbook
 * Worksheets:
 * 1. Weekly Summary: Executive KPIs & Class-wise breakdown
 * 2. Student Attendance: Comprehensive roster with daily marks & rates
 * 3. Daily Breakdown: All attendance audit transactions
 * 4. Class Summary: Class level capacity, active attendance & rates
 */
export async function generateWeeklyExcelWorkbook({ from, to, recipientEmail, mockData = null }) {
  const institutionName = process.env.MADRASA_NAME || "Darul Uloom Ashrafia, Atmakur";
  const arabicSubtitle = process.env.MADRASA_NAME_ARABIC || "دارالعلوم اشرفیہ اتماکور";

  const wb = new ExcelJS.Workbook();
  wb.creator = institutionName;
  wb.lastModifiedBy = "Automated Weekly Report";
  wb.created = new Date();

  // 1. Fetch authorized data
  let classes = [];
  let students = [];
  let attendances = [];

  if (mockData) {
    classes = mockData.classes || [];
    students = mockData.students || [];
    attendances = mockData.attendances || [];
  } else {
    [classes, students, attendances] = await Promise.all([
      Class.find({ active: true }).populate("teacherIds", "name email").sort({ name: 1 }),
      Student.find({ active: true }).populate("classId", "name section").collation({ locale: "en", numericOrdering: true }).sort({ admissionNo: 1, name: 1 }),
      Attendance.find({ dateKey: { $gte: from, $lte: to } })
        .populate("studentId", "name admissionNo classId")
        .populate("classId", "name section")
        .populate("markedBy", "name email")
        .sort({ dateKey: 1, sessionKey: 1 })
    ]);
  }

  students.sort(compareRollNumbers);

  const totalEnrolled = students.length;
  const totalRecords = attendances.length;
  const presentTotal = attendances.filter(a => a.status === "present").length;
  const absentTotal = attendances.filter(a => a.status === "absent").length;
  const lateTotal = attendances.filter(a => a.status === "late").length;
  const excusedTotal = attendances.filter(a => a.status === "excused").length;
  const attendedTotal = presentTotal + lateTotal;
  const overallPercentage = totalRecords > 0 ? ((attendedTotal / totalRecords) * 100).toFixed(1) : "0.0";
  const dateList = getDatesInRange(from, to);

  const borderStyle = {
    top: { style: "thin", color: { argb: "FFE2E8F0" } },
    left: { style: "thin", color: { argb: "FFE2E8F0" } },
    bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
    right: { style: "thin", color: { argb: "FFE2E8F0" } }
  };

  // =========================================================================
  // --- WORKSHEET 1: Weekly Summary ---
  // =========================================================================
  const wsSummary = wb.addWorksheet("Weekly Summary");
  wsSummary.columns = [
    { header: "Metric / Class", key: "col1", width: 36 },
    { header: "Value / Details", key: "col2", width: 24 },
    { header: "Present", key: "col3", width: 14 },
    { header: "Absent", key: "col4", width: 14 },
    { header: "Late", key: "col5", width: 14 },
    { header: "Excused", key: "col6", width: 14 },
    { header: "Attendance %", key: "col7", width: 18 }
  ];

  // Header banner
  wsSummary.addRow([`${arabicSubtitle} • ${institutionName.toUpperCase()}`, "Weekly Attendance Report"]);
  wsSummary.addRow(["Location", "Atmakur"]);
  wsSummary.addRow(["Project", "Madrasa Amanah Attendance Management System"]);
  wsSummary.addRow(["Reporting Period", `${from} to ${to}`]);
  wsSummary.addRow(["Report Generated At", new Date().toISOString()]);
  wsSummary.addRow(["Target Recipient(s)", recipientEmail || "2300030621cseh1@gmail.com, mdrafiq12118@gmail.com"]);
  wsSummary.addRow([]);

  // High-level KPIs
  wsSummary.addRow(["OVERALL METRICS", "COUNT", "NOTES"]);
  wsSummary.addRow(["Total Active Classes", classes.length, "Registered madrasa classes"]);
  wsSummary.addRow(["Total Enrolled Students", totalEnrolled, "Active students roster"]);
  wsSummary.addRow(["Total Attendance Marks", totalRecords, "Recorded during the reporting week"]);
  wsSummary.addRow(["Total Present", presentTotal, "Standard on-time attendance"]);
  wsSummary.addRow(["Total Absent", absentTotal, "Unexcused absence"]);
  wsSummary.addRow(["Total Late", lateTotal, "Late arrivals (counted towards attendance)"]);
  wsSummary.addRow(["Total Excused", excusedTotal, "Permitted or authorized leave"]);
  wsSummary.addRow(["Overall Attendance Rate", `${overallPercentage}%`, "Formula: ((Present + Late) / Total) * 100"]);
  wsSummary.addRow([]);

  // Class Breakdown Header
  const classHeaderRow = wsSummary.addRow([
    "Class Name",
    "Section",
    "Enrolled",
    "Total Marks",
    "Present",
    "Absent",
    "Late",
    "Excused",
    "Attendance %"
  ]);
  classHeaderRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  classHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };

  // Class Breakdown Rows
  for (const c of classes) {
    const classIdStr = String(c._id || c.name);
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
      c.section || "General",
      classStudents.length,
      cTotal,
      cPresent,
      cAbsent,
      cLate,
      cExcused,
      `${cPct}%`
    ]);
    row.eachCell(cell => { cell.border = borderStyle; });
  }

  // =========================================================================
  // --- WORKSHEET 2: Student Attendance (Daily Matrix & Summaries) ---
  // =========================================================================
  const wsStudent = wb.addWorksheet("Student Attendance");

  // Dynamic columns: Student info + each day in week + metrics
  const studentCols = [
    { header: "Admission No", key: "admissionNo", width: 16 },
    { header: "Student Name", key: "name", width: 28 },
    { header: "Class", key: "className", width: 20 },
    { header: "Section", key: "section", width: 12 }
  ];

  dateList.forEach(d => {
    studentCols.push({ header: d, key: `d_${d}`, width: 12 });
  });

  studentCols.push(
    { header: "Present", key: "presentCount", width: 12 },
    { header: "Absent", key: "absentCount", width: 12 },
    { header: "Late", key: "lateCount", width: 12 },
    { header: "Excused (Leave)", key: "excusedCount", width: 16 },
    { header: "Total Recorded", key: "totalCount", width: 15 },
    { header: "Weekly Rate", key: "rate", width: 15 },
    { header: "Standing", key: "standing", width: 18 }
  );
  wsStudent.columns = studentCols;

  // Format header row
  const studentHeaderRow = wsStudent.getRow(1);
  studentHeaderRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  studentHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };
  wsStudent.views = [{ state: "frozen", ySplit: 1 }];

  students.forEach(st => {
    const studentIdStr = String(st._id || st.admissionNo);
    const stAttendances = attendances.filter(a => String(a.studentId?._id || a.studentId) === studentIdStr);

    const sPresent = stAttendances.filter(a => a.status === "present").length;
    const sAbsent = stAttendances.filter(a => a.status === "absent").length;
    const sLate = stAttendances.filter(a => a.status === "late").length;
    const sExcused = stAttendances.filter(a => a.status === "excused").length;
    const sTotal = stAttendances.length;
    const sAttended = sPresent + sLate;
    const sRate = sTotal > 0 ? (((sAttended) / sTotal) * 100).toFixed(1) + "%" : "—";

    let standing = "No Records";
    if (sTotal > 0) {
      const numRate = Number(sRate.replace("%", ""));
      if (numRate >= 85) standing = "Good Standing";
      else if (numRate >= 70) standing = "Satisfactory";
      else standing = "Needs Attention";
    }

    const rowObj = {
      admissionNo: String(st.admissionNo || "—"), // String preserves leading zeros
      name: st.name || "Unknown",
      className: st.classId?.name || "General",
      section: st.classId?.section || "A",
      presentCount: sPresent,
      absentCount: sAbsent,
      lateCount: sLate,
      excusedCount: sExcused,
      totalCount: sTotal,
      rate: sRate,
      standing
    };

    // Populate daily marks
    dateList.forEach(d => {
      const dayRecord = stAttendances.find(a => a.dateKey === d);
      rowObj[`d_${d}`] = dayRecord ? dayRecord.status.toUpperCase() : "—";
    });

    const addedRow = wsStudent.addRow(rowObj);
    addedRow.eachCell(cell => { cell.border = borderStyle; });
  });

  // =========================================================================
  // --- WORKSHEET 3: Daily Breakdown (Detailed Attendance Transactions) ---
  // =========================================================================
  const wsDetail = wb.addWorksheet("Daily Breakdown");
  wsDetail.columns = [
    { header: "Date", key: "dateKey", width: 14 },
    { header: "Session", key: "sessionKey", width: 14 },
    { header: "Admission No", key: "admissionNo", width: 18 },
    { header: "Student Name", key: "studentName", width: 28 },
    { header: "Class", key: "className", width: 22 },
    { header: "Status", key: "status", width: 14 },
    { header: "Source", key: "source", width: 16 },
    { header: "Marked By", key: "markedBy", width: 24 },
    { header: "Note", key: "note", width: 26 },
    { header: "Recorded At", key: "createdAt", width: 22 }
  ];

  attendances.forEach(a => {
    const row = wsDetail.addRow({
      dateKey: a.dateKey,
      sessionKey: a.sessionKey || "morning",
      admissionNo: String(a.studentId?.admissionNo || "N/A"), // String preserves leading zeros
      studentName: a.studentId?.name || "Unknown",
      className: a.classId ? `${a.classId.name}${a.classId.section ? ` (${a.classId.section})` : ""}` : "Unassigned",
      status: String(a.status || "").toUpperCase(),
      source: a.source || "manual",
      markedBy: a.markedBy?.name || a.markedBy?.email || "System",
      note: a.note || "",
      createdAt: a.createdAt ? new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 19) : ""
    });
    row.eachCell(cell => { cell.border = borderStyle; });
  });

  wsDetail.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  wsDetail.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };
  wsDetail.views = [{ state: "frozen", ySplit: 1 }];

  // =========================================================================
  // --- WORKSHEET 4: Class Summary ---
  // =========================================================================
  const wsClassSummary = wb.addWorksheet("Class Summary");
  wsClassSummary.columns = [
    { header: "Class", key: "name", width: 24 },
    { header: "Section", key: "section", width: 14 },
    { header: "Academic Year", key: "academicYear", width: 18 },
    { header: "Teachers", key: "teachers", width: 28 },
    { header: "Enrolled Students", key: "enrolled", width: 18 },
    { header: "Weekly Records", key: "records", width: 16 },
    { header: "Weekly Present", key: "present", width: 16 },
    { header: "Weekly Absent", key: "absent", width: 16 },
    { header: "Weekly Late", key: "late", width: 14 },
    { header: "Weekly Excused", key: "excused", width: 16 },
    { header: "Attendance Rate", key: "rate", width: 18 },
    { header: "Register Status", key: "status", width: 22 }
  ];

  classes.forEach(c => {
    const classIdStr = String(c._id || c.name);
    const classStudents = students.filter(s => String(s.classId?._id || s.classId) === classIdStr);
    const classAttendances = attendances.filter(a => String(a.classId?._id || a.classId) === classIdStr);
    const cPresent = classAttendances.filter(a => a.status === "present").length;
    const cAbsent = classAttendances.filter(a => a.status === "absent").length;
    const cLate = classAttendances.filter(a => a.status === "late").length;
    const cExcused = classAttendances.filter(a => a.status === "excused").length;
    const cTotal = classAttendances.length;
    const cRate = cTotal > 0 ? (((cPresent + cLate) / cTotal) * 100).toFixed(1) + "%" : "0.0%";
    const teacherNames = (c.teacherIds || []).map(t => t.name || t).join(", ") || "None Assigned";
    const statusLabel = cTotal > 0 ? "Registers Logged ✓" : "No Registers Recorded";

    const row = wsClassSummary.addRow({
      name: c.name,
      section: c.section || "-",
      academicYear: c.academicYear || "2026-2027",
      teachers: teacherNames,
      enrolled: classStudents.length,
      records: cTotal,
      present: cPresent,
      absent: cAbsent,
      late: cLate,
      excused: cExcused,
      rate: cRate,
      status: statusLabel
    });
    row.eachCell(cell => { cell.border = borderStyle; });
  });

  wsClassSummary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  wsClassSummary.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };
  wsClassSummary.views = [{ state: "frozen", ySplit: 1 }];

  return wb;
}

export function getNextScheduledReportRun(schedule = "Sundays at 07:00 PM (IST)", timezone = "Asia/Kolkata") {
  // Computes the next scheduled Sunday at 07:00 PM (19:00 IST / 13:30 UTC)
  const now = new Date();
  const next = new Date(now);
  const day = now.getUTCDay(); // 0 is Sunday
  let daysUntilSunday = (7 - day) % 7;
  if (daysUntilSunday === 0) {
    // If today is Sunday UTC, check if 13:30 UTC (19:00 IST) has passed
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (currentMinutes >= 13 * 60 + 30) {
      daysUntilSunday = 7;
    }
  }
  next.setUTCDate(now.getUTCDate() + daysUntilSunday);
  next.setUTCHours(13, 30, 0, 0); // 13:30 UTC = 19:00 (7:00 PM) IST
  return next.toISOString();
}

/**
 * Resolves the effective recipient email:
 * 1. Explicitly requested recipient (from API/UI call)
 * 2. REPORT_RECIPIENT_EMAILS environment variable (comma-separated list)
 * 3. REPORT_RECIPIENT_EMAIL / ATTENDANCE_REPORT_EMAIL environment variables
 * 4. Saved DB settings
 * 5. ADMIN_EMAIL environment variable
 * 6. Default fallback (both configured recipients: 2300030621cseh1@gmail.com and mdrafiq12118@gmail.com)
 */
export function resolveRecipientEmail(explicitRecipient, settings) {
  if (explicitRecipient && typeof explicitRecipient === "string" && explicitRecipient.trim()) {
    return explicitRecipient.trim();
  }
  const envEmails = (process.env.REPORT_RECIPIENT_EMAILS || process.env.REPORT_RECIPIENT_EMAIL || process.env.ATTENDANCE_REPORT_EMAIL || "").trim();
  if (envEmails) {
    return envEmails;
  }
  const dbRecipient = settings?.reportRecipientEmail?.trim();
  if (dbRecipient) {
    return dbRecipient;
  }
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.trim() && process.env.ADMIN_EMAIL.trim() !== "admin@example.com") {
    return process.env.ADMIN_EMAIL.trim();
  }
  return "2300030621cseh1@gmail.com, mdrafiq12118@gmail.com";
}

/**
 * Splits comma, semicolon, or whitespace separated recipient emails
 * and returns unique, trimmed, valid email strings.
 */
export function parseRecipientEmails(targetRecipient) {
  if (Array.isArray(targetRecipient)) {
    return [...new Set(
      targetRecipient
        .map(e => String(e).trim())
        .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    )];
  }
  const list = String(targetRecipient || "")
    .split(/[,;\s]+/)
    .map(e => e.trim())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return [...new Set(list)];
}

/**
 * Sends weekly attendance report via email attachment (both PDF & Excel)
 */
export async function sendWeeklyEmailReport({ from, to, recipientEmail, trigger = "manual", actorId = null }) {
  let settings = null;
  try {
    settings = await SystemSetting.findOne({ key: "global" });
  } catch {}

  const targetRecipient = resolveRecipientEmail(recipientEmail, settings);
  const recipients = parseRecipientEmails(targetRecipient);
  if (recipients.length === 0) {
    recipients.push("2300030621cseh1@gmail.com", "mdrafiq12118@gmail.com");
  }
  const displayRecipients = recipients.join(", ");
  const institutionName = process.env.MADRASA_NAME || "Darul Uloom Ashrafia, Atmakur";
  const arabicSubtitle = process.env.MADRASA_NAME_ARABIC || "دارالعلوم اشرفیہ اتماکور";

  const safeName = institutionName.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
  const excelFilename = `${safeName}-Weekly-Attendance-${from}-to-${to}.xlsx`;
  const pdfFilename = `${safeName}-Weekly-Attendance-${from}-to-${to}.pdf`;

  // 1. Generate Excel workbook
  const wb = await generateWeeklyExcelWorkbook({ from, to, recipientEmail: displayRecipients });
  const excelBuffer = await wb.xlsx.writeBuffer();

  // 2. Generate PDF Report with logo & official styling
  let pdfBuffer = null;
  try {
    pdfBuffer = await generateWeeklyAttendancePdfBuffer({ from, to });
  } catch (pdfErr) {
    console.warn("[PDF WARNING] Failed to generate weekly PDF report:", pdfErr.message);
  }

  const [attendances, classes, students] = await Promise.all([
    Attendance.find({ dateKey: { $gte: from, $lte: to } }),
    Class.find({ active: true }),
    Student.find({ active: true })
  ]);

  const totalEnrolled = students.length;
  const presentTotal = attendances.filter(a => a.status === "present").length;
  const absentTotal = attendances.filter(a => a.status === "absent").length;
  const lateTotal = attendances.filter(a => a.status === "late").length;
  const excusedTotal = attendances.filter(a => a.status === "excused").length;
  const total = attendances.length;
  const rate = total > 0 ? (((presentTotal + lateTotal) / total) * 100).toFixed(1) : "0.0";

  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  const brevoApiKey = (process.env.BREVO_API_KEY || "").trim();
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").replace(/\s+/g, "");
  const smtpHost = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const isSecure = process.env.SMTP_SECURE === "true" || smtpPort === 465;
  const smtpFrom = process.env.SMTP_FROM || `"${institutionName}" <${smtpUser || "reports@madrasa-amanah.com"}>`;

  const emailConfigured = Boolean(resendApiKey || brevoApiKey || (smtpUser && smtpPass));

  const emailSubject = `${institutionName} — Weekly Attendance Report (${from} to ${to})`;

  const mailText = `Assalamu Alaikum,\n\nPlease find attached the official Weekly Attendance Report for ${institutionName} (${arabicSubtitle}) for the period ${from} to ${to}.\n\nExecutive Attendance Summary:\n- Total Registered Students: ${totalEnrolled}\n- Total Active Classes: ${classes.length}\n- Total Attendance Marks: ${total}\n- Present: ${presentTotal}\n- Absent: ${absentTotal}\n- Late: ${lateTotal}\n- Excused: ${excusedTotal}\n- Attendance Rate: ${rate}%\n\nAttached Documents:\n1. Official Printable PDF Attendance Dossier (${pdfFilename})\n2. Detailed Multi-Sheet Excel Spreadsheet (${excelFilename})\n\nMadrasa Amanah Attendance Management System\nLocation: Atmakur`;

  const mailHtml = `
    <div style="font-family: Arial, sans-serif; color: #1E293B; max-width: 600px; border: 1px solid #DFE5E0; border-radius: 8px; padding: 24px; background: #F8FAFC;">
      <div style="text-align: center; margin-bottom: 20px; border-bottom: 2px solid #D97706; padding-bottom: 16px;">
        <h2 style="color: #174B36; margin: 0; font-size: 18px; letter-spacing: 0.5px;">${arabicSubtitle}</h2>
        <h3 style="color: #0E3324; margin: 4px 0 0 0; font-size: 16px;">${institutionName.toUpperCase()}</h3>
        <p style="color: #64748B; margin: 4px 0 0 0; font-size: 12px;">Madrasa Amanah Attendance Management System · Location: Atmakur</p>
      </div>
      <div style="background: #FFFFFF; border-radius: 8px; padding: 18px; border: 1px solid #E2E8F0; margin-bottom: 16px;">
        <p style="margin: 0 0 12px 0; font-size: 14px; font-weight: bold; color: #174B36;">
          Weekly Attendance Summary: ${from} to ${to}
        </p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0; color: #64748B;">Total Registered Students:</td><td style="text-align: right; font-weight: bold;">${totalEnrolled}</td></tr>
          <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0; color: #64748B;">Total Records Logged:</td><td style="text-align: right; font-weight: bold;">${total}</td></tr>
          <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0; color: #64748B;">Present:</td><td style="text-align: right; color: #059669; font-weight: bold;">${presentTotal}</td></tr>
          <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0; color: #64748B;">Absent:</td><td style="text-align: right; color: #DC2626; font-weight: bold;">${absentTotal}</td></tr>
          <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0; color: #64748B;">Late:</td><td style="text-align: right; color: #D97706; font-weight: bold;">${lateTotal}</td></tr>
          <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0; color: #64748B;">Excused:</td><td style="text-align: right; color: #2563EB; font-weight: bold;">${excusedTotal}</td></tr>
          <tr><td style="padding: 8px 0; font-size: 14px; font-weight: bold; color: #0E3324;">Overall Attendance Rate:</td><td style="text-align: right; font-size: 15px; font-weight: bold; color: #059669;">${rate}%</td></tr>
        </table>
      </div>
      <div style="background: #F1F5F9; border-radius: 6px; padding: 12px 16px; font-size: 12px; color: #475569;">
        <strong>📎 Attached Official Reports:</strong>
        <ul style="margin: 6px 0 0 0; padding-left: 20px;">
          <li><strong>${pdfFilename}</strong> (Printable Official PDF Report with Madrasa Logo)</li>
          <li><strong>${excelFilename}</strong> (Executive Multi-Sheet Excel Spreadsheet)</li>
        </ul>
      </div>
      <p style="font-size: 11px; color: #94A3B8; margin-top: 16px; text-align: center;">
        ${institutionName} • Confidential Official Report
      </p>
    </div>
  `;

  if (emailConfigured) {
    try {
      let messageId = null;
      let sentSuccess = false;
      let dispatchError = null;
      let usedProvider = "None";

      // 1. Primary Email Channel: Brevo HTTPS API (Port 443 — Bypasses cloud port blocks)
      if (brevoApiKey) {
        try {
          const brevoSenderEmail = (process.env.BREVO_FROM || process.env.SMTP_USER || "mdrafiq12118@gmail.com").trim();
          const brevoAttachments = [];

          if (pdfBuffer) {
            brevoAttachments.push({
              name: pdfFilename,
              content: pdfBuffer.toString("base64")
            });
          }
          brevoAttachments.push({
            name: excelFilename,
            content: excelBuffer.toString("base64")
          });

          const res = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
              "api-key": brevoApiKey,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              sender: { name: institutionName, email: brevoSenderEmail },
              to: recipients.map(email => ({ email })),
              subject: emailSubject,
              textContent: mailText,
              htmlContent: mailHtml,
              attachment: brevoAttachments
            })
          });
          const resData = await res.json();
          if (res.ok) {
            messageId = resData.messageId || "brevo-dispatched";
            sentSuccess = true;
            usedProvider = "Brevo HTTPS API";
          } else {
            console.warn("[MAIL] Brevo send error:", resData);
            dispatchError = new Error(resData?.message || `Brevo HTTP ${res.status}`);
          }
        } catch (err) {
          console.warn("[MAIL] Brevo exception, trying fallback:", err.message);
          dispatchError = err;
        }
      }

      // 2. Direct Nodemailer Gmail SMTP (Fallback if Brevo fails)
      if (!sentSuccess && smtpUser && smtpPass) {
        try {
          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: isSecure,
            auth: {
              user: smtpUser,
              pass: smtpPass
            },
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 20000
          });

          const smtpAttachments = [];
          if (pdfBuffer) {
            smtpAttachments.push({
              filename: pdfFilename,
              content: pdfBuffer,
              contentType: "application/pdf"
            });
          }
          smtpAttachments.push({
            filename: excelFilename,
            content: excelBuffer,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          });

          const mailOptions = {
            from: smtpFrom,
            to: displayRecipients,
            subject: emailSubject,
            text: mailText,
            html: mailHtml,
            attachments: smtpAttachments
          };

          const info = await transporter.sendMail(mailOptions);
          messageId = info.messageId || "smtp-dispatched";
          sentSuccess = true;
          usedProvider = `Gmail SMTP (${smtpHost})`;
          dispatchError = null;
        } catch (err) {
          console.warn("[MAIL] SMTP fallback failed:", err.message);
          if (!dispatchError) dispatchError = err;
        }
      }

      // 3. Resend HTTPS API (Port 443 — Second Fallback)
      if (!sentSuccess && resendApiKey) {
        try {
          const resendFrom = process.env.RESEND_FROM || `${institutionName} <onboarding@resend.dev>`;
          const resendAttachments = [];
          if (pdfBuffer) {
            resendAttachments.push({
              filename: pdfFilename,
              content: pdfBuffer.toString("base64")
            });
          }
          resendAttachments.push({
            filename: excelFilename,
            content: excelBuffer.toString("base64")
          });

          const resendRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendApiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: resendFrom,
              to: recipients,
              subject: emailSubject,
              text: mailText,
              html: mailHtml,
              attachments: resendAttachments
            })
          });
          const resendData = await resendRes.json();
          if (resendRes.ok) {
            messageId = resendData.id || "resend-dispatched";
            sentSuccess = true;
            usedProvider = "Resend HTTPS API";
            dispatchError = null;
          } else {
            console.warn("[MAIL] Resend send error:", resendData);
            if (!dispatchError) dispatchError = new Error(resendData?.message || `Resend HTTP ${resendRes.status}`);
          }
        } catch (err) {
          console.warn("[MAIL] Resend exception:", err.message);
          if (!dispatchError) dispatchError = err;
        }
      }

      if (sentSuccess) {
        if (settings) {
          settings.lastReportSuccess = {
            date: new Date().toISOString(),
            recipient: displayRecipients,
            provider: usedProvider,
            period: `${from} to ${to}`,
            messageId
          };
          await settings.save();
        }

        try {
          await AuditLog.create({
            actorId: actorId || null,
            action: "report.weekly_email_sent",
            entityType: "Report",
            details: {
              recipient: displayRecipients,
              from,
              to,
              provider: usedProvider,
              messageId,
              pdfBytes: pdfBuffer ? pdfBuffer.length : 0,
              excelBytes: excelBuffer.length,
              trigger
            }
          });
        } catch {}

        return {
          delivered: true,
          recipient: displayRecipients,
          from,
          to,
          messageId,
          provider: usedProvider,
          bytes: excelBuffer.length,
          pdfBytes: pdfBuffer ? pdfBuffer.length : 0,
          summary: {
            totalEnrolled,
            total,
            present: presentTotal,
            absent: absentTotal,
            late: lateTotal,
            excused: excusedTotal,
            rate
          }
        };
      }

      const errorMessage = dispatchError?.message || "All email dispatch channels failed.";
      if (settings) {
        settings.lastReportFailure = {
          date: new Date().toISOString(),
          recipient: displayRecipients,
          error: errorMessage
        };
        await settings.save();
      }

      return {
        delivered: false,
        recipient: displayRecipients,
        from,
        to,
        error: errorMessage,
        bytes: excelBuffer.length,
        summary: { totalEnrolled, total, rate }
      };
    } catch (err) {
      return {
        delivered: false,
        recipient: displayRecipients,
        from,
        to,
        error: err.message,
        bytes: excelBuffer.length
      };
    }
  }

  // Not configured in environment
  return {
    delivered: false,
    recipient: displayRecipients,
    from,
    to,
    message: "No email API credentials configured. Set BREVO_API_KEY, RESEND_API_KEY, or SMTP_USER/SMTP_PASS in environment.",
    bytes: excelBuffer.length,
    summary: { totalEnrolled, total, rate }
  };
}
