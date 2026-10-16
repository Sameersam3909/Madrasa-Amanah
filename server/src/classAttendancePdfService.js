import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
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
 * Generates an executive, professional Landscape A4 Class Attendance Register & Parent Progress Dossier
 * Designed specifically for Parent-Teacher Meetings (PTM), official institutional audits, and class records.
 *
 * Features:
 * - Official Madrasa branding (Darul Uloom Ashrafia, Atmakur) and logo
 * - Executive KPI attendance summary cards
 * - Student-by-student summary with natural roll sorting, attendance rate %, and meeting standing
 * - Chronological attendance log with clear status badges, notes, and instructor name
 * - Official seal, teacher signature, and principal sign-off block
 * - Guaranteed zero blank pages, clean pagination with repeated headers
 */
export async function generateClassAttendancePdfBuffer({
  targetClass,
  students = [],
  attendances = [],
  from,
  to,
  lang = "en"
}) {
  const institutionName = process.env.MADRASA_NAME || "Darul Uloom Ashrafia, Atmakur";
  const institutionNameUpper = institutionName.toUpperCase();
  const arabicSubtitle = process.env.MADRASA_NAME_ARABIC || "دارالعلوم اشرفیہ اتماکور";

  const sortedStudents = [...students].sort(compareRollNumbers);

  const totalEnrolled = sortedStudents.length;
  const totalRecords = attendances.length;
  const presentTotal = attendances.filter(a => a.status === "present").length;
  const absentTotal = attendances.filter(a => a.status === "absent").length;
  const lateTotal = attendances.filter(a => a.status === "late").length;
  const excusedTotal = attendances.filter(a => a.status === "excused").length;
  const attendedTotal = presentTotal + lateTotal;
  const overallPercentage = totalRecords > 0 ? ((attendedTotal / totalRecords) * 100).toFixed(1) : "0.0";

  const teacherNames = (targetClass?.teacherIds || [])
    .map(t => (typeof t === "object" ? t.name : t))
    .filter(Boolean)
    .join(", ") || "Assigned Madrasa Faculty";

  const className = targetClass?.name || "General Class";
  const classSection = targetClass?.section ? ` (${targetClass.section})` : "";
  const fullClassTitle = `${className}${classSection}`;

  // Landscape A4: 841.89 pt width x 595.28 pt height
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 32, bottom: 32, left: 32, right: 32 },
    bufferPages: true,
    info: {
      Title: `${fullClassTitle} Attendance Register - ${from} to ${to}`,
      Author: institutionName,
      Subject: "Class Attendance Register & Parent Progress Dossier"
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

  // Helper to draw Header Banner on Landscape Page (W: 778 pt)
  const drawBanner = (pageNum = 1) => {
    doc.roundedRect(32, 32, 778, 62, 4).fill(primaryColor);
    doc.rect(32, 92, 778, 2).fill(accentGold);

    // Official Logo
    const cx = 60;
    const cy = 63;
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

    // Left Title Block
    doc.fillColor("#FFFFFF").fontSize(13).font("Helvetica-Bold")
      .text(institutionNameUpper, 92, 41, { width: 400, ellipsis: true });

    if (hasArabicFont) {
      try {
        doc.fillColor(accentGold).fontSize(10).font("NotoArabic")
          .text(arabicSubtitle, 92, 57, { width: 400, ellipsis: true });
      } catch {
        doc.fillColor(accentGold).fontSize(9).font("Helvetica")
          .text("Madrasa Amanah", 92, 57, { width: 400 });
      }
    } else {
      doc.fillColor(accentGold).fontSize(9).font("Helvetica")
        .text("Madrasa Amanah", 92, 57, { width: 400 });
    }

    doc.fillColor("#D1FAE5").fontSize(7.5).font("Helvetica")
      .text(`Official Attendance Register & Parent Progress Report • Academic Session ${targetClass?.academicYear || "2026-2027"}`, 92, 72, { width: 420 });

    // Right Details Block
    doc.fillColor("#FFFFFF").fontSize(11).font("Helvetica-Bold")
      .text(`CLASS: ${fullClassTitle.toUpperCase()}`, 490, 41, { align: "right", width: 310, ellipsis: true });
    doc.fillColor("#D1FAE5").fontSize(8.5).font("Helvetica")
      .text(`Reporting Period: ${from} to ${to}`, 490, 56, { align: "right", width: 310 });
    doc.fillColor("#A7F3D0").fontSize(7.5).font("Helvetica")
      .text(`Ustadh: ${teacherNames} • Generated: ${new Date().toISOString().slice(0, 10)}`, 490, 71, { align: "right", width: 310, ellipsis: true });
  };

  // Helper to draw Executive Summary KPI Cards (Landscape: 6 cards across 778 pt)
  const drawSummaryCards = (startY) => {
    const cardW = 123;
    const cardH = 40;
    const gap = 8;
    const kpis = [
      { label: "ENROLLED STUDENTS", value: String(totalEnrolled), color: textColor },
      { label: "CLASS ATTENDANCE", value: `${overallPercentage}%`, color: Number(overallPercentage) >= 80 ? "#059669" : "#D97706" },
      { label: "PRESENT SESSIONS", value: String(presentTotal), color: "#059669" },
      { label: "ABSENT SESSIONS", value: String(absentTotal), color: "#DC2626" },
      { label: "LATE ARRIVALS", value: String(lateTotal), color: "#D97706" },
      { label: "EXCUSED (LEAVE)", value: String(excusedTotal), color: "#2563EB" }
    ];

    kpis.forEach((kpi, idx) => {
      const kx = 32 + idx * (cardW + gap);
      doc.roundedRect(kx, startY, cardW, cardH, 4).fillAndStroke(bgLight, borderGray);
      doc.fillColor(textMuted).fontSize(6.5).font("Helvetica-Bold").text(kpi.label, kx + 8, startY + 6, { width: cardW - 16 });
      doc.fillColor(kpi.color).fontSize(13).font("Helvetica-Bold").text(kpi.value, kx + 8, startY + 19, { width: cardW - 16 });
    });

    return startY + cardH + 12;
  };

  // =========================================================================
  // PAGE 1: Banner + KPI Summary + Student-by-Student Performance Evaluation
  // =========================================================================
  drawBanner(1);
  let curY = 104;

  curY = drawSummaryCards(curY);

  // SECTION A: Student Progress Table Header (For Parent-Teacher Meeting)
  doc.fillColor(primaryDark).fontSize(10).font("Helvetica-Bold")
    .text("STUDENT ATTENDANCE & CONDUCT SUMMARY (FOR PARENT-TEACHER REVIEW)", 32, curY);
  curY += 14;

  const stuCols = [32, 85, 260, 395, 445, 495, 545, 595, 655];
  const stuWidths = [53, 175, 135, 50, 50, 50, 50, 60, 155];

  const drawStudentTableHeader = (y) => {
    doc.rect(32, y, 778, 18).fill("#F1F5F9");
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold");
    doc.text("ROLL NO", stuCols[0] + 4, y + 5);
    doc.text("STUDENT NAME", stuCols[1], y + 5);
    doc.text("GUARDIAN / PARENT", stuCols[2], y + 5);
    doc.text("PRESENT", stuCols[3], y + 5, { width: stuWidths[3], align: "center" });
    doc.text("ABSENT", stuCols[4], y + 5, { width: stuWidths[4], align: "center" });
    doc.text("LATE", stuCols[5], y + 5, { width: stuWidths[5], align: "center" });
    doc.text("EXCUSED", stuCols[6], y + 5, { width: stuWidths[6], align: "center" });
    doc.text("RATE %", stuCols[7], y + 5, { width: stuWidths[7], align: "center" });
    doc.text("MEETING STANDING / REMARKS", stuCols[8] + 4, y + 5);
    return y + 18;
  };

  curY = drawStudentTableHeader(curY);

  if (sortedStudents.length === 0) {
    doc.rect(32, curY, 778, 20).fill("#FFFFFF");
    doc.fillColor(textMuted).fontSize(7.5).font("Helvetica")
      .text("No students registered in this class.", 32, curY + 6, { align: "center", width: 778 });
    curY += 20;
  } else {
    sortedStudents.forEach((st, idx) => {
      // Check if page overflow
      if (curY > 510) {
        doc.addPage();
        drawBanner(doc.bufferedPageRange().count);
        curY = 104;
        doc.fillColor(primaryDark).fontSize(10).font("Helvetica-Bold")
          .text("STUDENT ATTENDANCE & CONDUCT SUMMARY (CONTINUED)", 32, curY);
        curY += 14;
        curY = drawStudentTableHeader(curY);
      }

      const stIdStr = String(st._id);
      const stAttendances = attendances.filter(a => String(a.studentId?._id || a.studentId) === stIdStr);
      const sPresent = stAttendances.filter(a => a.status === "present").length;
      const sAbsent = stAttendances.filter(a => a.status === "absent").length;
      const sLate = stAttendances.filter(a => a.status === "late").length;
      const sExcused = stAttendances.filter(a => a.status === "excused").length;
      const sTotal = stAttendances.length;
      const sAttended = sPresent + sLate;
      const sRateNum = sTotal > 0 ? ((sAttended / sTotal) * 100) : 0;
      const sRate = sTotal > 0 ? sRateNum.toFixed(1) + "%" : "—";

      let standing = "No Sessions Logged";
      let standingColor = textMuted;
      if (sTotal > 0) {
        if (sRateNum >= 90) {
          standing = "Excellent Regularity ★";
          standingColor = "#059669";
        } else if (sRateNum >= 75) {
          standing = "Satisfactory Attendance";
          standingColor = "#174B36";
        } else if (sRateNum >= 60) {
          standing = "Needs Improvement (Warning)";
          standingColor = "#D97706";
        } else {
          standing = "Critical - Parent Review Needed";
          standingColor = "#DC2626";
        }
      }

      const rollNo = String(st.admissionNo || "—");
      let displayName = st.name || "Unknown Student";
      if (lang === "ur" && st.nameUr) displayName = st.nameUr;
      else if (lang === "te" && st.nameTe) displayName = st.nameTe;
      else if (st.nameEn) displayName = st.nameEn;

      const guardian = st.guardianName || (st.guardianPhone ? `Ph: ${st.guardianPhone}` : "Not Listed");

      const rowBg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      doc.rect(32, curY, 778, 16).fill(rowBg);

      doc.fillColor(textColor).fontSize(7).font("Helvetica")
        .text(rollNo, stuCols[0] + 4, curY + 4, { width: stuWidths[0] - 6, ellipsis: true, lineBreak: false })
        .text(displayName, stuCols[1], curY + 4, { width: stuWidths[1] - 6, ellipsis: true, lineBreak: false })
        .text(guardian, stuCols[2], curY + 4, { width: stuWidths[2] - 6, ellipsis: true, lineBreak: false });

      doc.fillColor("#059669").fontSize(7).font("Helvetica-Bold")
        .text(String(sPresent), stuCols[3], curY + 4, { width: stuWidths[3], align: "center", lineBreak: false });

      doc.fillColor(sAbsent > 0 ? "#DC2626" : textMuted).fontSize(7).font("Helvetica-Bold")
        .text(String(sAbsent), stuCols[4], curY + 4, { width: stuWidths[4], align: "center", lineBreak: false });

      doc.fillColor(sLate > 0 ? "#D97706" : textMuted).fontSize(7).font("Helvetica-Bold")
        .text(String(sLate), stuCols[5], curY + 4, { width: stuWidths[5], align: "center", lineBreak: false });

      doc.fillColor(sExcused > 0 ? "#2563EB" : textMuted).fontSize(7).font("Helvetica-Bold")
        .text(String(sExcused), stuCols[6], curY + 4, { width: stuWidths[6], align: "center", lineBreak: false });

      const rateColor = sRate !== "—" && sRateNum >= 80 ? "#059669" : (sRate === "—" ? textMuted : "#D97706");
      doc.fillColor(rateColor).fontSize(7).font("Helvetica-Bold")
        .text(sRate, stuCols[7], curY + 4, { width: stuWidths[7], align: "center", lineBreak: false });

      doc.fillColor(standingColor).fontSize(7).font("Helvetica-Bold")
        .text(standing, stuCols[8] + 4, curY + 4, { width: stuWidths[8] - 8, ellipsis: true, lineBreak: false });

      curY += 16;
    });
  }

  curY += 14;

  // =========================================================================
  // SECTION B: Detailed Chronological Attendance Audit Transactions Log
  // =========================================================================
  if (attendances.length > 0) {
    // If not enough room for at least 3 rows on current page, start new page
    if (curY > 440) {
      doc.addPage();
      drawBanner(doc.bufferedPageRange().count);
      curY = 104;
    }

    doc.fillColor(primaryDark).fontSize(10).font("Helvetica-Bold")
      .text("CHRONOLOGICAL SESSION ATTENDANCE AUDIT LOG", 32, curY);
    curY += 14;

    const logCols = [32, 100, 160, 220, 400, 520, 590, 700];
    const logWidths = [68, 60, 60, 180, 120, 70, 110, 110];

    const drawAuditHeader = (y) => {
      doc.rect(32, y, 778, 18).fill("#F1F5F9");
      doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold");
      doc.text("DATE", logCols[0] + 4, y + 5);
      doc.text("SESSION", logCols[1], y + 5);
      doc.text("ROLL NO", logCols[2], y + 5);
      doc.text("STUDENT NAME", logCols[3], y + 5);
      doc.text("GUARDIAN / PHONE", logCols[4], y + 5);
      doc.text("STATUS", logCols[5], y + 5, { width: logWidths[5], align: "center" });
      doc.text("NOTE / REASON", logCols[6], y + 5);
      doc.text("RECORDED BY", logCols[7], y + 5);
      return y + 18;
    };

    curY = drawAuditHeader(curY);

    attendances.forEach((rec, idx) => {
      if (curY > 510) {
        doc.addPage();
        drawBanner(doc.bufferedPageRange().count);
        curY = 104;
        doc.fillColor(primaryDark).fontSize(10).font("Helvetica-Bold")
          .text("CHRONOLOGICAL SESSION ATTENDANCE AUDIT LOG (CONTINUED)", 32, curY);
        curY += 14;
        curY = drawAuditHeader(curY);
      }

      const student = rec.studentId;
      const studentName = student?.name || "Unknown Student";
      const rollNo = String(student?.admissionNo || "—");
      const guardian = student?.guardianPhone || student?.guardianName || "—";
      const dateStr = rec.dateKey || "—";
      const session = (rec.sessionKey || rec.session || "Morning").toUpperCase();
      const st = String(rec.status || "unmarked").toLowerCase();

      let stColor = "#2563EB";
      if (st === "present") stColor = "#059669";
      else if (st === "absent") stColor = "#DC2626";
      else if (st === "late") stColor = "#D97706";
      else if (st === "excused") stColor = "#4338CA";

      const noteStr = rec.note || (st === "present" ? "On time" : "—");
      const markedByName = rec.markedBy?.name || rec.markedBy?.email || "Class Instructor";

      const rowBg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      doc.rect(32, curY, 778, 15).fill(rowBg);

      doc.fillColor(textColor).fontSize(7).font("Helvetica")
        .text(dateStr, logCols[0] + 4, curY + 3.5, { lineBreak: false })
        .text(session, logCols[1], curY + 3.5, { width: logWidths[1] - 4, ellipsis: true, lineBreak: false })
        .text(rollNo, logCols[2], curY + 3.5, { width: logWidths[2] - 4, ellipsis: true, lineBreak: false })
        .text(studentName, logCols[3], curY + 3.5, { width: logWidths[3] - 4, ellipsis: true, lineBreak: false })
        .text(guardian, logCols[4], curY + 3.5, { width: logWidths[4] - 4, ellipsis: true, lineBreak: false });

      doc.fillColor(stColor).fontSize(7).font("Helvetica-Bold")
        .text(st.toUpperCase(), logCols[5], curY + 3.5, { width: logWidths[5], align: "center", lineBreak: false });

      doc.fillColor(textMuted).fontSize(7).font("Helvetica")
        .text(noteStr, logCols[6], curY + 3.5, { width: logWidths[6] - 4, ellipsis: true, lineBreak: false })
        .text(markedByName, logCols[7], curY + 3.5, { width: logWidths[7] - 4, ellipsis: true, lineBreak: false });

      curY += 15;
    });
  }

  // =========================================================================
  // SECTION C: Institutional Sign-Off Block & Official Endorsement
  // =========================================================================
  if (curY > 480) {
    doc.addPage();
    drawBanner(doc.bufferedPageRange().count);
    curY = 104;
  }

  curY += 10;
  doc.roundedRect(32, curY, 778, 48, 4).fillAndStroke("#F8FAFC", borderGray);

  // Left Note
  doc.fillColor(primaryDark).fontSize(7.5).font("Helvetica-Bold")
    .text("PARENT MEETING ENDORSEMENT & INSTITUTIONAL VERIFICATION", 44, curY + 8);
  doc.fillColor(textMuted).fontSize(7).font("Helvetica")
    .text(`This document serves as the official attendance record of ${institutionName} presented for parent review. Parents are requested to sign and acknowledge their child's regularity and consult with the class Ustadh regarding any unexcused absences.`, 44, curY + 20, { width: 440 });

  // Right Signatures
  doc.moveTo(510, curY + 32).lineTo(620, curY + 32).strokeColor("#94A3B8").lineWidth(0.75).stroke();
  doc.fillColor(textMuted).fontSize(6.5).font("Helvetica-Bold")
    .text("Class Ustadh Signature", 510, curY + 35, { align: "center", width: 110, lineBreak: false });

  doc.moveTo(650, curY + 32).lineTo(780, curY + 32).strokeColor("#94A3B8").lineWidth(0.75).stroke();
  doc.fillColor(textMuted).fontSize(6.5).font("Helvetica-Bold")
    .text("Principal / Madrasa Seal", 650, curY + 35, { align: "center", width: 130, lineBreak: false });

  // =========================================================================
  // FOOTER ON EVERY PAGE (Guaranteed Zero Blank Pages)
  // =========================================================================
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // Prevent auto-addPage

    const footY = 560; // Landscape A4 height is 595.28 pt
    doc.moveTo(32, footY).lineTo(810, footY).strokeColor(borderGray).lineWidth(0.75).stroke();

    doc.fillColor(textMuted).fontSize(7).font("Helvetica")
      .text(`${institutionName} • ${fullClassTitle} Attendance Dossier • Reporting Period: ${from} to ${to}`, 32, footY + 5, { lineBreak: false });
    doc.text(`Official Document • Page ${i + 1} of ${range.count}`, 32, footY + 15, { lineBreak: false });

    doc.fillColor(textMuted).fontSize(6.5).font("Helvetica")
      .text("Confidential School Register • Madrasa Amanah Smart Attendance System", 520, footY + 5, { align: "right", width: 290, lineBreak: false });

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
