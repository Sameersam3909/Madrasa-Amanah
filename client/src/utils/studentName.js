/**
 * MADRASA AMANAH — CENTRAL STUDENT LOCALIZED NAME SYSTEM
 * Single shared function for resolving a student's display name,
 * text direction, and search normalization across English, Urdu, and Telugu.
 */

/**
 * Normalizes accidental Urdu keyboard characters (like Urdu full-stop \u06D4)
 * that occur in English/Latin names into standard dots.
 * 
 * @param {string} str
 * @returns {string}
 */
export function normalizeStudentPunctuation(str) {
  if (!str || typeof str !== "string") return "";
  let val = str.trim();
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
 * Returns the preferred display name for a student given the active interface language.
 * Follows documented strict fallback order without concatenating different scripts.
 * 
 * Hierarchy:
 * - English ('en'): nameEn -> name (canonical) -> nameUr -> nameTe -> fullName -> admissionNo
 * - Urdu ('ur'): nameUr -> name (canonical) -> nameEn -> nameTe -> fullName -> admissionNo
 * - Telugu ('te'): nameTe -> name (canonical) -> nameEn -> nameUr -> fullName -> admissionNo
 * 
 * @param {Object} student - Student object or record
 * @param {string} [language='en'] - Active interface language code ('en', 'ur', 'te')
 * @returns {string} - Clean, localized display name
 */
export function getStudentDisplayName(student, language = "en") {
  if (!student) return "";
  if (typeof student === "string") return normalizeStudentPunctuation(student);

  const lang = String(language || "en").toLowerCase();

  const nameEn = normalizeStudentPunctuation(student.nameEn || "");
  const nameUr = (student.nameUr || "").trim();
  const nameTe = (student.nameTe || "").trim();
  const canonical = normalizeStudentPunctuation(student.name || student.fullName || "");
  const admissionNo = (student.admissionNo || student.admissionNumber || "").trim();

  if (lang === "ur") {
    return nameUr || canonical || nameEn || nameTe || admissionNo;
  }
  if (lang === "te") {
    return nameTe || canonical || nameEn || nameUr || admissionNo;
  }
  // Default to English
  return nameEn || canonical || nameUr || nameTe || admissionNo;
}

/**
 * Returns the correct text direction ('rtl' or 'ltr') for a student's name.
 * A name is only 'rtl' if it contains actual Arabic/Urdu alphabet letters AND
 * is not predominantly written in Latin/English characters.
 * 
 * @param {string} name - Resolved name string
 * @param {string} [language='en'] - Active interface language
 * @returns {'rtl' | 'ltr'}
 */
export function getStudentNameDir(name, language = "en") {
  if (!name) return language === "ur" ? "rtl" : "ltr";
  
  // Count Latin characters vs Urdu/Arabic alphabet letters
  const urduLetterMatches = name.match(/[\u0621-\u064A\u0671-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FC\u0750-\u077F]/g);
  const latinLetterMatches = name.match(/[a-zA-Z]/g);

  const urduCount = urduLetterMatches ? urduLetterMatches.length : 0;
  const latinCount = latinLetterMatches ? latinLetterMatches.length : 0;

  // If Latin letters are present and equal or greater than Urdu letters, text direction is LTR
  if (latinCount > 0 && latinCount >= urduCount) {
    return "ltr";
  }

  // If predominantly Urdu letters, text direction is RTL
  if (urduCount > 0) {
    return "rtl";
  }

  return language === "ur" ? "rtl" : "ltr";
}

/**
 * Determines if a name contains mixed Latin and Urdu/Arabic scripts
 * (e.g. "Md۔saeed" or "A۔Farhan Baig" or "Majeed عبد ال Bs")
 * 
 * @param {string} name
 * @returns {boolean}
 */
export function isMixedScript(name) {
  if (!name || typeof name !== "string") return false;
  const hasUrdu = /[\u0621-\u064A\u0671-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FC\u0750-\u077F]/.test(name);
  const hasLatin = /[a-zA-Z]/.test(name);
  return hasUrdu && hasLatin;
}

/**
 * Multi-script search matcher: checks if student matches a query across
 * all localized names, canonical name, and admission number.
 * 
 * @param {Object} student
 * @param {string} query
 * @returns {boolean}
 */
export function matchesStudentSearch(student, query) {
  if (!query || !query.trim()) return true;
  if (!student) return false;

  const q = query.trim().toLowerCase();
  const fields = [
    student.name,
    student.fullName,
    student.nameEn,
    student.nameUr,
    student.nameTe,
    student.admissionNo,
    student.admissionNumber,
    student.guardianName,
    student.guardianPhone
  ];

  return fields.some(f => f && String(f).toLowerCase().includes(q));
}
