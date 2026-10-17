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
    margins: { top: 36, left: 36, right: 36, bottom: 24 },
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

  // Helper for drawing localized text supporting mixed Latin/Arabic/Telugu runs
  const drawLocalizedText = (text, x, y, options = {}) => {
    const str = String(text || "");
    const size = options.fontSize || 9;
    const color = options.color || textColor;
    doc.fillColor(color).fontSize(size);

    // Segment mixed strings so Latin glyphs use Helvetica and Arabic uses NotoArabic
    const segments = [];
    let currentType = null;
    let currentChunk = "";

    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      let type = "latin";
      if (ARABIC_REGEX.test(char)) type = "arabic";
      else if (TELUGU_REGEX.test(char)) type = "telugu";
      else if (/[\s\(\)\[\]\{\}\-\–\—\:\,\.\/\\]/.test(char)) type = currentType || "latin";

      if (type !== currentType && currentChunk.length > 0) {
        segments.push({ text: currentChunk, type: currentType });
        currentChunk = "";
      }
      currentType = type;
      currentChunk += char;
    }
    if (currentChunk.length > 0) {
      segments.push({ text: currentChunk, type: currentType });
    }

    if (segments.length <= 1) {
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

      const textOpts = { ...options, lineBreak: false };
      delete textOpts.fontSize;
      delete textOpts.color;
      delete textOpts.bold;
      delete textOpts.oblique;

      doc.text(str, x, y, textOpts);
    } else {
      let curX = x;
      segments.forEach((seg) => {
        if (seg.type === "arabic" && hasArabicFont) {
          doc.font("NotoArabic");
        } else if (seg.type === "telugu" && hasTeluguFont) {
          doc.font("NotoTelugu");
        } else if (options.bold) {
          doc.font("Helvetica-Bold");
        } else {
          doc.font("Helvetica");
        }
        doc.text(seg.text, curX, y, { lineBreak: false });
        curX += doc.widthOfString(seg.text);
      });
    }
  };

  // Helper for drawing field key-value pairs
  const drawField = (label, value, x, y, labelW = 80, valW = 160) => {
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text(label.toUpperCase(), x, y, { lineBreak: false });
    const valY = y + 9.5;
    const displayVal = value !== undefined && value !== null && String(value).trim() !== "" ? String(value) : "—";
    drawLocalizedText(displayVal, x, valY, { fontSize: 8.5, color: textColor, width: valW, ellipsis: true });
  };

  // =========================================================================
  // TOP HEADER BANNER (Consistent 523pt width: X=36 to X=559)
  // =========================================================================
  const drawHeaderBanner = (isContinued = false) => {
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
    doc.fillColor("#FFFFFF").fontSize(12).font("Helvetica-Bold").text("DARUL ULOOM ASHRAFIA, ATMAKUR", 82, 44, { width: 260, lineBreak: false });
    if (hasArabicFont) {
      doc.fillColor(accentGold).fontSize(10.5).font("NotoArabic").text("دارالعلوم اشرفیہ اتماکور", 82, 59, { width: 260, lineBreak: false });
    }
    doc.fillColor("#D1FAE5").fontSize(7.5).font("Helvetica").text("Madrasa Amanah Attendance Management System", 82, 73, { lineBreak: false });

    // Right side dossier metadata
    const headerTitle = isContinued ? "OFFICIAL STUDENT DOSSIER (CONTINUED)" : "OFFICIAL STUDENT DOSSIER";
    doc.fillColor("#FFFFFF").fontSize(9).font("Helvetica-Bold").text(headerTitle, 340, 44, { align: "right", width: 205, lineBreak: false });
    const formattedDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const formattedTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    doc.fillColor("#D1FAE5").fontSize(7.5).font("Helvetica").text(`Generated: ${formattedDate} ${formattedTime}`, 340, 60, { align: "right", width: 205, lineBreak: false });
    doc.fillColor("#A7F3D0").fontSize(7).font("Helvetica").text("Location: Atmakur", 340, 72, { align: "right", width: 205, lineBreak: false });
  };

  drawHeaderBanner();

  // =========================================================================
  // SECTION A: STUDENT PROFILE & PHOTOGRAPH
  // =========================================================================
  const profileY = 104;
  const profileH = 140;
  doc.roundedRect(36, profileY, 523, profileH, 5).fillAndStroke(lightBg, borderGray);

  // Photo Frame
  const photoX = 48;
  const photoY = profileY + 11;
  const photoW = 92;
  const photoH = 118;

  // Frame Outer Background & Shadow border
  doc.roundedRect(photoX, photoY, photoW, photoH, 4).fillAndStroke("#FFFFFF", cardBorder);

  let photoRendered = false;
  if (imageBuffer) {
    try {
      doc.save();
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
    const avX = photoX + photoW / 2;
    const avY = photoY + 46;
    doc.save();
    doc.fillColor("#CBD5E1");
    doc.circle(avX, avY, 17).fill();
    doc.path(`M ${avX - 28} ${avY + 40} C ${avX - 28} ${avY + 22}, ${avX + 28} ${avY + 22}, ${avX + 28} ${avY + 40} Z`).fill();
    doc.restore();

    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text("STUDENT PHOTO", photoX, photoY + 92, { align: "center", width: photoW, lineBreak: false });
    doc.fillColor("#94A3B8").fontSize(6.5).font("Helvetica").text(imageBuffer ? "Format Unsupported" : "No Photo on Record", photoX, photoY + 103, { align: "center", width: photoW, lineBreak: false });
  }

  // Student Identity Info (Right of Photo)
  const infoX = 152;
  let curY = profileY + 11;

  // Student Primary Display Name
  const canonicalName = normalizeStudentName(student.name || "Student");
  const nameEn = normalizeStudentName(student.nameEn || "");
  const nameUr = (student.nameUr || "").trim();
  const nameTe = (student.nameTe || "").trim();

  // Primary English / Canonical Name
  drawLocalizedText(nameEn || canonicalName, infoX, curY, { fontSize: 14, bold: true, color: textColor, width: 330 });
  curY += 18;

  // Multilingual Secondary Names (Urdu & Telugu) if present
  const altNames = [];
  if (nameUr && nameUr !== canonicalName) altNames.push({ text: nameUr, lang: "ur" });
  if (nameTe && nameTe !== canonicalName) altNames.push({ text: nameTe, lang: "te" });

  if (altNames.length > 0) {
    let altX = infoX;
    altNames.forEach((item) => {
      if (item.lang === "ur" && hasArabicFont) {
        doc.fillColor(primaryColor).fontSize(10.5).font("NotoArabic").text(item.text, altX, curY - 2, { lineBreak: false });
        altX += doc.widthOfString(item.text) + 14;
      } else if (item.lang === "te" && hasTeluguFont) {
        doc.fillColor(primaryColor).fontSize(9.5).font("NotoTelugu").text(item.text, altX, curY, { lineBreak: false });
        altX += doc.widthOfString(item.text) + 14;
      }
    });
    curY += 15;
  }

  // Identity Badges (Admission No, Active Status, Class)
  const badgeY = curY;
  const admText = `ROLL / ADM #${student.admissionNo || "—"}`;
  doc.roundedRect(infoX, badgeY, 108, 16, 3).fill("#E0E7FF");
  doc.fillColor("#3730A3").fontSize(8).font("Helvetica-Bold").text(admText, infoX + 6, badgeY + 4, { lineBreak: false });

  const isActive = student.active !== false;
  const statusBg = isActive ? "#D1FAE5" : "#FEE2E2";
  const statusColor = isActive ? "#065F46" : "#991B1B";
  const statusLabel = isActive ? "ACTIVE ENROLLMENT" : "ARCHIVED / INACTIVE";
  doc.roundedRect(infoX + 114, badgeY, 114, 16, 3).fill(statusBg);
  doc.fillColor(statusColor).fontSize(8).font("Helvetica-Bold").text(statusLabel, infoX + 120, badgeY + 4, { lineBreak: false });

  const classDisplayName = `${student.classId?.name || "Unassigned"}${student.classId?.section ? ` - ${student.classId.section}` : ""}`;
  doc.roundedRect(infoX + 234, badgeY, 163, 16, 3).fill("#FEF3C7");
  doc.fillColor("#92400E").fontSize(8).font("Helvetica-Bold").text(classDisplayName.toUpperCase(), infoX + 240, badgeY + 4, { width: 151, ellipsis: true, lineBreak: false });

  curY += 23;

  // Multi-column Profile Details Grid
  const pCol1 = infoX;
  const pCol2 = infoX + 126;
  const pCol3 = infoX + 252;

  drawField("Assigned Class", classDisplayName, pCol1, curY, 70, 116);
  drawField("Academic Year", student.classId?.academicYear || "1447-1448 / 2026", pCol2, curY, 70, 116);
  const formattedEnroll = student.enrollmentDate ? String(student.enrollmentDate).slice(0, 10) : "Not Recorded";
  drawField("Enrollment Date", formattedEnroll, pCol3, curY, 70, 135);
  curY += 24;

  drawField("Gender", student.gender || "Not Specified", pCol1, curY, 70, 116);
  const formattedDob = student.dob ? String(student.dob).slice(0, 10) : "Not Recorded";
  const age = calculateAge(student.dob);
  const dobDisplay = age !== null ? `${formattedDob} (${age} yrs)` : formattedDob;
  drawField("Date of Birth", dobDisplay, pCol2, curY, 70, 116);

  let teacherDisplay = "Madrasa Staff";
  if (Array.isArray(student.classId?.teacherIds) && student.classId.teacherIds.length > 0) {
    teacherDisplay = student.classId.teacherIds.map(t => t.name || t).filter(Boolean).join(", ") || "Madrasa Staff";
  }
  drawField("Assigned Teacher", teacherDisplay, pCol3, curY, 70, 135);
  curY += 24;

  drawField("Photo Consent", student.consentGiven ? "Recorded (Granted ✓)" : "Pending / Not Given", pCol1, curY, 70, 116);
  const hasBiometrics = Boolean(student.faceDescriptor && student.faceDescriptor.length > 0);
  drawField("AI Biometrics", hasBiometrics ? "Enrolled (Face Model ✓)" : "Standard Registry", pCol2, curY, 70, 116);
  drawField("Assigned Madrasa", "Madrasa Amanah (Atmakur)", pCol3, curY, 70, 135);

  // =========================================================================
  // SECTION B: PERSONAL & GUARDIAN DETAILS (3-column layout without internal DB ID)
  // =========================================================================
  const guardY = profileY + profileH + 8;
  const guardH = 66;
  doc.roundedRect(36, guardY, 523, guardH, 5).fillAndStroke(lightBg, borderGray);

  doc.fillColor(primaryColor).fontSize(8.5).font("Helvetica-Bold").text("PERSONAL & GUARDIAN CONTACT INFORMATION", 48, guardY + 8, { lineBreak: false });
  doc.moveTo(48, guardY + 19).lineTo(547, guardY + 19).strokeColor(borderGray).stroke();

  const gY = guardY + 24;
  drawField("Father / Guardian", student.guardianName || "Not Recorded on file", 48, gY, 95, 140);
  drawField("Authorized Contact", student.guardianPhone || "Not Recorded on file", 215, gY, 90, 130);
  drawField("Registration ID", `#${student.admissionNo || "—"} (${isActive ? "Active" : "Archived"})`, 370, gY, 90, 160);

  drawField("Residential Address", student.address || "Not Recorded on file", 48, gY + 21, 95, 490);

  // =========================================================================
  // SECTION C: ATTENDANCE SUMMARY & KPIS
  // =========================================================================
  const statsSectionY = guardY + guardH + 10;
  doc.fillColor(primaryColor).fontSize(9).font("Helvetica-Bold").text("ATTENDANCE PERFORMANCE METRICS & STANDING", 36, statsSectionY, { lineBreak: false });

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
  // Excused absences are never counted as present
  const rate = total > 0 ? Math.round(((present + (late * 0.75)) / total) * 100) : 0;
  const purePresentRate = total > 0 ? Math.round((present / total) * 100) : 0;

  // Academic Standing Badge (separating English and Arabic to eliminate missing glyph boxes)
  let standingEnglish = "N/A (No Sessions)";
  let standingArabic = "";
  let standingColor = textMuted;
  if (total > 0) {
    if (rate >= 90) {
      standingEnglish = "Excellent";
      standingArabic = "(ممتاز)";
      standingColor = "#059669";
    } else if (rate >= 75) {
      standingEnglish = "Good / Satisfactory";
      standingArabic = "(جید)";
      standingColor = "#0D9488";
    } else {
      standingEnglish = "Attendance Alert / Low";
      standingArabic = "(ضعیف)";
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

  const periodPrefix = `Reporting Period: ${reportingPeriod}  •  Attendance Standing: `;
  doc.fillColor(textMuted).fontSize(7.5).font("Helvetica")
    .text(periodPrefix, 36, statsSectionY + 11, { lineBreak: false });
  let standX = 36 + doc.widthOfString(periodPrefix);

  // Render English part in Helvetica-Bold
  doc.fillColor(standingColor).fontSize(7.5).font("Helvetica-Bold")
    .text(standingEnglish, standX, statsSectionY + 11, { lineBreak: false });
  standX += doc.widthOfString(standingEnglish) + 4;

  // Render Arabic part in NotoArabic
  if (standingArabic && hasArabicFont) {
    doc.fillColor(standingColor).fontSize(8).font("NotoArabic")
      .text(standingArabic, standX, statsSectionY + 10, { lineBreak: false });
  }

  // 5 KPI Cards (Equally sized and evenly spaced across 523pt total width)
  // (523 - 4 * 8.25) / 5 = 98 pt each
  const kpiY = statsSectionY + 22;
  const kpiW = 98;
  const kpiH = 45;
  const kpiGap = 8.25;

  const drawKpiCard = (label, value, x, valColor = textColor, bg = lightBg, subtext = "") => {
    doc.roundedRect(x, kpiY, kpiW, kpiH, 4).fillAndStroke(bg, borderGray);
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text(label.toUpperCase(), x + 7, kpiY + 6, { lineBreak: false });
    doc.fillColor(valColor).fontSize(14).font("Helvetica-Bold").text(String(value), x + 7, kpiY + 18, { lineBreak: false });
    if (subtext) {
      doc.fillColor(textMuted).fontSize(6.5).font("Helvetica").text(subtext, x + 7, kpiY + 33, { width: kpiW - 12, ellipsis: true, lineBreak: false });
    }
  };

  const absentSubtext = excused > 0 ? `${absent} unexcused (${excused} exc)` : `${absent} unexcused`;
  drawKpiCard("Total Sessions", total, 36, textColor, lightBg, `${total} records`);
  drawKpiCard("Present", present, 36 + kpiW + kpiGap, "#059669", "#ECFDF5", `${purePresentRate}% pure on-time`);
  drawKpiCard("Absent", absent, 36 + (kpiW + kpiGap) * 2, "#DC2626", "#FEF2F2", absentSubtext);
  drawKpiCard("Late / Tardy", late, 36 + (kpiW + kpiGap) * 3, "#D97706", "#FFFBEB", `${late} arrivals`);
  drawKpiCard("Attendance Rate", `${rate}%`, 36 + (kpiW + kpiGap) * 4, rate >= 75 ? "#059669" : "#DC2626", rate >= 75 ? "#ECFDF5" : "#FEF2F2", rate >= 75 ? "Qualified ✓" : "Review Required");

  // =========================================================================
  // SECTION D: ATTENDANCE HISTORY LOG TABLE (WITH AUTO PAGINATION)
  // =========================================================================
  let tableStartY = kpiY + kpiH + 12;
  doc.fillColor(primaryColor).fontSize(9).font("Helvetica-Bold").text("CHRONOLOGICAL ATTENDANCE REGISTER", 36, tableStartY, { lineBreak: false });

  // Perfectly aligned columns summing to 523pt total width
  // Date: 76, Session: 76, Status: 80, Record Mode: 95, Remarks: 196 -> Total = 523
  const tCols = [44, 120, 196, 276, 371];
  const tWidths = [72, 72, 76, 91, 178];
  const tHeads = ["DATE", "SESSION", "STATUS", "RECORD MODE", "REMARKS / NOTES"];
  const rowH = 17;

  const drawTableHeader = (y) => {
    doc.rect(36, y, 523, 18).fill(primaryColor);
    doc.fillColor("#FFFFFF").fontSize(7.5).font("Helvetica-Bold");
    tHeads.forEach((h, i) => {
      doc.text(h, tCols[i], y + 4.5, { lineBreak: false });
    });
  };

  drawTableHeader(tableStartY + 11);
  let curRowY = tableStartY + 29;

  // Max Y before triggering page break (conservatively set to keep 1-page reports intact)
  const pageBottomLimit = 718;

  if (sortedAttendance.length === 0) {
    doc.rect(36, curRowY, 523, 24).fillAndStroke("#FFFFFF", borderGray);
    doc.fillColor(textMuted).fontSize(8).font("Helvetica").text("No attendance records logged for this student yet.", 48, curRowY + 7, { lineBreak: false });
    curRowY += 24;
  } else {
    sortedAttendance.forEach((rec, idx) => {
      // Check if we need a page break
      if (curRowY + rowH > pageBottomLimit) {
        doc.addPage();
        drawHeaderBanner(true);
        curRowY = 112;
        doc.fillColor(primaryColor).fontSize(8.5).font("Helvetica-Bold").text("CHRONOLOGICAL ATTENDANCE REGISTER (CONTINUED)", 36, curRowY, { lineBreak: false });
        drawTableHeader(curRowY + 11);
        curRowY += 29;
      }

      const bg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      doc.rect(36, curRowY, 523, rowH).fill(bg);

      // Date
      doc.fillColor(textColor).fontSize(7.5).font("Helvetica");
      doc.text(rec.dateKey || "—", tCols[0], curRowY + 4, { lineBreak: false });

      // Session
      const sessionLabel = (rec.session || rec.sessionKey || "Morning").toUpperCase();
      doc.fillColor(textMuted).fontSize(7.5).font("Helvetica").text(sessionLabel, tCols[1], curRowY + 4, { lineBreak: false });

      // Status with clean color code
      const st = String(rec.status || "unmarked").toLowerCase();
      let stColor = "#2563EB";
      if (st === "present") stColor = "#059669";
      else if (st === "absent") stColor = "#DC2626";
      else if (st === "late") stColor = "#D97706";
      else if (st === "excused") stColor = "#4338CA";

      doc.fillColor(stColor).font("Helvetica-Bold").fontSize(7.5).text(st.toUpperCase(), tCols[2], curRowY + 4, { lineBreak: false });

      // Record Mode
      const source = rec.source === "photo-assisted" ? "Photo-Assisted" : (rec.confirmed ? "Manual (Verified)" : "Standard");
      doc.fillColor(textMuted).font("Helvetica").fontSize(7).text(source, tCols[3], curRowY + 4, { lineBreak: false });

      // Notes
      const noteText = rec.notes || rec.note || "—";
      drawLocalizedText(noteText, tCols[4], curRowY + 4, { fontSize: 7.5, color: textColor, width: tWidths[4], ellipsis: true });

      curRowY += rowH;
    });

    // Outer table border for the current page
    doc.rect(36, tableStartY + 11, 523, Math.min(curRowY, pageBottomLimit) - (tableStartY + 11)).strokeColor(borderGray).stroke();
  }

  // =========================================================================
  // FOOTER & SEAL (APPLIED ON ALL PAGES VIA BUFFERPAGES)
  // =========================================================================
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footY = 744;

    // Top separator line
    doc.moveTo(36, footY).lineTo(559, footY).strokeColor(borderGray).stroke();

    // Footer Text (clean without exposing raw database IDs)
    doc.fillColor(textMuted).fontSize(7).font("Helvetica")
      .text("Darul Uloom Ashrafia, Atmakur • Madrasa Amanah Attendance Management System", 36, footY + 6, { lineBreak: false });
    doc.text(`Official Student Dossier • Roll/Adm #${student.admissionNo || "—"} • Page ${i + 1} of ${range.count}`, 36, footY + 16, { lineBreak: false });

    // Official Seal and Signature Line
    doc.moveTo(420, footY + 28).lineTo(540, footY + 28).strokeColor("#94A3B8").stroke();
    doc.fillColor(textMuted).fontSize(7).font("Helvetica-Bold").text("Authorized Signature & Seal", 420, footY + 32, { align: "center", width: 120, lineBreak: false });
  }

  doc.end();
  return doc;
}
