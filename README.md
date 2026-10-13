# مَدْرَسَة  •  MADRASA AMANAH
## Smart Attendance System
### Mobile-First · Offline-First · Multilingual (English / اردو / తెలుగు)

Designed for 100–300 students. Built primarily for mobile phones (especially Android) so teachers can take class attendance with one hand even when internet connectivity is completely unavailable.

---

## 🌟 Key Architecture & Capabilities

1. **Mobile-First & One-Handed Ergonomics**:
   - Primary design target: 360×800 to 414×896 mobile viewports.
   - Thumb-accessible bottom navigation (Dashboard, Take Attendance, Sync Center, Students, More).
   - Generous 48px+ touch targets for **Present**, **Absent**, **Late**, and **Excused**.
   - Sticky bottom Save action bar displaying live marked vs. not-marked counts.
   - One-tap "Mark All Present" helper to quickly process large classes with manual exceptions.

2. **Offline-First & Durable Outbox**:
   - Writes attendance drafts and idempotent mutations to IndexedDB (`Dexie`) immediately.
   - Displays **"Saved on this device — waiting to sync"** until server acknowledges receipt.
   - Automatic background sync on app start, network reconnection, and visibility change, plus a manual **Sync Now** button.
   - Idempotent API endpoint (`POST /api/sync/attendance`) ensures duplicate network retries never create duplicate rows.

3. **Facial Matching with Teacher Trust**:
   - Reference photos enrolled with guardian consent.
   - Browser-based face detection runs locally on the device (no raw classroom blobs stored on server).
   - Face matching produces **suggestions only**; teacher review and confirmation is mandatory.
   - Missing faces never trigger automatic absences.

4. **Languages & Localization**:
   - Full support for **English**, **Urdu (اردو)** with authentic Right-To-Left (RTL) layout, and **Telugu (తెలుగు)**.

---

## 🚀 Quick Start (Local Run)

Both servers are currently configured and running:

- **Frontend (PWA)**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:4000](http://localhost:4000)

### Default Administrator Credentials
- **Email**: `admin@example.com`
- **Password**: `Admin12345678!`

*(Classes and initial students are automatically seeded on startup)*

---

## 🛠 Project Structure

```
madrasa-smart-attendance/
├── client/                     # React 18 + Vite PWA + Tailwind
│   ├── public/
│   │   ├── favicon.svg         # Madrasa Amanah brand mark
│   │   └── models/             # Pre-installed @vladmandic/face-api model shards
│   ├── src/
│   │   ├── App.jsx             # Mobile-first UI, bottom navigation & workflows
│   │   ├── offlineDb.js        # Dexie IndexedDB durable outbox & sync processor
│   │   ├── i18n.js             # English, Urdu (RTL) and Telugu translations
│   │   ├── api.js              # Axios client with JWT interceptor
│   │   └── styles.css          # Design system & mobile-first tokens
│   └── vite.config.js          # VitePWA workbox service worker configuration
├── server/                     # Node.js + Express REST API
│   ├── src/
│   │   ├── index.js            # Express server, idempotent sync & reports
│   │   ├── models.js           # Mongoose schemas (User, Class, Student, Attendance, SyncMutation)
│   │   ├── db.js               # Resilient DB connector (MongoDB Atlas + Memory fallback)
│   │   ├── auth.js             # RBAC middleware & class access controls
│   │   └── cloudinary.js       # Cloudinary student reference photo storage
│   └── .env                    # Configured with MongoDB Atlas and Cloudinary
├── scripts/
│   ├── backup-mongodb.sh       # Compressed mongodump backup with sha256 checksum
│   └── restore-mongodb.sh      # Verified mongorestore script
└── package.json                # Root package with unified scripts
```

---

## 📦 Deployment Guide

### 1. Backend (e.g. Render / Railway / VPS)
1. Push this repository to GitHub.
2. In Render, create a **New Web Service** pointing to the `server/` directory.
3. Build command: `npm install`
4. Start command: `node src/index.js`
5. Environment Variables:
   - `PORT`: `4000` (or leave default for Render)
   - `NODE_ENV`: `production`
   - `MONGODB_URI`: Your MongoDB Atlas connection string
   - `JWT_SECRET`: Random 32+ character secret
   - `CLIENT_ORIGIN`: Your deployed frontend domain (e.g. `https://madrasa-attendance.vercel.app`)
   - `CLOUDINARY_CLOUD_NAME`: `lfvphfvl`
   - `CLOUDINARY_API_KEY`: `448565179921349`
   - `CLOUDINARY_API_SECRET`: `2a6ps_bIxkfJuprULDjf45ehlTg`

### 2. Frontend (e.g. Vercel / Netlify)
1. Create a **New Project** pointing to the `client/` directory.
2. Build command: `npm run build`
3. Output directory: `dist`
4. Environment Variables:
   - `VITE_API_URL`: Your deployed backend API URL (e.g. `https://madrasa-api.onrender.com/api`)

### 3. MongoDB Atlas Network Access
If using MongoDB Atlas:
- In the MongoDB Atlas Console, go to **Network Access** > **IP Access List**.
- Add IP Address `0.0.0.0/0` (Allow Access From Anywhere) or the static outbound IP of your hosting provider.

---

## 🛡 Security & Safeguards

- Biometric face descriptors are stored only with explicit guardian consent.
- Classroom photos are processed ephemerally in browser memory and discarded.
- Passwords hashed with `bcryptjs` (salt rounds: 12).
- Role-Based Access Control (RBAC): Teachers can only access classes assigned to them.
