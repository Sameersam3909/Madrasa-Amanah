# مَدْرَسَة  •  MADRASA AMANAH
## Smart Attendance System
### Mobile-First · Offline-First · Multilingual (English / اردو / తెలుగు)

Designed for 100–300 students. Built primarily for mobile phones (especially Android) so madrasa administrators and teachers can manage student profiles, monitor registers, and take attendance with one hand even when internet connectivity is completely unavailable.

---

## 🌟 Key Architecture & Capabilities

1. **Mobile-First & One-Handed Ergonomics**:
   - Responsive layout adapting from compact phones (320px–430px) through tablets and desktops.
   - Thumb-accessible bottom navigation (Dashboard, Take Attendance, Monitoring, Sync Center, Students, More).
   - Generous 44px+ touch targets for **Present**, **Absent**, **Late**, and **Excused**.
   - Responsive two-row student cards preventing horizontal viewport spillover.
   - Touch-friendly Mobile Action Sheet on mobile (< 600px) and clean dropdown on desktop.
   - Sticky Save action bar displaying live marked vs. not-marked counts.
   - One-tap "Mark All Present" helper to quickly process classes with manual exceptions.

2. **Offline-First & Durable Outbox**:
   - Immediate writes to client-side IndexedDB (`Dexie`) with a durable mutation outbox.
   - Distinct statuses: **"Saved on this device — waiting to sync"** vs. **"Synced to server"**.
   - Automatic background synchronization on app startup, network reconnection, and visibility change, with an explicit **Sync Now** button.
   - Idempotent backend endpoint (`POST /api/sync/attendance`) ensures network retries never create duplicate attendance records.

3. **Student & Attendance Management**:
   - Comprehensive student directory with class filters, active/archived status tabs, and instant search.
   - Student profile modal with attendance rate gauge, contact details, and class transfers.
   - Historical attendance drilldown with custom date ranges.
   - Guardian photo consent logging and secure student photo capture.

4. **Multi-Format Reporting & Automated Backups**:
   - Real-time attendance registers exportable in Excel (.xlsx), CSV, and printable PDF formats.
   - Automated weekly executive multi-sheet Excel reports sent via email.
   - Fully automated monthly Excel attendance backups executed via GitHub Actions and committed to the dedicated backup archive.

5. **Languages & Authentic Localization**:
   - Full support for **English**, **Urdu (اردو)** with authentic Right-To-Left (RTL) layout, and **Telugu (తెలుగు)**.

---

## 🚀 Quick Start (Local Run)

### Prerequisites
- Node.js 18+ (tested on Node 20 / 22 / 23)
- npm 9+

### Installation & Launch

```bash
# Install root, client, and server dependencies
npm run install:all

# Run both frontend and backend concurrently
npm run dev
```

- **Frontend (PWA)**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:4000](http://localhost:4000)

### Default Administrator Credentials
- **Email**: `admin@example.com`
- **Password**: `Admin12345678!`

*(Initial classes and sample student rosters are automatically seeded in local development if the database is empty).*

---

## 🛡 Security, Privacy & Safeguards

- **Biometric Privacy**: Reference photos are enrolled only with explicit guardian consent. Classroom photos are processed ephemerally in browser memory and immediately discarded. No raw classroom blobs or face descriptors are leaked into attendance exports.
- **Password Hashing**: Passwords hashed with `bcryptjs` (salt rounds: 12).
- **Role-Based Access Control (RBAC)**: Teachers can only access and record attendance for classes assigned to them. Administrative actions (student enrollment, transfers, deactivations, archives, roster exports) require admin authorization.
- **Database Safety**: Production connections reject destructive operations. Missing attendance records are never silently counted as absent.

---

## 💾 Data Retention, Backup Policy & Disaster Recovery

### Recommended Policy for 100–300 Students
Do not automatically erase data every six months. Follow a verified archive-and-verify cycle:

1. **Periodic Human-Readable Exports**: Export 6-month registers in `.xlsx` or `.csv` format from the More / Reports view.
2. **Automated Monthly Backup**: The automated GitHub Action exports each calendar month's attendance to the private backup repository on the 1st of every month at 02:00 AM IST.
3. **Compressed Full Database Dump**:
   ```bash
   export MONGODB_URI='your-production-mongodb-connection-string'
   bash scripts/backup-mongodb.sh
   ```
4. **Off-site Storage**: Keep the compressed `.archive.gz` and matching `.sha256` checksum in two controlled locations (e.g. encrypted school drive and secure offline storage).
5. **Drill Restore into Test Database**:
   ```bash
   export MONGODB_URI='mongodb+srv://.../madrasa_restore_test'
   bash scripts/restore-mongodb.sh backups/madrasa-mongodb-YYYYMMDDTHHMMSSZ.archive.gz
   ```
   *Note: The restore script intentionally avoids `--drop` to protect existing collections. Review target database carefully.*
6. **Live Database Capacity**: MongoDB Atlas Free tier provides 512 MB. Large binary classroom photos must never be stored in MongoDB documents; store only Cloudinary URLs or metadata.

---

## 📦 Deployment Guide

### 1. Backend API (Render / Railway / VPS)
1. Push this repository to GitHub (`Sameersam3909/Madrasa-Amanah`).
2. In Render, create a **New Web Service** pointing to the `server/` root directory.
3. **Build Command**: `npm install`
4. **Start Command**: `node src/index.js`
5. **Environment Variables**:
   - `PORT`: `4000`
   - `NODE_ENV`: `production`
   - `MONGODB_URI`: Production MongoDB Atlas connection string
   - `JWT_SECRET`: Secure 32+ character random secret
   - `CLIENT_ORIGIN`: Your deployed frontend domain (e.g. `https://madrasa-amanah.vercel.app`)
   - `BACKUP_SERVICE_TOKEN`: Secret bearer token shared with the backup workflow
   - `REPORT_RECIPIENT_EMAIL`: Email for weekly automated reports
   - `CLOUDINARY_CLOUD_NAME`: Cloudinary cloud name
   - `CLOUDINARY_API_KEY`: Cloudinary API key
   - `CLOUDINARY_API_SECRET`: Cloudinary API secret

### 2. Frontend PWA (Vercel)
1. Connect GitHub repository `Sameersam3909/Madrasa-Amanah` to Vercel.
2. **Root Directory**: `client`
3. **Build Command**: `npm run build`
4. **Output Directory**: `dist`
5. **Environment Variables**:
   - `VITE_API_URL`: Your deployed backend API URL (e.g. `https://madrasa-attendance-api.onrender.com/api`)

### 3. Automated Monthly Attendance Backup Repository
Attendance backups are stored in the dedicated archive repository:
`https://github.com/Sameersam3909/-Madrasa_Attandace`
The automated GitHub Actions workflow runs on the 1st of every month at 02:00 AM IST (`20:30 UTC`), connects to the backend export endpoint, computes a SHA-256 integrity hash, and commits the `.xlsx` workbook and `.sha256` checksum into `backups/YYYY/`.

---

## 🛠 Project Structure

```
madrasa-smart-attendance/
├── .github/
│   └── workflows/
│       ├── monthly-attendance-backup.yml # Automated monthly backup workflow
│       └── render-health-check.yml       # Production health monitor
├── client/                               # React 18 + Vite PWA + Tailwind
│   ├── public/
│   │   ├── favicon.svg                   # Madrasa Amanah brand mark
│   │   └── models/                       # Retained face-api model weights
│   ├── src/
│   │   ├── App.jsx                       # Responsive mobile-first UI & workflows
│   │   ├── offlineDb.js                  # Dexie IndexedDB durable outbox
│   │   ├── i18n.js                       # English, Urdu (RTL) & Telugu dictionary
│   │   ├── api.js                        # Axios API client with auth interceptor
│   │   └── styles.css                    # Responsive design system
│   └── vite.config.js                    # Vite PWA & Workbox build config
├── server/                               # Node.js + Express API
│   ├── src/
│   │   ├── index.js                      # Express application & endpoints
│   │   ├── models.js                     # Mongoose schemas
│   │   ├── db.js                         # MongoDB Atlas database connection
│   │   ├── auth.js                       # JWT auth & RBAC middleware
│   │   ├── monthlyBackupService.js       # Excel backup generator & validator
│   │   └── weeklyReportService.js        # Weekly report automation
│   ├── package.json
│   └── .env.example
├── scripts/
│   ├── export-monthly-backup.js          # CLI export & validation tool
│   ├── backup-mongodb.sh                 # mongodump archive utility
│   └── restore-mongodb.sh                # mongorestore validation utility
├── backups/                              # Local backup storage
│   └── 2026/
│       ├── 2026-09-attendance.xlsx       # Validated monthly backup
│       └── 2026-09-attendance.xlsx.sha256# SHA-256 checksum
└── render.yaml                           # Infrastructure as code
```
