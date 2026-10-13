مَدْرَسَة  •  MADRASA AMANAH

# Smart Attendance System

Product blueprint · UX/UI specification · Offline-first engineering plan

Designed for 100–300 students · Android-first · English / Urdu / Telugu


## What this document is

A build-from-zero specification for the product, screens, workflows, data, APIs, offline sync, testing and deployment. It is not a claim that the existing starter source is already production-ready. The implementation should follow this plan and pass the acceptance tests before real student data is entered.


## 1. Product scope and outcomes

Primary outcome: a teacher can take a complete attendance register even when internet access is unreliable, then safely synchronize it later without duplicate records or silent overwrites.


## 2. MVP scope and non-goals

- Support 100–300 students and multiple classes/sections, with an academic year field.

- Student profile: admission number, name, class, guardian contact only if needed, active/inactive status, optional reference photo and consent record.

- Attendance statuses: Present, Absent, Late, Excused, and Not marked. Not marked is not equivalent to absent.

- Attendance register for a class and date, manual marking, photo-assisted face suggestions, manual face-to-student attachment, notes and audit trail.

- Offline app shell, cached authorized classes/students, local attendance drafts, persistent outbox, visible Sync now and conflict review.

- English, Urdu (RTL) and Telugu, including date/number formatting and translated validation messages.

- Reports by date range, class and student; CSV/XLSX/PDF exports; verified backups and restore drills.

- No payment collection, parent messaging, public student directory or AI-generated disciplinary judgments in the first release.


## 3. Brand and visual design system

Use icons with labels for important actions. Avoid emoji as primary UI icons, excessive gradients, ornamental Arabic calligraphy as a substitute for usability, and dark backgrounds. Maintain large tap targets (around 44×44 CSS px or larger), visible focus states, keyboard support and reduced-motion behaviour.


## 4. Information architecture


## 5. Screen-by-screen UX


### S01 — Sign in

Logo/name, email/username, password, show/hide password, language switch, clear error, help/contact admin. On first use requires online authentication. Explain that offline mode works only after preparation.


### S02 — Prepare for offline use

A deliberate checklist: assigned classes; student count; last refresh; face models cached; storage estimate; button Download data for offline use. Show completion/errors per step and a final Ready for offline use state.


### S03 — Dashboard

Greeting, current date, online/offline pill, last sync, pending count, class cards, today's attendance completion, quick Take attendance. Avoid misleading percentages if no register exists.


### S04 — Class picker

Assigned classes only; search; roster count; cached/fresh marker; academic year. No classes state points to admin.


### S05 — Attendance setup

Class, date, attendance period/session, existing saved register warning, last modified by. Prevent accidental duplicate registers for same class/date/session.


### S06 — Manual register

Search roster; student name/admission number; large Present/Absent/Late/Excused buttons; per-student note; status counts; Not marked count; sticky Save on device. Do not pre-mark everyone absent.


### S07 — Photo-assisted attendance

Capture/upload image, privacy note, local processing indicator, detected face count, confidence suggestions, duplicate-match warnings. Keep photo temporary; delete temporary image after processing unless retention was explicitly approved.


### S08 — Face review

Each detected face has a face number/crop, suggested student, match confidence category, confirm/change/mark unmatched actions. One student cannot be assigned to two detected faces without explicit review. Face suggestion never finalizes attendance.


### S09 — Unmatched face attachment

Search/select a student in the current authorized class, show admission number to avoid same-name mistakes, attach suggestion and ask teacher to confirm. Also allow ‘No match / use manual register’.


### S10 — Save confirmation

Say exactly ‘Saved on this device’ if offline. Say ‘Synced to server’ only after API confirmation. Show count by status, date/class, pending queue ID and next steps.


### S11 — Sync Center

Pending, syncing, synced, needs sign-in, needs review, conflict, retry button and Sync now. Each item shows class/date and safe error wording; never expose tokens or stack traces.


### S12 — Student directory

Search, filter by class/active status, add student, edit, deactivate rather than hard-delete. Avoid showing guardian phone in the default list.


### S13 — Student form

Admission number, full name, class, optional guardian data, reference photo and consent state, validation and duplicate admission-number handling.


### S14 — Class management

Class name, section, academic year, active state, roster count, assigned teachers. Warn before moving students because history belongs to the original class/date.


### S15 — Teacher management

Name, login identifier, role, assigned classes, account state, reset flow. Never display password after creation.


### S16 — Reports

Date range, class, student, status, attendance completion and export type. Make timezone/date range explicit and exclude unmarked dates from absent totals.


### S17 — Archive/backup

Last backup, backup result, checksum, retention period, restore drill date, export/archive action with explicit confirmation. Never clear data automatically just because six months passed.


### S18 — Language/accessibility

English, اردو, తెలుగు; RTL layout; font scaling; readable focus states; translated errors; consistent date/number display.


## 6. Critical user flows


### A. First-time setup

1. Admin signs in online and changes the temporary password.

1. Admin creates academic year, classes and sections.

1. Admin creates teacher accounts and assigns only the relevant classes.

1. Admin imports/enrols students, validates unique admission numbers and records photo consent where applicable.

1. Teacher signs in online on the device they will use for attendance.

1. Teacher selects Prepare for offline use; the app downloads only authorized class/student data and required model assets.

1. App verifies cached records and shows a clear offline-ready checklist.


### B. Daily attendance with internet

1. Teacher chooses assigned class and date/session.

1. Teacher chooses manual register or photo-assisted suggestions.

1. Teacher reviews each student; detected faces are suggestions only.

1. Teacher marks every student Present/Absent/Late/Excused; unresolved rows remain Not marked.

1. App saves locally first, then sends the idempotent mutation to the API.

1. Server validates role, class assignment, student membership and duplicate mutation ID.

1. App shows Synced only after acknowledgement and refreshes server version.


### C. Daily attendance without internet

1. Open the already installed app; load cached class/student data.

1. Show offline banner and last cache refresh time.

1. Process cached face models locally if available; otherwise continue manual attendance.

1. Save draft and outbox in one IndexedDB transaction.

1. Show ‘Saved on this device — waiting to sync’ with pending count.

1. If app closes, the local draft and outbox remain in IndexedDB unless browser/site data is cleared or storage is evicted.

1. When internet returns, retry on app start, visibility change, online event and Sync now; do not rely only on browser Background Sync.

1. After server acknowledgement, mark synced. If auth expired, keep the item and request online sign-in. If data conflicts, hold for review instead of silently overwriting.


### D. Face-assisted flow

1. Use consented student reference descriptors, scoped to the current class.

1. Detect and match locally when model assets are available.

1. Display suggestion and match quality; teacher confirms or corrects each suggestion.

1. If no face is found, a descriptor is missing, lighting is poor or model load fails, offer manual register immediately.

1. Never infer absence from a face not being found in a single photo.

1. Avoid keeping full classroom images; explain temporary processing and retention to users.


## 7. Technical architecture


## 8. Data model

Use stable server IDs and keep a mapping from local temporary IDs to server IDs if offline creation of students/classes is ever added. For the MVP, keep class/student creation online-only; allow offline attendance for previously downloaded records. This greatly reduces sync conflicts.


## 9. API outline


## 10. Offline sync state machine

The server must store mutation receipts and return the same result for repeated mutation IDs. Use optimistic concurrency with a server version or baseUpdatedAt. A unique attendance index prevents duplicate rows but does not resolve conflicting edits by itself.


## 11. Security, privacy and safeguarding

- Obtain appropriate written consent and explain why facial processing is used, who can access it, how long it is kept, and how to opt out or use manual attendance.

- Children's facial descriptors are sensitive biometric data. Confirm applicable local law and institutional policy before collection. If lawful basis/consent is unclear, launch with manual attendance first.

- Teacher confirmation is mandatory; no automatic absence decision based on photo matching.

- Minimize guardian details; do not expose phone numbers in directory views or logs.

- Use HTTPS, secure headers, input validation, request size limits, rate limits and least-privilege database credentials.

- Protect offline device data with device PIN/lock, short session lifetime, minimal cached data, sign-out cleanup and warning before deleting unsynced records.

- Never put `.env`, database URI, JWT secret, face descriptors, photos or backups into a public repository.

- Audit student edits, attendance changes, exports, role changes, conflict resolutions and retention actions.

- Create a retention policy with named owner and approval; do not automatically delete everything every six months.


## 12. Hosting, storage and backups

A free-tier setup can be used for a prototype, but it cannot guarantee always-on service. A Render health ping every ten minutes is best-effort only; free instances may sleep or checks may be delayed. The offline client must continue to work without the API.

- Frontend hosting: Vercel/Netlify or equivalent HTTPS static hosting.

- API hosting: Render or equivalent; assume cold starts and transient outages.

- Database: MongoDB Atlas; monitor the current plan quota and alerts.

- Images: optional private object storage; retain only approved reference photos, not every classroom image.

- Backup: scheduled mongodump archive with gzip, checksum, separate secure copy, and restore test into a separate database.

- Six-month archive: export CSV/XLSX/PDF plus full database backup, verify checksum and record counts, test restore, then delete only eligible records after policy approval.

- Compressed backups do not reduce live database usage. Track database size, indexes and image storage separately.


## 13. Quality assurance acceptance plan

- ☐ Fresh install and login on Android Chrome; installable PWA icon and standalone launch.

- ☐ Prepare offline while connected; confirm correct class scope and all required model files cached.

- ☐ Enable airplane mode, close and reopen app; cached classes and students load.

- ☐ Mark attendance for 300 students offline; all drafts persist after app restart.

- ☐ Simulate no faces, poor light, missing models and unmatched face; manual workflow always works.

- ☐ Return internet; sync all pending records and verify each appears once on server.

- ☐ Simulate timeout after server write; retry same mutation ID and confirm no duplicate row.

- ☐ Make same record edits on two devices offline; conflict must be visible and audited, not silently overwritten.

- ☐ Expire token offline; local save still works but upload waits for re-authentication.

- ☐ Attempt cross-class API access as teacher; server rejects it.

- ☐ Test 401/403 handling; do not mislabel authorization failure as offline mode.

- ☐ Test Urdu RTL layout, Telugu characters, large text, keyboard/focus and screen-reader labels.

- ☐ Export each format with Unicode names, selected dates, correct statuses and no silent omission.

- ☐ Restore backup to separate DB and compare record counts/sample records.

- ☐ Test full/evicted browser storage, cleared site data, service-worker update and interrupted sync; warnings are clear.


## 14. Build order from zero


### Phase 0 — Confirm policy

Confirm who is admin, class/session definition, attendance statuses, retention duration, consent process and offline devices.


### Phase 1 — UX prototype

Create mobile-first wireframes and clickable flows for sign-in, dashboard, class selection, manual attendance, photo review, sync center, reports and admin.


### Phase 2 — Design system

Implement tokens, typography, buttons, forms, cards, badges, tables, empty/error/loading states, RTL and responsive layouts.


### Phase 3 — Online foundation

Build auth, class/student management, role checks, attendance API, audit logs and reports using test data.


### Phase 4 — Offline foundation

Add PWA caching, IndexedDB schemas, offline preparation, cached class/student loading and local-first save.


### Phase 5 — Safe sync

Implement durable outbox, idempotent API receipts, retry policy, auth-expiry state, conflict detection and Sync Center.


### Phase 6 — Face assistance

Cache model files, enrol reference descriptor with consent, local matching, teacher review, unmatched attachment and manual fallback.


### Phase 7 — Reports and operations

Exports, backup scripts, restore drills, retention workflow, quota alerts and minimal monitoring.


### Phase 8 — Test & pilot

Use dummy data, test on actual low-end Android devices and poor connectivity, then pilot one class before wider rollout.


### Phase 9 — Production

Deploy HTTPS, lock down environment secrets, run acceptance checklist, train admin/teachers, define support and backup ownership.


## 15. Definition of done

The product is not ‘complete’ just because the UI renders or the API returns 200. It is ready for a controlled pilot only when offline saves survive restarts, sync retries are idempotent, conflicts are handled visibly, access controls are enforced server-side, reports match source records, restore is tested, privacy policy is approved, and the Android acceptance suite passes.


## Appendix — suggested repo layout

madrasa-amanah/
  apps/
    web/                  # React + Vite PWA
    api/                  # Express REST API
  packages/
    ui/                   # shared design tokens/components
    shared/               # schemas, status enums, validation
  docs/
    product-requirements.md
    ux-ui-spec.md
    offline-sync-design.md
    privacy-retention.md
    deployment-runbook.md
  scripts/
    backup-mongodb.sh
    restore-mongodb.sh
  .github/workflows/
    tests.yml
    backup-check.yml