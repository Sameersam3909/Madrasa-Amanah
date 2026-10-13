import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import { Attendance, Class, Student, User, AuditLog } from "./models.js";

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
 * Generates the multi-sheet weekly attendance Excel workbook
 */
export async function generateWeeklyExcelWorkbook({ from, to }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Madrasa Amanah Smart Attendance System";
  wb.lastModifiedBy = "Automated Weekly Report";
  wb.created = new Date();

  // 1. Fetch authorized data
  const [classes, students, attendances] = await Promise.all([
    Class.find({ active: true }).populate("teacherIds", "name email").sort({ name: 1 }),
    Student.find({ active: true }).populate("classId", "name section").sort({ name: 1 }),
    Attendance.find({ dateKey: { $gte: from, $lte: to } })
      .populate("studentId", "name admissionNo classId")
      .populate("classId", "name section")
      .populate("markedBy", "name email")
      .sort({ dateKey: 1, sessionKey: 1 })
  ]);

  const totalEnrolled = students.length;
  const totalRecords = attendances.length;
  const presentTotal = attendances.filter(a => a.status === "present").length;
  const absentTotal = attendances.filter(a => a.status === "absent").length;
  const lateTotal = attendances.filter(a => a.status === "late").length;
  const excusedTotal = attendances.filter(a => a.status === "excused").length;
  const attendedTotal = presentTotal + lateTotal;
  const overallPercentage = totalRecords > 0 ? ((attendedTotal / totalRecords) * 100).toFixed(1) : "0.0";

  // --- SHEET 1: Attendance Summary ---
  const wsSummary = wb.addWorksheet("Attendance Summary");
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
  wsSummary.addRow(["مَدْرَسَة  •  MADRASA AMANAH", "Weekly Attendance Report"]);
  wsSummary.addRow(["Reporting Period", `${from} to ${to}`]);
  wsSummary.addRow(["Report Generated At", new Date().toISOString()]);
  wsSummary.addRow(["Target Recipient", process.env.REPORT_RECIPIENT_EMAIL || "2300030621cseh1@gmail.com"]);
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
    const classIdStr = String(c._id);
    const classStudents = students.filter(s => String(s.classId?._id || s.classId) === classIdStr);
    const classAttendances = attendances.filter(a => String(a.classId?._id || a.classId) === classIdStr);
    const cPresent = classAttendances.filter(a => a.status === "present").length;
    const cAbsent = classAttendances.filter(a => a.status === "absent").length;
    const cLate = classAttendances.filter(a => a.status === "late").length;
    const cExcused = classAttendances.filter(a => a.status === "excused").length;
    const cTotal = classAttendances.length;
    const cPct = cTotal > 0 ? (((cPresent + cLate) / cTotal) * 100).toFixed(1) : "0.0";

    wsSummary.addRow([
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
  }

  // --- SHEET 2: Detailed Attendance ---
  const wsDetail = wb.addWorksheet("Detailed Attendance");
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
    wsDetail.addRow({
      dateKey: a.dateKey,
      sessionKey: a.sessionKey || "morning",
      admissionNo: a.studentId?.admissionNo || "N/A",
      studentName: a.studentId?.name || "Unknown",
      className: a.classId ? `${a.classId.name}${a.classId.section ? ` (${a.classId.section})` : ""}` : "Unassigned",
      status: a.status.toUpperCase(),
      source: a.source || "manual",
      markedBy: a.markedBy?.name || a.markedBy?.email || "System",
      note: a.note || "",
      createdAt: a.createdAt ? new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 19) : ""
    });
  });

  wsDetail.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  wsDetail.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };
  wsDetail.views = [{ state: "frozen", ySplit: 1 }];

  // --- SHEET 3: Class Summary ---
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
    const classIdStr = String(c._id);
    const classStudents = students.filter(s => String(s.classId?._id || s.classId) === classIdStr);
    const classAttendances = attendances.filter(a => String(a.classId?._id || a.classId) === classIdStr);
    const cPresent = classAttendances.filter(a => a.status === "present").length;
    const cAbsent = classAttendances.filter(a => a.status === "absent").length;
    const cLate = classAttendances.filter(a => a.status === "late").length;
    const cExcused = classAttendances.filter(a => a.status === "excused").length;
    const cTotal = classAttendances.length;
    const cRate = cTotal > 0 ? (((cPresent + cLate) / cTotal) * 100).toFixed(1) + "%" : "0.0%";
    const teacherNames = (c.teacherIds || []).map(t => t.name).join(", ") || "None Assigned";
    const statusLabel = cTotal > 0 ? "Registers Logged ✓" : "No Registers Recorded";

    wsClassSummary.addRow({
      name: c.name,
      section: c.section || "-",
      academicYear: c.academicYear,
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
  });

  wsClassSummary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  wsClassSummary.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174B36" } };
  wsClassSummary.views = [{ state: "frozen", ySplit: 1 }];

  return wb;
}

/**
 * Sends weekly attendance report via email attachment
 */
export async function sendWeeklyEmailReport({ from, to, recipientEmail, trigger = "manual", actorId = null }) {
  const targetRecipient = recipientEmail || process.env.REPORT_RECIPIENT_EMAIL || "2300030621cseh1@gmail.com";
  const safeFilename = `Madrasa-Amanah-Weekly-Attendance-${from}-to-${to}.xlsx`;

  // 1. Generate workbook
  const wb = await generateWeeklyExcelWorkbook({ from, to });
  const buffer = await wb.xlsx.writeBuffer();

  const attendances = await Attendance.find({ dateKey: { $gte: from, $lte: to } });
  const presentTotal = attendances.filter(a => a.status === "present").length;
  const absentTotal = attendances.filter(a => a.status === "absent").length;
  const lateTotal = attendances.filter(a => a.status === "late").length;
  const excusedTotal = attendances.filter(a => a.status === "excused").length;
  const total = attendances.length;
  const rate = total > 0 ? (((presentTotal + lateTotal) / total) * 100).toFixed(1) : "0.0";

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpPort = Number(process.env.SMTP_PORT || 587);

  // If SMTP is configured, attempt real email delivery
  if (smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });

      const mailOptions = {
        from: `"Madrasa Amanah Reports" <${smtpUser}>`,
        to: targetRecipient,
        subject: `Madrasa Amanah — Weekly Attendance Report — ${from} to ${to}`,
        text: `Assalamu Alaikum,\n\nPlease find attached the Madrasa Amanah Smart Attendance System weekly attendance report for the period ${from} to ${to}.\n\nWeekly Summary:\n- Total Records: ${total}\n- Present: ${presentTotal}\n- Absent: ${absentTotal}\n- Late: ${lateTotal}\n- Excused: ${excusedTotal}\n- Attendance Rate: ${rate}%\n\nGenerated automatically on ${new Date().toUTCString()}.\n\nMadrasa Amanah Administration`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #23342A; max-width: 600px; border: 1px solid #DFE5E0; border-radius: 8px; padding: 24px; background: #F7F6F0;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h2 style="color: #174B36; margin: 0;">مَدْرَسَة • MADRASA AMANAH</h2>
              <p style="color: #68776D; margin: 4px 0 0 0; font-size: 13px;">Smart Attendance System · Weekly Executive Report</p>
            </div>
            <div style="background: #FFFFFF; border-radius: 8px; padding: 18px; border: 1px solid #DFE5E0;">
              <p style="margin: 0 0 12px 0;"><strong>Reporting Period:</strong> ${from} to ${to}</p>
              <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0;">Total Records Logged:</td><td style="text-align: right; font-weight: bold;">${total}</td></tr>
                <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0;">Present:</td><td style="text-align: right; color: #237547; font-weight: bold;">${presentTotal}</td></tr>
                <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0;">Absent:</td><td style="text-align: right; color: #B23A3A; font-weight: bold;">${absentTotal}</td></tr>
                <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0;">Late:</td><td style="text-align: right; color: #94620C; font-weight: bold;">${lateTotal}</td></tr>
                <tr style="border-bottom: 1px solid #EEE;"><td style="padding: 6px 0;">Excused:</td><td style="text-align: right; color: #285A84; font-weight: bold;">${excusedTotal}</td></tr>
                <tr><td style="padding: 8px 0; font-size: 14px; font-weight: bold;">Overall Attendance Rate:</td><td style="text-align: right; font-size: 15px; font-weight: bold; color: #174B36;">${rate}%</td></tr>
              </table>
            </div>
            <p style="font-size: 12px; color: #68776D; margin-top: 16px;">
              The full Excel report with Detailed Attendance and Class Summaries is attached to this email.
            </p>
          </div>
        `,
        attachments: [
          {
            filename: safeFilename,
            content: buffer,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          }
        ]
      };

      const info = await transporter.sendMail(mailOptions);

      if (actorId) {
        await AuditLog.create({
          actorId,
          action: "report.weekly_email_sent",
          entityType: "Report",
          details: { recipient: targetRecipient, from, to, messageId: info.messageId, trigger }
        });
      }

      return {
        success: true,
        delivered: true,
        messageId: info.messageId,
        recipient: targetRecipient,
        filename: safeFilename,
        bytes: buffer.byteLength,
        from,
        to,
        summary: { total, present: presentTotal, absent: absentTotal, late: lateTotal, excused: excusedTotal, rate }
      };
    } catch (err) {
      console.error("SMTP Delivery error:", err.message);
      return {
        success: false,
        delivered: false,
        error: err.message,
        recipient: targetRecipient,
        filename: safeFilename,
        bytes: buffer.byteLength,
        from,
        to,
        summary: { total, present: presentTotal, absent: absentTotal, late: lateTotal, excused: excusedTotal, rate }
      };
    }
  }

  // Fallback when SMTP credentials are not yet set
  return {
    success: true,
    delivered: false,
    smtpConfigured: false,
    message: "Report generated successfully. SMTP credentials (SMTP_USER/SMTP_PASS) are not yet configured for direct email delivery.",
    recipient: targetRecipient,
    filename: safeFilename,
    bytes: buffer.byteLength,
    from,
    to,
    summary: { total, present: presentTotal, absent: absentTotal, late: lateTotal, excused: excusedTotal, rate }
  };
}
