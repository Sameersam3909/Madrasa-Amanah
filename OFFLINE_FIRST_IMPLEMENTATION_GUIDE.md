# Complete implementation guide: offline-first Madrasa Smart Attendance

This guide extends the current React/Vite + Express/Mongoose project. The current starter source has online CRUD and report endpoints, but it is NOT yet a complete offline-first application. Follow this guide and test each phase before using real student data.

## 1. Final requirements checklist

- 100–300 students; multiple classes; English, Urdu and Telugu.
- Admin creates classes, teacher accounts and class assignments.
- Teachers can only access their assigned classes.
- Student admission number is unique; active/inactive status preserves historical attendance.
- Take/upload a classroom photo; detect faces; match against consented reference descriptors.
- Teacher reviews suggestions. Unmatched detected faces can be attached manually to students.
- If no face is detected, or models fail, manual attendance must still work.
- Attendance states: present, absent, late, excused, and not-yet-marked.
- Offline attendance writes to IndexedDB immediately and enters a durable outbox.
- Sync retries when network returns; manual Sync now button; clear pending/synced/failed/conflict statuses.
- Reports: date range, class, individual student, monthly summary, CSV/XLSX/PDF.
- PWA installable on Android; offline app shell, student/class cache and model cache.
- Full backup, six-month archive policy, verified restore, audit logs, consent and access controls.

## 2. Stack

- Frontend: React + Vite + TypeScript (or JavaScript starter) + Tailwind.
- PWA: `vite-plugin-pwa` / Workbox service worker.
- Device database: IndexedDB through `dexie`.
- Backend: Node.js + Express.
- Server database: MongoDB Atlas.
- Authentication: JWT with bcrypt password hashing; do not store plaintext passwords.
- Photo storage: approved image/object storage; do not store classroom photo blobs in MongoDB.
- Reports: ExcelJS, PDFKit, CSV export.

Install PWA/offline dependencies in `client/`:

```bash
npm install dexie
npm install -D vite-plugin-pwa
```

## 3. Local database and durable outbox

Create `client/src/offlineDb.js`:

```js
import Dexie from "dexie";

export const offlineDb = new Dexie("madrasa-attendance-v1");
offlineDb.version(1).stores({
  classes: "id, updatedAt",
  students: "id, classId, admissionNo, name, updatedAt",
  attendanceDrafts: "id, classId, dateKey, studentId, status, updatedAt",
  outbox: "++localId, mutationId, kind, createdAt, state",
  metadata: "key"
});

export async function cacheClasses(classes) {
  await offlineDb.classes.bulkPut(classes.map(c => ({
    ...c, id: String(c._id || c.id), updatedAt: c.updatedAt || new Date().toISOString()
  })));
}

export async function cacheStudents(students, classId) {
  await offlineDb.students.bulkPut(students.map(s => ({
    ...s, id: String(s._id || s.id), classId: String(s.classId?._id || s.classId || classId),
    updatedAt: s.updatedAt || new Date().toISOString()
  })));
}

export async function saveAttendanceLocally({ classId, dateKey, records, source = "manual" }) {
  const now = new Date().toISOString();
  const mutationId = crypto.randomUUID();
  const normalized = records.map(r => ({
    id: `${classId}:${dateKey}:${r.studentId}`,
    classId: String(classId),
    dateKey,
    studentId: String(r.studentId),
    status: r.status,
    note: String(r.note || "").slice(0, 300),
    source,
    updatedAt: now,
    syncState: "pending",
    mutationId
  }));

  await offlineDb.transaction("rw", offlineDb.attendanceDrafts, offlineDb.outbox, async () => {
    await offlineDb.attendanceDrafts.bulkPut(normalized);
    await offlineDb.outbox.add({
      mutationId,
      kind: "attendance.bulk",
      createdAt: now,
      state: "pending",
      payload: {
        mutationId, classId: String(classId), dateKey, source,
        records: normalized.map(({ studentId, status, note }) => ({ studentId, status, note }))
      }
    });
  });
  return { mutationId, savedLocally: normalized.length };
}
```

Notes:
- `crypto.randomUUID()` requires a secure context in modern browsers; use HTTPS in production.
- IndexedDB is per browser profile and per website origin. Clearing browser data or uninstalling the browser may erase local data. It is not a backup.
- For production, migrate the Dexie schema with version increments when fields change.
- Consider local device encryption and screen lock policy because student information is stored on the teacher's device.

## 4. PWA setup

In `client/vite.config.js` configure `VitePWA` to precache the built app shell and icons. Do NOT cache private API responses using a generic cache-first strategy. Cache only public static assets and face model files; store private student/class data in IndexedDB and refresh it through authenticated API calls.

Example baseline:

```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Madrasa Smart Attendance",
        short_name: "Madrasa",
        description: "Offline-first attendance for madrasa classes",
        theme_color: "#245c43",
        background_color: "#f6f8f5",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/models/"),
            handler: "CacheFirst",
            options: {
              cacheName: "face-models-v1",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }
            }
          }
        ]
      }
    })
  ]
});
```

Create real `pwa-192.png`, `pwa-512.png`, and favicon assets. If using this example, register the generated service worker in the client entry point with the `virtual:pwa-register` helper as documented by `vite-plugin-pwa`. Check that Vite's configured base path matches the deployment origin.

Use an explicit “Prepare for offline use” button while online:
1. Confirm teacher is authenticated.
2. Fetch assigned classes and their active students.
3. Save them into IndexedDB.
4. Load/cache the approved face models.
5. Show a ready summary: classes cached, student count, last refreshed timestamp.
6. Do not cache face descriptors for classes the teacher is not authorized to access.

## 5. Offline-aware data loading

For each selected class:
1. Try to fetch current class and student data from API.
2. If successful, refresh IndexedDB.
3. If request fails because of network failure, load the most recently cached class and students from IndexedDB.
4. Show “Offline — data last updated at …”.
5. Do not interpret a server 401/403 as an offline condition. Clear or restrict the session when the server rejects it.

Example:

```js
import { offlineDb, cacheStudents } from "./offlineDb";
import api from "./api";

export async function getStudentsOfflineFirst(classId) {
  try {
    const { data } = await api.get("/students", { params: { classId } });
    await cacheStudents(data, classId);
    return { students: data, fromCache: false };
  } catch (error) {
    if (error.response?.status) throw error; // 401/403/validation errors are not offline
    const students = await offlineDb.students.where("classId").equals(String(classId)).toArray();
    if (!students.length) throw new Error("No cached students for this class. Connect to the internet once to prepare offline use.");
    return { students, fromCache: true };
  }
}
```

## 6. Saving attendance offline

Do not send an attendance request first and only save locally if it fails. The safer flow is:
1. Validate that every student has an explicit status.
2. Save the attendance draft and outbox mutation in one IndexedDB transaction.
3. Immediately show “Saved on this device — waiting to sync”.
4. If online, try to sync the outbox.
5. Only mark as synced after the API confirms the mutation.
6. If the request times out, leave it pending. A timeout does not prove that the server failed to save it.

Example queue processor (adapt endpoint and error handling):

```js
import { offlineDb } from "./offlineDb";
import api from "./api";

let syncInProgress = false;

export async function syncPendingAttendance() {
  if (syncInProgress || !navigator.onLine) return;
  syncInProgress = true;
  try {
    const pending = await offlineDb.outbox
      .where("state").equals("pending")
      .sortBy("createdAt");

    for (const item of pending) {
      try {
        const { data } = await api.post("/sync/attendance", item.payload);
        await offlineDb.transaction("rw", offlineDb.outbox, offlineDb.attendanceDrafts, async () => {
          await offlineDb.outbox.update(item.localId, { state: "synced", serverResult: data, syncedAt: new Date().toISOString() });
          const ids = item.payload.records.map(r => `${item.payload.classId}:${item.payload.dateKey}:${r.studentId}`);
          for (const id of ids) {
            const draft = await offlineDb.attendanceDrafts.get(id);
            if (draft) await offlineDb.attendanceDrafts.update(id, { syncState: "synced" });
          }
        });
      } catch (error) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          await offlineDb.outbox.update(item.localId, { state: "needs-auth", lastError: "Sign in online to sync." });
          break;
        }
        if (error.response?.status >= 400 && error.response?.status < 500) {
          await offlineDb.outbox.update(item.localId, { state: "needs-review", lastError: error.response.data?.message || "Server rejected this change." });
          continue;
        }
        // Network errors and server errors stay pending for a later retry.
        await offlineDb.outbox.update(item.localId, { lastError: "Temporary sync failure", lastAttemptAt: new Date().toISOString() });
        break;
      }
    }
  } finally {
    syncInProgress = false;
  }
}

window.addEventListener("online", () => syncPendingAttendance());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncPendingAttendance();
});
```

Call `syncPendingAttendance()` after login, on app start, after attendance is saved, when the browser's `online` event fires, and from the visible Sync now button. `navigator.onLine` is only a hint; the actual API request determines whether the server is reachable.

Background Sync may be added as an enhancement, but do not rely on it alone because browser support and scheduling are limited. Keep the pending outbox until the server has confirmed receipt.

## 7. Server sync endpoint and idempotency

Add a `SyncMutation` collection with:
- `mutationId` (unique index)
- `actorId`
- `kind`
- `result`
- timestamps

For `POST /api/sync/attendance`:
1. Require a valid authenticated user.
2. Require a valid UUID `mutationId`.
3. Check whether that mutation ID was already applied. If yes, return the stored result.
4. Verify the teacher can access the requested class.
5. Verify every student belongs to that class and is active.
6. Validate `dateKey` and status values.
7. Upsert attendance using the unique key `(studentId, classId, dateKey)`.
8. Record who made the change, when it was received, and whether it came from offline sync.
9. Store the mutation result so a retried request is safe.
10. Return the IDs/counts accepted and any per-student failures.

For stronger guarantees, apply attendance writes and the mutation receipt in a MongoDB transaction where the selected MongoDB deployment supports transactions. Otherwise use a carefully designed idempotent write and receipt process; do not claim exactly-once delivery merely because the client retries.

Add conflict rules:
- If two teachers changed the same student/date offline, don't silently overwrite one change.
- Include `baseUpdatedAt` or a server version in each queued record.
- If the current server version differs from the version the teacher saw, return a conflict for review.
- Admin may resolve conflicts with an audit record.
- Unique indexes prevent duplicate attendance rows but do not alone solve conflicting edits.

## 8. Offline login and device security

Offline login is a design decision, not just a cache setting:
- The first login must be online.
- Keep a short-lived session token and cached minimal user/role/class assignment information on the device.
- Offline access should be limited to classes and data downloaded previously.
- When the token expires, let the teacher continue to save local drafts but mark them “Needs sign-in to sync”; do not allow the app to bypass server authorization.
- Require online re-authentication to upload data after expiry.
- Do not store plaintext passwords in IndexedDB/localStorage.
- Consider using a native app/device management if stronger at-rest encryption is required; browser storage alone is not a full security boundary.
- Provide “Sign out and remove local data from this device” with a confirmation. If unsynced attendance exists, warn before clearing it.
- Use HTTPS for deployed app and API.

## 9. Face detection and manual attachment

- Reference photo capture should be a separate student enrolment step.
- Keep face descriptors only if there is appropriate consent and a clear retention policy.
- Cache only authorized descriptors for the teacher's assigned classes.
- Classroom photo processing should run on the device where possible.
- Do not upload the full classroom image by default.
- If a face is not detected, show the full manual register.
- If detected but unmatched, display “Attach student manually” with a searchable student list.
- After attachment, mark a suggested status, but still require teacher review.
- Never mark absent students automatically based only on whether their face was found in a photo.
- Include a way to remove/re-enrol a reference photo and delete a descriptor.
- Test in actual classroom lighting and on low-end Android devices. Face matching is fallible and this starter has no liveness detection.

## 10. Reports and archive

Reports must distinguish:
- Attendance status: present / absent / late / excused.
- Not marked: no attendance record; do not count as absent.
- Offline pending: locally saved but not yet confirmed by server.
- Synced: server confirmed.
- Conflict/review: server rejected or another user edited the same record.

Six-month archive procedure:
1. Export student roster, class data, attendance rows and audit logs.
2. Create a compressed MongoDB backup with `mongodump --archive --gzip`.
3. Store two copies in separate controlled locations.
4. Verify checksum and restore into a separate test database.
5. Compare record counts and sample records.
6. Only after successful verification and policy approval, archive/delete eligible old attendance.
7. Keep active student profiles and current classes; never automatically erase all data.
8. MongoDB backups do not include external image objects, so separately export photo metadata and ensure images have an approved retention/backup plan.

## 11. Deployment

- Frontend: Vercel/Netlify with HTTPS; ensure the same deployed origin is used consistently for installed PWA data.
- API: Render; free service can sleep/restart, so use MongoDB/object storage for persistence, not Render local disk.
- Database: MongoDB Atlas; restrict DB user privileges and IP/network access as practical.
- Set `VITE_API_URL` to the deployed API base.
- Set `CLIENT_ORIGIN` on server to the exact deployed frontend origin.
- Use strong random `JWT_SECRET`; keep secrets in provider environment settings.
- Configure face model assets in the build and verify they are cached before offline use.
- Add health checks and backup monitoring. A 10-minute ping is best effort only and not a guarantee of uptime.
- Never put student photos, database URIs, credentials, `.env`, or backup files in the public Git repository.

## 12. Acceptance tests (must pass before real data)

1. Online login, prepare offline data, install PWA.
2. Enable airplane mode and reopen the installed app.
3. Open cached class/student list.
4. Mark every student and save; app says locally saved and pending.
5. Close/reopen app offline; drafts still exist.
6. Turn internet on; pending records sync.
7. Refresh server attendance; records are present once only.
8. Simulate request timeout after server write; retry must not duplicate or corrupt records.
9. Change same attendance from two devices offline; conflict is visible and auditable.
10. Expire token while offline; local save works but upload waits for re-authentication.
11. Face models available offline: detect/match; attach unmatched face manually.
12. Face models missing or no faces detected: manual register still works.
13. Export CSV, XLSX and PDF online; verify names, date range, statuses and UTF-8.
14. Test Urdu right-to-left layout and Telugu text on Android.
15. Test backup checksum and restore to a separate database.
16. Test when local storage is full, user clears browser data, and app updates; show warnings and never claim an unconfirmed backup exists.
17. Verify teacher cannot read another class by modifying API requests.
18. Verify no private student API response is served from a shared service-worker cache.

## 13. Recommended implementation order

1. Finish online authentication, class/student CRUD, attendance and exports.
2. Add IndexedDB schemas and offline caching.
3. Add PWA manifest/service worker and “Prepare for offline use”.
4. Change attendance save to write locally first and enqueue outbox.
5. Add idempotent sync endpoint, mutation receipts and conflict handling.
6. Add sync status indicators, Sync now, retry UI and needs-auth handling.
7. Add face model caching and manual attachment fallback.
8. Test on multiple Android phones and real connectivity interruptions.
9. Add backup/restore automation and archive workflow.
10. Deploy and test the production URL with dummy data before onboarding students.
