import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

// Patch TextDecoder for fontkit compatibility in Node 23+ where decode() on ascii returns a Buffer
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
const TELUGU_FONT_PATH = path.join(FONTS_DIR, "NotoSansTelugu-Regular.ttf");

const hasArabicFont = fs.existsSync(ARABIC_FONT_PATH);
const hasTeluguFont = fs.existsSync(TELUGU_FONT_PATH);

// Unicode regex tests
const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const TELUGU_REGEX = /[\u0C00-\u0C7F]/;

export function containsArabic(str) {
  return ARABIC_REGEX.test(String(str || ""));
}

export function containsTelugu(str) {
  return TELUGU_REGEX.test(String(str || ""));
}

/**
 * Normalizes accidental Urdu keyboard characters (like Urdu full-stop \u06D4)
 * that occur in English/Latin names into standard dots.
 */
export function normalizeStudentName(str) {
  if (!str) return "";
  let val = String(str).trim();
  if (/[a-zA-Z]/.test(val) && val.includes("\u06D4")) {
    val = val
      .replace(/([a-zA-Z])\u06D4\s*/g, "$1. ")
      .replace(/\s*\u06D4\s*([a-zA-Z])/g, ". $1")
      .replace(/\u06D4/g, ".")
      .replace(/\s+/g, " ")
      .trim();
  }
  return val;
}

/**
 * Calculate age in full years from date string
 */
export function calculateAge(dobStr) {
  if (!dobStr) return null;
  const birth = new Date(dobStr);
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return age >= 0 && age < 120 ? age : null;
}

/**
 * Safely fetches a student photograph as a Buffer
 * Supports HTTP/HTTPS URLs (including Cloudinary) and Base64 Data URIs
 */
export async function fetchStudentPhotoBuffer(photoUrl) {
  if (!photoUrl || typeof photoUrl !== "string") return null;
  const trimmed = photoUrl.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith("data:")) {
      const parts = trimmed.split(",");
      if (parts.length > 1) {
        return Buffer.from(parts[1], "base64");
      }
      return null;
    }

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      let fetchUrl = trimmed;
      if (fetchUrl.includes("res.cloudinary.com") && !fetchUrl.endsWith(".jpg") && !fetchUrl.endsWith(".png")) {
        fetchUrl = fetchUrl.replace(/\/image\/upload\//, "/image/upload/f_jpg/");
      }

      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(7000) });
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
    }
  } catch (err) {
    console.warn("Could not load student photo for PDF export:", err.message);
  }
  return null;
}

/**
 * Generates the official Madrasa Amanah Student Profile PDF
 * 
 * @param {Object} options
 * @param {Object} options.student - Student document (populated with classId and teacherIds)
 * @param {Array} options.attendance - Array of attendance records
 * @param {NodeJS.WritableStream} options.outputStream - Stream to pipe PDF into
 * @returns {Promise<PDFKit.PDFDocument>}
 */
export async function generateStudentProfilePdf({ student, attendance = [], outputStream }) {
  const doc = new PDFDocument({
    margin: 36,
    size: "A4",
    bufferPages: true,
    info: {
      Title: `Madrasa Amanah - Student Profile - ${student.admissionNo || ""}-${student.name || ""}`,
      Author: "Madrasa Amanah Smart Attendance System",
      Subject: "Official Student Academic & Attendance Dossier",
      Keywords: "Madrasa Amanah, Attendance, Student Profile, Report"
    }
  });

  if (outputStream) {
    doc.pipe(outputStream);
  }

  // Register multi-language TrueType fonts if available
  if (hasArabicFont) {
    try {
      doc.registerFont("NotoArabic", ARABIC_FONT_PATH);
    } catch (e) {
      console.warn("Failed to register NotoArabic font:", e.message);
    }
  }
  if (hasTeluguFont) {
    try {
      doc.registerFont("NotoTelugu", TELUGU_FONT_PATH);
    } catch (e) {
      console.warn("Failed to register NotoTelugu font:", e.message);
    }
  }

  // Color Palette - Emerald Green & Gold Luxury Madrasa Amanah Theme
  const primaryColor = "#174B36";
  const primaryLight = "#1F5F45";
  const primaryDark = "#0E3022";
  const accentGold = "#D4A759";
  const textColor = "#1F2937";
  const textMuted = "#6B7280";
  const borderGray = "#E2E8F0";
  const lightBg = "#F8FAFC";
  const cardBorder = "#CBD5E1";

  // Preload photo (checks photoUrl or referencePhotoUrl)
  const candidatePhoto = student.photoUrl || student.referencePhotoUrl || student.photoDataUrl || "";
  const imageBuffer = await fetchStudentPhotoBuffer(candidatePhoto);

  // Helper for drawing localized text
  const drawLocalizedText = (text, x, y, options = {}) => {
    const str = String(text || "");
    const size = options.fontSize || 9;
    const color = options.color || textColor;

    doc.fillColor(color).fontSize(size);

    if (containsArabic(str) && hasArabicFont) {
      doc.font("NotoArabic");
    } else if (containsTelugu(str) && hasTeluguFont) {
      doc.font("NotoTelugu");
    } else if (options.bold) {
      doc.font("Helvetica-Bold");
    } else if (options.oblique) {
      doc.font("Helvetica-Oblique");
    } else {
      doc.font("Helvetica");
    }

    const textOpts = { ...options };
    delete textOpts.fontSize;
    delete textOpts.color;
    delete textOpts.bold;
    delete textOpts.oblique;

    doc.text(str, x, y, textOpts);
  };

  // Helper for drawing field key-value pairs
  const drawField = (label, value, x, y, labelW = 80, valW = 160) => {
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text(label.toUpperCase(), x, y);
    const valY = y + 9.5;
    const displayVal = value !== undefined && value !== null && String(value).trim() !== "" ? String(value) : "—";
    drawLocalizedText(displayVal, x, valY, { fontSize: 8.5, color: textColor, width: valW, ellipsis: true });
  };

  // =========================================================================
  // TOP HEADER BANNER
  // =========================================================================
  const drawHeaderBanner = () => {
    // Top Banner Background
    doc.roundedRect(36, 36, 523, 62, 5).fill(primaryColor);

    // Decorative Gold Accent Stripe at bottom of banner
    doc.rect(36, 95, 523, 3).fill(accentGold);

    // Official Madrasa Logo
    const cx = 56;
    const cy = 66;
    const logoPath = path.join(__dirname, "assets", "logo.png");
    let logoDrawn = false;
    if (fs.existsSync(logoPath)) {
      try {
        doc.save();
        doc.circle(cx, cy, 20).fill("#FFFFFF");
        doc.image(logoPath, cx - 18, cy - 18, { width: 36, height: 36 });
        doc.restore();
        logoDrawn = true;
      } catch (err) {
        console.warn("Failed to render logo image in student PDF:", err.message);
      }
    }

    if (!logoDrawn) {
      doc.save();
      doc.circle(cx, cy, 18).fillAndStroke(primaryDark, accentGold);
      doc.strokeColor("#FFFFFF").lineWidth(1.5);
      doc.moveTo(cx - 10, cy + 5).quadraticCurveTo(cx - 5, cy, cx, cy + 4).stroke();
      doc.moveTo(cx + 10, cy + 5).quadraticCurveTo(cx + 5, cy, cx, cy + 4).stroke();
      doc.restore();
    }

    // Madrasa Title & Arabic Subtitle
    doc.fillColor("#FFFFFF").fontSize(12).font("Helvetica-Bold").text("DARUL ULOOM ASHRAFIA, ATMAKUR", 82, 44, { width: 260 });
    if (hasArabicFont) {
      doc.fillColor(accentGold).fontSize(10.5).font("NotoArabic").text("دارالعلوم اشرفیہ اتماکور", 82, 59, { width: 260 });
    }
    doc.fillColor("#D1FAE5").fontSize(7.5).font("Helvetica").text("Madrasa Amanah Attendance Management System", 82, 73);

    // Right side dossier metadata
    doc.fillColor("#FFFFFF").fontSize(9.5).font("Helvetica-Bold").text("OFFICIAL STUDENT DOSSIER", 340, 44, { align: "right", width: 205 });
    const formattedDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const formattedTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    doc.fillColor("#D1FAE5").fontSize(7.5).font("Helvetica").text(`Generated: ${formattedDate} ${formattedTime}`, 340, 60, { align: "right", width: 205 });
    doc.fillColor("#A7F3D0").fontSize(7).font("Helvetica").text(`Location: Atmakur`, 340, 72, { align: "right", width: 205 });
  };

  drawHeaderBanner();

  // =========================================================================
  // SECTION A: STUDENT PROFILE & PHOTOGRAPH
  // =========================================================================
  const profileY = 106;
  const profileH = 142;
  doc.roundedRect(36, profileY, 523, profileH, 5).fillAndStroke(lightBg, borderGray);

  // Photo Frame
  const photoX = 48;
  const photoY = profileY + 12;
  const photoW = 90;
  const photoH = 118;

  // Frame Outer Background & Shadow border
  doc.roundedRect(photoX, photoY, photoW, photoH, 4).fillAndStroke("#FFFFFF", cardBorder);

  let photoRendered = false;
  if (imageBuffer) {
    try {
      doc.save();
      // Clip to rounded rect
      doc.roundedRect(photoX + 2, photoY + 2, photoW - 4, photoH - 4, 3).clip();
      doc.image(imageBuffer, photoX + 2, photoY + 2, {
        fit: [photoW - 4, photoH - 4],
        align: "center",
        valign: "center"
      });
      doc.restore();
      photoRendered = true;
    } catch (e) {
      console.warn("PDFKit failed to render student image buffer, using placeholder:", e.message);
      photoRendered = false;
    }
  }

  // Graceful Professional Vector Photo Placeholder if image is missing or invalid
  if (!photoRendered) {
    doc.roundedRect(photoX + 2, photoY + 2, photoW - 4, photoH - 4, 3).fill("#F1F5F9");

    // Stylized user avatar silhouette
    const avX = photoX + photoW / 2;
    const avY = photoY + 46;
    doc.save();
    doc.fillColor("#CBD5E1");
    // Head circle
    doc.circle(avX, avY, 17).fill();
    // Shoulders arc
    doc.path(`M ${avX - 28} ${avY + 40} C ${avX - 28} ${avY + 22}, ${avX + 28} ${avY + 22}, ${avX + 28} ${avY + 40} Z`).fill();
    doc.restore();

    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text("STUDENT PHOTO", photoX, photoY + 92, { align: "center", width: photoW });
    doc.fillColor("#94A3B8").fontSize(6.5).font("Helvetica").text(imageBuffer ? "Format Unsupported" : "No Photo on Record", photoX, photoY + 103, { align: "center", width: photoW });
  }

  // Student Identity Info (Right of Photo)
  const infoX = 150;
  let curY = profileY + 12;

  // Student Primary Display Name
  const canonicalName = normalizeStudentName(student.name || "Student");
  const nameEn = normalizeStudentName(student.nameEn || "");
  const nameUr = (student.nameUr || "").trim();
  const nameTe = (student.nameTe || "").trim();

  // Primary English / Canonical Name
  drawLocalizedText(nameEn || canonicalName, infoX, curY, { fontSize: 15, bold: true, color: textColor, width: 330 });
  curY += 19;

  // Multilingual Secondary Names (Urdu & Telugu) if present
  const altNames = [];
  if (nameUr && nameUr !== canonicalName) altNames.push({ text: nameUr, lang: "ur" });
  if (nameTe && nameTe !== canonicalName) altNames.push({ text: nameTe, lang: "te" });

  if (altNames.length > 0) {
    let altX = infoX;
    altNames.forEach((item) => {
      if (item.lang === "ur" && hasArabicFont) {
        doc.fillColor(primaryColor).fontSize(10.5).font("NotoArabic").text(item.text, altX, curY - 2);
        altX += doc.widthOfString(item.text) + 14;
      } else if (item.lang === "te" && hasTeluguFont) {
        doc.fillColor(primaryColor).fontSize(9.5).font("NotoTelugu").text(item.text, altX, curY);
        altX += doc.widthOfString(item.text) + 14;
      }
    });
    curY += 16;
  }

  // Identity Badges (Admission No, Active Status, Class)
  const badgeY = curY;
  // Admission badge
  const admText = `ROLL / ADM #${student.admissionNo || "—"}`;
  doc.roundedRect(infoX, badgeY, 110, 16, 3).fill("#E0E7FF");
  doc.fillColor("#3730A3").fontSize(8).font("Helvetica-Bold").text(admText, infoX + 6, badgeY + 4);

  // Status badge
  const isActive = student.active !== false;
  const statusBg = isActive ? "#D1FAE5" : "#FEE2E2";
  const statusColor = isActive ? "#065F46" : "#991B1B";
  const statusLabel = isActive ? "ACTIVE ENROLLMENT" : "ARCHIVED / INACTIVE";
  doc.roundedRect(infoX + 116, badgeY, 115, 16, 3).fill(statusBg);
  doc.fillColor(statusColor).fontSize(8).font("Helvetica-Bold").text(statusLabel, infoX + 122, badgeY + 4);

  // Class Badge
  const classDisplayName = `${student.classId?.name || "Unassigned"}${student.classId?.section ? ` - ${student.classId.section}` : ""}`;
  doc.roundedRect(infoX + 237, badgeY, 162, 16, 3).fill("#FEF3C7");
  doc.fillColor("#92400E").fontSize(8).font("Helvetica-Bold").text(classDisplayName.toUpperCase(), infoX + 243, badgeY + 4, { width: 152, ellipsis: true });

  curY += 23;

  // Multi-column Profile Details Grid
  const pCol1 = infoX;
  const pCol2 = infoX + 130;
  const pCol3 = infoX + 260;

  drawField("Assigned Class", classDisplayName, pCol1, curY, 70, 120);
  drawField("Academic Year", student.classId?.academicYear || "2026-2027", pCol2, curY, 70, 120);
  const formattedEnroll = student.enrollmentDate ? String(student.enrollmentDate).slice(0, 10) : "Not Recorded";
  drawField("Enrollment Date", formattedEnroll, pCol3, curY, 70, 130);
  curY += 25;

  drawField("Gender", student.gender || "Not Specified", pCol1, curY, 70, 120);
  const formattedDob = student.dob ? String(student.dob).slice(0, 10) : "Not Recorded";
  const age = calculateAge(student.dob);
  const dobDisplay = age !== null ? `${formattedDob} (${age} yrs)` : formattedDob;
  drawField("Date of Birth", dobDisplay, pCol2, curY, 70, 120);

  // Teachers assigned
  let teacherDisplay = "Madrasa Staff";
  if (Array.isArray(student.classId?.teacherIds) && student.classId.teacherIds.length > 0) {
    teacherDisplay = student.classId.teacherIds.map(t => t.name || t).filter(Boolean).join(", ") || "Madrasa Staff";
  }
  drawField("Assigned Teacher", teacherDisplay, pCol3, curY, 70, 130);
  curY += 25;

  drawField("Photo Consent", student.consentGiven ? "Recorded (Granted ✓)" : "Pending / Not Given", pCol1, curY, 70, 120);
  const hasBiometrics = Boolean(student.faceDescriptor && student.faceDescriptor.length > 0);
  drawField("AI Biometrics", hasBiometrics ? "Enrolled (Face Model ✓)" : "Standard Registry", pCol2, curY, 70, 120);
  drawField("Assigned Madrasa", "Madrasa Amanah (Atmakur)", pCol3, curY, 70, 130);

  // =========================================================================
  // SECTION B: PERSONAL & GUARDIAN DETAILS
  // =========================================================================
  const guardY = profileY + profileH + 9;
  const guardH = 68;
  doc.roundedRect(36, guardY, 523, guardH, 5).fillAndStroke(lightBg, borderGray);

  // Card Header
  doc.fillColor(primaryColor).fontSize(8.5).font("Helvetica-Bold").text("PERSONAL & GUARDIAN CONTACT INFORMATION", 48, guardY + 9);
  doc.moveTo(48, guardY + 20).lineTo(547, guardY + 20).strokeColor(borderGray).stroke();

  const gY = guardY + 26;
  drawField("Father / Guardian", student.guardianName || "Not Recorded on file", 48, gY, 95, 145);
  drawField("Authorized Contact", student.guardianPhone || "Not Recorded on file", 215, gY, 90, 130);
  drawField("Student Database ID", String(student._id || "—"), 365, gY, 90, 180);

  drawField("Residential Address", student.address || "Not Recorded on file", 48, gY + 22, 95, 495);

  // =========================================================================
  // SECTION C: ATTENDANCE SUMMARY & KPIS
  // =========================================================================
  const statsSectionY = guardY + guardH + 11;
  doc.fillColor(primaryColor).fontSize(9).font("Helvetica-Bold").text("ATTENDANCE PERFORMANCE METRICS & STANDING", 36, statsSectionY);

  // Sorting attendance: chronologically (oldest to newest)
  const sortedAttendance = [...attendance].sort((a, b) => {
    const da = String(a.dateKey || "");
    const db = String(b.dateKey || "");
    return da.localeCompare(db);
  });

  const total = sortedAttendance.length;
  const present = sortedAttendance.filter(a => a.status === "present").length;
  const absent = sortedAttendance.filter(a => a.status === "absent").length;
  const late = sortedAttendance.filter(a => a.status === "late").length;
  const excused = sortedAttendance.filter(a => a.status === "excused").length;

  // Attendance rate standard formula: ((Present + 0.75 * Late) / Total) * 100
  const rate = total > 0 ? Math.round(((present + (late * 0.75)) / total) * 100) : 0;
  const purePresentRate = total > 0 ? Math.round((present / total) * 100) : 0;

  // Academic Standing Badge
  let standingLabel = "N/A (No Sessions)";
  let standingColor = textMuted;
  if (total > 0) {
    if (rate >= 90) {
      standingLabel = "Excellent (ممتاز) ★";
      standingColor = "#059669";
    } else if (rate >= 75) {
      standingLabel = "Good / Satisfactory (جید) ✓";
      standingColor = "#0D9488";
    } else {
      standingLabel = "Attendance Alert / Low (ضعیف) ⚠";
      standingColor = "#DC2626";
    }
  }

  // Reporting Period
  let reportingPeriod = "No attendance sessions logged";
  if (sortedAttendance.length > 0) {
    const firstDate = sortedAttendance[0].dateKey || "—";
    const lastDate = sortedAttendance[sortedAttendance.length - 1].dateKey || "—";
    reportingPeriod = firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`;
  }

  doc.fillColor(textMuted).fontSize(7.5).font("Helvetica")
    .text(`Reporting Period: ${reportingPeriod}  •  Attendance Standing: `, 36, statsSectionY + 11);
  const standX = 36 + doc.widthOfString(`Reporting Period: ${reportingPeriod}  •  Attendance Standing: `);
  drawLocalizedText(standingLabel, standX, statsSectionY + 11, { fontSize: 7.5, bold: true, color: standingColor });

  // 5 KPI Cards
  const kpiY = statsSectionY + 23;
  const kpiW = 98;
  const kpiH = 46;
  const kpiGap = 8;

  const drawKpiCard = (label, value, x, valColor = textColor, bg = lightBg, subtext = "") => {
    doc.roundedRect(x, kpiY, kpiW, kpiH, 4).fillAndStroke(bg, borderGray);
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text(label.toUpperCase(), x + 7, kpiY + 7);
    doc.fillColor(valColor).fontSize(14).font("Helvetica-Bold").text(String(value), x + 7, kpiY + 19);
    if (subtext) {
      doc.fillColor(textMuted).fontSize(6.5).font("Helvetica").text(subtext, x + 7, kpiY + 34);
    }
  };

  drawKpiCard("Total Sessions", total, 36, textColor, lightBg, `${total} records`);
  drawKpiCard("Present", present, 36 + kpiW + kpiGap, "#059669", "#ECFDF5", `${purePresentRate}% pure on-time`);
  drawKpiCard("Absent", absent, 36 + (kpiW + kpiGap) * 2, "#DC2626", "#FEF2F2", `${absent} unexcused`);
  drawKpiCard("Late / Tardy", late, 36 + (kpiW + kpiGap) * 3, "#D97706", "#FFFBEB", `${late} arrivals`);
  drawKpiCard("Attendance Rate", `${rate}%`, 36 + (kpiW + kpiGap) * 4, rate >= 75 ? "#059669" : "#DC2626", rate >= 75 ? "#ECFDF5" : "#FEF2F2", rate >= 75 ? "Qualified ✓" : "Review Required");

  // =========================================================================
  // SECTION D: ATTENDANCE HISTORY LOG TABLE (WITH AUTO PAGINATION)
  // =========================================================================
  let tableStartY = kpiY + kpiH + 13;
  doc.fillColor(primaryColor).fontSize(9).font("Helvetica-Bold").text("CHRONOLOGICAL ATTENDANCE REGISTER", 36, tableStartY);

  const tCols = [44, 126, 206, 286, 366];
  const tWidths = [78, 76, 76, 76, 185];
  const tHeads = ["DATE", "SESSION", "STATUS", "RECORD MODE", "REMARKS / NOTES"];
  const rowH = 17;

  const drawTableHeader = (y) => {
    doc.rect(36, y, 523, 19).fill(primaryColor);
    doc.fillColor("#FFFFFF").fontSize(7.5).font("Helvetica-Bold");
    tHeads.forEach((h, i) => {
      doc.text(h, tCols[i], y + 5);
    });
  };

  drawTableHeader(tableStartY + 12);
  let curRowY = tableStartY + 31;

  // Max Y before triggering page break
  const pageBottomLimit = 730;

  if (sortedAttendance.length === 0) {
    doc.rect(36, curRowY, 523, 24).fillAndStroke("#FFFFFF", borderGray);
    doc.fillColor(textMuted).fontSize(8).font("Helvetica").text("No attendance records logged for this student yet.", 48, curRowY + 7);
    curRowY += 24;
  } else {
    sortedAttendance.forEach((rec, idx) => {
      // Check if we need a page break
      if (curRowY + rowH > pageBottomLimit) {
        doc.addPage();
        drawHeaderBanner();
        curRowY = 114;
        doc.fillColor(primaryColor).fontSize(8.5).font("Helvetica-Bold").text("CHRONOLOGICAL ATTENDANCE REGISTER (CONTINUED)", 36, curRowY);
        drawTableHeader(curRowY + 12);
        curRowY += 31;
      }

      const bg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      doc.rect(36, curRowY, 523, rowH).fill(bg);

      // Date
      doc.fillColor(textColor).fontSize(7.5).font("Helvetica");
      doc.text(rec.dateKey || "—", tCols[0], curRowY + 4);

      // Session
      const sessionLabel = (rec.session || rec.sessionKey || "Morning").toUpperCase();
      doc.fillColor(textMuted).fontSize(7.5).font("Helvetica").text(sessionLabel, tCols[1], curRowY + 4);

      // Status with color code
      const st = String(rec.status || "unmarked").toLowerCase();
      let stColor = "#2563EB";
      if (st === "present") stColor = "#059669";
      else if (st === "absent") stColor = "#DC2626";
      else if (st === "late") stColor = "#D97706";
      else if (st === "excused") stColor = "#4338CA";

      doc.fillColor(stColor).font("Helvetica-Bold").fontSize(7.5).text(st.toUpperCase(), tCols[2], curRowY + 4);

      // Mode
      const source = rec.source === "photo-assisted" ? "Photo-Assisted" : (rec.confirmed ? "Manual (Verified)" : "Standard");
      doc.fillColor(textMuted).font("Helvetica").fontSize(7).text(source, tCols[3], curRowY + 4);

      // Notes
      const noteText = rec.notes || rec.note || "—";
      drawLocalizedText(noteText, tCols[4], curRowY + 4, { fontSize: 7.5, color: textColor, width: tWidths[4] - 8, ellipsis: true });

      curRowY += rowH;
    });

    // Outer table border for the current page
    doc.rect(36, tableStartY + 12, 523, Math.min(curRowY, pageBottomLimit) - (tableStartY + 12)).strokeColor(borderGray).stroke();
  }

  // =========================================================================
  // FOOTER & SEAL (APPLIED ON ALL PAGES VIA BUFFERPAGES)
  // =========================================================================
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footY = 760;

    // Top separator line
    doc.moveTo(36, footY).lineTo(559, footY).strokeColor(borderGray).stroke();

    // Footer Text
    doc.fillColor(textMuted).fontSize(7).font("Helvetica")
      .text("Darul Uloom Ashrafia, Atmakur • Madrasa Amanah Attendance Management System", 36, footY + 7);
    doc.text(`Student Database Record: ${student._id}  •  Page ${i + 1} of ${range.count}`, 36, footY + 17);

    // Official Seal and Signature Line
    doc.moveTo(420, footY + 40).lineTo(540, footY + 40).strokeColor("#94A3B8").stroke();
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text("Authorized Signature & Seal", 420, footY + 44, { align: "center", width: 120 });
  }

  doc.end();
  return doc;
}
