import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Bell,
  BookOpen,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  FlipHorizontal,
  GraduationCap,
  HardDrive,
  HelpCircle,
  History,
  Image,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  User,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import api from "./api";
import { translations } from "./i18n";
import {
  offlineDb,
  cacheClasses,
  cacheStudents,
  saveAttendanceLocally,
  queuePhotoUpdate,
  syncPendingAttendance,
  getPendingOutboxCount,
  getAllOutboxItems,
  retryOutboxMutation,
  getLastSyncTime,
  setLastSyncTime,
  checkStorageEstimate
} from "./offlineDb";

const today = () => new Date().toLocaleDateString("en-CA");
const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong.";
const readDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
const distance = (a, b) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("madrasa_token") || "");
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem("madrasa_user");
    return saved ? JSON.parse(saved) : null;
  });
  const [lang, setLang] = useState(localStorage.getItem("madrasa_lang") || "en");
  const [tab, setTab] = useState("dashboard");
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Core Data
  const [classes, setClasses] = useState([]);
  const [students, setStudents] = useState([]);
  const [selectedClass, setSelectedClass] = useState("");
  const [dateKey, setDateKey] = useState(today());
  const [sessionKey, setSessionKey] = useState("morning");
  const [records, setRecords] = useState({});
  const [notes, setNotes] = useState({});

  // Active Student Profile View Modal
  const [viewingStudent, setViewingStudent] = useState(null);
  const [profilePreviewPhoto, setProfilePreviewPhoto] = useState(null);
  const [profilePreviewDescriptor, setProfilePreviewDescriptor] = useState(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState("user");
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  // Attendance Submission Confirmation Modal
  const [confirmationModal, setConfirmationModal] = useState(null);

  // In-App Teacher Notification Center
  const [notifications, setNotifications] = useState(() => {
    try {
      const saved = localStorage.getItem("madrasa_notifications");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [showNotificationDrawer, setShowNotificationDrawer] = useState(false);

  // Sync & Storage State
  const [pendingCount, setPendingCount] = useState(0);
  const [outboxItems, setOutboxItems] = useState([]);
  const [lastSyncTime, setLastSync] = useState(null);
  const [storageEstimate, setStorageEstimate] = useState("");
  const [offlinePrep, setOfflinePrep] = useState({
    classesCount: 0,
    studentsCount: 0,
    modelsCached: false,
    ready: false,
    loading: false
  });

  // UI State
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Forms
  const [login, setLogin] = useState({ email: "admin@example.com", password: "Admin12345678!" });
  const [studentForm, setStudentForm] = useState({
    admissionNo: "",
    name: "",
    guardianName: "",
    guardianPhone: "",
    consentGiven: true
  });
  const [classPhoto, setClassPhoto] = useState(null);
  const [detected, setDetected] = useState([]);
  const [classForm, setClassForm] = useState({ name: "", section: "Morning", academicYear: "1447-1448 / 2026" });
  const [report, setReport] = useState([]);
  const [reportRange, setReportRange] = useState({
    from: new Date().toLocaleDateString("en-CA").slice(0, 7) + "-01",
    to: today()
  });

  const t = translations[lang] || translations.en;
  const activeClass = classes.find((c) => String(c._id || c.id) === String(selectedClass));

  // Counts
  const presentCount = Object.values(records).filter((r) => r.status === "present" || r.status === "late").length;
  const absentCount = Object.values(records).filter((r) => r.status === "absent").length;
  const markedTotal = Object.keys(records).length;
  const notMarkedCount = Math.max(0, students.length - markedTotal);

  const filteredStudents = useMemo(
    () =>
      students.filter((s) =>
        `${s.name} ${s.admissionNo}`.toLowerCase().includes(search.toLowerCase())
      ),
    [students, search]
  );

  // Save notifications
  useEffect(() => {
    localStorage.setItem("madrasa_notifications", JSON.stringify(notifications));
  }, [notifications]);

  function addNotification({ title, message, type = "info", metadata = {} }) {
    const id = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    setNotifications((prev) => [
      { id, title, message, type, timestamp: new Date().toISOString(), read: false, metadata },
      ...prev.slice(0, 49)
    ]);
  }

  // Listen for 401 Unauthorized globally
  useEffect(() => {
    const handleUnauthorized = () => {
      logout();
    };
    window.addEventListener("auth:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
  }, []);

  // Sync & Online Listeners
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ur" ? "rtl" : "ltr";
    localStorage.setItem("madrasa_lang", lang);
  }, [lang]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      triggerSync();
    };
    const handleOffline = () => setIsOnline(false);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") triggerSync();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);

    refreshSyncStatus();
    checkStorageEstimate().then(setStorageEstimate);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // Validate Session on Load
  useEffect(() => {
    if (!token) return;
    api
      .get("/auth/me")
      .then((r) => {
        setUser(r.data);
        localStorage.setItem("madrasa_user", JSON.stringify(r.data));
      })
      .catch((e) => {
        if (e.response?.status === 401) {
          logout();
        }
      });
  }, [token]);

  // Load Classes (Network first, then IndexedDB fallback)
  useEffect(() => {
    if (!token || !user) return;
    loadClassesOfflineFirst();
  }, [token, user]);

  async function loadClassesOfflineFirst() {
    try {
      const res = await api.get("/classes");
      setClasses(res.data);
      await cacheClasses(res.data);
      if (!selectedClass && res.data.length) setSelectedClass(res.data[0]._id || res.data[0].id);
    } catch {
      const cached = await offlineDb.classes.toArray();
      if (cached.length) {
        setClasses(cached);
        if (!selectedClass) setSelectedClass(cached[0].id);
      }
    }
  }

  // Load Students and Attendance for Selected Class
  useEffect(() => {
    if (!token || !user || !selectedClass) return;
    loadStudentsAndAttendanceOfflineFirst(selectedClass, dateKey, sessionKey);
  }, [token, user, selectedClass, dateKey, sessionKey]);

  async function loadStudentsAndAttendanceOfflineFirst(classId, date, session) {
    try {
      const res = await api.get("/students", { params: { classId } });
      setStudents(res.data);
      await cacheStudents(res.data, classId);
    } catch {
      const cached = await offlineDb.students.where("classId").equals(String(classId)).toArray();
      setStudents(cached);
    }

    try {
      const res = await api.get("/attendance", { params: { classId, dateKey: date, sessionKey: session } });
      const next = {};
      const noteMap = {};
      res.data.forEach((a) => {
        const sid = a.studentId?._id || a.studentId;
        next[sid] = { status: a.status };
        if (a.note) noteMap[sid] = a.note;
      });
      setRecords(next);
      setNotes(noteMap);
    } catch {
      const drafts = await offlineDb.attendanceDrafts
        .where("classId")
        .equals(String(classId))
        .filter((d) => d.dateKey === date && (d.sessionKey === session || !d.sessionKey))
        .toArray();
      const next = {};
      const noteMap = {};
      drafts.forEach((d) => {
        next[d.studentId] = { status: d.status };
        if (d.note) noteMap[d.studentId] = d.note;
      });
      setRecords(next);
      setNotes(noteMap);
    }
  }

  // Refresh Sync Status
  async function refreshSyncStatus() {
    const count = await getPendingOutboxCount();
    setPendingCount(count);
    const items = await getAllOutboxItems();
    setOutboxItems(items);
    const last = await getLastSyncTime();
    setLastSync(last);
  }

  async function triggerSync() {
    if (!token) return;
    try {
      const result = await syncPendingAttendance(api);
      await refreshSyncStatus();
      if (result?.processed > 0) {
        addNotification({
          title: "Synchronization Complete",
          message: `${result.processed} pending register(s) confirmed by MongoDB Atlas.`,
          type: "success"
        });
      }
    } catch (e) {
      console.warn("Sync:", e.message);
    }
  }

  function logout() {
    localStorage.removeItem("madrasa_token");
    localStorage.removeItem("madrasa_user");
    setToken("");
    setUser(null);
    setClasses([]);
    setStudents([]);
    stopCamera();
  }

  async function signIn(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await api.post("/auth/login", login);
      localStorage.setItem("madrasa_token", r.data.token);
      localStorage.setItem("madrasa_user", JSON.stringify(r.data.user));
      setToken(r.data.token);
      setUser(r.data.user);
      triggerSync();
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  // Face API Loader
  async function loadFaceApi() {
    const faceapi = await import("@vladmandic/face-api");
    const base = "/models";
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(base),
      faceapi.nets.faceLandmark68Net.loadFromUri(base),
      faceapi.nets.faceRecognitionNet.loadFromUri(base)
    ]);
    return faceapi;
  }

  // Extract Face Descriptor from image data URL
  async function extractDescriptor(dataUrl) {
    try {
      const faceapi = await loadFaceApi();
      const img = await faceapi.fetchImage(dataUrl);
      const res = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.48 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      return res ? Array.from(res.descriptor) : null;
    } catch {
      return null;
    }
  }

  // Camera Management (getUserMedia)
  async function startCamera(facing = "user") {
    setCameraFacing(facing);
    stopCamera();
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Direct camera access not supported. Using photo picker fallback.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCameraActive(true);
    } catch (err) {
      setError(err.message);
      document.getElementById("profile-camera-file-input")?.click();
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }

  function snapPhoto() {
    if (!videoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth || 480;
    canvas.height = videoRef.current.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    stopCamera();
    handleNewPhoto(dataUrl);
  }

  async function handleNewPhoto(dataUrl) {
    setProfilePreviewPhoto(dataUrl);
    setNotice("Processing face descriptor...");
    const desc = await extractDescriptor(dataUrl);
    setProfilePreviewDescriptor(desc);
    if (desc) {
      setNotice("Photo captured and face descriptor ready ✓");
    } else {
      setNotice("Photo captured. (No face detected; manual attendance is always available).");
    }
  }

  // Save / Replace Reference Photo
  async function saveStudentPhoto() {
    if (!viewingStudent || !profilePreviewPhoto) return;
    setLoading(true);
    setError("");
    const studentId = viewingStudent._id || viewingStudent.id;

    try {
      if (isOnline) {
        const { data } = await api.patch(`/students/${studentId}`, {
          photoDataUrl: profilePreviewPhoto,
          faceDescriptor: profilePreviewDescriptor
        });
        setStudents((prev) =>
          prev.map((s) => (String(s._id || s.id) === String(studentId) ? data : s))
        );
        setViewingStudent(data);
        await cacheStudents([data], selectedClass);
        addNotification({
          title: "Reference Photo Updated",
          message: `Photo for ${data.name} (${data.admissionNo}) saved and uploaded to Cloudinary.`,
          type: "success"
        });
        setNotice("Reference photo successfully updated and synced to Cloudinary.");
      } else {
        await queuePhotoUpdate({
          studentId,
          photoDataUrl: profilePreviewPhoto,
          faceDescriptor: profilePreviewDescriptor
        });
        addNotification({
          title: "Photo Saved Locally (Offline)",
          message: `Photo for ${viewingStudent.name} queued for Cloudinary sync when online.`,
          type: "warning"
        });
        setNotice("Saved on this device — photo queued to upload when internet reconnects.");
        await refreshSyncStatus();
      }
      setProfilePreviewPhoto(null);
      setProfilePreviewDescriptor(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  // Offline Preparation Checklist
  async function downloadOfflineData() {
    setOfflinePrep((prev) => ({ ...prev, loading: true }));
    setError("");
    setNotice("");
    try {
      const clsRes = await api.get("/classes");
      await cacheClasses(clsRes.data);

      let allStudentsCount = 0;
      for (const c of clsRes.data) {
        const sRes = await api.get("/students", { params: { classId: c._id } });
        await cacheStudents(sRes.data, c._id);
        allStudentsCount += sRes.data.length;
      }

      let modelsCached = false;
      try {
        await loadFaceApi();
        modelsCached = true;
      } catch (err) {
        console.warn("Models:", err.message);
      }

      await setLastSyncTime(new Date().toISOString());
      await refreshSyncStatus();
      const storage = await checkStorageEstimate();
      setStorageEstimate(storage);

      setOfflinePrep({
        classesCount: clsRes.data.length,
        studentsCount: allStudentsCount,
        modelsCached,
        ready: true,
        loading: false
      });
      setNotice("Offline data package successfully downloaded to this phone.");
      addNotification({
        title: "Offline Package Ready",
        message: `${clsRes.data.length} classes and ${allStudentsCount} students verified locally.`,
        type: "success"
      });
    } catch (e) {
      setError(errText(e));
      setOfflinePrep((prev) => ({ ...prev, loading: false }));
    }
  }

  // B: Save Attendance with Real Authoritative Confirmation
  async function saveAttendance() {
    setError("");
    setNotice("");
    const unmarked = students.filter((s) => !records[s._id || s.id]?.status);
    if (unmarked.length > 0) {
      setError(
        `Please mark all ${students.length} students. ${unmarked.length} student(s) still need a status.`
      );
      return;
    }

    setLoading(true);
    try {
      const studentRecords = students.map((s) => ({
        studentId: s._id || s.id,
        status: records[s._id || s.id].status,
        note: notes[s._id || s.id] || ""
      }));

      // 1. Transactional local save to Dexie outbox
      const localResult = await saveAttendanceLocally({
        classId: selectedClass,
        dateKey,
        sessionKey,
        source: detected.length ? "photo-assisted" : "manual",
        records: studentRecords
      });

      await refreshSyncStatus();

      const counts = {
        present: Object.values(records).filter((r) => r.status === "present").length,
        absent: Object.values(records).filter((r) => r.status === "absent").length,
        late: Object.values(records).filter((r) => r.status === "late").length,
        excused: Object.values(records).filter((r) => r.status === "excused").length
      };

      // 2. Online: Direct API save to MongoDB
      if (isOnline) {
        try {
          const res = await api.post("/attendance/bulk", {
            classId: selectedClass,
            dateKey,
            sessionKey,
            source: detected.length ? "photo-assisted" : "manual",
            records: studentRecords
          });

          // Mark outbox item synced if present
          const pendingItem = outboxItems.find(
            (item) => item.payload?.classId === String(selectedClass) && item.payload?.dateKey === dateKey
          );
          if (pendingItem) {
            await offlineDb.outbox.update(pendingItem.localId, {
              state: "synced",
              syncedAt: new Date().toISOString()
            });
            await refreshSyncStatus();
          }

          // Show Authoritative MongoDB Atlas Confirmation Modal
          setConfirmationModal({
            state: "synced",
            title: "Synced Successfully",
            className: activeClass ? activeClass.name : "Class",
            dateKey,
            sessionKey,
            totalStudents: students.length,
            counts,
            database: res.data.database || "MongoDB Atlas",
            timestamp: res.data.confirmedAt || new Date().toISOString()
          });

          addNotification({
            title: "Attendance Confirmed by Server",
            message: `${activeClass?.name || "Class"} (${sessionKey}) - ${students.length} marked. Confirmed by MongoDB.`,
            type: "success"
          });
        } catch {
          // If server failed during request, show accurate local-only confirmation
          setConfirmationModal({
            state: "pending",
            title: "Saved on this device — Waiting to sync",
            className: activeClass ? activeClass.name : "Class",
            dateKey,
            sessionKey,
            totalStudents: students.length,
            counts,
            database: "Local IndexedDB",
            timestamp: new Date().toISOString()
          });

          addNotification({
            title: "Attendance Saved Locally",
            message: `${activeClass?.name || "Class"} saved on device. Queued for background sync.`,
            type: "warning"
          });
        }
      } else {
        // Offline: Show accurate Saved on this device confirmation
        setConfirmationModal({
          state: "local-only",
          title: "Saved on this device",
          className: activeClass ? activeClass.name : "Class",
          dateKey,
          sessionKey,
          totalStudents: students.length,
          counts,
          database: "Local IndexedDB (Offline)",
          timestamp: new Date().toISOString()
        });

        addNotification({
          title: "Attendance Saved on Device (Offline)",
          message: `${activeClass?.name || "Class"} saved locally. Waiting for internet connection.`,
          type: "warning"
        });
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  function markAllPresent() {
    const next = { ...records };
    students.forEach((s) => {
      const sid = s._id || s.id;
      if (!next[sid]?.status) {
        next[sid] = { status: "present" };
      }
    });
    setRecords(next);
  }

  function mark(id, status) {
    setRecords((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), status } }));
  }

  // Classroom Photo Recognition
  async function processClassPhoto(file) {
    setClassPhoto(file);
    setDetected([]);
    setError("");
    setNotice("");
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Please select a photo under 8 MB.");
      const faceapi = await loadFaceApi();
      const img = await faceapi.fetchImage(URL.createObjectURL(file));
      const found = await faceapi
        .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.42 }))
        .withFaceLandmarks()
        .withFaceDescriptors();

      let index = [];
      try {
        const indexRes = await api.get("/students/face-index", { params: { classId: selectedClass } });
        index = indexRes.data.filter((s) => Array.isArray(s.faceDescriptor) && s.faceDescriptor.length);
      } catch {
        const localStudents = await offlineDb.students.where("classId").equals(String(selectedClass)).toArray();
        index = localStudents.filter((s) => Array.isArray(s.faceDescriptor) && s.faceDescriptor.length);
      }

      const matches = found.map((face, i) => {
        const d = Array.from(face.descriptor);
        const ranked = index
          .map((s) => ({ student: s, distance: distance(d, s.faceDescriptor) }))
          .sort((a, b) => a.distance - b.distance);
        const best = ranked[0];
        const confident = best && best.distance < 0.52;
        return {
          faceNo: i + 1,
          descriptor: d,
          studentId: confident ? best.student.id || best.student._id : "",
          matchName: confident ? best.student.name : "",
          distance: best ? best.distance : null,
          manual: !confident
        };
      });

      setDetected(matches);
      if (!found.length) {
        setNotice("No faces detected. Continue with manual register below.");
      } else {
        setNotice(`Detected ${found.length} face suggestion(s). Review each match below.`);
      }
    } catch (e) {
      setError(`${errText(e)} Continue with manual attendance.`);
    }
  }

  function attachFace(faceNo, studentId) {
    setDetected((prev) =>
      prev.map((f) => {
        if (f.faceNo !== faceNo) return f;
        const matched = students.find((s) => String(s._id || s.id) === String(studentId));
        return {
          ...f,
          studentId,
          matchName: matched ? matched.name : "",
          manual: true
        };
      })
    );
    if (studentId) {
      setRecords((prev) => ({
        ...prev,
        [studentId]: { ...(prev[studentId] || {}), status: "present" }
      }));
    }
  }

  // Reports
  async function fetchReport() {
    setError("");
    setLoading(true);
    try {
      const r = await api.get("/reports/summary", { params: { classId: selectedClass, ...reportRange } });
      setReport(r.data);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  // F: Download with Clean Human-Readable Filenames
  async function downloadReport(format) {
    setError("");
    setLoading(true);
    try {
      const className = activeClass ? `${activeClass.name}${activeClass.section ? `-${activeClass.section}` : ""}` : "Class";
      const cleanClassName = className.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      const generatedName = `Madrasa-Amanah-Attendance-${cleanClassName}-${reportRange.from}${reportRange.from !== reportRange.to ? `-to-${reportRange.to}` : ""}.${format === "xlsx" ? "xlsx" : format}`;

      const res = await api.get("/reports/export", {
        params: { classId: selectedClass, ...reportRange, format },
        responseType: "blob"
      });

      // Try reading filename from Content-Disposition header
      let finalFilename = generatedName;
      const disposition = res.headers["content-disposition"];
      if (disposition && disposition.indexOf("filename=") !== -1) {
        const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
        if (matches != null && matches[1]) {
          finalFilename = matches[1].replace(/['"]/g, "");
        }
      }

      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = finalFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      addNotification({
        title: "Report Downloaded",
        message: `${finalFilename} successfully generated and downloaded.`,
        type: "success"
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  // S01: Login Screen
  if (!token || !user) {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={signIn}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: "var(--primary)",
                color: "#fff",
                display: "grid",
                placeItems: "center",
                margin: "0 auto 10px"
              }}
            >
              <BookOpen size={28} />
            </div>
            <p className="eyebrow">مَدْرَسَة • MADRASA AMANAH</p>
            <h1>{t.brand}</h1>
            <p className="muted">Offline-first mobile attendance register</p>
          </div>

          {error && <div className="alert error">{error}</div>}

          <label style={{ marginBottom: 14 }}>
            {t.email}
            <input
              type="email"
              required
              autoComplete="username"
              value={login.email}
              onChange={(e) => setLogin({ ...login, email: e.target.value })}
            />
          </label>

          <label style={{ marginBottom: 18 }}>
            {t.password}
            <div className="password-input-wrap">
              <input
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={login.password}
                onChange={(e) => setLogin({ ...login, password: e.target.value })}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? t.hidePassword : t.showPassword}
              </button>
            </div>
          </label>

          <button className="btn primary full" disabled={loading} style={{ minHeight: 50 }}>
            {loading ? t.loading : t.login}
          </button>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 18
            }}
          >
            <span style={{ fontSize: 13, color: "var(--muted)" }}>{t.language}</span>
            <LanguageSelect lang={lang} setLang={setLang} />
          </div>
        </form>
      </div>
    );
  }

  const unreadNotifs = notifications.filter((n) => !n.read).length;

  return (
    <div className="app-shell">
      {/* DESKTOP SIDEBAR */}
      <aside className="desktop-sidebar">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "var(--primary)",
              color: "#fff",
              display: "grid",
              placeItems: "center"
            }}
          >
            <BookOpen size={20} />
          </div>
          <div>
            <strong style={{ display: "block", fontSize: 15, color: "var(--primary)" }}>{t.brand}</strong>
            <small style={{ color: "var(--accent)", fontWeight: 700 }}>{t.tagline}</small>
          </div>
        </div>

        <nav style={{ display: "grid", gap: 6, flex: 1 }}>
          <button
            className={`btn ${tab === "dashboard" ? "primary" : "secondary"}`}
            onClick={() => setTab("dashboard")}
            style={{ justifyContent: "flex-start" }}
          >
            <LayoutDashboard size={18} /> {t.dashboard}
          </button>
          <button
            className={`btn ${tab === "attendance" ? "primary" : "secondary"}`}
            onClick={() => setTab("attendance")}
            style={{ justifyContent: "flex-start" }}
          >
            <Camera size={18} /> {t.attendance}
          </button>
          <button
            className={`btn ${tab === "sync" ? "primary" : "secondary"}`}
            onClick={() => setTab("sync")}
            style={{ justifyContent: "flex-start" }}
          >
            <RefreshCw size={18} /> {t.syncCenter} {pendingCount > 0 && `(${pendingCount})`}
          </button>
          <button
            className={`btn ${tab === "students" ? "primary" : "secondary"}`}
            onClick={() => setTab("students")}
            style={{ justifyContent: "flex-start" }}
          >
            <Users size={18} /> {t.students}
          </button>
          <button
            className={`btn ${tab === "reports" ? "primary" : "secondary"}`}
            onClick={() => setTab("reports")}
            style={{ justifyContent: "flex-start" }}
          >
            <FileSpreadsheet size={18} /> {t.reports}
          </button>
          {user.role === "admin" && (
            <button
              className={`btn ${tab === "more" ? "primary" : "secondary"}`}
              onClick={() => setTab("more")}
              style={{ justifyContent: "flex-start" }}
            >
              <Settings size={18} /> {t.settings}
            </button>
          )}
        </nav>

        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "var(--primary-subtle)",
                color: "var(--primary)",
                display: "grid",
                placeItems: "center",
                fontWeight: 700
              }}
            >
              {user.name?.[0]?.toUpperCase()}
            </div>
            <div>
              <strong style={{ fontSize: 13, display: "block" }}>{user.name}</strong>
              <small style={{ color: "var(--muted)", textTransform: "capitalize" }}>{user.role}</small>
            </div>
          </div>
          <button
            onClick={logout}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--danger)",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: 0,
              minHeight: 32
            }}
          >
            <LogOut size={16} /> {t.signout}
          </button>
        </div>
      </aside>

      {/* MOBILE TOPBAR */}
      <header className="mobile-header">
        <div className="mobile-brand">
          <div className="mobile-brand-icon">
            <BookOpen size={20} />
          </div>
          <div className="mobile-brand-title">
            <strong>{t.brand}</strong>
            <small>مَدْرَسَة أَمَانَة</small>
          </div>
        </div>

        <div className="mobile-header-actions">
          {/* Notifications Bell */}
          <button
            onClick={() => setShowNotificationDrawer(true)}
            style={{
              background: "transparent",
              border: "none",
              position: "relative",
              padding: 6,
              color: "var(--text)"
            }}
            aria-label="Notifications"
          >
            <Bell size={20} />
            {unreadNotifs > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  background: "var(--danger)",
                  color: "#fff",
                  borderRadius: "50%",
                  width: 16,
                  height: 16,
                  fontSize: 10,
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 700
                }}
              >
                {unreadNotifs}
              </span>
            )}
          </button>

          <span className={`status-pill ${isOnline ? "online" : "offline"}`}>
            {isOnline ? <Wifi size={13} /> : <WifiOff size={13} />}
            {isOnline ? t.online : t.offline}
          </span>
          <LanguageSelect lang={lang} setLang={setLang} />
        </div>
      </header>

      {/* MOBILE MAIN CONTENT */}
      <main className="mobile-main">
        {error && (
          <div className="alert error">
            <span>{error}</span>
            <button onClick={() => setError("")}><X size={16} /></button>
          </div>
        )}
        {notice && (
          <div className="alert success">
            <span>{notice}</span>
            <button onClick={() => setNotice("")}><X size={16} /></button>
          </div>
        )}

        {/* TAB 1: MOBILE DASHBOARD */}
        {tab === "dashboard" && (
          <div>
            <div className="hero-action-card">
              <h2>{t.attendance}</h2>
              <p>
                {activeClass ? `${activeClass.name} (${sessionKey})` : "Select a class to begin"}
                {" · "}
                {dateKey}
              </p>
              <button className="hero-take-btn" onClick={() => setTab("attendance")}>
                <Camera size={22} />
                <span>{t.attendance}</span>
              </button>
            </div>

            <div className="card" style={{ padding: "14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label>
                  {t.class}
                  <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                    {classes.map((c) => (
                      <option key={c._id || c.id} value={c._id || c.id}>
                        {c.name} {c.section ? `(${c.section})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t.session}
                  <select value={sessionKey} onChange={(e) => setSessionKey(e.target.value)}>
                    <option value="morning">{t.morning}</option>
                    <option value="evening">{t.evening}</option>
                    <option value="full-day">{t.fullDay}</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="stats-row">
              <div className="mobile-stat-card">
                <div className="mobile-stat-header">
                  <span>{t.totalStudents}</span>
                  <Users size={16} />
                </div>
                <div className="mobile-stat-value">{students.length}</div>
                <div className="mobile-stat-note">Enrolled roster</div>
              </div>

              <div className="mobile-stat-card">
                <div className="mobile-stat-header">
                  <span>{t.present}</span>
                  <Check size={16} color="var(--success)" />
                </div>
                <div className="mobile-stat-value" style={{ color: "var(--success)" }}>
                  {presentCount}
                </div>
                <div className="mobile-stat-note">Marked present</div>
              </div>

              <div className="mobile-stat-card">
                <div className="mobile-stat-header">
                  <span>{t.absent}</span>
                  <Activity size={16} color="var(--danger)" />
                </div>
                <div className="mobile-stat-value" style={{ color: "var(--danger)" }}>
                  {absentCount}
                </div>
                <div className="mobile-stat-note">Marked absent</div>
              </div>

              <div className="mobile-stat-card">
                <div className="mobile-stat-header">
                  <span>{t.notMarked}</span>
                  <Clock size={16} color="var(--warning)" />
                </div>
                <div
                  className="mobile-stat-value"
                  style={{ color: notMarkedCount > 0 ? "var(--warning)" : "var(--muted)" }}
                >
                  {notMarkedCount}
                </div>
                <div className="mobile-stat-note">Requires marking</div>
              </div>
            </div>

            <div className="card">
              <div className="section-title">
                <div>
                  <h3>Offline & Sync Status</h3>
                  <p className="muted">
                    {pendingCount > 0
                      ? `${pendingCount} register(s) waiting to upload`
                      : "All registers synchronized"}
                  </p>
                </div>
                {pendingCount > 0 ? (
                  <span className="status-pill pending">
                    <Clock size={13} /> {pendingCount} Pending
                  </span>
                ) : (
                  <span className="status-pill online">
                    <CheckCircle2 size={13} /> Synced
                  </span>
                )}
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="btn secondary"
                  style={{ flex: 1, minHeight: 44, fontSize: 13 }}
                  onClick={() => setTab("sync")}
                >
                  <RefreshCw size={15} /> {t.syncCenter}
                </button>
                <button
                  className="btn secondary"
                  style={{ flex: 1, minHeight: 44, fontSize: 13 }}
                  onClick={downloadOfflineData}
                  disabled={offlinePrep.loading || !isOnline}
                >
                  <HardDrive size={15} /> {t.prepareOffline}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: FAST ATTENDANCE REGISTER */}
        {tab === "attendance" && (
          <div>
            <div className="card" style={{ padding: "12px", marginBottom: 10 }}>
              <div className="search-input-wrap">
                <Search size={18} className="search-icon-pos" />
                <input
                  type="text"
                  placeholder={t.search}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ minHeight: 44 }}
                />
              </div>

              <div className="quick-batch-bar">
                <button
                  className="btn secondary"
                  onClick={markAllPresent}
                  style={{ minHeight: 38, padding: "6px 12px", fontSize: 12 }}
                >
                  <UserCheck size={15} /> Mark All Present
                </button>

                <label
                  htmlFor="class-photo-input"
                  className="btn secondary"
                  style={{ minHeight: 38, padding: "6px 12px", fontSize: 12, cursor: "pointer", display: "inline-flex" }}
                >
                  <Camera size={15} /> Photo Match
                </label>
                <input
                  id="class-photo-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={(e) => processClassPhoto(e.target.files?.[0])}
                />
              </div>

              {detected.length > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>{t.faceSuggestions} ({detected.length})</strong>
                    <button
                      onClick={() => setDetected([])}
                      style={{ background: "none", border: "none", color: "var(--muted)", padding: 4 }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {detected.map((f) => (
                      <div
                        key={f.faceNo}
                        style={{
                          background: "var(--canvas)",
                          padding: "8px 10px",
                          borderRadius: 8,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8
                        }}
                      >
                        <span style={{ fontSize: 12 }}>
                          Face #{f.faceNo}: <strong>{f.matchName || "Unmatched"}</strong>
                        </span>
                        <select
                          value={f.studentId}
                          onChange={(e) => attachFace(f.faceNo, e.target.value)}
                          style={{ maxWidth: 140, minHeight: 34, fontSize: 11, padding: "4px 8px" }}
                        >
                          <option value="">Attach...</option>
                          {students.map((s) => (
                            <option key={s._id || s.id} value={s._id || s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ paddingBottom: 20 }}>
              {filteredStudents.map((s) => {
                const sid = s._id || s.id;
                const cur = records[sid]?.status;
                return (
                  <div className="student-attendance-card" key={sid}>
                    <div
                      className="student-card-header"
                      style={{ cursor: "pointer" }}
                      onClick={() => setViewingStudent(s)}
                    >
                      <div className="student-card-avatar">
                        {s.photoUrl ? <img src={s.photoUrl} alt="" /> : s.name?.[0]?.toUpperCase()}
                      </div>
                      <div className="student-card-meta">
                        <strong>{s.name}</strong>
                        <span>{s.admissionNo} · Tap for profile</span>
                      </div>
                    </div>

                    <div className="status-grid-large">
                      <button
                        className={`status-touch-btn present ${cur === "present" ? "active" : ""}`}
                        onClick={() => mark(sid, "present")}
                      >
                        <Check size={18} />
                        <span>{t.present}</span>
                      </button>
                      <button
                        className={`status-touch-btn absent ${cur === "absent" ? "active" : ""}`}
                        onClick={() => mark(sid, "absent")}
                      >
                        <X size={18} />
                        <span>{t.absent}</span>
                      </button>
                      <button
                        className={`status-touch-btn late ${cur === "late" ? "active" : ""}`}
                        onClick={() => mark(sid, "late")}
                      >
                        <Clock size={18} />
                        <span>{t.late}</span>
                      </button>
                      <button
                        className={`status-touch-btn excused ${cur === "excused" ? "active" : ""}`}
                        onClick={() => mark(sid, "excused")}
                      >
                        <AlertCircle size={18} />
                        <span>{t.excused}</span>
                      </button>
                    </div>
                  </div>
                );
              })}

              {!filteredStudents.length && (
                <Empty title="No students found" subtitle="Try another search or select a different class." />
              )}
            </div>

            <div className="mobile-sticky-save">
              <div className="save-summary-col">
                <strong>
                  {presentCount} {t.present} · {absentCount} {t.absent}
                </strong>
                <span style={{ color: notMarkedCount > 0 ? "var(--warning)" : "var(--success)" }}>
                  {notMarkedCount > 0 ? `${notMarkedCount} ${t.notMarked}` : "All Marked ✓"}
                </span>
              </div>
              <button
                className="save-action-btn"
                disabled={loading || !students.length}
                onClick={saveAttendance}
              >
                <Check size={18} />
                <span>{t.save}</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB 3: SYNC CENTER */}
        {tab === "sync" && (
          <div>
            <div className="section-title">
              <div>
                <h2>{t.syncCenter}</h2>
                <p className="muted">Durable offline outbox queue for reliable synchronization.</p>
              </div>
              <button
                className="btn primary"
                onClick={triggerSync}
                disabled={loading || !isOnline}
                style={{ minHeight: 44 }}
              >
                <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                {t.syncNow}
              </button>
            </div>

            {!isOnline && (
              <div className="alert warning">
                <WifiOff size={18} />
                <span>Device is offline. Local drafts remain safely in IndexedDB until internet reconnects.</span>
              </div>
            )}

            <div className="outbox-list">
              {outboxItems.map((item) => (
                <div className="outbox-card" key={item.localId}>
                  <div
                    className="outbox-icon"
                    style={{
                      background:
                        item.state === "synced"
                          ? "var(--success-bg)"
                          : item.state === "needs-auth"
                          ? "var(--danger-bg)"
                          : "var(--warning-bg)",
                      color:
                        item.state === "synced"
                          ? "var(--success)"
                          : item.state === "needs-auth"
                          ? "var(--danger)"
                          : "var(--warning)"
                    }}
                  >
                    {item.state === "synced" ? <Check size={20} /> : <Clock size={20} />}
                  </div>
                  <div className="outbox-details">
                    <strong>
                      {item.kind === "student.photo"
                        ? "Student Reference Photo Update"
                        : `${item.payload?.dateKey} - ${item.payload?.records?.length || 0} student records`}
                    </strong>
                    <small>
                      Status: <strong>{item.state}</strong> · {new Date(item.createdAt).toLocaleTimeString()}
                    </small>
                    {item.lastError && (
                      <span style={{ color: "var(--danger)", fontSize: 11, display: "block" }}>
                        {item.lastError}
                      </span>
                    )}
                  </div>
                  {item.state !== "synced" && (
                    <button
                      className="btn secondary"
                      onClick={() => retryOutboxMutation(item.localId, api)}
                      style={{ minHeight: 36, padding: "6px 12px", fontSize: 12 }}
                    >
                      {t.retry}
                    </button>
                  )}
                </div>
              ))}

              {!outboxItems.length && (
                <Empty title="Outbox is clean" subtitle="All attendance records and photos have been synchronized." />
              )}
            </div>
          </div>
        )}

        {/* TAB 4: STUDENTS DIRECTORY */}
        {tab === "students" && (
          <div>
            <div className="section-title">
              <div>
                <h2>{t.students}</h2>
                <p className="muted">Tap any student to view profile and update reference photo.</p>
              </div>
              <button
                className="btn primary"
                onClick={() => setTab("add-student")}
                style={{ minHeight: 44, padding: "8px 14px" }}
              >
                <Plus size={16} /> {t.addStudent}
              </button>
            </div>

            <div className="search-input-wrap">
              <Search size={18} className="search-icon-pos" />
              <input
                type="text"
                placeholder={t.search}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {filteredStudents.map((s) => (
                <div
                  key={s._id || s.id}
                  className="card"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: 12,
                    marginBottom: 0,
                    cursor: "pointer"
                  }}
                  onClick={() => setViewingStudent(s)}
                >
                  <div className="student-card-avatar">
                    {s.photoUrl ? <img src={s.photoUrl} alt="" /> : s.name?.[0]?.toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ display: "block", fontSize: 14 }}>{s.name}</strong>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>{s.admissionNo}</span>
                    {s.consentGiven && (
                      <small style={{ display: "block", color: "var(--success)", fontSize: 10, fontWeight: 700 }}>
                        Consent Recorded ✓
                      </small>
                    )}
                  </div>
                  <span className={`status-pill ${s.active !== false ? "neutral" : "offline"}`}>
                    {s.active !== false ? t.active : t.inactive}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SUB-VIEW: ADD STUDENT */}
        {tab === "add-student" && (
          <div>
            <div className="section-title">
              <div>
                <h2>{t.addStudent}</h2>
                <p className="muted">Enrol student with optional photo consent.</p>
              </div>
              <button className="btn secondary" onClick={() => setTab("students")} style={{ minHeight: 38 }}>
                Cancel
              </button>
            </div>

            <form
              className="card"
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                setNotice("");
                setLoading(true);
                try {
                  const r = await api.post("/students", {
                    ...studentForm,
                    classId: selectedClass
                  });
                  setStudents((prev) => [...prev, r.data].sort((a, b) => a.name.localeCompare(b.name)));
                  await cacheStudents([r.data], selectedClass);
                  setStudentForm({ admissionNo: "", name: "", guardianName: "", guardianPhone: "", consentGiven: true });
                  setNotice(`Student enrolled: ${r.data.name} (${r.data.admissionNo})`);
                  setTab("students");
                } catch (err) {
                  setError(errText(err));
                } finally {
                  setLoading(false);
                }
              }}
              style={{ display: "grid", gap: 14 }}
            >
              <label>
                {t.class}
                <select value={selectedClass} required onChange={(e) => setSelectedClass(e.target.value)}>
                  {classes.map((c) => (
                    <option key={c._id || c.id} value={c._id || c.id}>
                      {c.name} {c.section ? `(${c.section})` : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {t.admissionNo}
                <input
                  required
                  value={studentForm.admissionNo}
                  onChange={(e) => setStudentForm({ ...studentForm, admissionNo: e.target.value })}
                  placeholder="e.g. ADM-106"
                />
              </label>

              <label>
                {t.name}
                <input
                  required
                  value={studentForm.name}
                  onChange={(e) => setStudentForm({ ...studentForm, name: e.target.value })}
                  placeholder="Student full name"
                />
              </label>

              <label>
                {t.guardian}
                <input
                  value={studentForm.guardianName}
                  onChange={(e) => setStudentForm({ ...studentForm, guardianName: e.target.value })}
                  placeholder="Guardian name"
                />
              </label>

              <label>
                {t.phone}
                <input
                  type="tel"
                  value={studentForm.guardianPhone}
                  onChange={(e) => setStudentForm({ ...studentForm, guardianPhone: e.target.value })}
                  placeholder="Phone number"
                />
              </label>

              <label style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={studentForm.consentGiven}
                  onChange={(e) => setStudentForm({ ...studentForm, consentGiven: e.target.checked })}
                  style={{ width: 22, minHeight: 22 }}
                />
                <span style={{ fontSize: 12 }}>{t.consent}</span>
              </label>

              <button className="btn primary full" disabled={loading} style={{ minHeight: 48, marginTop: 10 }}>
                {loading ? t.loading : "Save Student"}
              </button>
            </form>
          </div>
        )}

        {/* TAB 5: REPORTS & ADMIN SETTINGS (MORE) */}
        {(tab === "more" || tab === "reports") && (
          <div>
            <div className="section-title">
              <div>
                <h2>{tab === "reports" ? t.reports : "Settings & Operations"}</h2>
                <p className="muted">Reports, offline cache control, teacher accounts, and audit.</p>
              </div>
            </div>

            <div className="card">
              <h3 style={{ marginBottom: 10 }}>Download Registers</h3>
              <div className="download-grid-mobile">
                <button className="download-card-mobile" onClick={() => downloadReport("xlsx")} disabled={loading}>
                  <FileSpreadsheet size={22} />
                  <div>
                    <strong>Excel Spreadsheet</strong>
                    <span>.xlsx format</span>
                  </div>
                </button>
                <button className="download-card-mobile" onClick={() => downloadReport("csv")} disabled={loading}>
                  <Download size={22} />
                  <div>
                    <strong>CSV Export</strong>
                    <span>UTF-8 with BOM</span>
                  </div>
                </button>
                <button className="download-card-mobile" onClick={() => downloadReport("pdf")} disabled={loading}>
                  <FileSpreadsheet size={22} />
                  <div>
                    <strong>Printable PDF</strong>
                    <span>Landscape layout</span>
                  </div>
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                <label>
                  {t.from}
                  <input
                    type="date"
                    value={reportRange.from}
                    onChange={(e) => setReportRange({ ...reportRange, from: e.target.value })}
                  />
                </label>
                <label>
                  {t.to}
                  <input
                    type="date"
                    value={reportRange.to}
                    onChange={(e) => setReportRange({ ...reportRange, to: e.target.value })}
                  />
                </label>
              </div>
              <button
                className="btn primary full"
                onClick={fetchReport}
                disabled={loading}
                style={{ marginTop: 12 }}
              >
                Generate Summary Table
              </button>
            </div>

            {report.length > 0 && (
              <div className="card">
                <h3 style={{ marginBottom: 10 }}>Summary View</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Present</th>
                        <th>Absent</th>
                        <th>Rate %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.map((r) => (
                        <tr key={r.studentId}>
                          <td>
                            <strong>{r.name}</strong>
                          </td>
                          <td>{r.present}</td>
                          <td>{r.absent}</td>
                          <td>
                            <strong>{r.percentage}%</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {user.role === "admin" && (
              <>
                <div className="card">
                  <h3 style={{ marginBottom: 10 }}>Add Class</h3>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        const r = await api.post("/classes", classForm);
                        setClasses((prev) => [...prev, r.data]);
                        setClassForm({ name: "", section: "Morning", academicYear: "1447-1448 / 2026" });
                        setNotice("Class created.");
                      } catch (err) {
                        setError(errText(err));
                      }
                    }}
                    style={{ display: "grid", gap: 10 }}
                  >
                    <label>
                      Class Name
                      <input
                        required
                        value={classForm.name}
                        onChange={(e) => setClassForm({ ...classForm, name: e.target.value })}
                        placeholder="e.g. Hifz, Nazira"
                      />
                    </label>
                    <button className="btn primary" style={{ minHeight: 44 }}>
                      Create Class
                    </button>
                  </form>
                </div>

                <div className="card" style={{ textAlign: "center" }}>
                  <button
                    onClick={logout}
                    className="btn secondary full"
                    style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                  >
                    <LogOut size={16} /> {t.signout}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {/* =========================================================
          B: ATTENDANCE CONFIRMATION MODAL
          Accurate breakdown: class, date, session, counts, and
          whether saved on this device or confirmed by MongoDB
          ========================================================= */}
      {confirmationModal && (
        <div className="sheet-overlay" onClick={() => setConfirmationModal(null)}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: "50%",
                  background: confirmationModal.state === "synced" ? "var(--success-bg)" : "var(--warning-bg)",
                  color: confirmationModal.state === "synced" ? "var(--success)" : "var(--warning)",
                  display: "grid",
                  placeItems: "center",
                  margin: "0 auto 12px"
                }}
              >
                {confirmationModal.state === "synced" ? <Check size={28} /> : <Clock size={28} />}
              </div>
              <h2>{confirmationModal.title}</h2>
              <p className="muted" style={{ fontSize: 13 }}>
                {confirmationModal.className} ({confirmationModal.sessionKey}) · {confirmationModal.dateKey}
              </p>
            </div>

            <div className="card" style={{ background: "var(--canvas)", padding: "14px", marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, textAlign: "center" }}>
                <div>
                  <small style={{ color: "var(--success)", fontWeight: 700 }}>Present</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{confirmationModal.counts?.present || 0}</strong>
                </div>
                <div>
                  <small style={{ color: "var(--danger)", fontWeight: 700 }}>Absent</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{confirmationModal.counts?.absent || 0}</strong>
                </div>
                <div>
                  <small style={{ color: "var(--warning)", fontWeight: 700 }}>Late</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{confirmationModal.counts?.late || 0}</strong>
                </div>
                <div>
                  <small style={{ color: "var(--info)", fontWeight: 700 }}>Excused</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{confirmationModal.counts?.excused || 0}</strong>
                </div>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 20, textAlign: "center" }}>
              Persistence Engine: <strong>{confirmationModal.database}</strong>
              <br />
              Timestamp: {new Date(confirmationModal.timestamp).toLocaleString()}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn secondary"
                style={{ flex: 1 }}
                onClick={() => setConfirmationModal(null)}
              >
                Dismiss
              </button>
              <button
                className="btn primary"
                style={{ flex: 1 }}
                onClick={() => {
                  setConfirmationModal(null);
                  setTab("attendance");
                }}
              >
                View Register
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          C: TEACHER NOTIFICATION DRAWER
          ========================================================= */}
      {showNotificationDrawer && (
        <div className="sheet-overlay" onClick={() => setShowNotificationDrawer(false)}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Bell size={20} color="var(--primary)" />
                <h3 style={{ marginBottom: 0 }}>Notification History</h3>
              </div>
              <button
                onClick={() => setShowNotificationDrawer(false)}
                style={{ background: "none", border: "none", padding: 6, color: "var(--muted)" }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ display: "grid", gap: 10, maxHeight: "65vh", overflowY: "auto" }}>
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className="card"
                  style={{
                    padding: "12px",
                    marginBottom: 0,
                    borderLeft: `4px solid ${
                      n.type === "success"
                        ? "var(--success)"
                        : n.type === "warning"
                        ? "var(--warning)"
                        : "var(--primary)"
                    }`
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <strong style={{ fontSize: 13 }}>{n.title}</strong>
                    <small style={{ color: "var(--muted)" }}>{new Date(n.timestamp).toLocaleTimeString()}</small>
                  </div>
                  <p className="muted" style={{ fontSize: 12 }}>{n.message}</p>
                </div>
              ))}

              {!notifications.length && (
                <Empty title="No notifications yet" subtitle="Saved registers and sync events will appear here." />
              )}
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          STUDENT PROFILE & PHOTO MANAGER (MODAL)
          ========================================================= */}
      {viewingStudent && (
        <div className="sheet-overlay" onClick={() => { setViewingStudent(null); stopCamera(); setProfilePreviewPhoto(null); }}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <p className="eyebrow">STUDENT PROFILE</p>
                <h2 style={{ marginBottom: 0 }}>{viewingStudent.name}</h2>
                <small className="muted">Admission No: {viewingStudent.admissionNo}</small>
              </div>
              <button
                onClick={() => { setViewingStudent(null); stopCamera(); setProfilePreviewPhoto(null); }}
                style={{ background: "transparent", border: "none", color: "var(--muted)", padding: 6 }}
              >
                <X size={22} />
              </button>
            </div>

            {/* EXACT MOCKUP CARD FROM USER IMAGE */}
            <div className="photo-manager-card">
              <div className="photo-manager-title">Student photo</div>

              <div className="photo-manager-avatar-wrap">
                <div className="photo-manager-avatar">
                  {viewingStudent.photoUrl ? (
                    <img src={viewingStudent.photoUrl} alt={viewingStudent.name} />
                  ) : (
                    <User size={38} />
                  )}
                </div>
                <div className="photo-manager-avatar-label">Current reference photo</div>
              </div>

              {!profilePreviewPhoto && !cameraActive && (
                <div>
                  <button
                    className="photo-pill-btn take"
                    onClick={() => startCamera(cameraFacing)}
                  >
                    <Camera size={20} />
                    <span>Take a photo</span>
                  </button>

                  <label
                    htmlFor="profile-gallery-file-input"
                    className="photo-pill-btn choose"
                  >
                    <Image size={20} />
                    <span>Choose existing photo</span>
                  </label>
                  <input
                    id="profile-gallery-file-input"
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        const url = await readDataUrl(f);
                        handleNewPhoto(url);
                      }
                    }}
                  />

                  <input
                    id="profile-camera-file-input"
                    type="file"
                    accept="image/*"
                    capture="user"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        const url = await readDataUrl(f);
                        handleNewPhoto(url);
                      }
                    }}
                  />
                </div>
              )}

              {profilePreviewPhoto && (
                <div className="photo-preview-wrap">
                  <div style={{ fontSize: 13, color: "#D8D2C2", marginBottom: 8 }}>
                    New image preview:
                  </div>
                  <img src={profilePreviewPhoto} alt="Preview" className="photo-preview-img" />
                  <div style={{ fontSize: 11, color: profilePreviewDescriptor ? "var(--success)" : "var(--warning)", marginBottom: 14 }}>
                    {profilePreviewDescriptor ? "Face descriptor recognized ✓" : "Manual attendance ready"}
                  </div>

                  <div className="photo-preview-actions">
                    <button
                      className="photo-pill-btn choose"
                      style={{ marginBottom: 0 }}
                      onClick={() => {
                        setProfilePreviewPhoto(null);
                        setProfilePreviewDescriptor(null);
                      }}
                    >
                      <RefreshCw size={16} /> Retake
                    </button>
                    <button
                      className="photo-pill-btn take"
                      style={{ marginBottom: 0 }}
                      disabled={loading}
                      onClick={saveStudentPhoto}
                    >
                      <Check size={18} /> {loading ? "Saving..." : "Save photo"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="card" style={{ padding: "14px", marginTop: 12 }}>
              <strong style={{ display: "block", fontSize: 13, marginBottom: 8 }}>Profile Details</strong>
              <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
                <div>Guardian: <strong>{viewingStudent.guardianName || "Not recorded"}</strong></div>
                <div>Contact: <strong>{viewingStudent.guardianPhone || "Not recorded"}</strong></div>
                <div>Photo Consent: <strong>{viewingStudent.consentGiven ? "Granted ✓" : "Opted out"}</strong></div>
                <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>
                  * Updating reference photo preserves all historical attendance records safely.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* LIVE CAMERA MODAL (GETUSERMEDIA) */}
      {cameraActive && (
        <div className="camera-modal-overlay">
          <div className="camera-modal-content">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "#fff", marginBottom: 10 }}>
              <span style={{ fontWeight: 600 }}>Camera Viewfinder</span>
              <button
                onClick={stopCamera}
                style={{ background: "none", border: "none", color: "#fff", padding: 6 }}
              >
                <X size={24} />
              </button>
            </div>

            <div className="camera-viewfinder">
              <video ref={videoRef} playsInline autoPlay muted />
            </div>

            <div className="camera-snap-bar">
              <button
                onClick={() => startCamera(cameraFacing === "user" ? "environment" : "user")}
                style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: "50%", width: 44, height: 44, display: "grid", placeItems: "center" }}
              >
                <FlipHorizontal size={20} />
              </button>

              <button className="camera-snap-trigger" onClick={snapPhoto}>
                <Camera size={26} color="var(--primary)" />
              </button>

              <div style={{ width: 44 }} />
            </div>
          </div>
        </div>
      )}

      {/* MOBILE BOTTOM NAVIGATION */}
      <nav className="bottom-nav">
        <button
          className={`bottom-nav-item ${tab === "dashboard" ? "active" : ""}`}
          onClick={() => setTab("dashboard")}
        >
          <LayoutDashboard size={20} />
          <span>{t.dashboard}</span>
        </button>

        <button
          className={`bottom-nav-item ${tab === "attendance" ? "active" : ""}`}
          onClick={() => setTab("attendance")}
        >
          <Camera size={20} />
          <span>{t.attendance}</span>
        </button>

        <button
          className={`bottom-nav-item ${tab === "sync" ? "active" : ""}`}
          onClick={() => setTab("sync")}
        >
          <RefreshCw size={20} />
          <span>{t.syncCenter}</span>
          {pendingCount > 0 && <span className="bottom-badge">{pendingCount}</span>}
        </button>

        <button
          className={`bottom-nav-item ${tab === "students" ? "active" : ""}`}
          onClick={() => setTab("students")}
        >
          <Users size={20} />
          <span>{t.students}</span>
        </button>

        <button
          className={`bottom-nav-item ${tab === "more" || tab === "reports" ? "active" : ""}`}
          onClick={() => setTab("more")}
        >
          <MoreHorizontal size={20} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}

function LanguageSelect({ lang, setLang }) {
  return (
    <select
      className="language-select"
      aria-label="Language selection"
      value={lang}
      onChange={(e) => setLang(e.target.value)}
    >
      <option value="en">English</option>
      <option value="ur">اردو</option>
      <option value="te">తెలుగు</option>
    </select>
  );
}

function Empty({ title, subtitle }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Users size={24} />
      </div>
      <strong>{title}</strong>
      <p className="muted">{subtitle}</p>
    </div>
  );
}
