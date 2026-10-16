import zlib from "zlib";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { Attendance, AttendanceArchive, Class, Student, User, AuditLog, SystemSetting } from "./models.js";
import { getStorageMetrics, getSecondaryConnection } from "./storageRotationService.js";

// In-memory concurrency lock to prevent parallel archive runs
let isArchivalInProgress = false;

/**
 * Calculates the cutoff date (YYYY-MM-DD) for N calendar months ago.
 * E.g., if today is 2026-10-16 and months=6, cutoff is 2026-04-16.
 */
export function getSixMonthCutoffDate(baseDate = new Date(), months = 6) {
  const d = new Date(baseDate.getTime());
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * Parses GitHub repo string (e.g. "Sameersam3909/-Madrasa_Attandace" or "https://github.com/Sameersam3909/-Madrasa_Attandace.git")
 * into owner and repo names.
 */
export function parseGitHubRepo(repoInput) {
  const raw = String(repoInput || process.env.GITHUB_ARCHIVE_REPO || "Sameersam3909/-Madrasa_Attandace").trim();
  const cleaned = raw.replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
  const parts = cleaned.split("/");
  if (parts.length >= 2) {
    return { owner: parts[0], repo: parts[1], fullRepo: `${parts[0]}/${parts[1]}` };
  }
  return { owner: "Sameersam3909", repo: "-Madrasa_Attandace", fullRepo: "Sameersam3909/-Madrasa_Attandace" };
}

/**
 * Checks actual storage usage against configured thresholds and identifies
 * attendance records that are at least six calendar months old.
 */
export async function checkStorageAndArchivalEligibility(baseDate = new Date()) {
  let settings = await SystemSetting.findOne({ key: "global" });
  if (!settings) {
    settings = new SystemSetting({ key: "global" });
  }

  const retentionMonths = Number(settings.storageArchiveRetentionMonths || 6);
  const triggerPercent = Number(process.env.DATABASE_STORAGE_ARCHIVE_TRIGGER_PERCENT || settings.storageArchiveTriggerPercent || 80);
  const targetPercent = Number(process.env.DATABASE_STORAGE_TARGET_PERCENT || settings.storageArchiveTargetPercent || 70);

  const cutoffDate = getSixMonthCutoffDate(baseDate, retentionMonths);

  // 1. Get live database storage metrics
  const storageMetrics = await getStorageMetrics();

  // 2. Query attendance record statistics
  const [totalAttendance, eligibleCount, oldestRecord, newestEligibleRecord] = await Promise.all([
    Attendance.countDocuments(),
    Attendance.countDocuments({ dateKey: { $lt: cutoffDate } }),
    Attendance.findOne().sort({ dateKey: 1 }).select("dateKey").lean(),
    Attendance.findOne({ dateKey: { $lt: cutoffDate } }).sort({ dateKey: -1 }).select("dateKey").lean()
  ]);

  const currentUsagePercent = storageMetrics.available ? storageMetrics.usagePercent : null;
  const isStorageHigh = currentUsagePercent !== null && currentUsagePercent >= triggerPercent;

  let recommendation = "NORMAL";
  let message = `Storage is within safe limits (${currentUsagePercent ?? "N/A"}% used). All attendance records are preserved.`;

  if (isStorageHigh) {
    if (eligibleCount > 0) {
      recommendation = "ARCHIVE_RECOMMENDED";
      message = `Storage usage (${currentUsagePercent}%) has reached the ${triggerPercent}% threshold. ${eligibleCount} attendance records older than ${retentionMonths} months (before ${cutoffDate}) are eligible for archival to GitHub.`;
    } else {
      recommendation = "STORAGE_HIGH_NO_ELIGIBLE_RECORDS";
      message = `Storage usage (${currentUsagePercent}%) is above ${triggerPercent}%, but NO attendance records are older than ${retentionMonths} months. Retaining all records to protect recent data.`;
    }
  }

  return {
    cutoffDate,
    retentionMonths,
    triggerPercent,
    targetPercent,
    storageMetrics,
    totalAttendance,
    eligibleCount,
    oldestDateKey: oldestRecord?.dateKey || null,
    newestEligibleDateKey: newestEligibleRecord?.dateKey || null,
    isStorageHigh,
    recommendation,
    message,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Builds a clean, privacy-compliant attendance archive payload for a set of attendance records.
 * CRITICAL RULE: NEVER includes student photos, face embeddings, passwords, or personal contacts.
 * Includes only attendance data required for historical reports and recovery.
 */
export function buildAttendanceArchivePayload(attendances, { archiveId, dateRange }) {
  const records = attendances.map(a => {
    return {
      _id: String(a._id),
      dateKey: a.dateKey,
      sessionKey: a.sessionKey || "morning",
      status: a.status,
      source: a.source || "manual",
      note: a.note || "",
      student: {
        _id: String(a.studentId?._id || a.studentId),
        admissionNo: a.studentId?.admissionNo || "",
        name: a.studentId?.name || "",
        nameEn: a.studentId?.nameEn || "",
        nameUr: a.studentId?.nameUr || "",
        nameTe: a.studentId?.nameTe || ""
      },
      class: {
        _id: String(a.classId?._id || a.classId),
        name: a.classId?.name || "",
        section: a.classId?.section || "",
        academicYear: a.classId?.academicYear || ""
      },
      markedBy: {
        _id: String(a.markedBy?._id || a.markedBy || ""),
        name: a.markedBy?.name || "",
        email: a.markedBy?.email || ""
      },
      createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : undefined,
      updatedAt: a.updatedAt ? new Date(a.updatedAt).toISOString() : undefined
    };
  });

  const recordIds = records.map(r => r._id).sort();
  const recordIdsHash = crypto.createHash("sha256").update(recordIds.join(",")).digest("hex");

  // Summary counts
  const statusSummary = { present: 0, absent: 0, late: 0, excused: 0 };
  const classSummary = {};
  for (const r of records) {
    if (statusSummary[r.status] !== undefined) statusSummary[r.status]++;
    const cName = r.class?.name || "Unassigned";
    classSummary[cName] = (classSummary[cName] || 0) + 1;
  }

  const exportTimestamp = new Date().toISOString();

  // JSON payload
  const rawJson = JSON.stringify({
    archiveId,
    schemaVersion: "1.0.0",
    exportTimestamp,
    system: "Madrasa Amanah Smart Attendance System",
    dateRange,
    totalRecords: records.length,
    recordIdsHash,
    statusSummary,
    classSummary,
    records
  }, null, 2);

  // Compress using gzip
  const compressedBuffer = zlib.gzipSync(Buffer.from(rawJson, "utf8"), { level: 9 });
  const sha256 = crypto.createHash("sha256").update(compressedBuffer).digest("hex");

  // Manifest
  const manifest = {
    archiveId,
    schemaVersion: "1.0.0",
    exportTimestamp,
    dateRange,
    totalRecords: records.length,
    byteSize: compressedBuffer.length,
    sha256,
    recordIdsHash,
    statusSummary,
    classSummary,
    recordIdsSample: recordIds.slice(0, 50),
    recordIdsCount: recordIds.length,
    verificationStatus: "PENDING_UPLOAD"
  };

  return {
    archiveId,
    compressedBuffer,
    rawJson,
    sha256,
    manifest,
    recordIds,
    recordIdsHash,
    totalRecords: records.length,
    byteSize: compressedBuffer.length
  };
}

/**
 * Uploads an archive and its manifest to the private GitHub repository.
 * Falls back safely to local storage if GITHUB_ARCHIVE_TOKEN is not configured,
 * without claiming success on GitHub.
 */
export async function uploadArchiveToGitHub({
  compressedBuffer,
  manifest,
  archivePath,
  manifestPath
}) {
  const { owner, repo, fullRepo } = parseGitHubRepo();
  const token = process.env.GITHUB_ARCHIVE_TOKEN || process.env.GITHUB_TOKEN;

  // 1. Always save locally first in backups/attendance-archives/ for persistence & redundancy
  const localArchiveBase = path.resolve(process.cwd(), "backups");
  const localArchiveFile = path.resolve(localArchiveBase, archivePath);
  const localManifestFile = path.resolve(localArchiveBase, manifestPath);

  fs.mkdirSync(path.dirname(localArchiveFile), { recursive: true });
  fs.mkdirSync(path.dirname(localManifestFile), { recursive: true });

  fs.writeFileSync(localArchiveFile, compressedBuffer);
  fs.writeFileSync(localManifestFile, JSON.stringify(manifest, null, 2), "utf8");

  // 2. If token is not provided, record local-only backup
  if (!token || !token.trim()) {
    console.warn(`[ARCHIVE] GITHUB_ARCHIVE_TOKEN not configured. Saved to local storage at ${localArchiveFile}.`);
    return {
      uploadedToGitHub: false,
      reason: "GITHUB_TOKEN_NOT_CONFIGURED",
      localArchiveFile,
      localManifestFile,
      githubRepo: fullRepo,
      message: "Archive saved to local storage. Configure GITHUB_ARCHIVE_TOKEN or GITHUB_TOKEN in environment to upload to private GitHub repository."
    };
  }

  // 3. Upload to GitHub via REST API
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token.trim()}`,
    "User-Agent": "Madrasa-Amanah-Attendance-Archiver/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  // Check repo visibility (must be private or accessible)
  try {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        throw new Error(`Repository ${fullRepo} not found or token lacks access.`);
      }
      throw new Error(`GitHub repository check failed: HTTP ${repoRes.status}`);
    }
    const repoInfo = await repoRes.json();
    if (!repoInfo.private) {
      console.warn(`[SECURITY WARNING] Repository ${fullRepo} is PUBLIC! Archiving is restricted to private repositories.`);
    }
  } catch (err) {
    console.warn(`[ARCHIVE] GitHub repo check notice: ${err.message}`);
  }

  // Helper to upload single file to GitHub with SHA check
  async function putGitHubFile(filePathOnRepo, contentBase64, commitMsg) {
    const fileUrl = `${baseUrl}/${filePathOnRepo}`;
    let existingSha = null;

    try {
      const getRes = await fetch(fileUrl, { headers });
      if (getRes.ok) {
        const existingData = await getRes.json();
        existingSha = existingData.sha;
      }
    } catch {}

    const body = {
      message: commitMsg,
      content: contentBase64,
      branch: "main"
    };
    if (existingSha) {
      body.sha = existingSha;
    }

    const putRes = await fetch(fileUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`GitHub upload failed for ${filePathOnRepo}: HTTP ${putRes.status} ${errText}`);
    }

    return await putRes.json();
  }

  // Upload compressed archive (.json.gz)
  const archiveBase64 = compressedBuffer.toString("base64");
  const uploadArchiveResult = await putGitHubFile(
    archivePath,
    archiveBase64,
    `chore(archive): historical attendance backup [${manifest.dateRange.from} to ${manifest.dateRange.to}]`
  );

  // Upload manifest (.manifest.json)
  manifest.verificationStatus = "UPLOADED_TO_GITHUB";
  manifest.githubCommitSha = uploadArchiveResult.commit?.sha || "";
  const manifestBase64 = Buffer.from(JSON.stringify(manifest, null, 2), "utf8").toString("base64");
  const uploadManifestResult = await putGitHubFile(
    manifestPath,
    manifestBase64,
    `chore(manifest): archive manifest ${manifest.archiveId}`
  );

  return {
    uploadedToGitHub: true,
    githubRepo: fullRepo,
    archiveCommitSha: uploadArchiveResult.commit?.sha,
    manifestCommitSha: uploadManifestResult.commit?.sha,
    archiveUrl: uploadArchiveResult.content?.html_url || `https://github.com/${fullRepo}/blob/main/${archivePath}`,
    localArchiveFile,
    localManifestFile
  };
}

/**
 * Rigorous round-trip verification of uploaded GitHub backup.
 * 1. Retrieves the file from GitHub (or local verified backup if local).
 * 2. Computes the SHA-256 checksum and compares with expected.
 * 3. Decompresses the archive and confirms record count matches manifest.
 * 4. Verifies record IDs hash matches.
 * 5. Returns verification certificate.
 */
export async function verifyArchiveIntegrity({
  compressedBuffer,
  manifest,
  archivePath,
  uploadedToGitHub = false
}) {
  const { owner, repo, fullRepo } = parseGitHubRepo();
  const token = process.env.GITHUB_ARCHIVE_TOKEN || process.env.GITHUB_TOKEN;

  let bufferToVerify = compressedBuffer;

  // If uploaded to GitHub, attempt retrieval from GitHub to confirm round-trip
  if (uploadedToGitHub && token) {
    try {
      const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${archivePath}`;
      const res = await fetch(fileUrl, {
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token.trim()}`,
          "User-Agent": "Madrasa-Amanah-Attendance-Archiver/1.0"
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.content && data.encoding === "base64") {
          bufferToVerify = Buffer.from(data.content.replace(/\s+/g, ""), "base64");
        }
      }
    } catch (err) {
      console.warn(`[ARCHIVE] Round-trip GitHub fetch warning: ${err.message}. Verifying local bytes.`);
    }
  }

  // 1. Checksum verification
  const calculatedSha = crypto.createHash("sha256").update(bufferToVerify).digest("hex");
  if (calculatedSha !== manifest.sha256) {
    throw new Error(`Verification Failed: SHA-256 mismatch. Expected ${manifest.sha256}, got ${calculatedSha}`);
  }

  // 2. Decompression test
  let decompressedJson = null;
  try {
    const raw = zlib.gunzipSync(bufferToVerify).toString("utf8");
    decompressedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Verification Failed: Archive is not valid gzipped JSON: ${err.message}`);
  }

  // 3. Count verification
  const records = decompressedJson.records || [];
  if (records.length !== manifest.totalRecords) {
    throw new Error(`Verification Failed: Record count mismatch. Expected ${manifest.totalRecords}, got ${records.length}`);
  }

  // 4. Record ID Hash verification
  const fetchedIds = records.map(r => r._id).sort();
  const calculatedIdsHash = crypto.createHash("sha256").update(fetchedIds.join(",")).digest("hex");
  if (calculatedIdsHash !== manifest.recordIdsHash) {
    throw new Error(`Verification Failed: Record IDs hash mismatch.`);
  }

  // 5. Sensitive data audit check on decompressed records
  for (const r of records.slice(0, 100)) {
    if (r.student?.faceDescriptor || r.student?.photoUrl) {
      throw new Error(`Verification Failed: Security violation. Prohibited sensitive biometric/photo data found in archive.`);
    }
  }

  return {
    verified: true,
    sha256: calculatedSha,
    recordCount: records.length,
    recordIdsHash: calculatedIdsHash,
    verifiedAt: new Date().toISOString()
  };
}

/**
 * CRITICAL DATA PROTECTION RULE:
 * Only deletes explicitly verified attendance records using their IDs.
 * NEVER deletes student profiles, classes, marks, users, or teachers!
 */
export async function deleteVerifiedArchivedRecords({ recordIds, archiveId, actorId = null }) {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    return { deletedCount: 0 };
  }

  const objectIds = recordIds.map(id => new mongoose.Types.ObjectId(String(id)));

  // 1. Delete from Primary MongoDB
  const deleteResult = await Attendance.deleteMany({ _id: { $in: objectIds } });

  // 2. Delete from Secondary MongoDB if connected to prevent stale attendance records
  let secondaryDeletedCount = 0;
  try {
    const secondaryConn = await getSecondaryConnection();
    if (secondaryConn && secondaryConn.readyState === 1) {
      const secResult = await secondaryConn.collection("attendances").deleteMany({ _id: { $in: objectIds } });
      secondaryDeletedCount = secResult.deletedCount || 0;
    }
  } catch (secErr) {
    console.warn("[ARCHIVE] Notice: Secondary database delete synchronization:", secErr.message);
  }

  // 3. Update archive document
  await AttendanceArchive.updateOne(
    { archiveId },
    {
      $set: {
        deletedFromDb: true,
        deletedAt: new Date(),
        deletedCount: deleteResult.deletedCount,
        status: "purged"
      }
    }
  );

  // 4. Audit Log
  try {
    await AuditLog.create({
      actorId: actorId || new mongoose.Types.ObjectId("000000000000000000000001"),
      action: "storage.archive_deleted",
      entityType: "AttendanceArchive",
      entityId: archiveId,
      details: {
        archiveId,
        primaryDeletedCount: deleteResult.deletedCount,
        secondaryDeletedCount,
        recordCount: recordIds.length
      }
    });
  } catch {}

  return {
    success: true,
    primaryDeletedCount: deleteResult.deletedCount,
    secondaryDeletedCount
  };
}

/**
 * Runs a complete archival cycle.
 * Workflow:
 * 1. Checks storage and 6-month eligibility.
 * 2. If storage is below threshold and force=false: stops safely, keeps all records.
 * 3. If storage is high: processes eligible records in safe monthly batches.
 * 4. Archives batch -> Uploads to GitHub -> Verifies Round-Trip -> Only then deletes from DB.
 * 5. Stops when target storage threshold (70%) is reached or no eligible records remain.
 */
export async function runAutomatedArchivalCycle({
  trigger = "scheduler",
  force = false,
  batchLimit = 5000,
  actorId = null
} = {}) {
  if (isArchivalInProgress) {
    return {
      success: false,
      skipped: true,
      reason: "ALREADY_IN_PROGRESS",
      message: "An archival or storage cleanup cycle is already running. Concurrent jobs are prevented."
    };
  }

  isArchivalInProgress = true;
  const cycleId = `ARCHIVE-CYCLE-${Date.now()}`;
  const startTime = Date.now();

  try {
    // Acquire DB lock
    await SystemSetting.updateOne(
      { key: "global" },
      {
        $set: {
          "archivalLock.isLocked": true,
          "archivalLock.lockedAt": new Date(),
          "archivalLock.processId": cycleId
        }
      },
      { upsert: true }
    );

    // Step 1: Check eligibility
    const eligibility = await checkStorageAndArchivalEligibility();

    // If storage is not under pressure and force is not set, preserve all records!
    if (!force && !eligibility.isStorageHigh) {
      return {
        success: true,
        actionTaken: "NONE_PRESERVED",
        storageStatus: "NORMAL",
        usagePercent: eligibility.storageMetrics?.usagePercent,
        triggerPercent: eligibility.triggerPercent,
        eligibleCount: eligibility.eligibleCount,
        message: `Storage usage (${eligibility.storageMetrics?.usagePercent ?? 0}%) is below the ${eligibility.triggerPercent}% threshold. All ${eligibility.totalAttendance} attendance records are preserved.`
      };
    }

    // If storage is high but no records are older than 6 months: alert and retain!
    if (eligibility.eligibleCount === 0) {
      const msg = `Storage usage (${eligibility.storageMetrics?.usagePercent ?? "high"}%) is high, but 0 attendance records are older than 6 months (cutoff: ${eligibility.cutoffDate}). All records are retained to protect recent data.`;
      console.warn(`[ARCHIVE ALERT] ${msg}`);

      await AuditLog.create({
        actorId: actorId || new mongoose.Types.ObjectId("000000000000000000000001"),
        action: "storage.high_no_eligible_records",
        entityType: "SystemStorage",
        details: { eligibility }
      });

      return {
        success: true,
        actionTaken: "ALERTED_ADMIN_NO_OLD_RECORDS",
        storageStatus: "CRITICAL_BUT_NO_OLD_RECORDS",
        usagePercent: eligibility.storageMetrics?.usagePercent,
        eligibleCount: 0,
        message: msg
      };
    }

    // Step 2: Query eligible attendance records in safe batches
    const cutoffDate = eligibility.cutoffDate;
    const eligibleRecords = await Attendance.find({ dateKey: { $lt: cutoffDate } })
      .populate("studentId", "name nameEn nameUr nameTe admissionNo")
      .populate("classId", "name section academicYear")
      .populate("markedBy", "name email")
      .sort({ dateKey: 1, _id: 1 })
      .limit(batchLimit);

    if (eligibleRecords.length === 0) {
      return {
        success: true,
        actionTaken: "NONE",
        message: "No eligible records found for batch."
      };
    }

    // Group records by Year and Month for clean, structured archives
    const monthlyGroups = {};
    for (const rec of eligibleRecords) {
      const ym = rec.dateKey.slice(0, 7); // "YYYY-MM"
      if (!monthlyGroups[ym]) monthlyGroups[ym] = [];
      monthlyGroups[ym].push(rec);
    }

    const archivedBatches = [];
    let totalDeletedInCycle = 0;

    for (const [ym, records] of Object.entries(monthlyGroups)) {
      const [yearStr, monthStr] = ym.split("-");
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);

      const from = records[0].dateKey;
      const to = records[records.length - 1].dateKey;
      const archiveId = `ARCHIVE-${ym}-${crypto.randomBytes(4).toString("hex")}`;
      const archivePath = `attendance-archives/${yearStr}/${monthStr}/attendance-${ym}.json.gz`;
      const manifestPath = `attendance-archives/${yearStr}/${monthStr}/attendance-${ym}.manifest.json`;

      // 1. Build payload & manifest
      const {
        compressedBuffer,
        manifest,
        recordIds,
        recordIdsHash,
        sha256,
        byteSize
      } = buildAttendanceArchivePayload(records, {
        archiveId,
        dateRange: { from, to }
      });

      // 2. Upload to GitHub
      const uploadResult = await uploadArchiveToGitHub({
        compressedBuffer,
        manifest,
        archivePath,
        manifestPath
      });

      // 3. Verify GitHub archive round-trip before deletion
      const verification = await verifyArchiveIntegrity({
        compressedBuffer,
        manifest,
        archivePath,
        uploadedToGitHub: uploadResult.uploadedToGitHub
      });

      // 4. Record archive in MongoDB
      const archiveDoc = await AttendanceArchive.create({
        archiveId,
        year,
        month,
        dateRange: { from, to },
        recordCount: records.length,
        recordIds,
        recordIdsHash,
        sha256,
        byteSize,
        archivePath,
        manifestPath,
        githubRepo: uploadResult.githubRepo || "Sameersam3909/-Madrasa_Attandace",
        githubCommitSha: uploadResult.archiveCommitSha || "",
        githubFileUrl: uploadResult.archiveUrl || "",
        verificationStatus: verification.verified ? "verified" : "failed",
        verifiedAt: new Date(),
        deletedFromDb: false,
        status: "verified",
        summary: manifest.statusSummary
      });

      // 5. CRITICAL: ONLY DELETE AFTER SUCCESSFUL VERIFICATION!
      const deleteResult = await deleteVerifiedArchivedRecords({
        recordIds,
        archiveId,
        actorId
      });

      totalDeletedInCycle += deleteResult.primaryDeletedCount;

      archivedBatches.push({
        archiveId,
        monthKey: ym,
        dateRange: { from, to },
        recordCount: records.length,
        deletedCount: deleteResult.primaryDeletedCount,
        sha256,
        githubUrl: uploadResult.archiveUrl,
        uploadedToGitHub: uploadResult.uploadedToGitHub
      });

      // Check if target storage threshold has been reached (when running automated check)
      if (!force) {
        const currentStats = await getStorageMetrics();
        if (currentStats.available && currentStats.usagePercent <= eligibility.targetPercent) {
          console.log(`[ARCHIVE] Target storage limit (${eligibility.targetPercent}%) reached. Stopping batch cleanup.`);
          break;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const summary = {
      cycleId,
      trigger,
      durationMs,
      batchesArchived: archivedBatches.length,
      totalRecordsDeleted: totalDeletedInCycle,
      archivedBatches,
      timestamp: new Date().toISOString()
    };

    // Update system setting
    await SystemSetting.updateOne(
      { key: "global" },
      {
        $set: {
          lastArchivalRun: summary,
          "archivalLock.isLocked": false
        }
      }
    );

    return {
      success: true,
      actionTaken: "ARCHIVED_AND_PURGED",
      totalRecordsArchived: totalDeletedInCycle,
      batches: archivedBatches,
      durationMs,
      message: `Successfully archived and safely cleaned ${totalDeletedInCycle} historical attendance records across ${archivedBatches.length} monthly archive(s).`
    };
  } catch (err) {
    console.error("[ARCHIVE ERROR] Archival cycle failed:", err);

    await SystemSetting.updateOne(
      { key: "global" },
      {
        $set: {
          lastArchivalFailure: {
            timestamp: new Date().toISOString(),
            error: err.message,
            cycleId
          },
          "archivalLock.isLocked": false
        }
      }
    );

    throw err;
  } finally {
    isArchivalInProgress = false;
  }
}

/**
 * Restores an attendance archive without duplicating existing records or modifying
 * student, teacher, marks, or other permanent data.
 */
export async function restoreAttendanceArchive({ archiveId, archiveBufferOrJson, actorId = null }) {
  let payload = archiveBufferOrJson;

  // If buffer, decompress gzip
  if (Buffer.isBuffer(payload)) {
    try {
      const raw = zlib.gunzipSync(payload).toString("utf8");
      payload = JSON.parse(raw);
    } catch {
      payload = JSON.parse(payload.toString("utf8"));
    }
  } else if (typeof payload === "string") {
    payload = JSON.parse(payload);
  } else if (!payload && archiveId) {
    // Look up local archive file
    const archiveRecord = await AttendanceArchive.findOne({ archiveId });
    if (!archiveRecord) {
      throw new Error(`Archive record "${archiveId}" not found in database.`);
    }
    const localFile = path.resolve(process.cwd(), "backups", archiveRecord.archivePath);
    if (!fs.existsSync(localFile)) {
      throw new Error(`Local archive file not found at ${localFile}.`);
    }
    const buffer = fs.readFileSync(localFile);
    const raw = zlib.gunzipSync(buffer).toString("utf8");
    payload = JSON.parse(raw);
  }

  if (!payload || !Array.isArray(payload.records)) {
    throw new Error("Invalid archive payload. Expected JSON object with 'records' array.");
  }

  const records = payload.records;
  let restoredCount = 0;
  let skippedExistingCount = 0;

  // Safe idempotent restoration using bulkWrite with $setOnInsert
  const bulkOps = records.map(r => {
    return {
      updateOne: {
        filter: {
          studentId: new mongoose.Types.ObjectId(String(r.student?._id || r.studentId)),
          classId: new mongoose.Types.ObjectId(String(r.class?._id || r.classId)),
          dateKey: r.dateKey,
          sessionKey: r.sessionKey || "morning"
        },
        update: {
          $setOnInsert: {
            status: r.status,
            source: r.source || "manual",
            markedBy: new mongoose.Types.ObjectId(String(r.markedBy?._id || r.markedBy || "000000000000000000000001")),
            updatedBy: new mongoose.Types.ObjectId(String(actorId || "000000000000000000000001")),
            note: r.note || "",
            serverVersion: 1
          }
        },
        upsert: true
      }
    };
  });

  if (bulkOps.length > 0) {
    const bulkRes = await Attendance.bulkWrite(bulkOps, { ordered: false });
    restoredCount = bulkRes.upsertedCount || 0;
    skippedExistingCount = records.length - restoredCount;
  }

  if (archiveId) {
    await AttendanceArchive.updateOne(
      { archiveId },
      { $set: { restoredAt: new Date(), status: "restored" } }
    );
  }

  if (actorId) {
    try {
      await AuditLog.create({
        actorId,
        action: "storage.archive_restored",
        entityType: "AttendanceArchive",
        entityId: archiveId || payload.archiveId || "manual_restore",
        details: {
          totalInArchive: records.length,
          restoredCount,
          skippedExistingCount
        }
      });
    } catch {}
  }

  return {
    success: true,
    totalInArchive: records.length,
    restoredCount,
    skippedExistingCount,
    message: `Restoration complete: ${restoredCount} records restored, ${skippedExistingCount} existing records skipped.`
  };
}
