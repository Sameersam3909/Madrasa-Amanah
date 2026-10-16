import enLocales from "../public/locales/en/translation.json";
import urLocales from "../public/locales/ur/translation.json";
import teLocales from "../public/locales/te/translation.json";

/**
 * Madrasa Amanah — Centralized Internationalization (i18n) Engine
 * Supported Languages:
 *   - English (en) [LTR]
 *   - Urdu (ur) [RTL]
 *   - Telugu (te) [LTR]
 */

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English", dir: "ltr", locale: "en-IN" },
  { code: "ur", label: "اردو", dir: "rtl", locale: "ur-PK" },
  { code: "te", label: "తెలుగు", dir: "ltr", locale: "te-IN" }
];

export const rawTranslations = {
  en: enLocales,
  ur: urLocales,
  te: teLocales
};

// Flatten helper to support both namespaced (e.g. "students.searchPlaceholder")
// and leaf keys (e.g. "searchPlaceholder", "save", "present")
function flattenDictionary(obj, prefix = "") {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(result, flattenDictionary(v, fullKey));
    } else {
      result[fullKey] = v;
      if (result[k] === undefined) {
        result[k] = v;
      }
    }
  }
  return result;
}

export const flatTranslations = {
  en: flattenDictionary(enLocales),
  ur: flattenDictionary(urLocales),
  te: flattenDictionary(teLocales)
};

// Backward-compatible translations export
export const translations = flatTranslations;

/**
 * Get layout direction for a language code
 */
export function getDirection(lang = "en") {
  return lang === "ur" ? "rtl" : "ltr";
}

/**
 * Apply language & direction to documentElement with localStorage persistence
 */
export function applyLanguageToDocument(lang = "en") {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
    document.documentElement.dir = getDirection(lang);
    try {
      localStorage.setItem("madrasa_lang", lang);
    } catch {}
  }
}

/**
 * Create a translation function `t(key, params)` for the given language
 * Supports dot-notated keys (e.g. "dashboard.totalStudents"), leaf keys ("totalStudents"),
 * interpolation (e.g. {{count}} or {count}), and direct property access (t.brand).
 */
export function createTranslator(lang = "en") {
  const currentDict = flatTranslations[lang] || flatTranslations.en;
  const fallbackDict = flatTranslations.en;

  function t(key, fallbackOrParams, maybeParams) {
    if (!key) return "";
    const hasStringFallback = typeof fallbackOrParams === "string";
    const defaultVal = hasStringFallback ? fallbackOrParams : key;
    const params = hasStringFallback ? maybeParams : fallbackOrParams;
    let val = currentDict[key] ?? fallbackDict[key] ?? defaultVal;
    if (typeof val !== "string") return String(val);
    if (params && typeof params === "object") {
      for (const [pKey, pVal] of Object.entries(params)) {
        val = val.replace(new RegExp(`{{${pKey}}}|{${pKey}}`, "g"), String(pVal));
      }
    }
    return val;
  }

  // Allow direct property access (e.g. t.brand, t.students, t.save, t.name)
  return new Proxy(t, {
    get(target, prop) {
      if (typeof prop !== "string") return target[prop];
      if (prop === "call" || prop === "apply" || prop === "bind") return target[prop];
      if (prop in currentDict || prop in fallbackDict) {
        return t(prop);
      }
      if (prop in target) return target[prop];
      return t(prop);
    }
  });
}

/**
 * Locale-aware date formatting
 */
export function formatDate(dateInput, lang = "en", options = {}) {
  if (!dateInput) return "";
  try {
    const d = typeof dateInput === "string" && dateInput.length === 10
      ? new Date(`${dateInput}T00:00:00`)
      : new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const locale = lang === "ur" ? "ur-PK" : lang === "te" ? "te-IN" : "en-IN";
    const defaultOptions = { year: "numeric", month: "short", day: "numeric", ...options };
    return new Intl.DateTimeFormat(locale, defaultOptions).format(d);
  } catch {
    return String(dateInput);
  }
}

/**
 * Locale-aware time formatting
 */
export function formatTime(dateInput, lang = "en", options = {}) {
  if (!dateInput) return "";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const locale = lang === "ur" ? "ur-PK" : lang === "te" ? "te-IN" : "en-IN";
    const defaultOptions = { hour: "2-digit", minute: "2-digit", ...options };
    return new Intl.DateTimeFormat(locale, defaultOptions).format(d);
  } catch {
    return String(dateInput);
  }
}

/**
 * Locale-aware date and time formatting
 */
export function formatDateTime(dateInput, lang = "en") {
  if (!dateInput) return "";
  return `${formatDate(dateInput, lang)} · ${formatTime(dateInput, lang)}`;
}

/**
 * Locale-aware number formatting
 */
export function formatNumber(numberInput, lang = "en") {
  const num = Number(numberInput);
  if (isNaN(num)) return String(numberInput);
  try {
    const locale = lang === "ur" ? "ur-PK" : lang === "te" ? "te-IN" : "en-IN";
    return new Intl.NumberFormat(locale).format(num);
  } catch {
    return String(num);
  }
}

/**
 * Locale-aware percentage formatting
 */
export function formatPercent(numberInput, lang = "en") {
  const num = Number(numberInput);
  if (isNaN(num)) return `${numberInput}%`;
  return `${formatNumber(num, lang)}%`;
}

/**
 * Localize Class Names in Urdu and Telugu
 */
export function localizeClassName(name, lang = "en") {
  if (!name) return "";
  const key = String(name).trim();
  const map = {
    "Hifz Class": { ur: "حفظ کلاس", te: "హిఫ్జ్ తరగతి" },
    "Hifz": { ur: "حفظ", te: "హిఫ్జ్" },
    "Nazira Class": { ur: "ناظرہ کلاس", te: "నాజిరా తరగతి" },
    "Nazira": { ur: "ناظرہ", te: "నాజిరా" }
  };
  return map[key]?.[lang] || key;
}

/**
 * Localize Section Names (Morning, Afternoon, Evening, Full Day)
 */
export function localizeSection(section, lang = "en") {
  if (!section) return "";
  const sec = String(section).trim().toLowerCase();
  const map = {
    morning: { ur: "صبح", te: "ఉదయం" },
    afternoon: { ur: "دوپہر", te: "మధ్యాహ్నం" },
    evening: { ur: "شام", te: "సాయంత్రం" },
    "full-day": { ur: "پورا دن", te: "రోజంతా" },
    "full day": { ur: "پورا دن", te: "రోజంతా" }
  };
  return map[sec]?.[lang] || section;
}

/**
 * Format Class Label with Localized Class Name and Section
 */
export function formatClassLabel(cls, lang = "en") {
  if (!cls) return "";
  const localizedName = localizeClassName(cls.name, lang);
  if (!cls.section) return localizedName;
  const localizedSec = localizeSection(cls.section, lang);
  return `${localizedName} (${localizedSec})`;
}

// Extended name word token dictionary for transliteration/translation
const nameTokens = {
  "muhammad": { ur: "محمد", te: "ముహమ్మద్" },
  "mohammad": { ur: "محمد", te: "ముహమ్మద్" },
  "mohammed": { ur: "محمد", te: "ముహమ్మద్" },
  "ahmad": { ur: "احمد", te: "అహ్మద్" },
  "ahmed": { ur: "احمد", te: "అహ్మద్" },
  "ali": { ur: "علی", te: "అలీ" },
  "hassan": { ur: "حسن", te: "హసన్" },
  "hasan": { ur: "حسن", te: "హసన్" },
  "hussain": { ur: "حسین", te: "హుస్సేన్" },
  "husain": { ur: "حسین", te: "హుస్సేన్" },
  "umar": { ur: "عمر", te: "ఉమర్" },
  "omer": { ur: "عمر", te: "ఉమర్" },
  "usman": { ur: "عثمان", te: "ఉస్మాన్" },
  "uthman": { ur: "عثمان", te: "ఉస్మాన్" },
  "abu": { ur: "ابو", te: "అబూ" },
  "bakr": { ur: "بکر", te: "బకర్" },
  "zaid": { ur: "زید", te: "జైద్" },
  "bilal": { ur: "بلال", te: "బిలాల్" },
  "habashi": { ur: "حبشی", te: "హబషీ" },
  "fatima": { ur: "فاطمہ", te: "ఫాతిమా" },
  "fatimah": { ur: "فاطمہ", te: "ఫాతిమా" },
  "zahra": { ur: "زہرا", te: "జహ్రా" },
  "mariam": { ur: "مریم", te: "మరియం" },
  "maryam": { ur: "مریم", te: "మరియం" },
  "siddiq": { ur: "صدیق", te: "సిద్దీఖ్" },
  "siddiqa": { ur: "صدیقہ", te: "సిద్దీఖా" },
  "aisha": { ur: "عائشہ", te: "ఆయిషా" },
  "khadija": { ur: "خدیجہ", te: "ఖదీజా" },
  "zainab": { ur: "زینب", te: "జైనబ్" },
  "ruqayyah": { ur: "رقیہ", te: "రుఖయ్య" },
  "ibrahim": { ur: "ابراہیم", te: "ఇబ్రహీం" },
  "ismail": { ur: "اسماعیل", te: "ఇస్మాయిల్" },
  "ishaq": { ur: "اسحاق", te: "ఇస్హాక్" },
  "yaqub": { ur: "یعقوب", te: "యాకూబ్" },
  "yusuf": { ur: "یوسف", te: "యూసుఫ్" },
  "musa": { ur: "موسیٰ", te: "మూసా" },
  "isa": { ur: "عیسیٰ", te: "ఈసా" },
  "yahya": { ur: "یحیٰی", te: "యహ్యా" },
  "sulaiman": { ur: "سلیمان", te: "సులైమాన్" },
  "dawood": { ur: "داؤد", te: "దావూద్" },
  "shaik": { ur: "شیخ", te: "షేక్" },
  "sheikh": { ur: "شیخ", te: "షేక్" },
  "sameer": { ur: "سمیر", te: "సమీర్" },
  "samir": { ur: "سمیر", te: "సమీర్" },
  "khan": { ur: "خان", te: "ఖాన్" },
  "syed": { ur: "سید", te: "సయ్యద్" },
  "sayed": { ur: "سید", te: "సయ్యద్" },
  "farooq": { ur: "فاروق", te: "ఫారూక్" },
  "abdullah": { ur: "عبد اللہ", te: "అబ్దుల్లా" },
  "abdul": { ur: "عبد ال", te: "అబ్దుల్" },
  "rahman": { ur: "رحمن", te: "రహమాన్" },
  "rahim": { ur: "رحیم", te: "రహీమ్" },
  "kareem": { ur: "کریم", te: "కరీమ్" }
};

function translateWords(text, lang) {
  if (!text || lang === "en") return text;
  const words = text.split(/\s+/);
  const translated = words.map((w) => {
    const clean = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    return nameTokens[clean]?.[lang] || w;
  });
  return translated.join(" ");
}

function cleanStudentPunctuation(str) {
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
 * Localize Student Names in Urdu and Telugu
 */
export function localizeStudentName(input, lang = "en") {
  if (!input) return "";
  if (typeof input === "object" && input !== null) {
    const nameEn = cleanStudentPunctuation(input.nameEn || "");
    const nameUr = (input.nameUr || "").trim();
    const nameTe = (input.nameTe || "").trim();
    const canonical = cleanStudentPunctuation(input.name || input.fullName || "");
    const admissionNo = (input.admissionNo || input.admissionNumber || "").trim();
    if (lang === "ur" && nameUr) return nameUr;
    if (lang === "te" && nameTe) return nameTe;
    if (lang === "en" && nameEn) return nameEn;
    return canonical || nameEn || nameUr || nameTe || admissionNo;
  }
  // Preserve personal names as-is without automatically translating into broken mixed scripts
  return cleanStudentPunctuation(String(input));
}

/**
 * Localize Guardian Names in Urdu and Telugu
 */
export function localizeGuardianName(name, lang = "en") {
  if (!name) return "";
  return String(name).trim();
}

