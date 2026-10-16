import Dexie from "dexie";

export const offlineDb = new Dexie("madrasa-attendance-v1");

offlineDb.version(2).stores({
  classes: "id, updatedAt",
  students: "id, classId, admissionNo, name, updatedAt",
  attendanceDrafts: "id, classId, dateKey, studentId, status, updatedAt",
  outbox: "++localId, mutationId, kind, createdAt, state",
  metadata: "key"
});

offlineDb.version(3).stores({
  attendanceHistory: "id, classId, dateKey, sessionKey, studentId, status, updatedAt"
});

export async function cacheClasses(classes) {
  if (!classes || !classes.length) return;
  await offlineDb.classes.bulkPut(classes.map(c => ({
    ...c,
    id: String(c._id || c.id),
    name: c.name,
    section: c.section || "",
    academicYear: c.academicYear,
    updatedAt: c.updatedAt || new Date().toISOString()
  })));
}

export async function cacheStudents(students, classId) {
  if (!students || !students.length) return;
  await offlineDb.students.bulkPut(students.map(s => ({
    ...s,
    id: String(s._id || s.id),
    classId: String(s.classId?._id || s.classId || classId),
    name: s.name,
    admissionNo: s.admissionNo,
    gender: s.gender || "",
    dob: s.dob || "",
    guardianName: s.guardianName || "",
    guardianPhone: s.guardianPhone || "",
    address: s.address || "",
    enrollmentDate: s.enrollmentDate || "",
    photoUrl: s.photoUrl || s.referencePhotoUrl || "",
    consentGiven: s.consentGiven !== false,
    active: s.active !== false,
    updatedAt: s.updatedAt || new Date().toISOString()
  })));
}

export async function removeStudentFromCache(studentId) {
  if (!studentId) return;
  await offlineDb.students.delete(String(studentId));
}

export async function updateStudentInCache(student) {
  if (!student) return;
  const id = String(student._id || student.id);
  const existing = await offlineDb.students.get(id);
  await offlineDb.students.put({
    ...(existing || {}),
    ...student,
    id,
    classId: String(student.classId?._id || student.classId || existing?.classId || ""),
    updatedAt: new Date().toISOString()
  });
}

// Deduplicated offline attendance save: updates existing draft/mutation instead of creating duplicate outbox rows
export async function saveAttendanceLocally({ classId, dateKey, sessionKey = "morning", records, source = "manual" }) {
  const now = new Date().toISOString();
  let assignedMutationId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `mut_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const normalized = records.map(r => ({
    id: `${classId}:${dateKey}:${sessionKey}:${r.studentId}`,
    classId: String(classId),
    dateKey,
    sessionKey,
    studentId: String(r.studentId),
    status: r.status,
    note: String(r.note || "").slice(0, 300),
    source,
    updatedAt: now,
    syncState: "pending"
  }));

  await offlineDb.transaction("rw", offlineDb.attendanceDrafts, offlineDb.outbox, async () => {
    await offlineDb.attendanceDrafts.bulkPut(normalized);

    // Check for an already pending outbox item for this class, date and session
    const existing = await offlineDb.outbox
      .where("state")
      .equals("pending")
      .filter(item =>
        item.kind === "attendance.bulk" &&
        item.payload?.classId === String(classId) &&
        item.payload?.dateKey === dateKey &&
        (item.payload?.sessionKey || "morning") === sessionKey
      )
      .first();

    if (existing) {
      assignedMutationId = existing.mutationId;
      await offlineDb.outbox.update(existing.localId, {
        updatedAt: now,
        payload: {
          mutationId: existing.mutationId,
          classId: String(classId),
          dateKey,
          sessionKey,
          source,
          records: normalized.map(({ studentId, status, note }) => ({ studentId, status, note }))
        }
      });
    } else {
      await offlineDb.outbox.add({
        mutationId: assignedMutationId,
        kind: "attendance.bulk",
        createdAt: now,
        state: "pending",
        payload: {
          mutationId: assignedMutationId,
          classId: String(classId),
          dateKey,
          sessionKey,
          source,
          records: normalized.map(({ studentId, status, note }) => ({ studentId, status, note }))
        }
      });
    }
  });

  return { mutationId: assignedMutationId, savedLocally: normalized.length };
}

// Queue offline photo update while retaining previous confirmed photo
export async function queuePhotoUpdate({ studentId, photoDataUrl, faceDescriptor }) {
  const now = new Date().toISOString();
  let mutationId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `photo_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  await offlineDb.transaction("rw", offlineDb.students, offlineDb.outbox, async () => {
    const existing = await offlineDb.students.get(String(studentId));
    if (existing) {
      await offlineDb.students.update(String(studentId), {
        pendingPhotoDataUrl: photoDataUrl,
        pendingFaceDescriptor: faceDescriptor,
        photoPendingSync: true,
        updatedAt: now
      });
    }

    const pendingPhotoItem = await offlineDb.outbox
      .where("state")
      .equals("pending")
      .filter(item => item.kind === "student.photo" && item.payload?.studentId === String(studentId))
      .first();

    if (pendingPhotoItem) {
      mutationId = pendingPhotoItem.mutationId;
      await offlineDb.outbox.update(pendingPhotoItem.localId, {
        updatedAt: now,
        payload: {
          studentId: String(studentId),
          photoDataUrl,
          faceDescriptor
        }
      });
    } else {
      await offlineDb.outbox.add({
        mutationId,
        kind: "student.photo",
        createdAt: now,
        state: "pending",
        payload: {
          studentId: String(studentId),
          photoDataUrl,
          faceDescriptor
        }
      });
    }
  });

  return { mutationId };
}

let syncInProgress = false;

export async function syncPendingAttendance(apiInstance) {
  if (syncInProgress) return { running: true };
  syncInProgress = true;

  try {
    const pendingItems = await offlineDb.outbox
      .where("state")
      .equals("pending")
      .sortBy("createdAt");

    const results = [];

    for (const item of pendingItems) {
      await offlineDb.outbox.update(item.localId, { state: "syncing" });
      try {
        if (item.kind === "attendance.bulk") {
          const { data } = await apiInstance.post("/sync/attendance", item.payload);
          // Only mark synced if the server truly confirmed success
          if (data.status === "error" || (Array.isArray(data.results) && data.results.some(r => r.status === "error"))) {
            const errMsg = data.message || data.results?.find(r => r.status === "error")?.message || "Sync validation failed.";
            await offlineDb.outbox.update(item.localId, {
              state: "needs-review",
              lastError: errMsg
            });
            continue;
          }
          await offlineDb.transaction("rw", offlineDb.outbox, offlineDb.attendanceDrafts, async () => {
            await offlineDb.outbox.update(item.localId, {
              state: "synced",
              serverResult: data,
              syncedAt: new Date().toISOString(),
              lastError: null
            });
            const ids = (item.payload.records || []).map(r => `${item.payload.classId}:${item.payload.dateKey}:${item.payload.sessionKey || "morning"}:${r.studentId}`);
            for (const id of ids) {
              const draft = await offlineDb.attendanceDrafts.get(id);
              if (draft) await offlineDb.attendanceDrafts.update(id, { syncState: "synced" });
            }
          });
          results.push({ mutationId: item.mutationId, success: true, serverResult: data });
        } else if (item.kind === "student.photo") {
          const { data } = await apiInstance.patch(`/students/${item.payload.studentId}`, {
            photoDataUrl: item.payload.photoDataUrl,
            faceDescriptor: item.payload.faceDescriptor
          });
          await offlineDb.transaction("rw", offlineDb.outbox, offlineDb.students, async () => {
            await offlineDb.outbox.update(item.localId, {
              state: "synced",
              serverResult: { photoUrl: data.photoUrl },
              syncedAt: new Date().toISOString(),
              lastError: null
            });
            await offlineDb.students.update(item.payload.studentId, {
              photoUrl: data.photoUrl,
              faceDescriptor: data.faceDescriptor,
              pendingPhotoDataUrl: null,
              photoPendingSync: false
            });
          });
          results.push({ mutationId: item.mutationId, success: true, photoUrl: data.photoUrl });
        }
      } catch (error) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          await offlineDb.outbox.update(item.localId, {
            state: "needs-auth",
            lastError: "Session expired or access denied. Sign in online to sync."
          });
          break;
        }
        if (error.response?.status >= 400 && error.response?.status < 500) {
          await offlineDb.outbox.update(item.localId, {
            state: "needs-review",
            lastError: error.response.data?.message || "Server rejected this change."
          });
          continue;
        }
        await offlineDb.outbox.update(item.localId, {
          state: "pending",
          lastError: "Network offline. Queued for background sync.",
          lastAttemptAt: new Date().toISOString()
        });
        break;
      }
    }

    await setLastSyncTime(new Date().toISOString());
    return { success: true, processed: results.length, items: results };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Mark a local outbox mutation as synced immediately upon authoritative server confirmation
 */
export async function markOutboxSynced(mutationId, serverResult) {
  if (!mutationId) return;
  const item = await offlineDb.outbox.where("mutationId").equals(mutationId).first();
  if (item) {
    await offlineDb.transaction("rw", offlineDb.outbox, offlineDb.attendanceDrafts, async () => {
      await offlineDb.outbox.update(item.localId, {
        state: "synced",
        serverResult,
        syncedAt: new Date().toISOString(),
        lastError: null
      });
      if (item.payload?.records && item.payload?.classId) {
        const ids = (item.payload.records || []).map(r => `${item.payload.classId}:${item.payload.dateKey}:${item.payload.sessionKey || "morning"}:${r.studentId}`);
        for (const id of ids) {
          const draft = await offlineDb.attendanceDrafts.get(id);
          if (draft) await offlineDb.attendanceDrafts.update(id, { syncState: "synced" });
        }
      }
    });
  }
}

export async function getPendingOutboxCount() {
  return await offlineDb.outbox.where("state").equals("pending").count();
}

export async function getAllOutboxItems() {
  return await offlineDb.outbox.orderBy("createdAt").reverse().toArray();
}

export async function retryOutboxMutation(localId, apiInstance) {
  const item = await offlineDb.outbox.get(localId);
  if (!item) return;
  await offlineDb.outbox.update(localId, { state: "pending", lastError: null });
  return await syncPendingAttendance(apiInstance);
}

export async function setLastSyncTime(isoString) {
  await offlineDb.metadata.put({ key: "lastSyncTime", value: isoString });
}

export async function getLastSyncTime() {
  const record = await offlineDb.metadata.get("lastSyncTime");
  return record?.value || null;
}

export async function checkStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const usedMB = (estimate.usage / (1024 * 1024)).toFixed(1);
    const quotaMB = (estimate.quota / (1024 * 1024)).toFixed(0);
    return `${usedMB} MB used (of ~${quotaMB} MB available)`;
  }
  return "Local storage active (IndexedDB)";
}

// 6-Month Data Retention: caches up to 6 months (180 days) of compressed attendance records
export async function cacheAttendanceHistory(records, classId, dateKey, sessionKey = "morning") {
  if (!records || !records.length) return;
  const now = new Date().toISOString();
  const normalized = records.map(r => ({
    id: `${classId}:${dateKey}:${sessionKey}:${r.studentId || r._id || r.id}`,
    classId: String(classId),
    dateKey,
    sessionKey,
    studentId: String(r.studentId || r._id || r.id),
    status: r.status,
    updatedAt: now
  }));
  await offlineDb.attendanceHistory.bulkPut(normalized);
}

// Clean attendance records older than 180 days (6 months) to keep storage compact & fast
export async function cleanOldAttendance(days = 180) {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await offlineDb.attendanceDrafts.where("dateKey").below(cutoff).delete();
    await offlineDb.attendanceHistory.where("dateKey").below(cutoff).delete();
    console.log(`IndexedDB cleaned records older than ${cutoff} (6-month retention).`);
  } catch (err) {
    console.warn("Storage cleaner note:", err.message);
  }
}

// User Cache Isolation: Prevents one teacher or account from viewing another account's cached classes/students
export async function isolateUserCache(userId) {
  if (!userId) return;
  try {
    const record = await offlineDb.metadata.get("cachedUserId");
    const previousUserId = record?.value;
    if (previousUserId && String(previousUserId) !== String(userId)) {
      console.log(`[Cache Isolation] User changed from ${previousUserId} to ${userId}. Purging stale user-specific roster cache.`);
      await offlineDb.transaction("rw", offlineDb.classes, offlineDb.students, offlineDb.attendanceHistory, async () => {
        await offlineDb.classes.clear();
        await offlineDb.students.clear();
        await offlineDb.attendanceHistory.clear();
      });
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith("madrasa_cached_students_") || key === "madrasa_selected_class")) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
      } catch {}
    }
    await offlineDb.metadata.put({ key: "cachedUserId", value: String(userId) });
  } catch (err) {
    console.warn("User cache isolation note:", err.message);
  }
}

export async function clearUserCache() {
  try {
    await offlineDb.transaction("rw", offlineDb.classes, offlineDb.students, offlineDb.attendanceHistory, offlineDb.metadata, async () => {
      await offlineDb.classes.clear();
      await offlineDb.students.clear();
      await offlineDb.attendanceHistory.clear();
      await offlineDb.metadata.delete("cachedUserId");
    });
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith("madrasa_cached_students_") || key === "madrasa_selected_class")) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch {}
    console.log("[Cache Isolation] User cache cleared on sign out.");
  } catch (err) {
    console.warn("clearUserCache note:", err.message);
  }
}

