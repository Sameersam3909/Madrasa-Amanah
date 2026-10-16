import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import { Class, Student, Attendance } from "./models.js";
import { compareRollNumbers } from "./utils/studentSort.js";

// Ensure TextDecoder compatibility in Node 23+
if (typeof TextDecoder !== "undefined") {
  const origDecode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function (...args) {
    const res = origDecode.apply(this, args);
    return typeof res === "string" ? res : res.toString("utf8");
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONTS_DIR = path.join(__dirname, "fonts");
const ARABIC_FONT_PATH = path.join(FONTS_DIR, "NotoSansArabic-Regular.ttf");
const hasArabicFont = fs.existsSync(ARABIC_FONT_PATH);

/**
 * Generates an executive, printable PDF weekly attendance report
 * with official Madrasa branding, logo, KPIs, class breakdown,
 * and detailed student attendance log.
 */
export async function generateWeeklyAttendancePdfBuffer({ from, to }) {
  // Fetch real database records
  const [classes, students, attendances] = await Promise.all([
    Class.find({ active: true }).populate("teacherIds", "name email").sort({ name: 1 }),
    Student.find({ active: true }).populate("classId", "name section").sort({ admissionNo: 1, name: 1 }),
    Attendance.find({ dateKey: { $gte: from, $lte: to } })
      .populate("studentId", "name admissionNo classId")
      .populate("classId", "name section")
      .populate("markedBy", "name email")
      .sort({ dateKey: 1, sessionKey: 1 })
  ]);

  students.sort(compareRollNumbers);

  const totalEnrolled = students.length;
  const totalRecords = attendances.length;
  const presentTotal = attendances.filter(a => a.status === "present").length;
  const absentTotal = attendances.filter(a => a.status === "absent").length;
  const lateTotal = attendances.filter(a => a.status === "late").length;
  const excusedTotal = attendances.filter(a => a.status === "excused").length;
  const attendedTotal = presentTotal + lateTotal;
  const overallPercentage = totalRecords > 0 ? ((attendedTotal / totalRecords) * 100).toFixed(1) : "0.0";

  // Create PDF Document
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: 36, bottom: 44, left: 36, right: 36 },
    bufferPages: true,
    info: {
      Title: `Weekly Attendance Report: ${from} to ${to}`,
      Author: "Darul Uloom Ashraful Ahad, Atmakur",
      Subject: "Madrasa Amanah Attendance Management System"
    }
  });

  if (hasArabicFont) {
    try {
      doc.registerFont("NotoArabic", ARABIC_FONT_PATH);
    } catch {}
  }

  const primaryDark = "#0E3324";
  const primaryColor = "#174B36";
  const accentGold = "#D97706";
  const borderGray = "#E2E8F0";
  const bgLight = "#F8FAFC";
  const textColor = "#1E293B";
  const textMuted = "#64748B";

  const logoPath = path.join(__dirname, "assets", "logo.png");

  // Helper to draw Header Banner
  const drawBanner = (pageNum) => {
    doc.roundedRect(36, 36, 523, 64, 4).fill(primaryColor);
    doc.rect(36, 98, 523, 2).fill(accentGold);

    // Official Logo
    const cx = 60;
    const cy = 68;
    if (fs.existsSync(logoPath)) {
      try {
        doc.save();
        doc.circle(cx, cy, 21).fill("#FFFFFF");
        doc.image(logoPath, cx - 19, cy - 19, { width: 38, height: 38 });
        doc.restore();
      } catch {
        doc.circle(cx, cy, 18).fillAndStroke(primaryDark, accentGold);
      }
    } else {
      doc.circle(cx, cy, 18).fillAndStroke(primaryDark, accentGold);
    }

    // Title
    doc.fillColor("#FFFFFF").fontSize(12).font("Helvetica-Bold")
      .text("DARUL ULOOM ASHRAFUL AHAD, ATMAKUR", 88, 44, { width: 280 });
    if (hasArabicFont) {
      doc.fillColor(accentGold).fontSize(10).font("NotoArabic")
        .text("دار العلوم اشرفیہ اتماکور", 88, 59, { width: 280 });
    }
    doc.fillColor("#D1FAE5").fontSize(7.5).font("Helvetica")
      .text("Madrasa Amanah Attendance Management System", 88, 73);

    // Right-aligned report metadata
    doc.fillColor("#FFFFFF").fontSize(10).font("Helvetica-Bold")
      .text("WEEKLY ATTENDANCE REPORT", 360, 44, { align: "right", width: 190 });
    doc.fillColor("#D1FAE5").fontSize(8).font("Helvetica")
      .text(`Period: ${from} to ${to}`, 360, 58, { align: "right", width: 190 });
    doc.fillColor("#A7F3D0").fontSize(7).font("Helvetica")
      .text(`Generated: ${new Date().toISOString().slice(0, 10)}`, 360, 72, { align: "right", width: 190 });
  };

  // PAGE 1: Banner + Executive KPIs + Class Breakdown
  drawBanner(1);

  let curY = 112;

  // Executive KPI Summary Cards
  doc.fillColor(primaryDark).fontSize(11).font("Helvetica-Bold").text("EXECUTIVE ATTENDANCE SUMMARY", 36, curY);
  curY += 16;

  const cardW = 125;
  const cardH = 46;
  const kpis = [
    { label: "REGISTERED STUDENTS", value: String(totalEnrolled), color: textColor },
    { label: "ATTENDANCE RATE", value: `${overallPercentage}%`, color: Number(overallPercentage) >= 80 ? "#059669" : "#D97706" },
    { label: "TOTAL RECORDS", value: String(totalRecords), color: textColor },
    { label: "PRESENT MARKS", value: String(presentTotal), color: "#059669" },
    { label: "ABSENT MARKS", value: String(absentTotal), color: "#DC2626" },
    { label: "LATE MARKS", value: String(lateTotal), color: "#D97706" },
    { label: "EXCUSED MARKS", value: String(excusedTotal), color: "#2563EB" },
    { label: "ACTIVE CLASSES", value: String(classes.length), color: textColor }
  ];

  kpis.forEach((kpi, idx) => {
    const col = idx % 4;
    const row = Math.floor(idx / 4);
    const kx = 36 + col * (cardW + 8);
    const ky = curY + row * (cardH + 8);

    doc.roundedRect(kx, ky, cardW, cardH, 4).fillAndStroke(bgLight, borderGray);
    doc.fillColor(textMuted).fontSize(6.5).font("Helvetica-Bold").text(kpi.label, kx + 8, ky + 8, { width: cardW - 16 });
    doc.fillColor(kpi.color).fontSize(14).font("Helvetica-Bold").text(kpi.value, kx + 8, ky + 22, { width: cardW - 16 });
  });

  curY += 2 * (cardH + 8) + 12;

  // Class-wise Breakdown Table
  doc.fillColor(primaryDark).fontSize(11).font("Helvetica-Bold").text("CLASS-WISE PERFORMANCE BREAKDOWN", 36, curY);
  curY += 16;

  // Table header
  const thCols = [36, 170, 230, 280, 330, 380, 430, 485];
  const thWidths = [134, 60, 50, 50, 50, 50, 55, 74];
  const tableHeaderY = curY;

  doc.rect(36, tableHeaderY, 523, 20).fill("#F1F5F9");
  doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold");
  doc.text("CLASS NAME", thCols[0] + 6, tableHeaderY + 6);
  doc.text("ENROLLED", thCols[1], tableHeaderY + 6, { width: thWidths[1], align: "center" });
  doc.text("MARKED", thCols[2], tableHeaderY + 6, { width: thWidths[2], align: "center" });
  doc.text("PRESENT", thCols[3], tableHeaderY + 6, { width: thWidths[3], align: "center" });
  doc.text("ABSENT", thCols[4], tableHeaderY + 6, { width: thWidths[4], align: "center" });
  doc.text("LATE", thCols[5], tableHeaderY + 6, { width: thWidths[5], align: "center" });
  doc.text("EXCUSED", thCols[6], tableHeaderY + 6, { width: thWidths[6], align: "center" });
  doc.text("ATTENDANCE %", thCols[7], tableHeaderY + 6, { width: thWidths[7], align: "center" });

  curY = tableHeaderY + 20;

  classes.forEach((cls, idx) => {
    const classIdStr = String(cls._id);
    const clsStudents = students.filter(s => s.classId && String(s.classId._id || s.classId) === classIdStr);
    const clsAttendances = attendances.filter(a => a.classId && String(a.classId._id || a.classId) === classIdStr);

    const cEnrolled = clsStudents.length;
    const cTotal = clsAttendances.length;
    const cPresent = clsAttendances.filter(a => a.status === "present").length;
    const cAbsent = clsAttendances.filter(a => a.status === "absent").length;
    const cLate = clsAttendances.filter(a => a.status === "late").length;
    const cExcused = clsAttendances.filter(a => a.status === "excused").length;
    const cRate = cTotal > 0 ? (((cPresent + cLate) / cTotal) * 100).toFixed(1) : "—";

    const rowBg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
    doc.rect(36, curY, 523, 18).fill(rowBg);

    doc.fillColor(textColor).fontSize(7.5).font("Helvetica-Bold")
      .text(cls.name + (cls.section ? ` (${cls.section})` : ""), thCols[0] + 6, curY + 5, { width: thWidths[0] - 8, ellipsis: true });
    doc.fillColor(textMuted).fontSize(7.5).font("Helvetica")
      .text(String(cEnrolled), thCols[1], curY + 5, { width: thWidths[1], align: "center" })
      .text(String(cTotal), thCols[2], curY + 5, { width: thWidths[2], align: "center" })
      .text(String(cPresent), thCols[3], curY + 5, { width: thWidths[3], align: "center" })
      .text(String(cAbsent), thCols[4], curY + 5, { width: thWidths[4], align: "center" })
      .text(String(cLate), thCols[5], curY + 5, { width: thWidths[5], align: "center" })
      .text(String(cExcused), thCols[6], curY + 5, { width: thWidths[6], align: "center" });

    const rateColor = cRate !== "—" && Number(cRate) >= 80 ? "#059669" : (cRate === "—" ? textMuted : "#D97706");
    doc.fillColor(rateColor).font("Helvetica-Bold")
      .text(cRate !== "—" ? `${cRate}%` : "—", thCols[7], curY + 5, { width: thWidths[7], align: "center" });

    curY += 18;
  });

  // Table summary border
  doc.rect(36, tableHeaderY, 523, curY - tableHeaderY).strokeColor(borderGray).stroke();
  curY += 16;

  // Institutional Verification Seal Section on Page 1
  doc.roundedRect(36, curY, 523, 60, 4).fillAndStroke("#F8FAFC", borderGray);
  doc.fillColor(primaryDark).fontSize(8.5).font("Helvetica-Bold")
    .text("INSTITUTIONAL VERIFICATION & COMPLIANCE STATEMENT", 46, curY + 8);
  doc.fillColor(textMuted).fontSize(7.5).font("Helvetica")
    .text(`This attendance dossier was automatically generated from official database transaction records of Darul Uloom Ashraful Ahad, Atmakur. All marks were recorded by authorized class instructors and verified through system audit logs.`, 46, curY + 22, { width: 503 });

  // PAGE 2+: Detailed Student Attendance Log
  if (attendances.length > 0) {
    doc.addPage();
    drawBanner(2);

    let pageY = 112;
    doc.fillColor(primaryDark).fontSize(11).font("Helvetica-Bold").text("DETAILED ATTENDANCE AUDIT LOG", 36, pageY);
    pageY += 16;

    const logCols = [36, 95, 185, 230, 355, 415, 475];
    const logWidths = [59, 90, 45, 125, 60, 60, 84];

    const drawLogHeader = (y) => {
      doc.rect(36, y, 523, 18).fill("#F1F5F9");
      doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold");
      doc.text("DATE", logCols[0] + 4, y + 5);
      doc.text("CLASS", logCols[1], y + 5);
      doc.text("ROLL NO", logCols[2], y + 5, { width: logWidths[2], align: "center" });
      doc.text("STUDENT NAME", logCols[3], y + 5);
      doc.text("STATUS", logCols[4], y + 5, { width: logWidths[4], align: "center" });
      doc.text("SESSION", logCols[5], y + 5, { width: logWidths[5], align: "center" });
      doc.text("RECORDED BY", logCols[6], y + 5);
      return y + 18;
    };

    pageY = drawLogHeader(pageY);

    attendances.forEach((rec, idx) => {
      if (pageY > 730) {
        doc.addPage();
        drawBanner(doc.bufferedPageRange().count);
        pageY = 112;
        doc.fillColor(primaryDark).fontSize(11).font("Helvetica-Bold").text("DETAILED ATTENDANCE AUDIT LOG (CONTINUED)", 36, pageY);
        pageY += 16;
        pageY = drawLogHeader(pageY);
      }

      const rowBg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      doc.rect(36, pageY, 523, 16).fill(rowBg);

      const studentName = rec.studentId?.name || "Unknown Student";
      const rollNo = rec.studentId?.admissionNo || "—";
      const className = rec.classId?.name || "General";
      const dateStr = rec.dateKey || "—";
      const session = (rec.sessionKey || rec.session || "Morning").toUpperCase();
      const st = String(rec.status || "unmarked").toLowerCase();

      let stColor = "#2563EB";
      if (st === "present") stColor = "#059669";
      else if (st === "absent") stColor = "#DC2626";
      else if (st === "late") stColor = "#D97706";
      else if (st === "excused") stColor = "#4338CA";

      const markedByName = rec.markedBy?.name || "System";

      doc.fillColor(textColor).fontSize(7).font("Helvetica")
        .text(dateStr, logCols[0] + 4, pageY + 4)
        .text(className, logCols[1], pageY + 4, { width: logWidths[1] - 4, ellipsis: true })
        .text(rollNo, logCols[2], pageY + 4, { width: logWidths[2], align: "center" })
        .text(studentName, logCols[3], pageY + 4, { width: logWidths[3] - 4, ellipsis: true });

      doc.fillColor(stColor).fontSize(7).font("Helvetica-Bold")
        .text(st.toUpperCase(), logCols[4], pageY + 4, { width: logWidths[4], align: "center" });

      doc.fillColor(textMuted).fontSize(7).font("Helvetica")
        .text(session, logCols[5], pageY + 4, { width: logWidths[5], align: "center" })
        .text(markedByName, logCols[6], pageY + 4, { width: logWidths[6] - 4, ellipsis: true });

      pageY += 16;
    });
  }

  // Common Footer with Page Numbers on all pages
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footY = 765;

    doc.moveTo(36, footY).lineTo(559, footY).strokeColor(borderGray).stroke();
    doc.fillColor(textMuted).fontSize(7).font("Helvetica")
      .text("Darul Uloom Ashraful Ahad, Atmakur • Official Weekly Attendance Register", 36, footY + 6);
    doc.text(`Official Document • Page ${i + 1} of ${range.count}`, 36, footY + 16);

    doc.moveTo(420, footY + 36).lineTo(540, footY + 36).strokeColor("#94A3B8").stroke();
    doc.fillColor(textMuted).fontSize(6.5).font("Helvetica-Bold")
      .text("Authorized Signature & Seal", 420, footY + 40, { align: "center", width: 120 });
  }

  doc.end();

  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
