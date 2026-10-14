import assert from "assert";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { connectDB } from "./src/db.js";
import { User, Class, Student, Attendance } from "./src/models.js";
import {
  getPreviousReportingMonth,
  parseReportingMonth,
  generateMonthlyExcelWorkbook,
  verifyMonthlyExcelBackup,
  exportAndSaveMonthlyBackup
} from "./src/monthlyBackupService.js";

async function runTests() {
  console.log("=================================================");
  console.log("  MADRASA AMANAH — MONTHLY BACKUP TEST SUITE");
  console.log("=================================================\n");

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  async function asyncTest(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  // 1. Date Calculation Tests
  test("getPreviousReportingMonth calculates correct previous month within same year", () => {
    // Oct 14, 2026 -> Sep 2026
    const baseDate = new Date("2026-10-14T02:00:00+05:30");
    const meta = getPreviousReportingMonth(baseDate, "Asia/Kolkata");
    assert.strictEqual(meta.year, 2026);
    assert.strictEqual(meta.month, 9);
    assert.strictEqual(meta.monthKey, "2026-09");
    assert.strictEqual(meta.from, "2026-09-01");
    assert.strictEqual(meta.to, "2026-09-30");
    assert.strictEqual(meta.filename, "2026-09-attendance.xlsx");
    assert.strictEqual(meta.relativePath, "backups/2026/2026-09-attendance.xlsx");
  });

  test("getPreviousReportingMonth handles year boundary correctly (Jan 1 -> Dec prev year)", () => {
    const baseDate = new Date("2027-01-01T02:00:00+05:30");
    const meta = getPreviousReportingMonth(baseDate, "Asia/Kolkata");
    assert.strictEqual(meta.year, 2026);
    assert.strictEqual(meta.month, 12);
    assert.strictEqual(meta.monthKey, "2026-12");
    assert.strictEqual(meta.from, "2026-12-01");
    assert.strictEqual(meta.to, "2026-12-31");
    assert.strictEqual(meta.relativePath, "backups/2026/2026-12-attendance.xlsx");
  });

  test("parseReportingMonth parses valid YYYY-MM and rejects invalid formats", () => {
    const meta = parseReportingMonth("2026-08");
    assert.strictEqual(meta.monthKey, "2026-08");
    assert.strictEqual(meta.from, "2026-08-01");
    assert.strictEqual(meta.to, "2026-08-31");

    assert.throws(() => parseReportingMonth("invalid-date"), /Invalid month format/);
    assert.throws(() => parseReportingMonth("2026-13"), /Invalid month format/);
  });

  // 2. Database Connection & Integration Tests
  console.log("\nConnecting to test database...");
  await connectDB();

  // Create isolated test classes, students, and attendance records
  let testClass, testStudent1, testStudent2, teacherUser;

  await asyncTest("Setup test records for September 2026", async () => {
    teacherUser = await User.findOne({ email: "test-teacher-backup@example.com" });
    if (!teacherUser) {
      teacherUser = await User.create({
        name: "Qari Ahmad",
        email: "test-teacher-backup@example.com",
        passwordHash: "$2a$10$hashedpasswordsimulation1234567890",
        role: "teacher"
      });
    }

    testClass = await Class.findOne({ name: "Backup Test Hifz", section: "A" });
    if (!testClass) {
      testClass = await Class.create({
        name: "Backup Test Hifz",
        section: "A",
        academicYear: "2026-2027",
        teacherIds: [teacherUser._id]
      });
    }

    testStudent1 = await Student.findOne({ admissionNo: "TEST-BK-001" });
    if (!testStudent1) {
      testStudent1 = await Student.create({
        admissionNo: "TEST-BK-001",
        name: "Hamza Bin Tariq",
        classId: testClass._id,
        consentGiven: true
      });
    }

    testStudent2 = await Student.findOne({ admissionNo: "TEST-BK-002" });
    if (!testStudent2) {
      testStudent2 = await Student.create({
        admissionNo: "TEST-BK-002",
        name: "Yusuf Al-Farooq",
        classId: testClass._id,
        consentGiven: true
      });
    }

    // Clear old test attendances
    await Attendance.deleteMany({
      studentId: { $in: [testStudent1._id, testStudent2._id] },
      dateKey: { $gte: "2026-09-01", $lte: "2026-09-30" }
    });

    // Student 1: 3 days attendance (2 present, 1 late)
    await Attendance.create([
      {
        studentId: testStudent1._id,
        classId: testClass._id,
        dateKey: "2026-09-01",
        sessionKey: "morning",
        status: "present",
        markedBy: teacherUser._id,
        updatedBy: teacherUser._id,
        note: "On time"
      },
      {
        studentId: testStudent1._id,
        classId: testClass._id,
        dateKey: "2026-09-02",
        sessionKey: "morning",
        status: "late",
        markedBy: teacherUser._id,
        updatedBy: teacherUser._id,
        note: "5 mins late"
      },
      {
        studentId: testStudent1._id,
        classId: testClass._id,
        dateKey: "2026-09-03",
        sessionKey: "morning",
        status: "present",
        markedBy: teacherUser._id,
        updatedBy: teacherUser._id
      }
    ]);

    // Student 2: 2 days attendance (1 absent, 1 excused)
    await Attendance.create([
      {
        studentId: testStudent2._id,
        classId: testClass._id,
        dateKey: "2026-09-01",
        sessionKey: "morning",
        status: "absent",
        markedBy: teacherUser._id,
        updatedBy: teacherUser._id,
        note: "Unexcused"
      },
      {
        studentId: testStudent2._id,
        classId: testClass._id,
        dateKey: "2026-09-02",
        sessionKey: "morning",
        status: "excused",
        markedBy: teacherUser._id,
        updatedBy: teacherUser._id,
        note: "Medical appointment"
      }
    ]);
  });

  // 3. Test Workbook Generation
  let generatedResult;
  await asyncTest("generateMonthlyExcelWorkbook produces multi-sheet workbook with valid metadata", async () => {
    generatedResult = await generateMonthlyExcelWorkbook({
      from: "2026-09-01",
      to: "2026-09-30",
      monthLabel: "September 2026",
      monthKey: "2026-09"
    });

    assert.ok(generatedResult.workbook);
    assert.ok(generatedResult.meta);
    assert.strictEqual(generatedResult.meta.monthKey, "2026-09");
    assert.ok(generatedResult.meta.totalRecords >= 5);

    // Verify worksheets
    const sheetNames = generatedResult.workbook.worksheets.map(ws => ws.name);
    assert.ok(sheetNames.includes("Monthly Summary"), "Contains Monthly Summary");
    assert.ok(sheetNames.includes("Daily Attendance"), "Contains Daily Attendance");
    assert.ok(sheetNames.includes("Student Summary"), "Contains Student Summary");
  });

  // 4. Test Export and Full Verification to disk
  const testOutputDir = path.resolve(process.cwd(), "test-temp-backups");
  await asyncTest("exportAndSaveMonthlyBackup saves, verifies and computes SHA-256", async () => {
    const exportRes = await exportAndSaveMonthlyBackup({
      targetMonth: "2026-09",
      force: true,
      baseDir: testOutputDir,
      timeZone: "Asia/Kolkata"
    });

    assert.strictEqual(exportRes.success, true);
    assert.strictEqual(exportRes.monthKey, "2026-09");
    assert.ok(fs.existsSync(exportRes.filePath), "Workbook file exists on disk");
    assert.ok(fs.existsSync(exportRes.checksumPath), "SHA-256 checksum file exists on disk");
    assert.ok(exportRes.sha256 && exportRes.sha256.length === 64, "SHA-256 is 64 hex characters");

    // Read and verify checksum file content
    const savedChecksum = fs.readFileSync(exportRes.checksumPath, "utf8");
    assert.ok(savedChecksum.startsWith(exportRes.sha256), "Checksum file begins with sha256");

    // Test duplicate rerun prevention without force
    const rerunRes = await exportAndSaveMonthlyBackup({
      targetMonth: "2026-09",
      force: false,
      baseDir: testOutputDir,
      timeZone: "Asia/Kolkata"
    });

    assert.strictEqual(rerunRes.success, true);
    assert.strictEqual(rerunRes.alreadyExisted, true);
    assert.strictEqual(rerunRes.overwritten, false);
    assert.strictEqual(rerunRes.sha256, exportRes.sha256);
  });

  // 5. Test Prohibited Data Security Guard
  await asyncTest("verifyMonthlyExcelBackup rejects files containing prohibited sensitive data", async () => {
    const dirtyWb = new ExcelJS.Workbook();
    const wsSummary = dirtyWb.addWorksheet("Monthly Summary");
    wsSummary.addRow(["Title"]);

    const ws = dirtyWb.addWorksheet("Daily Attendance");
    ws.addRow(["Date", "Class", "Session", "Admission Number", "Student Name", "Attendance Status", "Source", "Marked By", "Note", "Recorded At"]);
    ws.addRow(["2026-09-01", "Hifz", "morning", "ADM-1", "Test", "PRESENT", "manual", "Admin", "passwordHash: $2a$10$leak", "2026-09-01 10:00:00"]);

    const wsStudent = dirtyWb.addWorksheet("Student Summary");
    wsStudent.addRow(["Admission Number", "Student Name", "Class", "Recorded Sessions", "Present Days", "Absent Days", "Late Days", "Excused Days", "Attendance %", "Attendance Assessment"]);
    wsStudent.addRow(["ADM-1", "Test", "Hifz", 1, 1, 0, 0, 0, "100.0%", "Excellent"]);

    const dirtyPath = path.resolve(testOutputDir, "dirty-test.xlsx");
    await dirtyWb.xlsx.writeFile(dirtyPath);

    await assert.rejects(
      async () => {
        await verifyMonthlyExcelBackup({
          filePath: dirtyPath,
          expectedFrom: "2026-09-01",
          expectedTo: "2026-09-30",
          expectedAttendancesCount: 1,
          expectedStudentsCount: 1,
          expectedMonthKey: "2026-09"
        });
      },
      /SECURITY VIOLATION/i,
      "Expected rejection due to security violation"
    );

    // Clean up dirty test file
    if (fs.existsSync(dirtyPath)) fs.unlinkSync(dirtyPath);
  });

  // Clean up test temp output directory
  if (fs.existsSync(testOutputDir)) {
    fs.rmSync(testOutputDir, { recursive: true, force: true });
  }

  // Clean up created test DB records
  await Attendance.deleteMany({ studentId: { $in: [testStudent1._id, testStudent2._id] } });
  await Student.deleteMany({ _id: { $in: [testStudent1._id, testStudent2._id] } });
  await Class.deleteOne({ _id: testClass._id });
  await User.deleteOne({ _id: teacherUser._id });

  await mongoose.disconnect();

  console.log("\n=================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================\n");

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
