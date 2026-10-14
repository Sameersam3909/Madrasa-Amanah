#!/usr/bin/env node
/**
 * ──────────────────────────────────────────────────────────────
 * Madrasa Amanah — Automated Monthly Excel Attendance Backup Script
 * ──────────────────────────────────────────────────────────────
 * Phase 13: Exports previous calendar month's attendance records
 * from MongoDB Atlas into a verified, sanitized multi-sheet Excel workbook.
 *
 * Usage:
 *   node scripts/export-monthly-backup.js [--month=YYYY-MM] [--force]
 *
 * Environment Variables:
 *   MONGODB_URI           Connection string to MongoDB Atlas
 *   BACKUP_API_URL        (Optional) Fallback backend API URL
 *   BACKUP_SERVICE_TOKEN  (Optional) Dedicated backup service authentication token
 *   REPORT_TIMEZONE       Timezone for date calculations (default: Asia/Kolkata)
 * ──────────────────────────────────────────────────────────────
 */

import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const serverDir = path.resolve(projectRoot, "server");
const serverRequire = createRequire(path.resolve(serverDir, "package.json"));

// Load .env variables from server/.env and root .env without external dotenv dependency
function loadEnvFile(envPath) {
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}
loadEnvFile(path.resolve(serverDir, ".env"));
loadEnvFile(path.resolve(projectRoot, ".env"));

// Dynamically import mongoose from server dependencies
const mongooseModule = await import(pathToFileURL(serverRequire.resolve("mongoose")).href);
const mongoose = mongooseModule.default || mongooseModule;

// Dynamically import backend services
const {
  getPreviousReportingMonth,
  parseReportingMonth,
  exportAndSaveMonthlyBackup
} = await import(pathToFileURL(path.resolve(serverDir, "src/monthlyBackupService.js")).href);
const { connectDB } = await import(pathToFileURL(path.resolve(serverDir, "src/db.js")).href);

// CLI Argument Parsing
function parseArgs() {
  const args = process.argv.slice(2);
  let targetMonth = null;
  let force = false;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--month=")) {
      targetMonth = arg.split("=")[1].trim();
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Madrasa Amanah Monthly Attendance Backup CLI

Options:
  --month=YYYY-MM   Specify target calendar month (e.g. 2026-09).
                    Defaults to previous calendar month in Asia/Kolkata.
  --force           Overwrite existing verified backup if present.
  --dry-run         Validate configuration without saving files.
  --help, -h        Show this help message.
`);
      process.exit(0);
    }
  }

  return { targetMonth, force, dryRun };
}

async function run() {
  console.log("=================================================");
  console.log("  مَدْرَسَة  •  MADRASA AMANAH ATTENDANCE BACKUP");
  console.log("  Automated Monthly Excel Backup to GitHub");
  console.log("=================================================");

  const { targetMonth, force, dryRun } = parseArgs();
  const timeZone = process.env.REPORT_TIMEZONE || "Asia/Kolkata";

  const monthMeta = targetMonth
    ? parseReportingMonth(targetMonth)
    : getPreviousReportingMonth(new Date(), timeZone);

  console.log(`\n📅 Target Month:       ${monthMeta.monthLabel} (${monthMeta.monthKey})`);
  console.log(`⏱️  Reporting Period:   ${monthMeta.from} to ${monthMeta.to}`);
  console.log(`📁 Destination File:   ${monthMeta.relativePath}`);
  console.log(`🔑 Timezone:           ${timeZone}`);
  console.log(`⚡ Force Overwrite:    ${force ? "YES" : "NO"}`);

  if (dryRun) {
    console.log("\n[DRY-RUN] Configuration and date parameters validated. Exiting without execution.");
    process.exit(0);
  }

  // Connect to Database
  console.log("\n🔌 Connecting to attendance database...");
  try {
    await connectDB();
  } catch (dbErr) {
    console.error("❌ Database connection error:", dbErr.message);
    console.error("Ensure MONGODB_URI is provided in environment or repository secrets.");
    process.exit(1);
  }

  try {
    console.log("📊 Extracting saved attendance records and building Excel workbook...");
    const result = await exportAndSaveMonthlyBackup({
      targetMonth: monthMeta.monthKey,
      force,
      baseDir: projectRoot,
      timeZone
    });

    console.log("\n✅ BACKUP COMPLETED & VERIFIED SUCCESSFULLY");
    console.log("─────────────────────────────────────────────────");
    console.log(`📄 Workbook:         ${result.relativePath} (${(result.bytes / 1024).toFixed(1)} KB)`);
    console.log(`🔒 SHA-256 Checksum: ${result.sha256}`);
    console.log(`📝 Checksum File:    ${result.relativeChecksumPath}`);

    if (result.alreadyExisted && !result.overwritten) {
      console.log(`ℹ️  Note:             ${result.message}`);
    } else if (result.meta) {
      console.log(`👥 Eligible Students:${result.meta.totalEligibleStudents}`);
      console.log(`🏫 Active Classes:   ${result.meta.totalClasses}`);
      console.log(`📋 Total Marks:      ${result.meta.totalRecords}`);
      console.log(`   - Present:        ${result.meta.presentTotal}`);
      console.log(`   - Absent:         ${result.meta.absentTotal}`);
      console.log(`   - Late:           ${result.meta.lateTotal}`);
      console.log(`   - Excused:        ${result.meta.excusedTotal}`);
      console.log(`📈 Attendance Rate:  ${result.meta.overallPercentage}%`);
    }

    // Set GitHub Actions step outputs if running in runner
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `month_key=${monthMeta.monthKey}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `backup_file=${result.relativePath}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `checksum_file=${result.relativeChecksumPath}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${result.sha256}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_changes=${result.alreadyExisted && !result.overwritten ? "false" : "true"}\n`);
      if (result.meta) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `records_count=${result.meta.totalRecords}\n`);
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `students_count=${result.meta.totalEligibleStudents}\n`);
      }
    }

    console.log("─────────────────────────────────────────────────\n");
    await mongoose.disconnect();
    process.exit(0);
  } catch (exportErr) {
    console.error("\n❌ BACKUP FAILED WITH ERROR:");
    console.error(exportErr.stack || exportErr.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

run();
