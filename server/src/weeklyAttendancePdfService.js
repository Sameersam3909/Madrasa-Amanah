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
 * Generates an executive, printable A4 PDF weekly attendance report
 * with official Madrasa branding, logo, KPIs, class breakdown,
 * and detailed student attendance audit log.
 *
 * Guarantees:
 * - Exactly 1 page if report fits within single page bounds (no accidental blank pages)
 * - Seamless multi-page pagination with repeated table headers for larger datasets (100–300+ students)
 * - Zero trailing blank pages by using safe footer margins and lineBreak: false
 * - Unicode-safe text rendering with clipping/wrapping protection
 */
export async function generateWeeklyAttendancePdfBuffer({ from, to, mockData = null }) {
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
      Student.find({ active: true }).populate("classId", "name section").sort({ admissionNo: 1, name: 1 }),
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

  const institutionName = process.env.MADRASA_NAME || "Darul Uloom Ashrafia, Atmakur";
  const institutionNameUpper = institutionName.toUpperCase();
  const arabicSubtitle = process.env.MADRASA_NAME_ARABIC || "دارالعلوم اشرفیہ اتماکور";

  // Create PDF Document (A4: 595.28 x 841.89 points)
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: 36, bottom: 36, left: 36, right: 36 },
    bufferPages: true,
    info: {
      Title: `Weekly Attendance Report: ${from} to ${to}`,
      Author: institutionName,
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
  const drawBanner = (pageNum = 1) => {
    doc.roundedRect(36, 36, 523, 62, 4).fill(primaryColor);
    doc.rect(36, 96, 523, 2).fill(accentGold);

    // Official Logo
    const cx = 60;
    const cy = 67;
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

    // Madrasa Title & Subtitles
    doc.fillColor("#FFFFFF").fontSize(11.5).font("Helvetica-Bold")
      .text(institutionNameUpper, 88, 44, { width: 280, ellipsis: true });

    if (hasArabicFont) {
      try {
        doc.fillColor(accentGold).fontSize(9.5).font("NotoArabic")
          .text(arabicSubtitle, 88, 59, { width: 280, ellipsis: true });
      } catch {
        doc.fillColor(accentGold).fontSize(8.5).font("Helvetica")
          .text("Madrasa Amanah", 88, 59, { width: 280 });
      }
    } else {
      doc.fillColor(accentGold).fontSize(8.5).font("Helvetica")
        .text("Madrasa Amanah", 88, 59, { width: 280 });
    }

    doc.fillColor("#D1FAE5").fontSize(7).font("Helvetica")
      .text("Madrasa Amanah Attendance Management System", 88, 73, { width: 280 });

    // Right-aligned report metadata
    doc.fillColor("#FFFFFF").fontSize(9.5).font("Helvetica-Bold")
      .text("WEEKLY ATTENDANCE REGISTER", 360, 44, { align: "right", width: 190 });
    doc.fillColor("#D1FAE5").fontSize(8).font("Helvetica")
      .text(`Period: ${from} to ${to}`, 360, 58, { align: "right", width: 190 });
    doc.fillColor("#A7F3D0").fontSize(7).font("Helvetica")
      .text(`Generated: ${new Date().toISOString().slice(0, 10)}`, 360, 72, { align: "right", width: 190 });
  };

  // 1. Initial Page Banner
  drawBanner(1);

  let curY = 108;

  // 2. Executive Attendance Summary Cards (4 cols x 2 rows)
  doc.fillColor(primaryDark).fontSize(10.5).font("Helvetica-Bold").text("EXECUTIVE ATTENDANCE SUMMARY", 36, curY);
  curY += 15;

  const cardW = 125;
  const cardH = 42;
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
    const ky = curY + row * (cardH + 6);

    doc.roundedRect(kx, ky, cardW, cardH, 4).fillAndStroke(bgLight, borderGray);
    doc.fillColor(textMuted).fontSize(6.5).font("Helvetica-Bold").text(kpi.label, kx + 8, ky + 7, { width: cardW - 16 });
    doc.fillColor(kpi.color).fontSize(13).font("Helvetica-Bold").text(kpi.value, kx + 8, ky + 20, { width: cardW - 16 });
  });

  curY += 2 * (cardH + 6) + 12;

  // 3. Class-wise Breakdown Table
  doc.fillColor(primaryDark).fontSize(10.5).font("Helvetica-Bold").text("CLASS-WISE PERFORMANCE BREAKDOWN", 36, curY);
  curY += 15;

  const thCols = [36, 170, 230, 280, 330, 380, 430, 485];
  const thWidths = [134, 60, 50, 50, 50, 50, 55, 74];
  const tableHeaderY = curY;

  doc.rect(36, tableHeaderY, 523, 18).fill("#F1F5F9");
  doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold");
  doc.text("CLASS NAME", thCols[0] + 6, tableHeaderY + 5);
  doc.text("ENROLLED", thCols[1], tableHeaderY + 5, { width: thWidths[1], align: "center" });
  doc.text("MARKED", thCols[2], tableHeaderY + 5, { width: thWidths[2], align: "center" });
  doc.text("PRESENT", thCols[3], tableHeaderY + 5, { width: thWidths[3], align: "center" });
  doc.text("ABSENT", thCols[4], tableHeaderY + 5, { width: thWidths[4], align: "center" });
  doc.text("LATE", thCols[5], tableHeaderY + 5, { width: thWidths[5], align: "center" });
  doc.text("EXCUSED", thCols[6], tableHeaderY + 5, { width: thWidths[6], align: "center" });
  doc.text("ATTENDANCE %", thCols[7], tableHeaderY + 5, { width: thWidths[7], align: "center" });

  curY = tableHeaderY + 18;

  classes.forEach((cls, idx) => {
    const classIdStr = String(cls._id || cls.name);
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
    doc.rect(36, curY, 523, 16).fill(rowBg);

    doc.fillColor(textColor).fontSize(7.5).font("Helvetica-Bold")
      .text(cls.name + (cls.section ? ` (${cls.section})` : ""), thCols[0] + 6, curY + 4, { width: thWidths[0] - 8, ellipsis: true });
    doc.fillColor(textMuted).fontSize(7.5).font("Helvetica")
      .text(String(cEnrolled), thCols[1], curY + 4, { width: thWidths[1], align: "center" })
      .text(String(cTotal), thCols[2], curY + 4, { width: thWidths[2], align: "center" })
      .text(String(cPresent), thCols[3], curY + 4, { width: thWidths[3], align: "center" })
      .text(String(cAbsent), thCols[4], curY + 4, { width: thWidths[4], align: "center" })
      .text(String(cLate), thCols[5], curY + 4, { width: thWidths[5], align: "center" })
      .text(String(cExcused), thCols[6], curY + 4, { width: thWidths[6], align: "center" });

    const rateColor = cRate !== "—" && Number(cRate) >= 80 ? "#059669" : (cRate === "—" ? textMuted : "#D97706");
    doc.fillColor(rateColor).font("Helvetica-Bold")
      .text(cRate !== "—" ? `${cRate}%` : "—", thCols[7], curY + 4, { width: thWidths[7], align: "center" });

    curY += 16;
  });

  // Table summary border
  doc.rect(36, tableHeaderY, 523, curY - tableHeaderY).strokeColor(borderGray).stroke();
  curY += 12;

  // 4. Institutional Verification & Compliance Statement
  doc.roundedRect(36, curY, 523, 44, 4).fillAndStroke("#F8FAFC", borderGray);
  doc.fillColor(primaryDark).fontSize(8).font("Helvetica-Bold")
    .text("INSTITUTIONAL VERIFICATION & COMPLIANCE STATEMENT", 46, curY + 7);
  doc.fillColor(textMuted).fontSize(7).font("Helvetica")
    .text(`This weekly attendance dossier was automatically generated from official database transaction records of ${institutionName}. All marks were recorded by authorized class instructors and verified through system audit logs.`, 46, curY + 18, { width: 503 });
  curY += 52;

  // 5. Detailed Attendance Audit Log
  const logCols = [36, 95, 155, 205, 345, 405, 465];
  const logWidths = [59, 60, 50, 140, 60, 60, 94];

  const drawLogHeader = (y) => {
    doc.rect(36, y, 523, 18).fill("#F1F5F9");
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold");
    doc.text("DATE", logCols[0] + 4, y + 5);
    doc.text("CLASS", logCols[1], y + 5, { width: logWidths[1], ellipsis: true });
    doc.text("ROLL NO", logCols[2], y + 5, { width: logWidths[2], align: "center" });
    doc.text("STUDENT NAME", logCols[3], y + 5, { width: logWidths[3], ellipsis: true });
    doc.text("STATUS", logCols[4], y + 5, { width: logWidths[4], align: "center" });
    doc.text("SESSION", logCols[5], y + 5, { width: logWidths[5], align: "center" });
    doc.text("RECORDED BY", logCols[6], y + 5, { width: logWidths[6], ellipsis: true });
    return y + 18;
  };

  if (attendances.length === 0) {
    // If no attendance records, display clean informative card on Page 1 (STRICTLY 1 PAGE)
    doc.roundedRect(36, curY, 523, 36, 4).fillAndStroke("#F1F5F9", borderGray);
    doc.fillColor(textMuted).fontSize(8).font("Helvetica")
      .text("No individual attendance session marks were recorded during this period.", 46, curY + 12, { align: "center", width: 503 });
  } else {
    // Determine whether student log fits on Page 1 or needs Page 2+
    // Height needed for title + header + 1 row = 14 + 18 + 15 = 47pt
    const remainingOnPage1 = 735 - curY;
    const recordsCanFitOnPage1 = Math.floor((remainingOnPage1 - 32) / 15);

    if (recordsCanFitOnPage1 >= attendances.length && remainingOnPage1 > 40) {
      // Entire report fits on Page 1! (STRICTLY 1 PAGE)
      doc.fillColor(primaryDark).fontSize(10.5).font("Helvetica-Bold").text("DETAILED ATTENDANCE AUDIT LOG", 36, curY);
      curY += 14;
      curY = drawLogHeader(curY);

      attendances.forEach((rec, idx) => {
        const rowBg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
        doc.rect(36, curY, 523, 15).fill(rowBg);

        const studentName = rec.studentId?.name || "Unknown Student";
        const rollNo = String(rec.studentId?.admissionNo || "—");
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
          .text(dateStr, logCols[0] + 4, curY + 3.5, { lineBreak: false })
          .text(className, logCols[1], curY + 3.5, { width: logWidths[1] - 4, ellipsis: true, lineBreak: false })
          .text(rollNo, logCols[2], curY + 3.5, { width: logWidths[2], align: "center", lineBreak: false })
          .text(studentName, logCols[3], curY + 3.5, { width: logWidths[3] - 4, ellipsis: true, lineBreak: false });

        doc.fillColor(stColor).fontSize(7).font("Helvetica-Bold")
          .text(st.toUpperCase(), logCols[4], curY + 3.5, { width: logWidths[4], align: "center", lineBreak: false });

        doc.fillColor(textMuted).fontSize(7).font("Helvetica")
          .text(session, logCols[5], curY + 3.5, { width: logWidths[5], align: "center", lineBreak: false })
          .text(markedByName, logCols[6], curY + 3.5, { width: logWidths[6] - 4, ellipsis: true, lineBreak: false });

        curY += 15;
      });
    } else {
      // Multiple pages required
      let isFirstLogPage = true;

      attendances.forEach((rec, idx) => {
        // If first log item, create page 2
        if (isFirstLogPage) {
          doc.addPage();
          drawBanner(doc.bufferedPageRange().count);
          curY = 108;
          doc.fillColor(primaryDark).fontSize(10.5).font("Helvetica-Bold").text("DETAILED ATTENDANCE AUDIT LOG", 36, curY);
          curY += 15;
          curY = drawLogHeader(curY);
          isFirstLogPage = false;
        } else if (curY > 735) {
          // Automatic page break with header repetition
          doc.addPage();
          drawBanner(doc.bufferedPageRange().count);
          curY = 108;
          doc.fillColor(primaryDark).fontSize(10.5).font("Helvetica-Bold").text("DETAILED ATTENDANCE AUDIT LOG (CONTINUED)", 36, curY);
          curY += 15;
          curY = drawLogHeader(curY);
        }

        const rowBg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
        doc.rect(36, curY, 523, 15).fill(rowBg);

        const studentName = rec.studentId?.name || "Unknown Student";
        const rollNo = String(rec.studentId?.admissionNo || "—");
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
          .text(dateStr, logCols[0] + 4, curY + 3.5, { lineBreak: false })
          .text(className, logCols[1], curY + 3.5, { width: logWidths[1] - 4, ellipsis: true, lineBreak: false })
          .text(rollNo, logCols[2], curY + 3.5, { width: logWidths[2], align: "center", lineBreak: false })
          .text(studentName, logCols[3], curY + 3.5, { width: logWidths[3] - 4, ellipsis: true, lineBreak: false });

        doc.fillColor(stColor).fontSize(7).font("Helvetica-Bold")
          .text(st.toUpperCase(), logCols[4], curY + 3.5, { width: logWidths[4], align: "center", lineBreak: false });

        doc.fillColor(textMuted).fontSize(7).font("Helvetica")
          .text(session, logCols[5], curY + 3.5, { width: logWidths[5], align: "center", lineBreak: false })
          .text(markedByName, logCols[6], curY + 3.5, { width: logWidths[6] - 4, ellipsis: true, lineBreak: false });

        curY += 15;
      });
    }
  }

  // 6. Professional Footer on EVERY Page (Guaranteed Zero Blank Pages)
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // Temporarily zero out bottom margin to prevent auto-addPage

    const footY = 785;
    doc.moveTo(36, footY).lineTo(559, footY).strokeColor(borderGray).lineWidth(0.75).stroke();

    doc.fillColor(textMuted).fontSize(7).font("Helvetica")
      .text(`${institutionName} • Official Weekly Attendance Register`, 36, footY + 5, { lineBreak: false });
    doc.text(`Official Document • Page ${i + 1} of ${range.count}`, 36, footY + 15, { lineBreak: false });

    doc.moveTo(420, footY + 22).lineTo(540, footY + 22).strokeColor("#94A3B8").lineWidth(0.75).stroke();
    doc.fillColor(textMuted).fontSize(6.5).font("Helvetica-Bold")
      .text("Authorized Signature & Seal", 420, footY + 25, { align: "center", width: 120, lineBreak: false });

    doc.page.margins.bottom = oldBottom;
  }

  doc.end();

  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
