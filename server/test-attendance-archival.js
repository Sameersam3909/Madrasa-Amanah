import assert from "assert";
import crypto from "crypto";
import zlib from "zlib";
import mongoose from "mongoose";
import { connectDB } from "./src/db.js";
import { User, Class, Student, Attendance, AttendanceArchive, SystemSetting, AuditLog } from "./src/models.js";
import {
  getSixMonthCutoffDate,
  checkStorageAndArchivalEligibility,
  buildAttendanceArchivePayload,
  verifyArchiveIntegrity,
  deleteVerifiedArchivedRecords,
  runAutomatedArchivalCycle,
  restoreAttendanceArchive
} from "./src/attendanceArchiveService.js";

async function runTestSuite() {
  console.log("=================================================");
  console.log("  MADRASA AMANAH — 6-MONTH ATTENDANCE ARCHIVAL TEST SUITE");
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

  // 1. Cutoff Calculation Unit Test
  test("getSixMonthCutoffDate calculates exact 6 calendar months ago", () => {
    const base = new Date("2026-10-16T10:00:00Z");
    const cutoff = getSixMonthCutoffDate(base, 6);
    assert.strictEqual(cutoff, "2026-04-16");
  });

  // Connect to test database
  console.log("Connecting to test database engine...");
  await connectDB();

  // Create test entities
  let testAdmin, testTeacher, testClass, testStudent1, testStudent2;

  await asyncTest("Setup test students, teacher, class, and attendance fixtures", async () => {
    testAdmin = await User.findOne({ email: "archive-admin-test@example.com" });
    if (!testAdmin) {
      testAdmin = await User.create({
        name: "Admin User",
        email: "archive-admin-test@example.com",
        passwordHash: "$2a$10$hashedpasswordsimulation1234567890",
        role: "admin"
      });
    }

    testTeacher = await User.findOne({ email: "archive-teacher-test@example.com" });
    if (!testTeacher) {
      testTeacher = await User.create({
        name: "Teacher Ahmad",
        email: "archive-teacher-test@example.com",
        passwordHash: "$2a$10$hashedpasswordsimulation1234567890",
        role: "teacher"
      });
    }

    testClass = await Class.findOne({ name: "Hifz Year 1", academicYear: "2025-2026" });
    if (!testClass) {
      testClass = await Class.create({
        name: "Hifz Year 1",
        section: "A",
        academicYear: "2025-2026",
        teacherIds: [testTeacher._id]
      });
    }

    testStudent1 = await Student.findOne({ admissionNo: "ARCH-001" });
    if (!testStudent1) {
      testStudent1 = await Student.create({
        admissionNo: "ARCH-001",
        name: "Zaid Bin Haritha",
        nameEn: "Zaid Bin Haritha",
        nameUr: "زید بن حارثہ",
        nameTe: "జైద్ బిన్ హరిత",
        classId: testClass._id,
        photoUrl: "https://example.com/photos/zaid.jpg",
        faceDescriptor: [0.12, -0.34, 0.56, 0.78],
        active: true
      });
    }

    testStudent2 = await Student.findOne({ admissionNo: "ARCH-002" });
    if (!testStudent2) {
      testStudent2 = await Student.create({
        admissionNo: "ARCH-002",
        name: "Bilal Ibn Rabah",
        nameEn: "Bilal Ibn Rabah",
        nameUr: "بلال بن رباح",
        nameTe: "బిలాల్ ఇబ్న్ రబాహ్",
        classId: testClass._id,
        photoUrl: "https://example.com/photos/bilal.jpg",
        faceDescriptor: [0.22, -0.14, 0.46, 0.88],
        active: true
      });
    }

    // Clean any prior test attendance records for these test students
    await Attendance.deleteMany({
      studentId: { $in: [testStudent1._id, testStudent2._id] }
    });

    // Create 4 old attendance records (> 6 months old: January & February 2026)
    // and 2 recent records (< 6 months old: September 2026)
    await Attendance.insertMany([
      // Old records
      {
        studentId: testStudent1._id,
        classId: testClass._id,
        dateKey: "2026-01-10",
        sessionKey: "morning",
        status: "present",
        source: "manual",
        markedBy: testTeacher._id,
        updatedBy: testTeacher._id
      },
      {
        studentId: testStudent2._id,
        classId: testClass._id,
        dateKey: "2026-01-10",
        sessionKey: "morning",
        status: "absent",
        source: "manual",
        markedBy: testTeacher._id,
        updatedBy: testTeacher._id
      },
      {
        studentId: testStudent1._id,
        classId: testClass._id,
        dateKey: "2026-02-15",
        sessionKey: "morning",
        status: "present",
        source: "manual",
        markedBy: testTeacher._id,
        updatedBy: testTeacher._id
      },
      {
        studentId: testStudent2._id,
        classId: testClass._id,
        dateKey: "2026-02-15",
        sessionKey: "morning",
        status: "late",
        source: "manual",
        markedBy: testTeacher._id,
        updatedBy: testTeacher._id
      },
      // Recent records (< 6 months old, must NEVER be deleted by 6-month archival)
      {
        studentId: testStudent1._id,
        classId: testClass._id,
        dateKey: "2026-09-20",
        sessionKey: "morning",
        status: "present",
        source: "manual",
        markedBy: testTeacher._id,
        updatedBy: testTeacher._id
      },
      {
        studentId: testStudent2._id,
        classId: testClass._id,
        dateKey: "2026-09-20",
        sessionKey: "morning",
        status: "present",
        source: "manual",
        markedBy: testTeacher._id,
        updatedBy: testTeacher._id
      }
    ]);
  });

  // 2. Eligibility & Threshold Verification
  await asyncTest("checkStorageAndArchivalEligibility correctly identifies 6-month old records", async () => {
    const fixedDate = new Date("2026-10-16T10:00:00Z");
    const res = await checkStorageAndArchivalEligibility(fixedDate);
    assert.strictEqual(res.cutoffDate, "2026-04-16");
    assert.ok(res.eligibleCount >= 4, `Expected at least 4 eligible records, got ${res.eligibleCount}`);
    assert.strictEqual(res.retentionMonths, 6);
  });

  // 3. Storage is below threshold: NO records are deleted
  await asyncTest("When storage is below 80% threshold and force=false, no records are deleted", async () => {
    const beforeCount = await Attendance.countDocuments();
    const cycleRes = await runAutomatedArchivalCycle({
      trigger: "test-normal-storage",
      force: false
    });
    const afterCount = await Attendance.countDocuments();

    // Since in test env storage is low, cycleRes should preserve all records
    assert.strictEqual(beforeCount, afterCount, "Record count must remain identical when storage is healthy!");
    assert.strictEqual(cycleRes.actionTaken, "NONE_PRESERVED");
  });

  // 4. Payload construction and Security/Privacy Audit
  let testArchivePayload;
  await asyncTest("buildAttendanceArchivePayload produces valid gzip and strips sensitive biometric/photo fields", async () => {
    const records = await Attendance.find({ dateKey: { $lt: "2026-04-16" } })
      .populate("studentId", "name nameEn nameUr nameTe admissionNo photoUrl faceDescriptor")
      .populate("classId", "name section academicYear")
      .populate("markedBy", "name email");

    testArchivePayload = buildAttendanceArchivePayload(records, {
      archiveId: "TEST-ARCHIVE-001",
      dateRange: { from: "2026-01-10", to: "2026-02-15" }
    });

    assert.ok(Buffer.isBuffer(testArchivePayload.compressedBuffer), "Output must be compressed buffer");
    assert.ok(testArchivePayload.sha256.length === 64, "SHA-256 must be 64-char hex");
    assert.strictEqual(testArchivePayload.manifest.totalRecords, records.length);

    // Decompress and verify absence of sensitive data
    const raw = zlib.gunzipSync(testArchivePayload.compressedBuffer).toString("utf8");
    const json = JSON.parse(raw);
    assert.strictEqual(json.records.length, records.length);

    // Confirm no student photos or face embeddings in records
    for (const r of json.records) {
      assert.strictEqual(r.student.photoUrl, undefined, "photoUrl must NOT be included in attendance archives");
      assert.strictEqual(r.student.faceDescriptor, undefined, "faceDescriptor must NOT be included in attendance archives");
      assert.strictEqual(r.markedBy.passwordHash, undefined, "passwordHash must NOT be in archive");
    }
  });

  // 5. Verification Integrity Check
  await asyncTest("verifyArchiveIntegrity verifies authentic archive and rejects corrupted payload", async () => {
    // A. Authentic payload must verify
    const verifyOk = await verifyArchiveIntegrity({
      compressedBuffer: testArchivePayload.compressedBuffer,
      manifest: testArchivePayload.manifest,
      archivePath: "test.json.gz",
      uploadedToGitHub: false
    });
    assert.strictEqual(verifyOk.verified, true);
    assert.strictEqual(verifyOk.recordCount, testArchivePayload.manifest.totalRecords);

    // B. Tampered payload must fail verification and throw error
    const tamperedManifest = { ...testArchivePayload.manifest, totalRecords: 99999 };
    await assert.rejects(
      async () => {
        await verifyArchiveIntegrity({
          compressedBuffer: testArchivePayload.compressedBuffer,
          manifest: tamperedManifest,
          archivePath: "test.json.gz",
          uploadedToGitHub: false
        });
      },
      /Record count mismatch/
    );
  });

  // 6. Safe Archival and Cleanup Execution
  await asyncTest("runAutomatedArchivalCycle with force=true archives eligible old records and preserves recent records", async () => {
    const initialTotal = await Attendance.countDocuments();
    const initialRecentCount = await Attendance.countDocuments({ dateKey: { $gte: "2026-04-16" } });

    // Run archival cycle
    const cycleRes = await runAutomatedArchivalCycle({
      trigger: "test-forced-cleanup",
      force: true,
      actorId: testAdmin._id
    });

    assert.strictEqual(cycleRes.success, true);
    assert.strictEqual(cycleRes.actionTaken, "ARCHIVED_AND_PURGED");
    assert.ok(cycleRes.totalRecordsArchived >= 4);

    // Verify recent records are 100% PRESERVED
    const afterRecentCount = await Attendance.countDocuments({ dateKey: { $gte: "2026-04-16" } });
    assert.strictEqual(afterRecentCount, initialRecentCount, "Recent attendance records (< 6 months) must NEVER be deleted!");

    // Verify critical application data was NEVER modified or deleted
    const student1Check = await Student.findOne({ admissionNo: "ARCH-001" });
    assert.ok(student1Check, "Student profile must NOT be deleted!");
    assert.strictEqual(student1Check.name, "Zaid Bin Haritha");

    const classCheck = await Class.findById(testClass._id);
    assert.ok(classCheck, "Class must NOT be deleted!");

    const adminCheck = await User.findById(testAdmin._id);
    assert.ok(adminCheck, "Admin account must NOT be deleted!");
  });

  // 7. Archive record persisted and queryable
  await asyncTest("AttendanceArchive record is saved in MongoDB with verification status", async () => {
    const archiveDocs = await AttendanceArchive.find().sort({ createdAt: -1 });
    assert.ok(archiveDocs.length > 0, "Must have at least one AttendanceArchive record");
    const latest = archiveDocs[0];
    assert.strictEqual(latest.deletedFromDb, true);
    assert.ok(latest.sha256.length === 64);
  });

  // 8. Idempotent Restoration
  await asyncTest("restoreAttendanceArchive restores attendance records without duplicating or altering permanent data", async () => {
    const latestArchive = await AttendanceArchive.findOne().sort({ createdAt: -1 });
    assert.ok(latestArchive, "Archive must exist");

    const restoreRes = await restoreAttendanceArchive({
      archiveId: latestArchive.archiveId,
      actorId: testAdmin._id
    });

    assert.strictEqual(restoreRes.success, true);
    assert.ok(restoreRes.restoredCount > 0, `Expected restoredCount > 0, got ${restoreRes.restoredCount}`);

    // Re-running restore must be completely IDEMPOTENT (no duplicates added)
    const countAfterFirstRestore = await Attendance.countDocuments();
    const secondRestore = await restoreAttendanceArchive({
      archiveId: latestArchive.archiveId,
      actorId: testAdmin._id
    });

    const countAfterSecondRestore = await Attendance.countDocuments();
    assert.strictEqual(countAfterSecondRestore, countAfterFirstRestore, "Duplicate restore must not duplicate records!");
    assert.strictEqual(secondRestore.restoredCount, 0, "Second restore should have 0 new inserts (all skipped)");
  });

  // Clean up test data
  console.log("\nCleaning up test artifacts...");
  await Attendance.deleteMany({ studentId: { $in: [testStudent1._id, testStudent2._id] } });
  await AttendanceArchive.deleteMany({ archiveId: { $regex: /^ARCHIVE-2026/ } });
  await Student.deleteMany({ admissionNo: { $in: ["ARCH-001", "ARCH-002"] } });
  await Class.deleteMany({ _id: testClass._id });
  await User.deleteMany({ email: { $in: ["archive-admin-test@example.com", "archive-teacher-test@example.com"] } });

  console.log("\n=================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
