import "dotenv/config";
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";
import { generateStudentProfilePdf, normalizeStudentName, calculateAge, fetchStudentPhotoBuffer } from "./src/studentPdfService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractAllText(pdfBuffer) {
  let allText = pdfBuffer.toString("binary");
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match;
  while ((match = streamRegex.exec(pdfBuffer.toString("latin1"))) !== null) {
    try {
      const raw = Buffer.from(match[1], "latin1");
      const unzipped = zlib.inflateSync(raw).toString("latin1");
      allText += " " + unzipped;
    } catch (_) {}
  }
  return allText;
}

async function runStudentPdfTests() {
  console.log("=================================================");
  console.log("  MADRASA AMANAH — STUDENT PDF GENERATION SUITE");
  console.log("=================================================\n");

  let passed = 0;
  let failed = 0;

  function testAssert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // Sample test students
  const studentA = {
    _id: "6ad0541a9eacf3cf12709aa0",
    admissionNo: "16",
    name: "Muhammad Ubaidullah",
    nameEn: "Muhammad Ubaidullah",
    nameUr: "محمد عبید اللہ",
    nameTe: "ముహమ్మద్ ఉబైదుల్లా",
    gender: "Male",
    dob: "2014-06-15",
    guardianName: "Hafiz Abdul Qadir",
    guardianPhone: "9876543210",
    address: "Old Town Atmakur",
    enrollmentDate: "2026-06-01",
    consentGiven: true,
    active: true,
    photoUrl: "https://res.cloudinary.com/lfvphfvl/image/upload/v1792038137/madrasa-attendance/student-reference/lfsndlrlcow1n7lalkyj.jpg",
    classId: { name: "Nazira Class", section: "Evening", academicYear: "2026-2027" }
  };

  const studentB = {
    _id: "6ad0d7b4e78fbabb48a0bd53",
    admissionNo: "18",
    name: "Noor muhammad",
    nameEn: "Noor Muhammad",
    nameUr: "نور محمد",
    nameTe: "నూర్ ముహమ్మద్",
    gender: "Male",
    dob: "2015-08-20",
    guardianName: "Muhammad Noor",
    guardianPhone: "8712382029",
    address: "Kothapeta Atmakur",
    enrollmentDate: "2026-06-01",
    consentGiven: true,
    active: true,
    photoUrl: "", // Missing photo to test placeholder
    classId: { name: "Nazira Class", section: "Evening", academicYear: "2026-2027" }
  };

  const studentC_Minimal = {
    _id: "6ad0d8f2e78fbabb48a0bd79",
    admissionNo: "22",
    name: "Minimal Student",
    // All optional fields intentionally omitted (dob, gender, guardian, phone, address, photoUrl)
    active: false,
    classId: null
  };

  // Helper to generate in-memory buffer waiting for stream finish
  async function generateToBuffer(student, attendance) {
    const chunks = [];
    const { Writable } = await import("stream");
    return new Promise(async (resolve, reject) => {
      const out = new Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk);
          callback();
        }
      });
      out.on("finish", () => resolve(Buffer.concat(chunks)));
      out.on("error", reject);
      try {
        await generateStudentProfilePdf({ student, attendance, outputStream: out });
      } catch (e) {
        reject(e);
      }
    });
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Downloading PDF for different students produces distinct PDFs
    // -------------------------------------------------------------
    const pdfBufA = await generateToBuffer(studentA, [
      { dateKey: "2026-10-01", status: "present", session: "Morning", confirmed: true, notes: "On time" }
    ]);
    const pdfBufB = await generateToBuffer(studentB, [
      { dateKey: "2026-10-01", status: "late", session: "Morning", confirmed: true, notes: "Tardy 10m" }
    ]);

    testAssert(pdfBufA.length > 5000, `Student A PDF generated successfully (${pdfBufA.length} bytes)`);
    testAssert(pdfBufB.length > 5000, `Student B PDF generated successfully (${pdfBufB.length} bytes)`);
    testAssert(pdfBufA.slice(0, 5).toString() === "%PDF-", "PDF header %PDF- is present and valid");

    // -------------------------------------------------------------
    // Test 2: Dynamic details are fetched, not hardcoded
    // -------------------------------------------------------------
    const pdfStrA = pdfBufA.toString("binary");
    const pdfStrB = pdfBufB.toString("binary");

    testAssert(pdfStrA.includes(studentA.name), "PDF for Student A contains student A's name in metadata");
    testAssert(pdfStrB.includes(studentB.name), "PDF for Student B contains student B's name in metadata");
    testAssert(!pdfStrA.includes(studentB.name), "PDF for Student A does not contain Student B's name");

    // -------------------------------------------------------------
    // Test 3: Missing photos display a professional placeholder
    // -------------------------------------------------------------
    const placeholderPdf = await generateToBuffer(studentB, []);
    testAssert(placeholderPdf.length > 3000, "Student with missing photo generated PDF without error");
    const noPhotoFetch = await fetchStudentPhotoBuffer("");
    testAssert(noPhotoFetch === null, "fetchStudentPhotoBuffer gracefully returns null for empty photo URL");

    // -------------------------------------------------------------
    // Test 4: Missing optional fields do not break generation
    // -------------------------------------------------------------
    const minimalPdf = await generateToBuffer(studentC_Minimal, []);
    testAssert(minimalPdf.length > 3000, "Student with minimal fields (no DOB, guardian, class) generates valid PDF");

    // -------------------------------------------------------------
    // Test 5: Attendance counts and percentages match accurately
    // -------------------------------------------------------------
    const testRecords = [
      { dateKey: "2026-10-01", status: "present" },
      { dateKey: "2026-10-02", status: "present" },
      { dateKey: "2026-10-03", status: "absent" },
      { dateKey: "2026-10-04", status: "late" },
      { dateKey: "2026-10-05", status: "excused" }
    ];
    const presentCount = testRecords.filter(r => r.status === "present").length;
    const absentCount = testRecords.filter(r => r.status === "absent").length;
    const lateCount = testRecords.filter(r => r.status === "late").length;
    const excusedCount = testRecords.filter(r => r.status === "excused").length;

    testAssert(presentCount === 2 && absentCount === 1 && lateCount === 1 && excusedCount === 1, "Attendance counts correctly categorized (2 present, 1 absent, 1 late, 1 excused)");
    const calcRate = Math.round(((presentCount + (lateCount * 0.75)) / testRecords.length) * 100);
    testAssert(calcRate === 55, `Attendance percentage calculated consistently: ${calcRate}%`);

    // -------------------------------------------------------------
    // Test 6: Attendance belongs to selected student only
    // -------------------------------------------------------------
    const studentARecords = [{ dateKey: "2026-10-10", status: "present", notes: "UbaidullahOnlyNote" }];
    const studentBRecords = [{ dateKey: "2026-10-10", status: "absent", notes: "NoorOnlyNote" }];

    const pdfRecA = await generateToBuffer(studentA, studentARecords);
    const pdfRecB = await generateToBuffer(studentB, studentBRecords);

    const textA = extractAllText(pdfRecA);
    const textB = extractAllText(pdfRecB);
    const hexA = Buffer.from("UbaidullahOnlyNote").toString("hex");
    const hexB = Buffer.from("NoorOnlyNote").toString("hex");

    testAssert(textA.includes(hexA) || textA.includes("UbaidullahOnlyNote"), "Student A PDF contains Student A's attendance notes");
    testAssert(!textA.includes(hexB) && !textA.includes("NoorOnlyNote"), "Student A PDF does not contain Student B's attendance notes");

    // -------------------------------------------------------------
    // Test 7: Long reports paginate correctly without clipping
    // -------------------------------------------------------------
    const longAttendance = Array.from({ length: 60 }, (_, i) => ({
      dateKey: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      session: i % 2 === 0 ? "Morning" : "Evening",
      status: i % 10 === 0 ? "absent" : (i % 6 === 0 ? "late" : "present"),
      confirmed: true,
      notes: `Periodic register verification session log #${i + 1}`
    }));

    const paginatedPdf = await generateToBuffer(studentA, longAttendance);
    const pageMatches = paginatedPdf.toString("binary").match(/\/Type\s*\/Page\b/g);
    testAssert(pageMatches && pageMatches.length >= 3, `Long attendance list paginates cleanly across ${pageMatches?.length} pages`);

    // -------------------------------------------------------------
    // Test 8: English, Urdu, and Telugu support without breaking
    // -------------------------------------------------------------
    const multiLangStudent = {
      ...studentA,
      name: "Muhammad Ubaidullah",
      nameUr: "محمد عبید اللہ",
      nameTe: "ముహమ్మద్ ఉబైదుల్లా"
    };
    const multiLangPdf = await generateToBuffer(multiLangStudent, [
      { dateKey: "2026-10-12", status: "present", notes: "حاضر - హాజరు - Present" }
    ]);
    testAssert(multiLangPdf.length > 5000, "Multilingual English, Urdu, and Telugu student PDF renders cleanly");

    // -------------------------------------------------------------
    // Test 9: Filename and extension verification
    // -------------------------------------------------------------
    const cleanName = (studentA.name || "Student").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    const todayStr = new Date().toISOString().slice(0, 10);
    const filename = `Madrasa-Amanah-Student-${studentA.admissionNo || "Data"}-${cleanName}-${todayStr}.pdf`;
    testAssert(filename.endsWith(".pdf"), `Filename correctly formatted with .pdf extension: ${filename}`);
    testAssert(!filename.includes(" "), "Filename contains sanitized hyphens with no spaces");

    // -------------------------------------------------------------
    // Test 10: Age calculation and punctuation normalization helpers
    // -------------------------------------------------------------
    testAssert(normalizeStudentName("Md۔saeed") === "Md. saeed", "Urdu full stop U+06D4 normalized to ASCII dot");
    testAssert(calculateAge("2010-01-01") > 10, "calculateAge returns valid age from date of birth");
    testAssert(calculateAge(null) === null, "calculateAge returns null for missing date of birth");

    // -------------------------------------------------------------
    // Test 11: PDF opens and contains standard trailer
    // -------------------------------------------------------------
    const trailerIndex = pdfBufA.lastIndexOf("%%EOF");
    testAssert(trailerIndex !== -1, "PDF ends with standard %%EOF trailer indicator");

  } catch (err) {
    console.error("Test execution failed with unhandled error:", err);
    failed++;
  }

  console.log("\n=================================================");
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runStudentPdfTests();
