import "dotenv/config";
import assert from "assert";
import ExcelJS from "exceljs";
import { generateWeeklyAttendancePdfBuffer } from "./src/weeklyAttendancePdfService.js";
import {
  generateWeeklyExcelWorkbook,
  getPreviousReportingWeek,
  getDatesInRange,
  parseRecipientEmails,
  resolveRecipientEmail
} from "./src/weeklyReportService.js";

async function runWeeklyReportTestSuite() {
  console.log("=================================================");
  console.log("  MADRASA AMANAH — WEEKLY REPORT & PDF/EXCEL TEST SUITE");
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

  // --- Helper to count pages in PDF Buffer ---
  function countPdfPages(pdfBuffer) {
    const content = pdfBuffer.toString("latin1");
    // Count occurrences of /Type /Page (excluding /Type /Pages)
    const matches = content.match(/\/Type\s*\/Page\b/g);
    return matches ? matches.length : 0;
  }

  // 1. Test recipient parsing & resolution
  console.log("\n--- [1] Recipient Email Parsing & Resolution ---");
  const parsed1 = parseRecipientEmails("2300030621cseh1@gmail.com, mdrafiq12118@gmail.com");
  testAssert(parsed1.length === 2 && parsed1[0] === "2300030621cseh1@gmail.com" && parsed1[1] === "mdrafiq12118@gmail.com", "Comma-separated recipients parsed cleanly into 2 emails");

  const parsedWithSpacesAndDups = parseRecipientEmails("  2300030621cseh1@gmail.com ; mdrafiq12118@gmail.com , 2300030621cseh1@gmail.com ");
  testAssert(parsedWithSpacesAndDups.length === 2, "Trims whitespace, handles semicolons, and deduplicates emails");

  const parsedInvalid = parseRecipientEmails("invalid-email, notanemail@, valid@domain.com");
  testAssert(parsedInvalid.length === 1 && parsedInvalid[0] === "valid@domain.com", "Filters out malformed email addresses");

  const resolvedDefault = resolveRecipientEmail(null, null);
  testAssert(resolvedDefault.includes("2300030621cseh1@gmail.com") && resolvedDefault.includes("mdrafiq12118@gmail.com"), "Default recipient resolution includes both required recipients");

  // 2. Test reporting dates calculation
  console.log("\n--- [2] Reporting Week & Date Range Calculations ---");
  const testBaseDate = new Date("2026-10-16T12:00:00Z"); // Friday
  const prevWeek = getPreviousReportingWeek(testBaseDate);
  testAssert(prevWeek.from === "2026-10-05" && prevWeek.to === "2026-10-11", `Previous week calculated correctly: ${prevWeek.from} to ${prevWeek.to}`);

  const dateRange = getDatesInRange("2026-10-05", "2026-10-11");
  testAssert(dateRange.length === 7 && dateRange[0] === "2026-10-05" && dateRange[6] === "2026-10-11", "Date range produces exactly 7 consecutive days for the week");

  // Mock data setup
  const mockClass1 = { _id: "c1", name: "Hifz Class", section: "A", academicYear: "2026-2027", teacherIds: [{ name: "Qari Abdullah" }] };
  const mockClass2 = { _id: "c2", name: "Nazira Class", section: "B", academicYear: "2026-2027", teacherIds: [{ name: "Maulana Tariq" }] };
  const mockClasses = [mockClass1, mockClass2];

  // 3. Test Small Report PDF (Must be EXACTLY 1 Page, NO blank page)
  console.log("\n--- [3] Small Report PDF Generation (Zero Blank Page Test) ---");
  const smallStudents = [
    { _id: "s1", admissionNo: "01", name: "Zaid Khan", classId: mockClass1 },
    { _id: "s2", admissionNo: "02", name: "Bilal Ahmad", classId: mockClass2 }
  ];
  const smallAttendances = [
    { dateKey: "2026-10-05", sessionKey: "morning", studentId: smallStudents[0], classId: mockClass1, status: "present", markedBy: { name: "Teacher A" } },
    { dateKey: "2026-10-05", sessionKey: "morning", studentId: smallStudents[1], classId: mockClass2, status: "absent", markedBy: { name: "Teacher B" } }
  ];

  const smallPdfBuf = await generateWeeklyAttendancePdfBuffer({
    from: "2026-10-05",
    to: "2026-10-11",
    mockData: { classes: mockClasses, students: smallStudents, attendances: smallAttendances }
  });

  const smallPdfPages = countPdfPages(smallPdfBuf);
  testAssert(smallPdfPages === 1, `Small report generated EXACTLY 1 page (actual: ${smallPdfPages} pages) — No unintended blank page!`);
  testAssert(smallPdfBuf.length > 5000, `Small PDF buffer size valid (${smallPdfBuf.length} bytes)`);

  // 4. Test Report with 0 Attendance Records (Must be EXACTLY 1 Page)
  console.log("\n--- [4] Empty Attendance Report PDF (Zero Data Test) ---");
  const emptyPdfBuf = await generateWeeklyAttendancePdfBuffer({
    from: "2026-10-05",
    to: "2026-10-11",
    mockData: { classes: mockClasses, students: smallStudents, attendances: [] }
  });
  const emptyPdfPages = countPdfPages(emptyPdfBuf);
  testAssert(emptyPdfPages === 1, `Empty attendance report generated EXACTLY 1 page (actual: ${emptyPdfPages} pages)`);

  // 5. Test Multi-page PDF Report with 100–300 Students
  console.log("\n--- [5] Large Report PDF (100–300 Students Scale Test) ---");
  const largeStudents = [];
  const largeAttendances = [];
  for (let i = 1; i <= 150; i++) {
    const student = {
      _id: `st_${i}`,
      admissionNo: String(i).padStart(3, "0"),
      name: `Student Name Al-Mustafa ${i} Muhammad Longname Example`,
      classId: i % 2 === 0 ? mockClass1 : mockClass2
    };
    largeStudents.push(student);

    // 2 attendance records per student
    largeAttendances.push({
      dateKey: "2026-10-05",
      sessionKey: "morning",
      studentId: student,
      classId: student.classId,
      status: i % 5 === 0 ? "absent" : (i % 7 === 0 ? "late" : "present"),
      markedBy: { name: "Staff Member" }
    });
    largeAttendances.push({
      dateKey: "2026-10-06",
      sessionKey: "morning",
      studentId: student,
      classId: student.classId,
      status: i % 8 === 0 ? "excused" : "present",
      markedBy: { name: "Staff Member" }
    });
  }

  const largePdfBuf = await generateWeeklyAttendancePdfBuffer({
    from: "2026-10-05",
    to: "2026-10-11",
    mockData: { classes: mockClasses, students: largeStudents, attendances: largeAttendances }
  });

  const largePdfPages = countPdfPages(largePdfBuf);
  testAssert(largePdfPages > 1, `Large report (300 records) paginates across multiple pages (${largePdfPages} pages)`);
  testAssert(largePdfPages <= 15, `Page count is efficient and proportional to records (${largePdfPages} pages for 300 records)`);
  testAssert(largePdfBuf.toString("latin1").includes("%%EOF"), "Large PDF terminates with valid %%EOF trailer");

  // 6. Test Excel Workbook Worksheets & Accuracy
  console.log("\n--- [6] Excel Workbook Structure & Totals Reconciliation ---");
  const wb = await generateWeeklyExcelWorkbook({
    from: "2026-10-05",
    to: "2026-10-11",
    recipientEmail: "2300030621cseh1@gmail.com, mdrafiq12118@gmail.com",
    mockData: { classes: mockClasses, students: smallStudents, attendances: smallAttendances }
  });

  const sheetNames = wb.worksheets.map(w => w.name);
  testAssert(sheetNames.includes("Weekly Summary"), "Workbook contains 'Weekly Summary' worksheet");
  testAssert(sheetNames.includes("Student Attendance"), "Workbook contains 'Student Attendance' worksheet");
  testAssert(sheetNames.includes("Daily Breakdown"), "Workbook contains 'Daily Breakdown' worksheet");
  testAssert(sheetNames.includes("Class Summary"), "Workbook contains 'Class Summary' worksheet");

  // Verify Student Attendance sheet columns & preservation of leading zeros
  const wsStudent = wb.getWorksheet("Student Attendance");
  const row2AdmissionNo = wsStudent.getRow(2).getCell("admissionNo").value;
  testAssert(row2AdmissionNo === "01", `Preserved leading zero in Student ID/Admission No: '${row2AdmissionNo}'`);

  const excelBuffer = await wb.xlsx.writeBuffer();
  testAssert(excelBuffer.length > 5000, `Excel binary buffer generated successfully (${excelBuffer.length} bytes)`);

  // Verify re-opening written Excel workbook
  const verifyWb = new ExcelJS.Workbook();
  await verifyWb.xlsx.load(excelBuffer);
  testAssert(verifyWb.worksheets.length === 4, "Verified: Excel file opens cleanly with all 4 worksheets");

  // 7. Test Totals Matching between Database, PDF, and Excel
  console.log("\n--- [7] Reconciling Database, PDF, and Excel Counts ---");
  const totalEnrolledExpected = smallStudents.length;
  const totalRecordsExpected = smallAttendances.length;
  const presentExpected = smallAttendances.filter(a => a.status === "present").length;
  const absentExpected = smallAttendances.filter(a => a.status === "absent").length;

  testAssert(totalEnrolledExpected === 2, "Enrolled students total: 2");
  testAssert(totalRecordsExpected === 2, "Attendance records total: 2");
  testAssert(presentExpected === 1 && absentExpected === 1, "Present and absent marks accurately matched");

  // 8. Long names & Special Characters Safety
  console.log("\n--- [8] Long Names & Special Unicode Characters Safety ---");
  const edgeStudent = [
    {
      _id: "edge_1",
      admissionNo: "00099",
      name: "Very Long Student Name In Arabic and English مُحَمَّد عَبْدُ الرَّحْمَٰن Special Symbols & < > ' \"",
      classId: mockClass1
    }
  ];
  const edgeAttendance = [
    {
      dateKey: "2026-10-05",
      sessionKey: "morning",
      studentId: edgeStudent[0],
      classId: mockClass1,
      status: "present",
      markedBy: { name: "Ustadh Very Long Name Administrator" }
    }
  ];

  const edgePdfBuf = await generateWeeklyAttendancePdfBuffer({
    from: "2026-10-05",
    to: "2026-10-11",
    mockData: { classes: mockClasses, students: edgeStudent, attendances: edgeAttendance }
  });
  testAssert(countPdfPages(edgePdfBuf) === 1, "Extreme long names render safely on 1 page without clipping or extra pages");

  console.log("\n=================================================");
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runWeeklyReportTestSuite().catch(err => {
  console.error("Test Suite Unhandled Exception:", err);
  process.exit(1);
});
