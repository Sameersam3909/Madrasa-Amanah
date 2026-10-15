import "dotenv/config";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { Student, AuditLog } from "../src/models.js";

const isDryRun = process.argv.includes("--dry-run");

async function runMigration() {
  console.log("==================================================================");
  console.log("  MADRASA AMANAH — STUDENT LOCALIZED NAME MIGRATION UTILITY");
  console.log(`  Mode: ${isDryRun ? "DRY RUN (Preview Only — No Database Writes)" : "LIVE MIGRATION"}`);
  console.log("==================================================================\n");

  const uri = process.env.MONGODB_URI_PRIMARY || process.env.MONGODB_URI;
  if (!uri) {
    console.error("FATAL: MONGODB_URI or MONGODB_URI_PRIMARY is not configured.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB Atlas cluster.");

  const students = await Student.find({}).sort({ admissionNo: 1 });
  console.log(`Loaded ${students.length} existing student profiles for inspection.\n`);

  // Step 1: Pre-migration backup snapshot if running live
  if (!isDryRun) {
    const backupDir = path.resolve(process.cwd(), "backups/pre-name-migration");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupFile = path.join(backupDir, `students-pre-migration-${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(students.map(s => s.toObject()), null, 2), "utf8");
    console.log(`💾 Safety backup created at: ${backupFile}\n`);
  }

  let suspiciousMixedCount = 0;
  let populatedEnglishCount = 0;
  let skippedAlreadySetCount = 0;
  let flaggedForReviewCount = 0;

  const reviewReport = [];

  for (const student of students) {
    const canonical = (student.name || "").trim();
    const hasUrdu = /[\u0600-\u06FF]/.test(canonical);
    const hasLatin = /[a-zA-Z]/.test(canonical);
    const isMixed = hasUrdu && hasLatin;

    // Check if English can be safely derived:
    // Only if canonical is purely standard Latin/English and nameEn is empty!
    // Never guess mixed names or Urdu names!
    const isPureLatin = /^[a-zA-Z\s.,'-]+$/.test(canonical);

    let willUpdate = false;
    let updateAction = "NO_CHANGE";

    if (isMixed) {
      suspiciousMixedCount++;
      flaggedForReviewCount++;
      updateAction = "SUSPICIOUS_MIXED_SCRIPT_FLAGGED";
      reviewReport.push({
        id: student._id,
        admissionNo: student.admissionNo,
        canonicalName: canonical,
        reason: "Contains mixed Arabic/Urdu and Latin characters. Must be reviewed by Admin.",
        currentEn: student.nameEn || "",
        currentUr: student.nameUr || "",
        currentTe: student.nameTe || ""
      });
    } else if (!student.nameEn && isPureLatin) {
      populatedEnglishCount++;
      willUpdate = true;
      updateAction = "POPULATE_NAME_EN_FROM_CANONICAL";
      if (!isDryRun) {
        student.nameEn = canonical;
        await student.save();
      }
    } else if (student.nameEn) {
      skippedAlreadySetCount++;
      updateAction = "NAME_EN_ALREADY_EXISTS";
    } else {
      flaggedForReviewCount++;
      updateAction = "MANUAL_LOCALIZATION_REQUIRED";
      reviewReport.push({
        id: student._id,
        admissionNo: student.admissionNo,
        canonicalName: canonical,
        reason: "Non-standard characters or needs manual Urdu/Telugu entry.",
        currentEn: student.nameEn || "",
        currentUr: student.nameUr || "",
        currentTe: student.nameTe || ""
      });
    }

    console.log(`• [${student.admissionNo}] "${canonical}" -> ${updateAction}`);
  }

  console.log("\n==================================================================");
  console.log("  MIGRATION SUMMARY REPORT");
  console.log("==================================================================");
  console.log(`Total Students Inspected:         ${students.length}`);
  console.log(`Suspicious Mixed-Script Names:    ${suspiciousMixedCount} (Flagged for Admin review)`);
  console.log(`Safely Populated nameEn:          ${populatedEnglishCount}`);
  console.log(`Already Had nameEn:               ${skippedAlreadySetCount}`);
  console.log(`Flagged for Urdu/Telugu Entry:    ${flaggedForReviewCount}`);
  console.log(`Status:                           ${isDryRun ? "DRY RUN COMPLETE — 0 WRITES PERFORMED" : "LIVE MIGRATION SUCCESSFUL"}`);
  console.log("==================================================================\n");

  if (!isDryRun) {
    try {
      await AuditLog.create({
        actorId: students[0]?.classId ? new mongoose.Types.ObjectId("6ace5ffef96ee77e0702a15d") : new mongoose.Types.ObjectId(),
        action: "migration.student_names",
        entityType: "Student",
        details: {
          total: students.length,
          suspiciousMixedCount,
          populatedEnglishCount,
          skippedAlreadySetCount,
          flaggedForReviewCount
        }
      });
    } catch {}
  }

  await mongoose.disconnect();
  return {
    total: students.length,
    suspiciousMixedCount,
    populatedEnglishCount,
    skippedAlreadySetCount,
    flaggedForReviewCount,
    reviewReport
  };
}

runMigration().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
