/**
 * MADRASA AMANAH — CENTRAL STUDENT LOCALIZED NAME SYSTEM
 * Single shared function for resolving a student's display name,
 * text direction, and search normalization across English, Urdu, and Telugu.
 */

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
  if (typeof student === "string") return student.trim();

  const lang = String(language || "en").toLowerCase();

  const nameEn = (student.nameEn || "").trim();
  const nameUr = (student.nameUr || "").trim();
  const nameTe = (student.nameTe || "").trim();
  const canonical = (student.name || student.fullName || "").trim();
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
 * Returns the correct text direction ('rtl' or 'ltr') for a student's name
 * based on whether the resolved name contains Arabic/Urdu unicode characters.
 * 
 * @param {string} name - Resolved name string
 * @param {string} [language='en'] - Active interface language
 * @returns {'rtl' | 'ltr'}
 */
export function getStudentNameDir(name, language = "en") {
  if (!name) return language === "ur" ? "rtl" : "ltr";
  const hasUrduCharacters = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(name);
  if (hasUrduCharacters) return "rtl";
  return "ltr";
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
  const hasUrdu = /[\u0600-\u06FF\u0750-\u077F]/.test(name);
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
