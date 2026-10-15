import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bell,
  BookOpen,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  Filter,
  FlipHorizontal,
  GraduationCap,
  HardDrive,
  HelpCircle,
  History,
  Image,
  LayoutDashboard,
  LogOut,
  MapPin,
  MoreHorizontal,
  Phone,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  User,
  UserCheck,
  UserX,
  Users,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import api from "./api";
import {
  translations,
  createTranslator,
  applyLanguageToDocument,
  getDirection,
  formatClassLabel,
  localizeClassName,
  localizeSection,
  localizeStudentName,
  localizeGuardianName,
  formatDate,
  formatTime,
  formatDateTime,
  formatNumber,
  formatPercent
} from "./i18n";
import {
  offlineDb,
  cacheClasses,
  cacheStudents,
  removeStudentFromCache,
  updateStudentInCache,
  saveAttendanceLocally,
  markOutboxSynced,
  queuePhotoUpdate,
  syncPendingAttendance,
  getPendingOutboxCount,
  getAllOutboxItems,
  retryOutboxMutation,
  getLastSyncTime,
  setLastSyncTime,
  checkStorageEstimate,
  cacheAttendanceHistory,
  cleanOldAttendance,
  isolateUserCache,
  clearUserCache
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

// Fast, resilient Euclidean distance calculation (guards against NaN & mismatch)
const distance = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 999;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
};

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
  const [students, setStudents] = useState(() => {
    try {
      const cls = localStorage.getItem("madrasa_selected_class");
      if (cls) {
        const saved = localStorage.getItem("madrasa_cached_students_" + cls);
        return saved ? JSON.parse(saved) : [];
      }
    } catch {}
    return [];
  });
  const [selectedClass, setSelectedClassState] = useState(() => {
    try {
      return localStorage.getItem("madrasa_selected_class") || "";
    } catch {
      return "";
    }
  });

  const setSelectedClass = (val) => {
    setSelectedClassState(val);
    try {
      if (val) localStorage.setItem("madrasa_selected_class", String(val));
    } catch {}
  };
  const [dateKey, setDateKey] = useState(today());
  const [sessionKey, setSessionKey] = useState("morning");
  const [records, setRecords] = useState({});
  const [notes, setNotes] = useState({});

  // Fast Loading & Freshness Indicators
  const [classesLoading, setClassesLoading] = useState(false);
  const [attendanceLoading, setAttendanceLoading] = useState(false);
  const [attendanceFreshness, setAttendanceFreshness] = useState(null); // { type: 'cached'|'synced', time: string }

  // Session Security (2h Inactivity, 3h Max Lifetime, 5m Warning Dialog)
  const [sessionExpiryWarning, setSessionExpiryWarning] = useState(false);
  const [sessionCountdown, setSessionCountdown] = useState(300);
  const [sessionExtending, setSessionExtending] = useState(false);
  const lastActivityRef = useRef(Date.now());

  // Render Backend Health Monitoring (Admin)
  const [healthStatus, setHealthStatus] = useState({
    status: "healthy",
    database: "connected",
    responseTime: 0,
    lastCheck: null,
    consecutiveFailures: 0,
    loading: false,
    lastIncident: null,
    lastRecovery: null
  });

  // Active Student Profile View Modal & Camera
  const [viewingStudent, setViewingStudent] = useState(null);
  const [profilePreviewPhoto, setProfilePreviewPhoto] = useState(null);
  const [profilePreviewDescriptor, setProfilePreviewDescriptor] = useState(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState("user");
  const [cameraMode, setCameraMode] = useState("student-profile"); // 'student-profile' | 'class-attendance'
  const [faceDetectStatus, setFaceDetectStatus] = useState(""); // '', 'loading', 'detected', 'no-face', 'error', 'unavailable'
  const [photoSaving, setPhotoSaving] = useState(false);
  const [photoSaveError, setPhotoSaveError] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const savingAttendanceRef = useRef(false);

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
  // Student Management & Directory State
  const [studentStatusFilter, setStudentStatusFilter] = useState("active"); // 'active' | 'archived' | 'all'
  const [studentClassFilter, setStudentClassFilter] = useState("all");
  const [directoryStudents, setDirectoryStudents] = useState([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [activeMenuStudentId, setActiveMenuStudentId] = useState(null);

  // Close student action menu on Escape key press
  useEffect(() => {
    if (!activeMenuStudentId) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setActiveMenuStudentId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeMenuStudentId]);

  // Modals for Student Management
  const [viewingStudentProfile, setViewingStudentProfile] = useState(null);
  const [editingStudent, setEditingStudent] = useState(null);
  const [transferringStudent, setTransferringStudent] = useState(null);
  const [transferTargetClassId, setTransferTargetClassId] = useState("");
  const [attendanceHistoryStudent, setAttendanceHistoryStudent] = useState(null);
  const [studentAttendanceData, setStudentAttendanceData] = useState(null);
  const [studentAttendanceLoading, setStudentAttendanceLoading] = useState(false);
  const [studentConfirmAction, setStudentConfirmAction] = useState(null);

  // Attendance Monitoring State
  const [monitoringMode, setMonitoringMode] = useState("single"); // 'single' | 'range'
  const [monitoringClass, setMonitoringClass] = useState("all");
  const [monitoringDate, setMonitoringDate] = useState(today());
  const [monitoringStartDate, setMonitoringStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [monitoringEndDate, setMonitoringEndDate] = useState(today());
  const [monitoringSession, setMonitoringSession] = useState("morning");
  const [monitoringStatus, setMonitoringStatus] = useState("all");
  const [monitoringSearch, setMonitoringSearch] = useState("");
  const [monitoringData, setMonitoringData] = useState(null);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [monitoringError, setMonitoringError] = useState("");
  const [confirmedRecords, setConfirmedRecords] = useState({});
  const [studentHistoryRange, setStudentHistoryRange] = useState({ from: "", to: "" });

  const [studentForm, setStudentForm] = useState({
    admissionNo: "",
    name: "",
    gender: "",
    dob: "",
    guardianName: "",
    guardianPhone: "",
    address: "",
    enrollmentDate: today(),
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

  // Teacher Accounts Management
  const [teachers, setTeachers] = useState([]);
  const [showAddTeacherModal, setShowAddTeacherModal] = useState(false);
  const [teacherForm, setTeacherForm] = useState({ name: "", email: "", password: "", assignedClasses: [] });
  const [resetPasswordTeacher, setResetPasswordTeacher] = useState(null);
  const [newTeacherPassword, setNewTeacherPassword] = useState("");

  // Storage Rotation & Monitoring
  const [storageReport, setStorageReport] = useState(null);
  const [storageLoading, setStorageLoading] = useState(false);

  // System Settings & Email Automation
  const [emailStatus, setEmailStatus] = useState(null);
  const [settingsForm, setSettingsForm] = useState({
    reportRecipientEmail: "",
    reportTimezone: "Asia/Kolkata",
    reportSchedule: "Mondays at 06:00 AM",
    reportAutomationEnabled: false,
    attendanceCorrectionWindowDays: 7
  });

  // User Password Change Form
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [passwordNotice, setPasswordNotice] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const t = useMemo(() => createTranslator(lang), [lang]);
  const activeClass = classes.find((c) => String(c._id || c.id) === String(selectedClass));

  // Counts - strictly computed against enrolled roster of selected class
  const presentCount = students.filter((s) => records[s._id || s.id]?.status === "present").length;
  const absentCount = students.filter((s) => records[s._id || s.id]?.status === "absent").length;
  const lateCount = students.filter((s) => records[s._id || s.id]?.status === "late").length;
  const excusedCount = students.filter((s) => records[s._id || s.id]?.status === "excused").length;
  const markedTotal = presentCount + absentCount + lateCount + excusedCount;
  const notMarkedCount = Math.max(0, students.length - markedTotal);

  const filteredStudents = useMemo(
    () =>
      students.filter((s) =>
        `${s.name} ${s.admissionNo}`.toLowerCase().includes(search.toLowerCase())
      ),
    [students, search]
  );

  const filteredDirectoryStudents = useMemo(() => {
    return directoryStudents.filter((s) => {
      if (studentStatusFilter === "active" && s.active === false) return false;
      if (studentStatusFilter === "archived" && s.active !== false) return false;
      if (studentClassFilter !== "all") {
        const sClassId = String(s.classId?._id || s.classId?.id || s.classId || "");
        if (sClassId !== String(studentClassFilter)) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        const match =
          (s.name || "").toLowerCase().includes(q) ||
          (s.admissionNo || "").toLowerCase().includes(q) ||
          (s.guardianName || "").toLowerCase().includes(q) ||
          (s.guardianPhone || "").toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [directoryStudents, studentStatusFilter, studentClassFilter, search]);

  // Fetch directory students
  const fetchDirectoryStudents = async (status = studentStatusFilter, classId = studentClassFilter) => {
    if (!token) return;
    setDirectoryLoading(true);
    try {
      const params = {};
      if (status) params.status = status;
      if (classId && classId !== "all") params.classId = classId;
      const res = await api.get("/students", { params });
      setDirectoryStudents(res.data);
      if (res.data.length > 0) {
        await cacheStudents(res.data, classId !== "all" ? classId : "");
      }
    } catch {
      try {
        let cached = await offlineDb.students.toArray();
        if (status === "active") cached = cached.filter((s) => s.active !== false);
        if (status === "archived") cached = cached.filter((s) => s.active === false);
        if (classId && classId !== "all") cached = cached.filter((s) => String(s.classId) === String(classId));
        setDirectoryStudents(cached);
      } catch (e) {
        console.error("Failed to load cached students", e);
      }
    } finally {
      setDirectoryLoading(false);
    }
  };

  useEffect(() => {
    if (!token || !user) return;
    if (tab === "students") {
      fetchDirectoryStudents(studentStatusFilter, studentClassFilter);
    }
  }, [token, user, tab, studentStatusFilter, studentClassFilter]);

  async function openStudentProfile(student) {
    setActiveMenuStudentId(null);
    try {
      const res = await api.get(`/students/${student._id || student.id}`);
      setViewingStudentProfile(res.data);
    } catch {
      setViewingStudentProfile(student);
    }
  }

  function openEditStudent(student) {
    setActiveMenuStudentId(null);
    setEditingStudent({
      id: student._id || student.id,
      name: student.name || student.fullName || "",
      admissionNo: student.admissionNo || student.admissionNumber || "",
      classId: String(student.classId?._id || student.classId?.id || student.classId || selectedClass || ""),
      gender: student.gender || "",
      dob: student.dob || "",
      guardianName: student.guardianName || "",
      guardianPhone: student.guardianPhone || "",
      address: student.address || "",
      enrollmentDate: student.enrollmentDate || today(),
      active: student.active !== false,
      consentGiven: student.consentGiven !== false,
      saving: false,
      error: ""
    });
  }

  async function handleSaveStudentEdit(e) {
    e.preventDefault();
    if (!editingStudent) return;
    if (!editingStudent.name.trim()) {
      setEditingStudent((prev) => ({ ...prev, error: "Student name is required." }));
      return;
    }
    if (!editingStudent.admissionNo.trim()) {
      setEditingStudent((prev) => ({ ...prev, error: "Admission number is required." }));
      return;
    }
    if (!editingStudent.classId) {
      setEditingStudent((prev) => ({ ...prev, error: "Class assignment is required." }));
      return;
    }
    setEditingStudent((prev) => ({ ...prev, saving: true, error: "" }));
    try {
      const payload = {
        name: editingStudent.name.trim(),
        fullName: editingStudent.name.trim(),
        classId: editingStudent.classId,
        gender: editingStudent.gender,
        dob: editingStudent.dob,
        guardianName: editingStudent.guardianName,
        guardianPhone: editingStudent.guardianPhone,
        address: editingStudent.address,
        enrollmentDate: editingStudent.enrollmentDate,
        active: editingStudent.active,
        consentGiven: editingStudent.consentGiven
      };
      if (user.role === "admin") {
        payload.admissionNo = editingStudent.admissionNo.trim();
        payload.admissionNumber = editingStudent.admissionNo.trim();
      }
      const res = await api.patch(`/students/${editingStudent.id}`, payload);
      await updateStudentInCache(res.data);
      setDirectoryStudents((prev) =>
        prev.map((s) => (String(s._id || s.id) === String(editingStudent.id) ? res.data : s))
      );
      setStudents((prev) =>
        prev.map((s) => (String(s._id || s.id) === String(editingStudent.id) ? res.data : s))
      );
      if (viewingStudentProfile && String(viewingStudentProfile._id || viewingStudentProfile.id) === String(editingStudent.id)) {
        setViewingStudentProfile(res.data);
      }
      setNotice(`Student "${res.data.name}" updated successfully.`);
      setEditingStudent(null);
    } catch (err) {
      setEditingStudent((prev) => ({ ...prev, saving: false, error: errText(err) }));
    }
  }

  function openTransferClass(student) {
    setActiveMenuStudentId(null);
    setTransferringStudent(student);
    setTransferTargetClassId(String(student.classId?._id || student.classId?.id || student.classId || ""));
  }

  async function handleConfirmTransfer() {
    if (!transferringStudent || !transferTargetClassId) return;
    setLoading(true);
    try {
      const res = await api.patch(`/students/${transferringStudent._id || transferringStudent.id}`, {
        classId: transferTargetClassId
      });
      await updateStudentInCache(res.data);
      setDirectoryStudents((prev) =>
        prev.map((s) => (String(s._id || s.id) === String(transferringStudent._id || transferringStudent.id) ? res.data : s))
      );
      if (viewingStudentProfile && String(viewingStudentProfile._id || viewingStudentProfile.id) === String(transferringStudent._id || transferringStudent.id)) {
        setViewingStudentProfile(res.data);
      }
      const newCls = classes.find((c) => String(c._id || c.id) === String(transferTargetClassId));
      setNotice(`Transferred ${res.data.name} to ${newCls?.name || "new class"} successfully.`);
      setTransferringStudent(null);
      if (selectedClass) {
        loadStudentsAndAttendanceOfflineFirst(selectedClass, dateKey, sessionKey);
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }

  async function openAttendanceHistory(student, range = null) {
    setActiveMenuStudentId(null);
    setAttendanceHistoryStudent(student);
    setStudentAttendanceLoading(true);
    setStudentAttendanceData(null);
    try {
      const params = {};
      const from = range?.from !== undefined ? range.from : studentHistoryRange.from;
      const to = range?.to !== undefined ? range.to : studentHistoryRange.to;
      if (from) params.startDate = from;
      if (to) params.endDate = to;
      const res = await api.get(`/students/${student._id || student.id}/attendance`, { params });
      setStudentAttendanceData(res.data);
    } catch (err) {
      setError(errText(err));
    } finally {
      setStudentAttendanceLoading(false);
    }
  }

  async function fetchMonitoringData() {
    if (!token) return;
    setMonitoringLoading(true);
    setMonitoringError("");
    try {
      const params = {
        classId: monitoringClass,
        sessionKey: monitoringSession,
        status: monitoringStatus,
        search: monitoringSearch
      };
      if (monitoringMode === "range") {
        params.startDate = monitoringStartDate;
        params.endDate = monitoringEndDate;
      } else {
        params.dateKey = monitoringDate;
      }
      const res = await api.get("/attendance/monitoring", { params });
      setMonitoringData(res.data);
    } catch (err) {
      setMonitoringError(errText(err));
    } finally {
      setMonitoringLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "monitoring" && token) {
      fetchMonitoringData();
    }
  }, [
    tab,
    token,
    monitoringMode,
    monitoringClass,
    monitoringDate,
    monitoringStartDate,
    monitoringEndDate,
    monitoringSession,
    monitoringStatus,
    monitoringSearch
  ]);

  function requestStudentAction(actionType, student) {
    setActiveMenuStudentId(null);
    setStudentConfirmAction({
      type: actionType,
      student,
      confirmAdmNo: "",
      loading: false,
      error: ""
    });
  }

  async function executeStudentConfirmAction() {
    if (!studentConfirmAction) return;
    const { type, student, confirmAdmNo } = studentConfirmAction;
    const sId = student._id || student.id;

    if (type === "delete" && confirmAdmNo.trim() !== (student.admissionNo || student.admissionNumber)) {
      setStudentConfirmAction((prev) => ({
        ...prev,
        error: `Please type exact admission number "${student.admissionNo || student.admissionNumber}" to confirm permanent deletion.`
      }));
      return;
    }

    setStudentConfirmAction((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      if (type === "activate") {
        const res = await api.patch(`/students/${sId}`, { active: true });
        await updateStudentInCache(res.data);
        setDirectoryStudents((prev) => prev.map((s) => (String(s._id || s.id) === String(sId) ? res.data : s)));
        setNotice(`Student ${res.data.name} activated successfully.`);
      } else if (type === "deactivate") {
        const res = await api.patch(`/students/${sId}`, { active: false });
        await updateStudentInCache(res.data);
        setDirectoryStudents((prev) => prev.map((s) => (String(s._id || s.id) === String(sId) ? res.data : s)));
        setNotice(`Student ${res.data.name} deactivated.`);
      } else if (type === "archive") {
        const res = await api.post(`/students/${sId}/archive`, { reason: "Archived by Admin" });
        await updateStudentInCache({ ...student, active: false });
        setDirectoryStudents((prev) => prev.map((s) => (String(s._id || s.id) === String(sId) ? { ...s, active: false } : s)));
        setNotice(res.data.message || `Student ${student.name} archived.`);
      } else if (type === "restore") {
        const res = await api.post(`/students/${sId}/restore`);
        await updateStudentInCache({ ...student, active: true });
        setDirectoryStudents((prev) => prev.map((s) => (String(s._id || s.id) === String(sId) ? { ...s, active: true } : s)));
        setNotice(res.data.message || `Student ${student.name} restored.`);
      } else if (type === "delete") {
        await api.delete(`/students/${sId}`, { data: { confirmAdmissionNo: confirmAdmNo.trim() } });
        await removeStudentFromCache(sId);
        setDirectoryStudents((prev) => prev.filter((s) => String(s._id || s.id) !== String(sId)));
        setStudents((prev) => prev.filter((s) => String(s._id || s.id) !== String(sId)));
        if (viewingStudentProfile && String(viewingStudentProfile._id || viewingStudentProfile.id) === String(sId)) {
          setViewingStudentProfile(null);
        }
        setNotice(`Student record permanently removed.`);
      }

      setStudentConfirmAction(null);
      if (selectedClass) {
        loadStudentsAndAttendanceOfflineFirst(selectedClass, dateKey, sessionKey);
      }
    } catch (err) {
      setStudentConfirmAction((prev) => ({ ...prev, loading: false, error: errText(err) }));
    }
  }

  async function downloadStudentRoster(format = "csv") {
    setLoading(true);
    try {
      const className = studentClassFilter !== "all"
        ? (classes.find((c) => String(c._id || c.id) === String(studentClassFilter))?.name || "Class")
        : "All-Students";
      const filename = `Madrasa-Amanah-${className}-${studentStatusFilter}-${today()}.${format}`;
      await triggerFileDownload("/students/export", {
        classId: studentClassFilter !== "all" ? studentClassFilter : undefined,
        status: studentStatusFilter,
        format
      }, filename);
      setNotice(`Student roster export (${format.toUpperCase()}) completed.`);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }

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

  function removeNotification(id) {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }

  function clearAllNotifications() {
    setNotifications([]);
  }

  function markAllNotificationsRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  // 6-Month Data Retention Cleanup & Pre-warm
  useEffect(() => {
    cleanOldAttendance(180);
  }, []);

  // Listen for 401 Unauthorized globally
  useEffect(() => {
    const handleUnauthorized = (e) => {
      const msg = e?.detail?.message || "Session expired. Please sign in again.";
      logout(msg);
    };
    window.addEventListener("auth:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
  }, []);

  // Language & Direction Sync
  useEffect(() => {
    applyLanguageToDocument(lang);
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
          logout(e.response?.data?.message || "Session expired. Please sign in again.");
        }
      });
  }, [token]);

  // User Cache Isolation on Mount / User change
  useEffect(() => {
    if (user?._id || user?.id) {
      isolateUserCache(user._id || user.id);
    }
  }, [user]);

  // Track meaningful user activity (pointer, keys, touch, scroll)
  // Background polling/refreshes do NOT trigger these
  useEffect(() => {
    if (!token) return;
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener("pointerdown", updateActivity, { passive: true });
    window.addEventListener("keydown", updateActivity, { passive: true });
    window.addEventListener("touchstart", updateActivity, { passive: true });
    window.addEventListener("scroll", updateActivity, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", updateActivity);
      window.removeEventListener("keydown", updateActivity);
      window.removeEventListener("touchstart", updateActivity);
      window.removeEventListener("scroll", updateActivity);
    };
  }, [token]);

  // Auto-save attendance drafts before automatic logout
  const autoSaveCurrentAttendance = async () => {
    try {
      if (selectedClass && records && Object.keys(records).length > 0) {
        const studentRecords = Object.entries(records).map(([studentId, data]) => ({
          studentId,
          status: data.status,
          note: notes[studentId] || ""
        }));
        await saveAttendanceLocally({
          classId: selectedClass,
          dateKey,
          sessionKey,
          records: studentRecords,
          source: "auto-session-save"
        });
        console.log("[Session Security] Attendance draft safely preserved in local IndexedDB outbox.");
      }
    } catch (e) {
      console.warn("autoSaveCurrentAttendance note:", e.message);
    }
  };

  // Continuous Session Inactivity (2 hours) & Maximum Session Lifetime (3 hours) Enforcement
  useEffect(() => {
    if (!token) return;

    const interval = setInterval(async () => {
      const now = Date.now();
      const inactivitySec = Math.floor((now - lastActivityRef.current) / 1000);
      const sessionStart = parseInt(localStorage.getItem("madrasa_session_start") || String(now), 10);
      const totalSessionSec = Math.floor((now - sessionStart) / 1000);

      const maxLifetimeSec = 3 * 3600; // 3 hours absolute max
      const inactivityLimitSec = 2 * 3600; // 2 hours inactivity limit
      const warningWindowSec = 300; // 5 minutes warning

      // 1. Check absolute 3-hour maximum session lifetime
      if (totalSessionSec >= maxLifetimeSec) {
        await autoSaveCurrentAttendance();
        logout(t("session.maxLifetimeExpired", "Maximum session lifetime of 3 hours reached. Please sign in again."));
        return;
      }

      // 2. Check 2-hour inactivity timeout
      if (inactivitySec >= inactivityLimitSec) {
        await autoSaveCurrentAttendance();
        logout(t("session.inactivityExpired", "Your session has expired due to 2 hours of inactivity. Please sign in again."));
        return;
      }

      // 3. Check if within 5-minute warning window
      const remainingInactivity = inactivityLimitSec - inactivitySec;
      const remainingTotal = maxLifetimeSec - totalSessionSec;
      const effectiveRemaining = Math.min(remainingInactivity, remainingTotal);

      if (effectiveRemaining <= warningWindowSec) {
        if (!sessionExpiryWarning) {
          await autoSaveCurrentAttendance();
        }
        setSessionCountdown(Math.max(0, effectiveRemaining));
        setSessionExpiryWarning(true);
      } else if (sessionExpiryWarning && effectiveRemaining > warningWindowSec) {
        setSessionExpiryWarning(false);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [token, sessionExpiryWarning, selectedClass, records, notes, dateKey, sessionKey]);

  async function handleContinueSession() {
    setSessionExtending(true);
    try {
      const res = await api.post("/auth/refresh-session");
      if (res.data?.token) {
        localStorage.setItem("madrasa_token", res.data.token);
        setToken(res.data.token);
        lastActivityRef.current = Date.now();
        setSessionExpiryWarning(false);
        setNotice(t("session.refreshSuccess", "Session extended successfully."));
      }
    } catch (err) {
      if (err.response?.status === 401) {
        logout(err.response?.data?.message || t("session.maxLifetimeExpired", "Maximum session lifetime reached. Please sign in again."));
      } else {
        setError(errText(err));
      }
    } finally {
      setSessionExtending(false);
    }
  }

  // Stale-While-Revalidate: Instant Local Load + Background Revalidation
  useEffect(() => {
    if (!token || !user) return;
    loadClassesOfflineFirst();
  }, [token, user]);

  async function loadClassesOfflineFirst() {
    // Phase 1: Instant load from IndexedDB cache (<10ms)
    try {
      const cached = await offlineDb.classes.toArray();
      if (cached && cached.length) {
        setClasses(cached);
        const saved = localStorage.getItem("madrasa_selected_class");
        const found = cached.find((c) => String(c._id || c.id) === String(saved));
        if (found) {
          setSelectedClass(found._id || found.id);
        } else if (!selectedClass) {
          setSelectedClass(cached[0]._id || cached[0].id);
        }
      }
    } catch (e) {
      console.warn("Cached classes read error:", e.message);
    }

    // Phase 2: Background revalidation via network
    try {
      setClassesLoading(true);
      const res = await api.get("/classes");
      setClasses(res.data);
      await cacheClasses(res.data);
      const saved = localStorage.getItem("madrasa_selected_class");
      const found = res.data.find((c) => String(c._id || c.id) === String(saved));
      if (found) {
        setSelectedClass(found._id || found.id);
      } else if (!selectedClass && res.data.length) {
        setSelectedClass(res.data[0]._id || res.data[0].id);
      }

      // Pre-warm all students in background so all classes load in <10ms
      api.get("/students").then((sRes) => {
        if (sRes.data && sRes.data.length) {
          cacheStudents(sRes.data);
        }
      }).catch(() => {});
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) return;
      console.warn("Network classes revalidation note:", err.message);
    } finally {
      setClassesLoading(false);
    }
  }

  // Load Students and Attendance for Selected Class (Parallel Network Requests)
  // FIX: Triggered on dashboard, attendance, and monitoring so stats are NEVER 0 on refresh!
  useEffect(() => {
    if (!token || !user || !selectedClass) return;
    if (tab === "attendance" || tab === "dashboard" || tab === "monitoring") {
      loadStudentsAndAttendanceOfflineFirst(selectedClass, dateKey, sessionKey);
    }
  }, [token, user, selectedClass, dateKey, sessionKey, tab]);

  async function loadStudentsAndAttendanceOfflineFirst(classId, date, session) {
    if (!classId) return;
    setAttendanceLoading(true);

    // Phase 1: Instant cache hydration (<10ms)
    try {
      let [cachedStudents, cachedDrafts] = await Promise.all([
        offlineDb.students.where("classId").equals(String(classId)).toArray(),
        offlineDb.attendanceDrafts
          .where("classId")
          .equals(String(classId))
          .filter((d) => d.dateKey === date && (d.sessionKey === session || !d.sessionKey))
          .toArray()
      ]);

      if (!cachedStudents || cachedStudents.length === 0) {
        const allCached = await offlineDb.students.toArray();
        cachedStudents = allCached.filter((s) => {
          const sClassId = String(s.classId?._id || s.classId?.id || s.classId || "");
          return sClassId === String(classId);
        });
      }

      if (cachedStudents.length) {
        const unique = Array.from(new Map(cachedStudents.map((s) => [String(s._id || s.id), s])).values());
        setStudents(unique);
      }

      if (cachedDrafts.length) {
        const next = {};
        const noteMap = {};
        cachedDrafts.forEach((d) => {
          next[d.studentId] = { status: d.status };
          if (d.note) noteMap[d.studentId] = d.note;
        });
        setRecords(next);
        setNotes(noteMap);
        setAttendanceFreshness({ type: "cached", time: new Date().toLocaleTimeString() });
      }
    } catch (e) {
      console.warn("Cached attendance hydration note:", e.message);
    }

    // Phase 2: Parallel network fetching — eliminate sequential waterfall delay
    try {
      const [studentsRes, attendanceRes] = await Promise.allSettled([
        api.get("/students", { params: { classId } }),
        api.get("/attendance", { params: { classId, dateKey: date, sessionKey: session } })
      ]);

      if (studentsRes.status === "fulfilled") {
        const unique = Array.from(new Map(studentsRes.value.data.map((s) => [String(s._id || s.id), s])).values());
        setStudents(unique);
        try { localStorage.setItem("madrasa_cached_students_" + classId, JSON.stringify(unique)); } catch {}
        await cacheStudents(unique, classId);
      }

      if (attendanceRes.status === "fulfilled") {
        const next = {};
        const noteMap = {};
        const confirmed = {};
        attendanceRes.value.data.forEach((a) => {
          const sid = String(a.studentId?._id || a.studentId?.id || a.studentId);
          next[sid] = { status: a.status };
          confirmed[sid] = { status: a.status, updatedAt: a.updatedAt || a.createdAt };
          if (a.note) noteMap[sid] = a.note;
        });
        setRecords(next);
        setConfirmedRecords(confirmed);
        setNotes(noteMap);
        setAttendanceFreshness({ type: "synced", time: new Date().toLocaleTimeString() });
      }
    } catch (err) {
      console.warn("Parallel fetch error:", err.message);
    } finally {
      setAttendanceLoading(false);
    }
  }

  // Render Health Check Probe for Admin
  async function fetchHealthCheck() {
    setHealthStatus((prev) => ({ ...prev, loading: true }));
    const startTime = Date.now();
    try {
      const res = await api.get("/health");
      const duration = Date.now() - startTime;
      const isOk = res.status === 200 && (res.data?.status === "ok" || res.data?.status === "healthy");
      const isDbConnected = res.data?.database === "connected" || res.data?.database?.state === "connected";
      setHealthStatus((prev) => ({
        status: isOk && isDbConnected ? "healthy" : isOk ? "degraded" : "unavailable",
        database: isDbConnected ? "connected" : "disconnected",
        responseTime: duration,
        lastCheck: new Date().toLocaleTimeString(),
        consecutiveFailures: 0,
        loading: false,
        lastIncident: prev.lastIncident,
        lastRecovery: prev.consecutiveFailures > 0 ? new Date().toLocaleTimeString() : prev.lastRecovery
      }));
    } catch (err) {
      const duration = Date.now() - startTime;
      setHealthStatus((prev) => ({
        status: "unavailable",
        database: "disconnected",
        responseTime: duration,
        lastCheck: new Date().toLocaleTimeString(),
        consecutiveFailures: prev.consecutiveFailures + 1,
        loading: false,
        lastIncident: new Date().toLocaleTimeString(),
        lastRecovery: prev.lastRecovery
      }));
    }
  }

  // Periodic Admin Health Check (Only while settings/reports tab is open)
  useEffect(() => {
    if (!token || !user || user.role !== "admin") return;
    if (tab === "more" || tab === "reports") {
      fetchHealthCheck();
      const interval = setInterval(fetchHealthCheck, 30000);
      return () => clearInterval(interval);
    }
  }, [token, user, tab]);

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

  async function logout(msg = "") {
    localStorage.removeItem("madrasa_token");
    localStorage.removeItem("madrasa_user");
    localStorage.removeItem("madrasa_session_start");
    setToken("");
    setUser(null);
    setClasses([]);
    setStudents([]);
    setRecords({});
    setNotes({});
    setSessionExpiryWarning(false);
    stopCamera();
    await clearUserCache();
    if (msg) {
      setError(msg);
    }
  }

  // System Settings, Teachers & Storage Admin loaders
  useEffect(() => {
    if (!token || !user) return;
    if (tab === "more" || tab === "reports") {
      fetchEmailStatus();
      if (user.role === "admin") {
        fetchTeachers();
        fetchStorageStatus();
        fetchSystemSettings();
      }
    }
  }, [token, user, tab]);

  async function fetchTeachers() {
    try {
      const res = await api.get("/admin/users");
      setTeachers(res.data);
    } catch (err) {
      console.warn("fetchTeachers error:", err.message);
    }
  }

  async function fetchStorageStatus() {
    try {
      setStorageLoading(true);
      const res = await api.get("/admin/storage/status");
      setStorageReport(res.data);
    } catch (err) {
      console.warn("fetchStorageStatus error:", err.message);
    } finally {
      setStorageLoading(false);
    }
  }

  async function fetchEmailStatus() {
    try {
      const res = await api.get("/reports/weekly/status");
      setEmailStatus(res.data);
    } catch (err) {
      console.warn("fetchEmailStatus error:", err.message);
    }
  }

  async function fetchSystemSettings() {
    try {
      const res = await api.get("/settings");
      if (res.data) {
        setSettingsForm({
          reportRecipientEmail: res.data.reportRecipientEmail || "",
          reportTimezone: res.data.reportTimezone || "Asia/Kolkata",
          reportSchedule: res.data.reportSchedule || "Mondays at 06:00 AM",
          reportAutomationEnabled: Boolean(res.data.reportAutomationEnabled),
          attendanceCorrectionWindowDays: res.data.attendanceCorrectionWindowDays ?? 7
        });
      }
    } catch (err) {
      console.warn("fetchSystemSettings error:", err.message);
    }
  }

  async function verifySecondaryStorage() {
    try {
      setStorageLoading(true);
      setError("");
      setNotice("Verifying secondary MongoDB Atlas cluster...");
      const res = await api.post("/admin/storage/verify-secondary");
      if (res.data?.success || res.data?.ok) {
        const colls = res.data.collections ? Object.keys(res.data.collections).join(", ") : "All collections ready";
        const ping = res.data.pingMs ? ` (${res.data.pingMs}ms latency)` : "";
        setNotice(`Secondary database verified successfully ✓ ${colls}${ping}`);
        addNotification({
          title: "Storage Verified",
          message: "Secondary MongoDB Atlas cluster connection and collections verified.",
          type: "success"
        });
      } else {
        setError(`Secondary database verification failed: ${res.data?.message || res.data?.error || "Unknown error"}`);
      }
      fetchStorageStatus();
    } catch (err) {
      setError(errText(err));
    } finally {
      setStorageLoading(false);
    }
  }

  async function rotateStorageDestination() {
    if (!window.confirm("Are you sure you want to trigger storage rotation to the secondary MongoDB Atlas cluster? New attendance records will write to the secondary destination.")) {
      return;
    }
    try {
      setStorageLoading(true);
      setError("");
      setNotice("Initiating storage rotation...");
      const currentTarget = storageReport?.activeWriteTarget || "primary";
      const nextTarget = currentTarget === "secondary" ? "primary" : "secondary";
      const res = await api.post("/admin/storage/rotate", { target: nextTarget, reason: "Admin manual rotation trigger" });
      setNotice(`Storage rotated to ${res.data?.activeStorage || "secondary"} ✓`);
      addNotification({
        title: "Storage Rotated",
        message: `Database active destination is now ${res.data?.activeStorage || "secondary"}.`,
        type: "success"
      });
      fetchStorageStatus();
    } catch (err) {
      setError(errText(err));
    } finally {
      setStorageLoading(false);
    }
  }

  async function handleCreateTeacher(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      await api.post("/admin/users", {
        name: teacherForm.name,
        email: teacherForm.email,
        password: teacherForm.password,
        role: "teacher",
        assignedClasses: teacherForm.assignedClasses
      });
      setNotice(`Teacher account for ${teacherForm.name} created successfully.`);
      setShowAddTeacherModal(false);
      setTeacherForm({ name: "", email: "", password: "", assignedClasses: [] });
      fetchTeachers();
    } catch (err) {
      setError(errText(err));
    }
  }

    async function handleDeleteClass(cls) {
    const clsId = cls._id || cls.id;
    if (!window.confirm(`Are you sure you want to remove class "${cls.name} (${cls.section || 'All'})"? Active students will need to be reassigned to another class.`)) {
      return;
    }
    setError("");
    setNotice("");
    setLoading(true);
    try {
      await api.delete(`/classes/${clsId}`);
      setClasses((prev) => prev.filter((c) => (c._id || c.id) !== clsId));
      try { await offlineDb.classes.delete(String(clsId)); } catch {}
      setNotice(`Class "${cls.name}" was removed successfully.`);
      if (selectedClass === clsId) {
        const remaining = classes.filter((c) => (c._id || c.id) !== clsId);
        if (remaining.length) setSelectedClass(remaining[0]._id || remaining[0].id);
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }

  async function downloadWeeklyExcelNow() {
    setLoading(true);
    setError("");
    try {
      const now = new Date();
      const currentDay = now.getDay();
      const diffToSunday = currentDay === 0 ? 7 : currentDay;
      const prevSunday = new Date(now);
      prevSunday.setDate(now.getDate() - diffToSunday);
      const prevMonday = new Date(prevSunday);
      prevMonday.setDate(prevSunday.getDate() - 6);
      const from = prevMonday.toISOString().slice(0, 10);
      const to = prevSunday.toISOString().slice(0, 10);
      await triggerFileDownload("/reports/weekly-excel", {}, `Madrasa-Amanah-Weekly-Attendance-${from}-to-${to}.xlsx`);
      setNotice("Weekly Excel report downloaded successfully ✓");
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeactivateTeacher(teacher) {
    if (!window.confirm(`Are you sure you want to deactivate teacher ${teacher.name}? Safe account rules apply: historical attendance records, class logs, and audit trails will be strictly preserved.`)) {
      return;
    }
    setError("");
    setNotice("");
    try {
      await api.delete(`/admin/users/${teacher._id || teacher.id}`);
      setNotice(`Teacher ${teacher.name} has been deactivated. Historical records preserved.`);
      fetchTeachers();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function handleResetTeacherPassword(e) {
    e.preventDefault();
    if (!resetPasswordTeacher) return;
    setError("");
    setNotice("");
    try {
      await api.post(`/admin/users/${resetPasswordTeacher._id || resetPasswordTeacher.id}/reset-password`, {
        newPassword: newTeacherPassword
      });
      setNotice(`Password for ${resetPasswordTeacher.name} was reset successfully.`);
      setResetPasswordTeacher(null);
      setNewTeacherPassword("");
    } catch (err) {
      setError(errText(err));
    }
  }

  async function handleSaveSettings(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      await api.patch("/settings", settingsForm);
      setNotice("System settings updated successfully ✓");
      addNotification({
        title: "Settings Saved",
        message: "Weekly report automation and attendance correction window settings updated.",
        type: "success"
      });
      fetchEmailStatus();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function handlePasswordChange(e) {
    e.preventDefault();
    setPasswordError("");
    setPasswordNotice("");
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }
    if (passwordForm.newPassword.length < 6) {
      setPasswordError("Password must be at least 6 characters.");
      return;
    }
    try {
      await api.post("/auth/change-password", {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword
      });
      setPasswordNotice("Password changed successfully ✓");
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      addNotification({
        title: "Password Changed",
        message: "Your account password has been updated securely.",
        type: "success"
      });
    } catch (err) {
      setPasswordError(errText(err));
    }
  }

  async function signIn(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await api.post("/auth/login", login);
      const sessionStart = r.data.session?.sessionStart ? r.data.session.sessionStart * 1000 : Date.now();
      localStorage.setItem("madrasa_token", r.data.token);
      localStorage.setItem("madrasa_user", JSON.stringify(r.data.user));
      localStorage.setItem("madrasa_session_start", String(sessionStart));
      lastActivityRef.current = Date.now();
      setToken(r.data.token);
      setUser(r.data.user);
      await isolateUserCache(r.data.user.id || r.data.user._id);
      triggerSync();
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  // Resilient Face API Loader with CDN fallback and promise sharing
  const faceApiRef = useRef(null);
  const faceApiPromiseRef = useRef(null);

  async function loadFaceApi() {
    if (faceApiRef.current) return faceApiRef.current;
    if (faceApiPromiseRef.current) return faceApiPromiseRef.current;

    faceApiPromiseRef.current = (async () => {
      const faceapi = await import("@vladmandic/face-api");
      const CDN_BASE = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";
      const LOCAL_BASE = "/models";
      let modelBase = CDN_BASE;

      try {
        // Probe local /models directory to verify real binary weights are deployed (and not the SPA index.html fallback)
        const check = await fetch(`${LOCAL_BASE}/tiny_face_detector_model.bin`, { method: "HEAD" });
        const cType = check.headers.get("content-type") || "";
        const cLen = Number(check.headers.get("content-length") || 0);
        if (check.ok && !cType.includes("text/html") && (cLen > 100000 || cLen === 0)) {
          modelBase = LOCAL_BASE;
        }
      } catch {
        modelBase = CDN_BASE;
      }

      console.info(`Madrasa Amanah: Initializing face models from ${modelBase}`);
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelBase),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelBase),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelBase)
      ]);

      faceApiRef.current = faceapi;
      return faceapi;
    })();

    try {
      return await faceApiPromiseRef.current;
    } catch (err) {
      faceApiPromiseRef.current = null; // allow retry
      console.error("Face model load failure:", err);
      throw new Error("Face recognition models unavailable. Manual attendance is active.");
    }
  }

  // Extract Face Descriptor from image data URL — with clear status reporting
  async function extractDescriptor(dataUrl) {
    try {
      const faceapi = await loadFaceApi();
      // Create an Image element and wait for it to fully load before detection
      const img = document.createElement("img");
      img.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Failed to decode the captured image."));
        img.src = dataUrl;
      });
      if (!img.naturalWidth || !img.naturalHeight) {
        throw new Error("Image has invalid dimensions (0×0).");
      }
      const res = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.38 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      return res ? Array.from(res.descriptor) : null;
    } catch (err) {
      console.warn("Face detection error:", err.message);
      throw err; // propagate — caller will decide what to show
    }
  }

  // Camera Management (getUserMedia) — prevents black screen on laptops & mobiles
  async function startCamera(facing = "user", mode = "student-profile") {
    setCameraFacing(facing);
    setCameraMode(mode);
    stopCamera();
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Direct camera access not supported on this browser.");
      }

      let stream = null;
      try {
        // 1. Try requested ideal facing mode
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: facing ? { ideal: facing } : undefined,
            width: { ideal: 1280, min: 320 },
            height: { ideal: 720, min: 240 }
          },
          audio: false
        });
      } catch (e1) {
        // 2. Resilient fallback for desktop webcams that don't support facingMode constraints
        console.warn("Facing constraint failed, falling back to basic video:", e1.message);
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      if (!stream) throw new Error("Could not initialize camera stream.");

      streamRef.current = stream;
      setCameraActive(true);

      const attachVideo = () => {
        const vid = videoRef.current;
        if (!vid || !streamRef.current) return;
        vid.srcObject = streamRef.current;
        vid.setAttribute("playsinline", "true");
        vid.setAttribute("autoplay", "true");
        vid.muted = true;
        vid.onloadedmetadata = () => {
          vid.play().catch((pErr) => console.warn("Auto-play warning:", pErr));
        };
        vid.play().catch(() => {});
      };

      requestAnimationFrame(() => {
        setTimeout(attachVideo, 60);
      });
    } catch (err) {
      setError(`Camera error: ${err.message}. Please check browser camera permissions.`);
      if (mode === "student-profile") {
        document.getElementById("profile-camera-file-input")?.click();
      } else {
        document.getElementById("class-photo-input")?.click();
      }
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }

  function snapPhoto() {
    if (!videoRef.current) return;
    const vw = videoRef.current.videoWidth;
    const vh = videoRef.current.videoHeight;
    if (!vw || !vh) {
      setError("Camera not ready yet — please wait a moment and try again.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    const currentMode = cameraMode;
    stopCamera();

    if (currentMode === "class-attendance") {
      processClassPhoto(dataUrl);
    } else {
      handleNewPhoto(dataUrl);
    }
  }

  async function handleNewPhoto(dataUrl) {
    setProfilePreviewPhoto(dataUrl);
    setProfilePreviewDescriptor(null);
    setFaceDetectStatus("loading");
    setPhotoSaveError("");
    setNotice("Analyzing image for face detection...");

    // Validate image size (reject > 5MB data URLs)
    if (dataUrl.length > 5 * 1024 * 1024 * 1.37) {
      setFaceDetectStatus("error");
      setNotice("Image is too large. Please use a smaller photo (under 5 MB).");
      return;
    }

    try {
      const desc = await extractDescriptor(dataUrl);
      setProfilePreviewDescriptor(desc);
      if (desc) {
        setFaceDetectStatus("detected");
        setNotice("Face detected and descriptor ready ✓");
      } else {
        setFaceDetectStatus("no-face");
        setNotice("No face detected in this image. You can still save the photo for manual attendance.");
      }
    } catch (err) {
      setProfilePreviewDescriptor(null);
      if (err.message?.includes("model") || err.message?.includes("404") || err.message?.includes("not found")) {
        setFaceDetectStatus("unavailable");
        setNotice("Face recognition models could not load. Photo can still be saved for manual attendance.");
      } else {
        setFaceDetectStatus("error");
        setNotice(`Face detection failed: ${err.message}. Photo can still be saved.`);
      }
    }
  }

  // Save / Replace Reference Photo
  async function saveStudentPhoto() {
    if (!viewingStudent || !profilePreviewPhoto) return;
    setPhotoSaving(true);
    setPhotoSaveError("");
    const studentId = viewingStudent._id || viewingStudent.id;
    const previousPhotoUrl = viewingStudent.photoUrl; // preserve old photo reference

    try {
      if (isOnline) {
        const { data } = await api.patch(`/students/${studentId}`, {
          photoDataUrl: profilePreviewPhoto,
          faceDescriptor: profilePreviewDescriptor
        });
        // Verify server returned a valid permanent photo URL (not a blob)
        if (data.photoUrl && !data.photoUrl.startsWith("blob:") && !data.photoUrl.startsWith("data:")) {
          setStudents((prev) =>
            prev.map((s) => (String(s._id || s.id) === String(studentId) ? data : s))
          );
          setDirectoryStudents((prev) =>
            prev.map((s) => (String(s._id || s.id) === String(studentId) ? { ...s, photoUrl: data.photoUrl, referencePhotoUrl: data.photoUrl } : s))
          );
          if (viewingStudentProfile && String(viewingStudentProfile._id || viewingStudentProfile.id) === String(studentId)) {
            setViewingStudentProfile((prev) => ({ ...prev, photoUrl: data.photoUrl, referencePhotoUrl: data.photoUrl }));
          }
          setViewingStudent(data);
          await updateStudentInCache(data);
          addNotification({
            title: "Reference Photo Updated",
            message: `Photo for ${data.name} (${data.admissionNo}) saved to cloud storage.`,
            type: "success"
          });
          setNotice("Reference photo saved and uploaded successfully ✓");
          setProfilePreviewPhoto(null);
          setProfilePreviewDescriptor(null);
          setFaceDetectStatus("");
        } else {
          // Server responded but URL looks like a temp reference
          setPhotoSaveError("Server saved the record but the photo URL may not be permanent. Please verify in the student list.");
        }
      } else {
        await queuePhotoUpdate({
          studentId,
          photoDataUrl: profilePreviewPhoto,
          faceDescriptor: profilePreviewDescriptor
        });
        addNotification({
          title: "Photo Saved Locally (Offline)",
          message: `Photo for ${viewingStudent.name} queued for upload when online.`,
          type: "warning"
        });
        setNotice("Photo saved on this device — will upload when internet reconnects.");
        setProfilePreviewPhoto(null);
        setProfilePreviewDescriptor(null);
        setFaceDetectStatus("");
        await refreshSyncStatus();
      }
    } catch (e) {
      // Keep preview and old photo intact on failure — allow retry
      setPhotoSaveError(errText(e));
      setNotice("");
    } finally {
      setPhotoSaving(false);
    }
  }

  // Close the student profile modal safely
  function closeStudentModal() {
    stopCamera();
    setViewingStudent(null);
    setProfilePreviewPhoto(null);
    setProfilePreviewDescriptor(null);
    setFaceDetectStatus("");
    setPhotoSaveError("");
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

  // B: Save Attendance with Real Authoritative Confirmation & 6-Month Cache
  async function saveAttendance() {
    if (savingAttendanceRef.current) return; // Prevent duplicate rapid submission
    setError("");
    setNotice("");
    const unmarked = students.filter((s) => !records[s._id || s.id]?.status);
    if (unmarked.length > 0) {
      const sampleNames = unmarked.slice(0, 3).map((s) => s.name).join(", ");
      const extra = unmarked.length > 3 ? ` and ${unmarked.length - 3} more` : "";
      setError(
        `Please mark all ${students.length} students. ${unmarked.length} student(s) still need a status (${sampleNames}${extra}).`
      );
      return;
    }

    savingAttendanceRef.current = true;
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

      // 2. Cache into 6-month historical offline store
      await cacheAttendanceHistory(studentRecords, selectedClass, dateKey, sessionKey);
      await refreshSyncStatus();

      const counts = {
        present: presentCount,
        absent: absentCount,
        late: lateCount,
        excused: excusedCount
      };

      // 3. Online: Direct API save to MongoDB Atlas
      if (isOnline) {
        try {
          const res = await api.post("/attendance/bulk", {
            mutationId: localResult?.mutationId,
            classId: selectedClass,
            dateKey,
            sessionKey,
            source: detected.length ? "photo-assisted" : "manual",
            records: studentRecords
          });

          // Immediately mark outbox item as synced using the assigned mutationId
          if (localResult?.mutationId) {
            await markOutboxSynced(localResult.mutationId, res.data);
            await refreshSyncStatus();
          }

          // Mark records as confirmed
          const nextConfirmed = {};
          studentRecords.forEach((r) => {
            nextConfirmed[r.studentId] = { status: r.status, updatedAt: res.data.confirmedAt || new Date().toISOString() };
          });
          setConfirmedRecords(nextConfirmed);

          if (monitoringData) {
            fetchMonitoringData();
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
            message: `${activeClass?.name || "Class"} (${sessionKey}) - ${students.length} marked. Confirmed by MongoDB Atlas.`,
            type: "success"
          });
        } catch (serverErr) {
          setError(
            t.savingFailed || "Failed to save attendance to server. Draft preserved locally."
          );
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
      savingAttendanceRef.current = false;
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
    setNotice("Marked all unmarked students as present.");
  }

  function markRemainingAbsent() {
    const next = { ...records };
    students.forEach((s) => {
      const sid = s._id || s.id;
      if (!next[sid]?.status) {
        next[sid] = { status: "absent" };
      }
    });
    setRecords(next);
    setNotice("Marked remaining unmarked students as absent.");
  }

  function mark(id, status) {
    setRecords((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), status } }));
  }

  // Classroom Photo Recognition — supports File upload and direct camera dataUrl
  async function processClassPhoto(fileOrDataUrl) {
    setClassPhoto(fileOrDataUrl);
    setDetected([]);
    setError("");
    setNotice("Scanning photo for student faces...");
    if (!fileOrDataUrl) return;

    try {
      if (typeof fileOrDataUrl !== "string" && fileOrDataUrl.size > 8 * 1024 * 1024) {
        throw new Error("Please select a photo under 8 MB.");
      }
      const faceapi = await loadFaceApi();

      let img;
      if (typeof fileOrDataUrl === "string") {
        img = document.createElement("img");
        img.crossOrigin = "anonymous";
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error("Failed to decode camera snapshot."));
          img.src = fileOrDataUrl;
        });
      } else {
        const objectUrl = URL.createObjectURL(fileOrDataUrl);
        try {
          img = await faceapi.fetchImage(objectUrl);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }

      const found = await faceapi
        .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.38 }))
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
        const confident = best && best.distance < 0.58;
        const confidencePct = best ? Math.max(0, Math.min(100, Math.round((1 - best.distance) * 100))) : 0;
        return {
          faceNo: i + 1,
          descriptor: d,
          studentId: confident ? best.student.id || best.student._id : "",
          matchName: confident ? best.student.name : "",
          matchAdmissionNo: confident ? (best.student.admissionNo || best.student.admissionNumber || "") : "",
          distance: best ? best.distance : null,
          confidencePct,
          confirmed: false
        };
      });

      setDetected(matches);
      if (!found.length) {
        setNotice("No faces detected in this photo. You can mark attendance manually below.");
      } else {
        const recognizedCount = matches.filter((m) => m.studentId).length;
        setNotice(`Detected ${found.length} face(s) (${recognizedCount} recognized with high confidence). Review below.`);
      }
    } catch (e) {
      setError(`${errText(e)} Continue with manual attendance.`);
    }
  }

  function confirmFaceMatch(faceNo, status = "present") {
    const item = detected.find((f) => f.faceNo === faceNo);
    if (!item || !item.studentId) return;

    setDetected((prev) =>
      prev.map((f) => (f.faceNo === faceNo ? { ...f, confirmed: true } : f))
    );

    setRecords((prev) => ({
      ...prev,
      [item.studentId]: { ...(prev[item.studentId] || {}), status }
    }));

    setNotice(`Confirmed ${item.matchName || "Student"} as ${status} ✓`);
  }

  function confirmAllFaceMatches() {
    let count = 0;
    const updatedRecords = { ...records };
    setDetected((prev) =>
      prev.map((f) => {
        if (f.studentId) {
          updatedRecords[f.studentId] = { ...(updatedRecords[f.studentId] || {}), status: "present" };
          count++;
          return { ...f, confirmed: true };
        }
        return f;
      })
    );
    setRecords(updatedRecords);
    setNotice(`Confirmed all ${count} recognized student(s) as Present ✓. Click "Save Attendance" to persist.`);
  }

  function changeFaceStudent(faceNo, newStudentId) {
    const matched = students.find((s) => String(s._id || s.id) === String(newStudentId));
    setDetected((prev) =>
      prev.map((f) => {
        if (f.faceNo !== faceNo) return f;
        return {
          ...f,
          studentId: newStudentId,
          matchName: matched ? matched.name : "",
          matchAdmissionNo: matched ? (matched.admissionNo || matched.admissionNumber || "") : "",
          confirmed: false
        };
      })
    );
  }

  function dismissFaceMatch(faceNo) {
    setDetected((prev) => prev.filter((f) => f.faceNo !== faceNo));
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

  // Generic File Download Helper with Content-Disposition & UTF-8 parsing
  async function triggerFileDownload(endpoint, params = {}, fallbackName = "download") {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      const res = await api.get(endpoint, { params, responseType: "blob" });

      let filename = fallbackName;
      const disposition = res.headers["content-disposition"];
      if (disposition) {
        const utf8Match = /filename\*=UTF-8''([^;\n]+)/i.exec(disposition);
        if (utf8Match && utf8Match[1]) {
          filename = decodeURIComponent(utf8Match[1].trim());
        } else {
          const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i.exec(disposition);
          if (match && match[1]) {
            filename = match[1].replace(/['"]/g, "").trim();
          }
        }
      }

      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      addNotification({
        title: "Download Complete",
        message: `${filename} downloaded successfully.`,
        type: "success"
      });
      setNotice(`Downloaded ${filename} ✓`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  // F: Download with Clean Human-Readable Filenames
  async function downloadReport(format) {
    const className = activeClass ? `${activeClass.name}${activeClass.section ? `-${activeClass.section}` : ""}` : "Class";
    const cleanClassName = className.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    const generatedName = `Madrasa-Amanah-Attendance-${cleanClassName}-${reportRange.from}${reportRange.from !== reportRange.to ? `-to-${reportRange.to}` : ""}.${format === "xlsx" ? "xlsx" : format}`;
    await triggerFileDownload("/reports/export", { classId: selectedClass, ...reportRange, format }, generatedName);
  }

  async function downloadWeeklyReport() {
    await triggerFileDownload("/reports/weekly-excel", {}, `Madrasa-Amanah-Weekly-Attendance-${today()}.xlsx`);
  }

  async function downloadStudentsRoster(format = "csv") {
    const className = activeClass ? `${activeClass.name}${activeClass.section ? `-${activeClass.section}` : ""}` : "All-Classes";
    const cleanClassName = className.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    const generatedName = `Madrasa-Amanah-Students-${cleanClassName}-${today()}.${format}`;
    await triggerFileDownload("/students/export", { classId: selectedClass || undefined, format }, generatedName);
  }

  async function downloadSystemBackup() {
    await triggerFileDownload("/admin/backup/export", {}, `Madrasa-Amanah-Backup-${today()}.json`);
  }

  async function sendWeeklyEmail() {
    if (loading) return;
    setError("");
    setNotice("Generating and sending weekly report email...");
    setLoading(true);
    try {
      const res = await api.post("/reports/send-weekly-email", {
        recipientEmail: settingsForm.reportRecipientEmail || undefined
      });
      if (res.data?.delivered) {
        setNotice(`Weekly report email sent successfully to ${res.data.recipient} ✓`);
        addNotification({
          title: "Weekly Email Sent",
          message: `Attendance report for ${res.data.from} to ${res.data.to} delivered to ${res.data.recipient}.`,
          type: "success"
        });
      } else {
        setNotice(`Weekly report generated (${res.data?.bytes || 0} bytes). ${res.data?.message || ""}`);
        addNotification({
          title: "Weekly Report Generated",
          message: `Workbook created for ${res.data?.recipient || "admin"}. Delivery status: ${res.data?.message || "Pending SMTP configuration."}`,
          type: "info"
        });
      }
      fetchEmailStatus();
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

          {error && (
            <div className="alert error" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={18} style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          )}

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
            className={`btn ${tab === "monitoring" ? "primary" : "secondary"}`}
            onClick={() => setTab("monitoring")}
            style={{ justifyContent: "flex-start" }}
          >
            <Activity size={18} /> {t.monitoring}
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
            onClick={() => {
              setShowNotificationDrawer(true);
              markAllNotificationsRead();
            }}
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
            <span>{isOnline ? t.online : t.offline}</span>
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
              <h2>{t.attendanceToday}</h2>
              <p>
                {activeClass
                  ? `${formatClassLabel(activeClass, lang)}`
                  : t.selectClassToBegin}
                {" · "}
                {formatDate(dateKey, lang)}
              </p>
              <button className="hero-take-btn" onClick={() => setTab("attendance")}>
                <Camera size={22} />
                <span>{t.takeAttendanceAction || t.attendance}</span>
              </button>
            </div>

            <div className="card" style={{ padding: "14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label>
                  {t.class}
                  <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                    {classes.map((c) => (
                      <option key={c._id || c.id} value={c._id || c.id}>
                        {formatClassLabel(c, lang)}
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
                <div className="mobile-stat-value">{formatNumber(students.length, lang)}</div>
                <div className="mobile-stat-note">{t.enrolledRoster}</div>
              </div>

              <div className="mobile-stat-card">
                <div className="mobile-stat-header">
                  <span>{t.present}</span>
                  <Check size={16} color="var(--success)" />
                </div>
                <div className="mobile-stat-value" style={{ color: "var(--success)" }}>
                  {formatNumber(presentCount, lang)}
                </div>
                <div className="mobile-stat-note">{t.markedPresent}</div>
              </div>

              <div className="mobile-stat-card">
                <div className="mobile-stat-header">
                  <span>{t.absent}</span>
                  <Activity size={16} color="var(--danger)" />
                </div>
                <div className="mobile-stat-value" style={{ color: "var(--danger)" }}>
                  {formatNumber(absentCount, lang)}
                </div>
                <div className="mobile-stat-note">{t.markedAbsent}</div>
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
                  {formatNumber(notMarkedCount, lang)}
                </div>
                <div className="mobile-stat-note">{t.requiresMarking}</div>
              </div>
            </div>

            <div className="card">
              <div className="section-title">
                <div>
                  <h3>{t.offlineSyncStatus}</h3>
                  <p className="muted">
                    {pendingCount > 0
                      ? t("dashboard.registersWaitingUpload", { count: formatNumber(pendingCount, lang) })
                      : t.allRegistersSynced}
                  </p>
                </div>
                {pendingCount > 0 ? (
                  <span className="status-pill pending">
                    <Clock size={13} /> {t("dashboard.pendingCountBadge", { count: formatNumber(pendingCount, lang) })}
                  </span>
                ) : (
                  <span className="status-pill online">
                    <CheckCircle2 size={13} /> {t.syncedBadge}
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
            {/* Live Cache & Freshness Indicator */}
            {attendanceFreshness && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--muted)", marginBottom: 8, padding: "5px 10px", background: "var(--canvas)", borderRadius: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {attendanceFreshness.type === "synced" ? (
                    <span style={{ color: "var(--success)", display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
                      <CheckCircle2 size={13} /> {t("dataStatus.freshlySynced", "Synchronized")}
                    </span>
                  ) : (
                    <span style={{ color: "#d97706", display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
                      <Clock size={13} /> {t("dataStatus.cachedData", "Cached (Offline)")}
                    </span>
                  )}
                </span>
                <span>{t("dataStatus.lastUpdated", { time: attendanceFreshness.time })}</span>
              </div>
            )}
            {attendanceLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--primary)", padding: "4px 8px", marginBottom: 6 }}>
                <RefreshCw size={13} className="spin" />
                <span>{t("dataStatus.loadingData", "Loading fresh data from cloud…")}</span>
              </div>
            )}

            {/* 2.1 Clear, Mobile-Friendly Attendance Header */}
            <div className="card" style={{ padding: "14px", marginBottom: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <label>
                  {t.class}
                  <select
                    value={selectedClass}
                    onChange={(e) => setSelectedClass(e.target.value)}
                    style={{ minHeight: 44, fontSize: 13 }}
                  >
                    {classes.map((c) => (
                      <option key={c._id || c.id} value={c._id || c.id}>
                        {formatClassLabel(c, lang)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  {t.session}
                  <select
                    value={sessionKey}
                    onChange={(e) => setSessionKey(e.target.value)}
                    style={{ minHeight: 44, fontSize: 13 }}
                  >
                    <option value="morning">{t.morning}</option>
                    <option value="afternoon">{t.afternoon}</option>
                    <option value="evening">{t.evening}</option>
                    <option value="full-day">{t.fullDay}</option>
                  </select>
                </label>
              </div>

              <div style={{ marginBottom: 10 }}>
                <label>
                  {t.date}
                  <input
                    type="date"
                    value={dateKey}
                    onChange={(e) => setDateKey(e.target.value)}
                    style={{ minHeight: 44, fontSize: 13 }}
                  />
                </label>
              </div>

              {/* Selected class, date, and session summary badge */}
              <div
                style={{
                  background: "var(--primary-subtle)",
                  color: "var(--primary)",
                  padding: "8px 12px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 10
                }}
              >
                <span>
                  {activeClass ? formatClassLabel(activeClass, lang) : t.class} · {formatDate(dateKey, lang)} · {localizeSection(sessionKey, lang)}
                </span>
                <span>{formatNumber(students.length, lang)} {t.totalStudents}</span>
              </div>

              {/* 5 Distinct Attendance Counters */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, textAlign: "center" }}>
                <div style={{ background: "var(--success-bg)", padding: "6px 2px", borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: "var(--success)", fontWeight: 600 }}>{t.present}</div>
                  <strong style={{ fontSize: 15, color: "var(--success)" }}>{formatNumber(presentCount, lang)}</strong>
                </div>
                <div style={{ background: "var(--danger-bg)", padding: "6px 2px", borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: "var(--danger)", fontWeight: 600 }}>{t.absent}</div>
                  <strong style={{ fontSize: 15, color: "var(--danger)" }}>{formatNumber(absentCount, lang)}</strong>
                </div>
                <div style={{ background: "#FFF8E6", padding: "6px 2px", borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: "#B78103", fontWeight: 600 }}>{t.late}</div>
                  <strong style={{ fontSize: 15, color: "#B78103" }}>{formatNumber(lateCount, lang)}</strong>
                </div>
                <div style={{ background: "var(--info-bg)", padding: "6px 2px", borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: "var(--info)", fontWeight: 600 }}>{t.excused}</div>
                  <strong style={{ fontSize: 15, color: "var(--info)" }}>{formatNumber(excusedCount, lang)}</strong>
                </div>
                <div
                  style={{
                    background: notMarkedCount > 0 ? "var(--warning-bg)" : "var(--canvas)",
                    padding: "6px 2px",
                    borderRadius: 6
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: notMarkedCount > 0 ? "var(--warning)" : "var(--muted)",
                      fontWeight: 600
                    }}
                  >
                    {t.notMarked}
                  </div>
                  <strong
                    style={{
                      fontSize: 15,
                      color: notMarkedCount > 0 ? "var(--warning)" : "var(--muted)"
                    }}
                  >
                    {formatNumber(notMarkedCount, lang)}
                  </strong>
                </div>
              </div>
            </div>

            {/* Student Search and Batch Actions */}
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

              <div className="quick-batch-bar" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <button
                  className="btn secondary"
                  onClick={markAllPresent}
                  style={{ minHeight: 38, padding: "6px 12px", fontSize: 12, flex: 1 }}
                >
                  <UserCheck size={15} /> {t.markAllPresent}
                </button>

                {notMarkedCount > 0 && (
                  <button
                    className="btn secondary"
                    onClick={markRemainingAbsent}
                    style={{ minHeight: 38, padding: "6px 12px", fontSize: 12, flex: 1, color: "var(--danger)" }}
                  >
                    <X size={15} /> {t.markRemainingAbsent}
                  </button>
                )}

                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => startCamera("environment", "class-attendance")}
                  style={{ minHeight: 38, padding: "6px 12px", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                >
                  <Camera size={15} /> {t.liveCameraScan}
                </button>

                <label
                  htmlFor="class-photo-input"
                  className="btn secondary"
                  style={{ minHeight: 38, padding: "6px 12px", fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  <Image size={15} /> {t.uploadPhoto}
                </label>
                <input
                  id="class-photo-input"
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => processClassPhoto(e.target.files?.[0])}
                />
              </div>

              {/* Phase 3 Face Suggestions & Review */}
              {detected.length > 0 && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <strong style={{ fontSize: 13 }}>{t.faceSuggestions} ({formatNumber(detected.length, lang)})</strong>
                      <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                        {t.faceSuggestionsSub}
                      </p>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {detected.some((f) => f.studentId && !f.confirmed) && (
                        <button
                          className="btn primary"
                          style={{ minHeight: 30, fontSize: 11, padding: "4px 8px" }}
                          onClick={confirmAllFaceMatches}
                        >
                          <Check size={13} /> {t.confirmAllPresent}
                        </button>
                      )}
                      <button
                        onClick={() => setDetected([])}
                        style={{ background: "none", border: "none", color: "var(--muted)", padding: 4, cursor: "pointer" }}
                        title={t.clearSuggestions}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    {detected.map((f) => (
                      <div
                        key={f.faceNo}
                        style={{
                          background: f.confirmed ? "var(--success-bg)" : "var(--canvas)",
                          border: `1px solid ${f.confirmed ? "var(--success)" : "var(--border)"}`,
                          padding: "10px 12px",
                          borderRadius: 8,
                          display: "flex",
                          flexDirection: "column",
                          gap: 8
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 12 }}>
                            {t("faceMatching.faceItem", { number: formatNumber(f.faceNo, lang) })}: <strong>{f.matchName || t.unmatched}</strong> {f.matchAdmissionNo ? `(${f.matchAdmissionNo})` : ""}
                            {f.confidencePct > 0 && (
                              <span style={{ fontSize: 10, color: f.confidencePct > 70 ? "var(--success)" : "var(--warning)", marginInlineStart: 6 }}>
                                {t("faceMatching.matchPercentage", { pct: formatNumber(f.confidencePct, lang) })}
                              </span>
                            )}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: 4,
                              background: f.confirmed ? "var(--success)" : "var(--warning-bg)",
                              color: f.confirmed ? "#fff" : "var(--warning)"
                            }}
                          >
                            {f.confirmed ? t.confirmed : t.suggested}
                          </span>
                        </div>

                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <select
                            value={f.studentId}
                            onChange={(e) => changeFaceStudent(f.faceNo, e.target.value)}
                            style={{ flex: 1, minHeight: 36, fontSize: 12, padding: "4px 8px" }}
                          >
                            <option value="">{t.chooseStudent}</option>
                            {students.map((s) => (
                              <option key={s._id || s.id} value={s._id || s.id}>
                                {localizeStudentName(s.name, lang)} ({s.admissionNo})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button
                            className="btn primary"
                            style={{ minHeight: 34, fontSize: 11, padding: "4px 10px", flex: 1 }}
                            onClick={() => confirmFaceMatch(f.faceNo, "present")}
                            disabled={!f.studentId}
                          >
                            <Check size={14} /> {t.confirmPresent}
                          </button>
                          <button
                            className="btn secondary"
                            style={{ minHeight: 34, fontSize: 11, padding: "4px 10px" }}
                            onClick={() => dismissFaceMatch(f.faceNo)}
                          >
                            <X size={14} /> {t.dismiss}
                          </button>
                        </div>
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
                const isConfirmed = confirmedRecords[sid]?.status === cur && cur !== undefined;
                const displayName = localizeStudentName(s.name, lang);
                return (
                  <div className="student-attendance-card" key={sid}>
                    <div
                      className="student-card-header"
                      style={{ cursor: "pointer", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}
                      onClick={() => setViewingStudent(s)}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div className="student-card-avatar">
                          {s.photoUrl ? <img src={s.photoUrl} alt="" /> : (displayName?.[0] || s.name?.[0])?.toUpperCase()}
                        </div>
                        <div className="student-card-meta">
                          <strong>{displayName}</strong>
                          <span>{s.admissionNo} · {t.studentProfile}</span>
                        </div>
                      </div>

                      <div>
                        {cur ? (
                          <span
                            className={`student-card-status-indicator ${isConfirmed ? "confirmed" : "draft"}`}
                            title={isConfirmed ? t.serverConfirmed : t.localDraft}
                          >
                            {isConfirmed ? <Check size={13} /> : <Clock size={13} />}
                            {(t[cur] || cur)} · {isConfirmed ? t.confirmed : t.localDraft}
                          </span>
                        ) : (
                          <span className="student-card-status-indicator unmarked">
                            <HelpCircle size={13} /> {t.notMarked}
                          </span>
                        )}
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
                <Empty title={t.noStudentsFound} subtitle={t.noStudentsFoundSub} />
              )}
            </div>

            <div className="mobile-sticky-save">
              <div className="save-summary-col">
                <strong>
                  {formatNumber(presentCount, lang)} {t.present} · {formatNumber(absentCount, lang)} {t.absent}
                </strong>
                <span style={{ color: notMarkedCount > 0 ? "var(--warning)" : "var(--success)" }}>
                  {notMarkedCount > 0 ? `${formatNumber(notMarkedCount, lang)} ${t.notMarked}` : t.allMarked}
                </span>
              </div>
              <button
                className="save-action-btn"
                disabled={loading || !students.length}
                onClick={saveAttendance}
              >
                <Check size={18} />
                <span>{isOnline ? t.saveAttendance : t.saveOffline}</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB: ATTENDANCE MONITORING */}
        {tab === "monitoring" && (
          <div>
            {/* Page Header */}
            <div className="tab-header" style={{ marginBottom: 16 }}>
              <div>
                <h2 style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
                  <Activity size={24} style={{ color: "var(--primary)" }} /> {t.monitoring}
                </h2>
                <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
                  {t.monitoringSubtitle}
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {/* Single Date vs Range Toggle */}
                <div style={{ display: "flex", background: "var(--canvas)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: 2 }}>
                  <button
                    type="button"
                    className={`btn ${monitoringMode === "single" ? "primary" : "secondary"}`}
                    style={{ minHeight: 32, padding: "4px 12px", fontSize: 12, border: "none" }}
                    onClick={() => setMonitoringMode("single")}
                  >
                    <Calendar size={14} /> {t.singleDate}
                  </button>
                  <button
                    type="button"
                    className={`btn ${monitoringMode === "range" ? "primary" : "secondary"}`}
                    style={{ minHeight: 32, padding: "4px 12px", fontSize: 12, border: "none" }}
                    onClick={() => setMonitoringMode("range")}
                  >
                    <History size={14} /> {t.dateRange}
                  </button>
                </div>

                <button
                  className="btn secondary"
                  onClick={fetchMonitoringData}
                  disabled={monitoringLoading}
                  style={{ minHeight: 36, padding: "6px 12px", fontSize: 13 }}
                >
                  <RefreshCw size={15} className={monitoringLoading ? "spinning" : ""} /> {t.retry}
                </button>
              </div>
            </div>

            {/* Filters Toolbar */}
            <div className="monitoring-toolbar">
              <div className="monitoring-filter-row">
                {/* Class Selector */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", display: "block", marginBottom: 4 }}>
                    {t.class}
                  </label>
                  <select
                    value={monitoringClass}
                    onChange={(e) => setMonitoringClass(e.target.value)}
                    style={{ width: "100%", minHeight: 40 }}
                  >
                    {user.role === "admin" && <option value="all">{t.allClasses}</option>}
                    {classes.map((c) => (
                      <option key={c._id || c.id} value={c._id || c.id}>
                        {formatClassLabel(c, lang)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Session Selector */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", display: "block", marginBottom: 4 }}>
                    {t.session}
                  </label>
                  <select
                    value={monitoringSession}
                    onChange={(e) => setMonitoringSession(e.target.value)}
                    style={{ width: "100%", minHeight: 40 }}
                  >
                    <option value="all">{t.allSessions}</option>
                    <option value="morning">{t.morning}</option>
                    <option value="afternoon">{t.afternoon}</option>
                    <option value="evening">{t.evening}</option>
                    <option value="full-day">{t.fullDay}</option>
                  </select>
                </div>

                {/* Date / Range Selector */}
                {monitoringMode === "single" ? (
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", display: "block", marginBottom: 4 }}>
                      {t.date}
                    </label>
                    <input
                      type="date"
                      value={monitoringDate}
                      onChange={(e) => setMonitoringDate(e.target.value)}
                      style={{ width: "100%", minHeight: 40 }}
                    />
                  </div>
                ) : (
                  <>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", display: "block", marginBottom: 4 }}>
                        {t.startDate}
                      </label>
                      <input
                        type="date"
                        value={monitoringStartDate}
                        onChange={(e) => setMonitoringStartDate(e.target.value)}
                        style={{ width: "100%", minHeight: 40 }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", display: "block", marginBottom: 4 }}>
                        {t.endDate}
                      </label>
                      <input
                        type="date"
                        value={monitoringEndDate}
                        onChange={(e) => setMonitoringEndDate(e.target.value)}
                        style={{ width: "100%", minHeight: 40 }}
                      />
                    </div>
                  </>
                )}

                {/* Search */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", display: "block", marginBottom: 4 }}>
                    {t.search}
                  </label>
                  <div className="search-input-wrap" style={{ margin: 0 }}>
                    <Search size={16} className="search-icon-pos" />
                    <input
                      type="text"
                      placeholder={t.search}
                      value={monitoringSearch}
                      onChange={(e) => setMonitoringSearch(e.target.value)}
                      style={{ minHeight: 40 }}
                    />
                  </div>
                </div>
              </div>

              {/* Status Filter Pills */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                <div className="monitoring-status-pills">
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginRight: 4 }}>
                    {t.statusFilter}:
                  </span>
                  <button
                    type="button"
                    className={`status-pill-btn ${monitoringStatus === "all" ? "active" : ""}`}
                    onClick={() => setMonitoringStatus("all")}
                  >
                    {t.allStatuses}
                  </button>
                  <button
                    type="button"
                    className={`status-pill-btn pill-present ${monitoringStatus === "present" ? "active" : ""}`}
                    onClick={() => setMonitoringStatus("present")}
                  >
                    <Check size={13} /> {t.present}
                  </button>
                  <button
                    type="button"
                    className={`status-pill-btn pill-absent ${monitoringStatus === "absent" ? "active" : ""}`}
                    onClick={() => setMonitoringStatus("absent")}
                  >
                    <X size={13} /> {t.absent}
                  </button>
                  <button
                    type="button"
                    className={`status-pill-btn pill-late ${monitoringStatus === "late" ? "active" : ""}`}
                    onClick={() => setMonitoringStatus("late")}
                  >
                    <Clock size={13} /> {t.late}
                  </button>
                  <button
                    type="button"
                    className={`status-pill-btn pill-excused ${monitoringStatus === "excused" ? "active" : ""}`}
                    onClick={() => setMonitoringStatus("excused")}
                  >
                    <AlertCircle size={13} /> {t.excused}
                  </button>
                  <button
                    type="button"
                    className={`status-pill-btn pill-unmarked ${monitoringStatus === "unmarked" ? "active" : ""}`}
                    onClick={() => setMonitoringStatus("unmarked")}
                  >
                    <HelpCircle size={13} /> {t.notMarked}
                  </button>
                </div>

                <small style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 11 }}>
                  {t.rateFormulaNotice}
                </small>
              </div>
            </div>

            {/* Error state */}
            {monitoringError && (
              <div className="alert danger" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <span>{monitoringError}</span>
                <button className="btn secondary" onClick={fetchMonitoringData} style={{ minHeight: 32, fontSize: 12, padding: "4px 10px" }}>
                  {t.retry}
                </button>
              </div>
            )}

            {/* Summary KPI Cards */}
            {monitoringData?.summary && (
              <div className="monitoring-kpi-grid">
                <div className="monitoring-kpi-card kpi-eligible">
                  <div className="monitoring-kpi-label"><Users size={14} /> {t.eligibleStudents}</div>
                  <div className="monitoring-kpi-value">{formatNumber(monitoringData.summary.totalEligible ?? 0, lang)}</div>
                  <div className="monitoring-kpi-sub">{t.activeEnrolled}</div>
                </div>
                <div className="monitoring-kpi-card kpi-present">
                  <div className="monitoring-kpi-label"><Check size={14} /> {t.present}</div>
                  <div className="monitoring-kpi-value" style={{ color: "var(--success)" }}>{formatNumber(monitoringData.summary.present ?? 0, lang)}</div>
                  <div className="monitoring-kpi-sub">{t.onTimeAttendees}</div>
                </div>
                <div className="monitoring-kpi-card kpi-absent">
                  <div className="monitoring-kpi-label"><X size={14} /> {t.absent}</div>
                  <div className="monitoring-kpi-value" style={{ color: "var(--danger)" }}>{formatNumber(monitoringData.summary.absent ?? 0, lang)}</div>
                  <div className="monitoring-kpi-sub">{t.unexcusedAbsences}</div>
                </div>
                <div className="monitoring-kpi-card kpi-late">
                  <div className="monitoring-kpi-label"><Clock size={14} /> {t.late}</div>
                  <div className="monitoring-kpi-value" style={{ color: "#D69E2E" }}>{formatNumber(monitoringData.summary.late ?? 0, lang)}</div>
                  <div className="monitoring-kpi-sub">{t.lateArrivals}</div>
                </div>
                <div className="monitoring-kpi-card kpi-excused">
                  <div className="monitoring-kpi-label"><AlertCircle size={14} /> {t.excused}</div>
                  <div className="monitoring-kpi-value" style={{ color: "var(--info)" }}>{formatNumber(monitoringData.summary.excused ?? 0, lang)}</div>
                  <div className="monitoring-kpi-sub">{t.authorizedLeave}</div>
                </div>
                <div className="monitoring-kpi-card kpi-unmarked">
                  <div className="monitoring-kpi-label"><HelpCircle size={14} /> {t.notMarked}</div>
                  <div className="monitoring-kpi-value" style={{ color: "#718096" }}>{formatNumber(monitoringData.summary.notMarked ?? 0, lang)}</div>
                  <div className="monitoring-kpi-sub">{t.awaitingMark}</div>
                </div>
                <div className="monitoring-kpi-card kpi-rate">
                  <div className="monitoring-kpi-label"><Activity size={14} /> {t.attendanceRate}</div>
                  <div className="monitoring-kpi-value" style={{ color: "var(--primary)" }}>{formatPercent(monitoringData.summary.attendanceRate ?? 0, lang)}</div>
                  <div className="monitoring-kpi-sub">{t.presentDividedEligible}</div>
                </div>
              </div>
            )}

            {/* Date Range Daily Breakdown Table */}
            {monitoringMode === "range" && monitoringData?.dailyTotals?.length > 0 && (
              <div className="card" style={{ padding: 16, marginBottom: 16 }}>
                <h3 style={{ margin: "0 0 12px", fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                  <Calendar size={18} /> {t.dailyBreakdown}
                </h3>
                <div style={{ overflowX: "auto" }}>
                  <table className="monitoring-table">
                    <thead>
                      <tr>
                        <th>{t.date}</th>
                        <th>{t.eligibleStudents}</th>
                        <th>{t.present}</th>
                        <th>{t.absent}</th>
                        <th>{t.late}</th>
                        <th>{t.excused}</th>
                        <th>{t.notMarked}</th>
                        <th>{t.attendanceRate}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monitoringData.dailyTotals.map((d) => (
                        <tr key={d.dateKey}>
                          <td><strong>{d.dateKey}</strong></td>
                          <td>{formatNumber(d.totalEligible, lang)}</td>
                          <td style={{ color: "var(--success)", fontWeight: 700 }}>{formatNumber(d.present, lang)}</td>
                          <td style={{ color: "var(--danger)", fontWeight: 700 }}>{formatNumber(d.absent, lang)}</td>
                          <td style={{ color: "#D69E2E", fontWeight: 700 }}>{formatNumber(d.late, lang)}</td>
                          <td style={{ color: "var(--info)", fontWeight: 700 }}>{formatNumber(d.excused, lang)}</td>
                          <td style={{ color: "#718096", fontWeight: 700 }}>{formatNumber(d.notMarked, lang)}</td>
                          <td>
                            <span style={{ fontWeight: 800, color: d.attendanceRate >= 80 ? "var(--success)" : d.attendanceRate >= 50 ? "#D69E2E" : "var(--danger)" }}>
                              {formatPercent(d.attendanceRate, lang)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Live Attendance Table */}
            <div className="monitoring-table-container">
              <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: 15 }}>
                  {monitoringMode === "range" ? t.studentWiseRecords : t.liveAttendanceRecords}
                  {" "}
                  <span style={{ color: "var(--muted)", fontSize: 13, fontWeight: 400 }}>
                    ({t("monitoring.recordsCount", { count: formatNumber(monitoringData?.records?.length ?? 0, lang) })})
                  </span>
                </h3>
              </div>

              {monitoringLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
                  <RefreshCw size={24} className="spinning" style={{ marginBottom: 8 }} />
                  <div>{t.loading}</div>
                </div>
              ) : !monitoringData?.records?.length ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
                  <HelpCircle size={32} style={{ marginBottom: 8, opacity: 0.5 }} />
                  <p style={{ margin: 0, fontSize: 14 }}>{t.noAttendanceRecorded}</p>
                  <button
                    className="btn secondary"
                    style={{ marginTop: 12, minHeight: 34, fontSize: 12 }}
                    onClick={() => {
                      setMonitoringStatus("all");
                      setMonitoringSearch("");
                    }}
                  >
                    {t.clearFilters}
                  </button>
                </div>
              ) : (
                <>
                  {/* Desktop Table View */}
                  <div style={{ overflowX: "auto" }}>
                    <table className="monitoring-table">
                      <thead>
                        <tr>
                          <th>{t.name}</th>
                          <th>{t.admissionNo}</th>
                          <th>{t.class}</th>
                          <th>{t.date}</th>
                          <th>{t.session}</th>
                          <th>{t.statusFilter}</th>
                          <th>{t.lastUpdated}</th>
                          <th>{t.updatedBy}</th>
                          <th style={{ textAlign: "right" }}>{t.actions}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monitoringData.records.map((r) => {
                          const sName = localizeStudentName(r.name, lang);
                          return (
                            <tr key={`${r.studentId}-${r.date}-${r.session}`}>
                              <td>
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <div className="student-card-avatar" style={{ width: 34, height: 34, fontSize: 13 }}>
                                    {r.photoUrl ? <img src={r.photoUrl} alt="" /> : (sName?.[0] || r.name?.[0])?.toUpperCase()}
                                  </div>
                                  <strong>{sName}</strong>
                                </div>
                              </td>
                              <td><code style={{ fontSize: 12 }}>{r.admissionNo}</code></td>
                              <td>{r.class ? `${r.class.name}${r.class.section ? ` (${r.class.section})` : ""}` : "-"}</td>
                              <td>{r.date}</td>
                              <td>{localizeSection(r.session, lang)}</td>
                              <td>
                                <span className={`accessible-status-badge status-${r.status}`}>
                                  {r.status === "present" && <Check size={13} />}
                                  {r.status === "absent" && <X size={13} />}
                                  {r.status === "late" && <Clock size={13} />}
                                  {r.status === "excused" && <AlertCircle size={13} />}
                                  {r.status === "unmarked" && <HelpCircle size={13} />}
                                  <span>{t[r.status] || (r.status === "unmarked" ? t.notMarked : r.status)}</span>
                                </span>
                              </td>
                              <td style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                                {r.lastUpdated ? new Date(r.lastUpdated).toLocaleString() : "-"}
                              </td>
                              <td style={{ fontSize: 12, color: "var(--muted)" }}>
                                {r.updatedBy?.name || "-"}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  type="button"
                                  className="btn secondary"
                                  style={{ minHeight: 30, padding: "4px 10px", fontSize: 11 }}
                                  onClick={() => {
                                    const foundStudent = students.find((s) => String(s._id || s.id) === String(r.studentId)) || {
                                      _id: r.studentId,
                                      id: r.studentId,
                                      name: r.name,
                                      admissionNo: r.admissionNo,
                                      photoUrl: r.photoUrl
                                    };
                                    openAttendanceHistory(foundStudent);
                                  }}
                                >
                                  <History size={13} /> {t.viewHistory}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: SYNC CENTER */}
        {tab === "sync" && (
          <div>
            <div className="section-title">
              <div>
                <h2>{t.syncCenter}</h2>
                <p className="muted">{t.durableOutboxSub}</p>
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
                <span>{t.deviceOfflineWarning}</span>
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
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                      <strong>
                        {item.kind === "student.photo"
                          ? t.photoUpdateKind
                          : `${formatDate(item.payload?.dateKey, lang)} (${localizeSection(item.payload?.sessionKey || "morning", lang)}) — ${formatNumber(item.payload?.records?.length || 0, lang)} ${t.students}`}
                      </strong>
                      <span className={`status-pill ${item.state === "synced" ? "success" : item.state === "needs-auth" ? "danger" : "warning"}`} style={{ fontSize: 10 }}>
                        {item.state === "synced" ? t.syncedState : item.state === "syncing" ? t.syncingState : item.state === "needs-auth" ? t.needsLoginState : t.pendingSyncState}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>
                      {t.operationId}: <code>{item.mutationId?.slice(0, 16)}...</code> · {formatTime(item.createdAt, lang)}
                    </div>
                    {item.lastError && (
                      <span style={{ color: "var(--danger)", fontSize: 11, display: "block", marginTop: 4 }}>
                        {item.lastError}
                      </span>
                    )}
                  </div>
                  {item.state !== "synced" && (
                    <button
                      className="btn secondary"
                      onClick={async () => {
                        await retryOutboxMutation(item.localId, api);
                        await refreshSyncStatus();
                      }}
                      style={{ minHeight: 36, padding: "6px 12px", fontSize: 12 }}
                    >
                      {t.retry}
                    </button>
                  )}
                </div>
              ))}

              {!outboxItems.length && (
                <Empty title={t.outboxCleanTitle} subtitle={t.outboxCleanSub} />
              )}
            </div>
          </div>
        )}

        {/* TAB 4: STUDENTS DIRECTORY & MANAGEMENT */}
        {tab === "students" && (
          <div>
            <div className="section-title" style={{ flexWrap: "wrap", gap: 10 }}>
              <div>
                <h2>{t.studentsTitle}</h2>
                <p className="muted" style={{ margin: 0 }}>
                  {t.manageStudentsSub}
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    className="btn secondary"
                    onClick={() => downloadStudentRoster("csv")}
                    title={t.exportCsv}
                    style={{ minHeight: 40, padding: "6px 12px", fontSize: 13 }}
                    disabled={loading || directoryLoading}
                  >
                    <Download size={15} /> CSV
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() => downloadStudentRoster("xlsx")}
                    title={t.exportExcel}
                    style={{ minHeight: 40, padding: "6px 12px", fontSize: 13 }}
                    disabled={loading || directoryLoading}
                  >
                    <FileSpreadsheet size={15} /> Excel
                  </button>
                </div>
                {user?.role === "admin" && (
                  <button
                    className="btn primary"
                    onClick={() => {
                      setStudentForm({
                        admissionNo: "",
                        name: "",
                        gender: "",
                        dob: "",
                        guardianName: "",
                        guardianPhone: "",
                        address: "",
                        enrollmentDate: today(),
                        consentGiven: true
                      });
                      setTab("add-student");
                    }}
                    style={{ minHeight: 40, padding: "6px 14px", fontSize: 13 }}
                  >
                    <Plus size={16} /> {t.addStudent}
                  </button>
                )}
              </div>
            </div>

            {/* FILTERS & SEARCH TOOLBAR */}
            <div className="card" style={{ padding: "12px 14px", marginBottom: 12 }}>
              <div className="student-filter-bar">
                {/* Status Tabs: Active | Archived | All */}
                <div className="student-status-tabs">
                  <button
                    type="button"
                    className={`student-status-tab-btn ${studentStatusFilter === "active" ? "active" : ""}`}
                    onClick={() => setStudentStatusFilter("active")}
                  >
                    <UserCheck size={14} />
                    <span>{t.activeStudents}</span>
                    <span style={{ fontSize: 10, background: "rgba(0,0,0,0.06)", padding: "2px 6px", borderRadius: 10 }}>
                      {formatNumber(directoryStudents.filter(s => s.active !== false).length, lang)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`student-status-tab-btn ${studentStatusFilter === "archived" ? "active" : ""}`}
                    onClick={() => setStudentStatusFilter("archived")}
                  >
                    <Archive size={14} />
                    <span>{t.archivedStudents}</span>
                    <span style={{ fontSize: 10, background: "rgba(0,0,0,0.06)", padding: "2px 6px", borderRadius: 10 }}>
                      {formatNumber(directoryStudents.filter(s => s.active === false).length, lang)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`student-status-tab-btn ${studentStatusFilter === "all" ? "active" : ""}`}
                    onClick={() => setStudentStatusFilter("all")}
                  >
                    <Users size={14} />
                    <span>{t.allStudents}</span>
                    <span style={{ fontSize: 10, background: "rgba(0,0,0,0.06)", padding: "2px 6px", borderRadius: 10 }}>
                      {formatNumber(directoryStudents.length, lang)}
                    </span>
                  </button>
                </div>

                {/* Class Filter */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Filter size={15} color="var(--muted)" />
                  <select
                    className="student-filter-select"
                    value={studentClassFilter}
                    onChange={(e) => setStudentClassFilter(e.target.value)}
                  >
                    {user?.role === "admin" && (
                      <option value="all">{t.allClasses}</option>
                    )}
                    {classes.map((c) => (
                      <option key={c._id || c.id} value={c._id || c.id}>
                        {formatClassLabel(c, lang)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Search bar */}
              <div className="search-input-wrap" style={{ marginBottom: 0 }}>
                <Search size={18} className="search-icon-pos" />
                <input
                  type="text"
                  placeholder={t("students.searchPlaceholder")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ minHeight: 42 }}
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--muted)", padding: 4, cursor: "pointer", minHeight: "auto" }}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* RESULTS COUNT & RELOAD */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 12, color: "var(--muted)" }}>
              <span>
                {t("students.showingCount", { count: formatNumber(filteredDirectoryStudents.length, lang), status: studentStatusFilter === "active" ? t.active : studentStatusFilter === "archived" ? t.archived : "" })}
              </span>
              <button
                onClick={() => fetchDirectoryStudents(studentStatusFilter, studentClassFilter)}
                style={{ background: "none", border: "none", color: "var(--primary)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12, padding: 0, minHeight: "auto", fontWeight: 600 }}
              >
                <RefreshCw size={13} className={directoryLoading ? "spin" : ""} /> {t.refresh}
              </button>
            </div>

            {/* STUDENT ROSTER LIST */}
            <div style={{ display: "grid", gap: 8 }}>
              {filteredDirectoryStudents.map((s) => {
                const sId = String(s._id || s.id);
                const isMenuOpen = activeMenuStudentId === sId;
                const studentClass = s.classId?.name
                  ? `${s.classId.name}${s.classId.section ? ` (${s.classId.section})` : ""}`
                  : (classes.find(c => String(c._id || c.id) === String(s.classId))?.name || t.unassigned);

                return (
                  <div key={sId} className="student-card">
                    {/* Top Row: Avatar + Name / Admission Badge + Status Pill */}
                    <div className="student-card-top">
                      <div
                        className="student-card-avatar"
                        style={{ cursor: "pointer" }}
                        onClick={() => openStudentProfile(s)}
                        title={t.viewProfile}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openStudentProfile(s); }}
                      >
                        {s.photoUrl ? (
                          <img src={s.photoUrl} alt="" />
                        ) : (
                          (localizeStudentName(s.name, lang)?.[0] || s.name?.[0])?.toUpperCase()
                        )}
                      </div>

                      <div
                        className="student-card-main-info"
                        style={{ cursor: "pointer" }}
                        onClick={() => openStudentProfile(s)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openStudentProfile(s); }}
                      >
                        <div className="student-card-name-row">
                          <strong>{localizeStudentName(s.name, lang)}</strong>
                          {(s.admissionNo || s.admissionNumber) && (
                            <span className="student-card-admission-badge">
                              {s.admissionNo || s.admissionNumber}
                            </span>
                          )}
                        </div>
                        {s.consentGiven && (
                          <small style={{ display: "block", color: "var(--success)", fontSize: 10, fontWeight: 700, marginTop: 1 }}>
                            {t.photoConsentRecorded}
                          </small>
                        )}
                      </div>

                      <span className={`status-pill ${s.active !== false ? "neutral" : "offline"}`} style={{ flexShrink: 0 }}>
                        {s.active !== false ? t.active : t.archived}
                      </span>
                    </div>

                    {/* Bottom Row: Class & Guardian Phone on left, Quick Actions & Menu on right */}
                    <div className="student-card-bottom">
                      <div className="student-card-meta-line">
                        <span>{studentClass}</span>
                        {s.guardianPhone && (
                          <span>· <a href={`tel:${s.guardianPhone}`} style={{ color: "var(--muted)", textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>{s.guardianPhone}</a></span>
                        )}
                      </div>

                      <div className="student-card-actions-group">
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => openStudentProfile(s)}
                          title={t.viewProfile}
                          aria-label={t("accessibility.viewProfileOf", { name: localizeStudentName(s.name, lang) })}
                          style={{ minHeight: 34, padding: "5px 9px", fontSize: 12 }}
                        >
                          <Eye size={15} />
                        </button>

                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => openEditStudent(s)}
                          title={t.editDetails}
                          aria-label={t("accessibility.editDetailsOf", { name: localizeStudentName(s.name, lang) })}
                          style={{ minHeight: 34, padding: "5px 9px", fontSize: 12 }}
                        >
                          <Edit3 size={15} />
                        </button>

                        <div style={{ position: "relative" }}>
                          <button
                            type="button"
                            className="student-action-menu-trigger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveMenuStudentId(isMenuOpen ? null : sId);
                            }}
                            aria-expanded={isMenuOpen}
                            aria-haspopup="true"
                            title={t.actions}
                            aria-label={t("accessibility.actionsFor", { name: localizeStudentName(s.name, lang) })}
                          >
                            <MoreHorizontal size={18} />
                          </button>

                          {/* Mobile Action Sheet / Desktop Dropdown Menu */}
                          {isMenuOpen && (
                            <>
                              <div
                                className="student-action-sheet-backdrop"
                                onClick={() => setActiveMenuStudentId(null)}
                              />
                              <div
                                className="student-action-sheet"
                                onClick={(e) => e.stopPropagation()}
                                role="dialog"
                                aria-modal="true"
                                aria-label={t("accessibility.actionsFor", { name: localizeStudentName(s.name, lang) })}
                              >
                                <div className="student-action-sheet-header">
                                  <h4>
                                    <Users size={16} />
                                    <span>{localizeStudentName(s.name, lang)}</span>
                                  </h4>
                                  <button
                                    type="button"
                                    onClick={() => setActiveMenuStudentId(null)}
                                    style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer", color: "var(--muted)", display: "flex", alignItems: "center" }}
                                    aria-label={t.close}
                                  >
                                    <X size={18} />
                                  </button>
                                </div>

                                <div className="student-action-sheet-list">
                                  <button
                                    type="button"
                                    className="student-action-item"
                                    onClick={() => {
                                      setActiveMenuStudentId(null);
                                      openStudentProfile(s);
                                    }}
                                  >
                                    <Eye size={15} color="var(--primary)" />
                                    <span>{t.viewProfile}</span>
                                  </button>

                                  {user?.role === "admin" && (
                                    <>
                                      <button
                                        type="button"
                                        className="student-action-item"
                                        onClick={() => {
                                          setActiveMenuStudentId(null);
                                          openEditStudent(s);
                                        }}
                                      >
                                        <Edit3 size={15} color="var(--primary)" />
                                        <span>{t.editDetails}</span>
                                      </button>

                                      <button
                                        type="button"
                                        className="student-action-item"
                                        onClick={() => {
                                          setActiveMenuStudentId(null);
                                          setViewingStudent(s);
                                        }}
                                      >
                                        <Camera size={15} color="var(--primary)" />
                                        <span>{t.changePhoto}</span>
                                      </button>

                                      <button
                                        type="button"
                                        className="student-action-item"
                                        onClick={() => {
                                          setActiveMenuStudentId(null);
                                          openTransferClass(s);
                                        }}
                                      >
                                        <ArrowRightLeft size={15} color="var(--primary)" />
                                        <span>{t.changeClass}</span>
                                      </button>
                                    </>
                                  )}

                                  <button
                                    type="button"
                                    className="student-action-item"
                                    onClick={() => {
                                      setActiveMenuStudentId(null);
                                      openAttendanceHistory(s);
                                    }}
                                  >
                                    <History size={15} color="var(--primary)" />
                                    <span>{t.attendanceHistory}</span>
                                  </button>

                                  {user?.role === "admin" && (
                                    <>
                                      <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />

                                      {/* Activate / Deactivate Toggle */}
                                      {s.active !== false ? (
                                        <button
                                          type="button"
                                          className="student-action-item"
                                          style={{ color: "var(--warning)" }}
                                          onClick={() => {
                                            setActiveMenuStudentId(null);
                                            requestStudentAction("deactivate", s);
                                          }}
                                        >
                                          <UserX size={15} />
                                          <span>{t.deactivate}</span>
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          className="student-action-item success"
                                          onClick={() => {
                                            setActiveMenuStudentId(null);
                                            requestStudentAction("activate", s);
                                          }}
                                        >
                                          <UserCheck size={15} />
                                          <span>{t.activate}</span>
                                        </button>
                                      )}
                                    </>
                                  )}

                                  {/* Archive / Restore (Admin only) */}
                                  {user?.role === "admin" && (
                                    s.active !== false ? (
                                      <button
                                        type="button"
                                        className="student-action-item"
                                        style={{ color: "var(--warning)" }}
                                        onClick={() => {
                                          setActiveMenuStudentId(null);
                                          requestStudentAction("archive", s);
                                        }}
                                      >
                                        <Archive size={15} />
                                        <span>{t.archive}</span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className="student-action-item success"
                                        onClick={() => {
                                          setActiveMenuStudentId(null);
                                          requestStudentAction("restore", s);
                                        }}
                                      >
                                        <ArchiveRestore size={15} />
                                        <span>{t.restore}</span>
                                      </button>
                                    )
                                  )}

                                  {/* Permanent Removal (Admin only) */}
                                  {user?.role === "admin" && (
                                    <button
                                      type="button"
                                      className="student-action-item danger"
                                      onClick={() => {
                                        setActiveMenuStudentId(null);
                                        requestStudentAction("delete", s);
                                      }}
                                    >
                                      <Trash2 size={15} />
                                      <span>{t.removeStudent}</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {!filteredDirectoryStudents.length && (
                <Empty
                  title={t.noStudentsFound}
                  subtitle={t.noStudentsFoundSub}
                />
              )}
            </div>
          </div>
        )}

        {/* SUB-VIEW: ADD STUDENT */}
        {tab === "add-student" && (
          <div>
            <div className="section-title">
              <div>
                <h2>{t.addStudent}</h2>
                <p className="muted">{t("students.enrolStudentSub", "Enrol a new student with complete details and photo consent.")}</p>
              </div>
              <button
                className="btn secondary"
                onClick={() => setTab("students")}
                style={{ minHeight: 38 }}
              >
                {t.cancel}
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
                  const targetClassId = studentForm.classId || selectedClass || classes[0]?._id;
                  if (!targetClassId) {
                    throw new Error(t("validation.selectClassError", "Please select a class for enrollment."));
                  }
                  const r = await api.post("/students", {
                    ...studentForm,
                    classId: targetClassId
                  });
                  setStudents((prev) => {
                    const map = new Map(prev.map((s) => [String(s._id || s.id), s]));
                    map.set(String(r.data._id || r.data.id), r.data);
                    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
                  });
                  setDirectoryStudents((prev) => [r.data, ...prev.filter(s => String(s._id || s.id) !== String(r.data._id || r.data.id))]);
                  await cacheStudents([r.data], targetClassId);
                  setStudentForm({
                    admissionNo: "",
                    name: "",
                    gender: "",
                    dob: "",
                    guardianName: "",
                    guardianPhone: "",
                    address: "",
                    enrollmentDate: today(),
                    consentGiven: true
                  });
                  setNotice(`${t("students.studentsTitle", "Student")}: ${r.data.name} (${r.data.admissionNo})`);
                  setTab("students");
                  fetchDirectoryStudents(studentStatusFilter, studentClassFilter);
                } catch (err) {
                  setError(errText(err));
                } finally {
                  setLoading(false);
                }
              }}
              style={{ display: "grid", gap: 14 }}
            >
              <div className="responsive-grid-2">
                <label>
                  {t.class} *
                  <select
                    value={studentForm.classId || selectedClass}
                    required
                    onChange={(e) => {
                      setStudentForm({ ...studentForm, classId: e.target.value });
                      setSelectedClass(e.target.value);
                    }}
                  >
                    {classes.map((c) => (
                      <option key={c._id || c.id} value={c._id || c.id}>
                        {formatClassLabel(c, lang)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  {t.admissionNo} *
                  <input
                    required
                    value={studentForm.admissionNo}
                    onChange={(e) => setStudentForm({ ...studentForm, admissionNo: e.target.value })}
                    placeholder="e.g. ADM-106"
                  />
                </label>
              </div>

              <label>
                {t.name} *
                <input
                  required
                  value={studentForm.name}
                  onChange={(e) => setStudentForm({ ...studentForm, name: e.target.value })}
                  placeholder={t("students.fullName", "Student full name")}
                />
              </label>

              <div className="responsive-grid-2">
                <label>
                  {t.gender || "Gender"}
                  <select
                    value={studentForm.gender}
                    onChange={(e) => setStudentForm({ ...studentForm, gender: e.target.value })}
                  >
                    <option value="">{t("common.unspecified", "Unspecified")}</option>
                    <option value="Male">{t("common.male", "Male")}</option>
                    <option value="Female">{t("common.female", "Female")}</option>
                  </select>
                </label>

                <label>
                  {t.dob || "Date of Birth"}
                  <input
                    type="date"
                    value={studentForm.dob}
                    onChange={(e) => setStudentForm({ ...studentForm, dob: e.target.value })}
                  />
                </label>
              </div>

              <div className="responsive-grid-2">
                <label>
                  {t.guardian}
                  <input
                    value={studentForm.guardianName}
                    onChange={(e) => setStudentForm({ ...studentForm, guardianName: e.target.value })}
                    placeholder={t("students.guardianParent", "Parent or guardian name")}
                  />
                </label>

                <label>
                  {t.phone}
                  <input
                    type="tel"
                    value={studentForm.guardianPhone}
                    onChange={(e) => setStudentForm({ ...studentForm, guardianPhone: e.target.value })}
                    placeholder={t("students.guardianPhone", "Guardian phone number")}
                  />
                </label>
              </div>

              <div className="responsive-grid-2">
                <label>
                  {t.address || "Address"}
                  <input
                    value={studentForm.address}
                    onChange={(e) => setStudentForm({ ...studentForm, address: e.target.value })}
                    placeholder={t("students.addressArea", "Residential address / locality")}
                  />
                </label>

                <label>
                  {t.enrollmentDate || "Enrollment Date"}
                  <input
                    type="date"
                    value={studentForm.enrollmentDate}
                    onChange={(e) => setStudentForm({ ...studentForm, enrollmentDate: e.target.value })}
                  />
                </label>
              </div>

              <label style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={studentForm.consentGiven}
                  onChange={(e) => setStudentForm({ ...studentForm, consentGiven: e.target.checked })}
                  style={{ width: 22, minHeight: 22 }}
                />
                <span style={{ fontSize: 13 }}>{t.consent}</span>
              </label>

              <button className="btn primary full" disabled={loading} style={{ minHeight: 48, marginTop: 10 }}>
                {loading ? t.loading : t("students.enrolStudent", "Enrol Student")}
              </button>
            </form>
          </div>
        )}

        {/* TAB 5: REPORTS & ADMIN SETTINGS (MORE) */}
        {(tab === "more" || tab === "reports") && (
          <div>
            <div className="section-title">
              <div>
                <h2>{tab === "reports" ? t.reports : t("settings.title", "Settings & System Operations")}</h2>
                <p className="muted">{t("settings.settingsSub", "Reports, offline cache control, database storage, and email automation.")}</p>
              </div>
            </div>

            {/* Download Registers */}
            <div className="card">
              <h3 style={{ marginBottom: 10 }}>{t("reports.downloadRegisters", "Download Registers")}</h3>

              <div className="responsive-grid-2" style={{ marginBottom: 10 }}>
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

              {(!selectedClass || !reportRange.from || !reportRange.to || reportRange.from > reportRange.to) && (
                <div className="alert info" style={{ fontSize: 12, marginBottom: 10 }}>
                  {!selectedClass
                    ? t("reports.selectClassPrompt", "Please select a class above to export registers.")
                    : !reportRange.from || !reportRange.to
                    ? t("reports.selectDatesPrompt", "Please specify both Start and End dates.")
                    : t("reports.invalidDateRange", "Start date must be earlier than or equal to End date.")}
                </div>
              )}

              <div className="download-grid-mobile">
                <button
                  className="download-card-mobile"
                  onClick={() => downloadReport("xlsx")}
                  disabled={loading || !selectedClass || !reportRange.from || !reportRange.to || reportRange.from > reportRange.to}
                >
                  <FileSpreadsheet size={22} />
                  <div>
                    <strong>{t("reports.excelSpreadsheet", "Excel Spreadsheet")}</strong>
                    <span>{t("reports.xlsxFormat", ".xlsx format")}</span>
                  </div>
                </button>
                <button
                  className="download-card-mobile"
                  onClick={() => downloadReport("csv")}
                  disabled={loading || !selectedClass || !reportRange.from || !reportRange.to || reportRange.from > reportRange.to}
                >
                  <Download size={22} />
                  <div>
                    <strong>{t("reports.csvExport", "CSV Export")}</strong>
                    <span>{t("reports.utf8Bom", "UTF-8 with BOM")}</span>
                  </div>
                </button>
                <button
                  className="download-card-mobile"
                  onClick={() => downloadReport("pdf")}
                  disabled={loading || !selectedClass || !reportRange.from || !reportRange.to || reportRange.from > reportRange.to}
                >
                  <FileSpreadsheet size={22} />
                  <div>
                    <strong>{t("reports.printablePdf", "Printable PDF")}</strong>
                    <span>{t("reports.landscapeLayout", "Landscape layout")}</span>
                  </div>
                </button>
              </div>

              <button
                className="btn primary full"
                onClick={fetchReport}
                disabled={loading || !selectedClass || !reportRange.from || !reportRange.to || reportRange.from > reportRange.to}
                style={{ marginTop: 12 }}
              >
                {t("reports.generateSummaryTable", "Generate Summary Table")}
              </button>
            </div>

            {/* Weekly Multi-Sheet Excel & Email Automation (Admin only) */}
            {user?.role === "admin" && (
              <div className="card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                  <h3 style={{ margin: 0 }}>{t("reports.weeklyReportAutomation", "Weekly Report Automation")}</h3>
                  <span className={`status-pill ${emailStatus?.automationEnabled || settingsForm.reportAutomationEnabled ? "online" : "offline"}`}>
                    {emailStatus?.automationEnabled || settingsForm.reportAutomationEnabled ? t("reports.automatedBadge", "Automated") : t("reports.manualOnly", "Manual Trigger Only")}
                  </span>
                </div>
                <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                  {t("reports.weeklyReportSub", "Executive 3-sheet Excel report covering attendance summary, detailed audit log, and class breakdown.")}
                </p>

                <div style={{ background: "var(--canvas)", padding: "10px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13, wordBreak: "break-word" }}>
                  <div><strong>{t("reports.scheduledRecipient", "Scheduled Recipient")}:</strong> <span style={{ wordBreak: "break-all" }}>{settingsForm.reportRecipientEmail || emailStatus?.recipientEmail || "2300030621cseh1@gmail.com"}</span></div>
                  <div style={{ color: "var(--muted)", marginTop: 2 }}>{settingsForm.reportSchedule || "Mondays at 06:00 AM"} ({settingsForm.reportTimezone || "Asia/Kolkata"})</div>
                  {emailStatus?.lastSent && (
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      <strong>{t("reports.lastDelivery", "Last Delivery")}:</strong> {formatDateTime(emailStatus.lastSent, lang)} {emailStatus.lastDelivered ? "✓ (Delivered)" : "⚠ (Attempted)"}
                    </div>
                  )}
                  {emailStatus?.nextRun && (
                    <div style={{ fontSize: 12, marginTop: 2, color: "var(--muted)" }}>
                      <strong>{t("reports.nextScheduledRun", "Next Scheduled Run")}:</strong> {emailStatus.nextRun}
                    </div>
                  )}
                </div>

                <div className="responsive-grid-2">
                  <button
                    className="btn secondary"
                    onClick={downloadWeeklyReport}
                    disabled={loading}
                    style={{ minHeight: 44, fontSize: 13 }}
                  >
                    <FileSpreadsheet size={16} /> {t("reports.downloadWeeklyXlsx", "Download Weekly .xlsx")}
                  </button>
                  <button
                    className="btn primary"
                    onClick={sendWeeklyEmail}
                    disabled={loading}
                    style={{ minHeight: 44, fontSize: 13 }}
                  >
                    <Bell size={16} /> {t("reports.sendEmailReport", "Send Email Report")}
                  </button>
                </div>
              </div>
            )}

            {/* Student Roster Export */}
            <div className="card">
              <h3 style={{ marginBottom: 6 }}>{t("reports.studentRosterExport", "Student Roster Export")}</h3>
              <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                {t("reports.studentRosterExportSub", "Export clean student roster with admission numbers, guardian contacts, and photo consent flags.")}
              </p>
              <div className="responsive-grid-2">
                <button
                  className="btn secondary"
                  onClick={() => downloadStudentsRoster("csv")}
                  disabled={loading}
                  style={{ minHeight: 42, fontSize: 13 }}
                >
                  <Download size={15} /> {t("reports.studentsCsv", "Students (CSV)")}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => downloadStudentsRoster("xlsx")}
                  disabled={loading}
                  style={{ minHeight: 42, fontSize: 13 }}
                >
                  <FileSpreadsheet size={15} /> {t("reports.studentsExcel", "Students (Excel)")}
                </button>
              </div>
            </div>

            {report.length > 0 && (
              <div className="card">
                <h3 style={{ marginBottom: 10 }}>{t("reports.summaryView", "Summary View")}</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("reports.student", "Student")}</th>
                        <th>{t.present}</th>
                        <th>{t.absent}</th>
                        <th>{t("reports.ratePercent", "Rate %")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.map((r) => (
                        <tr key={r.studentId}>
                          <td>
                            <strong>{r.name}</strong>
                          </td>
                          <td>{formatNumber(r.present, lang)}</td>
                          <td>{formatNumber(r.absent, lang)}</td>
                          <td>
                            <strong>{formatPercent(r.percentage, lang)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Universal User Profile & Password Change */}
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                <div>
                  <h3 style={{ margin: 0 }}>{t("auth.profileSecurity", "Profile & Security")}</h3>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    {t("auth.manageCredentials", "Manage your account credentials and personal password.")}
                  </p>
                </div>
                <span className="status-pill online" style={{ textTransform: "capitalize" }}>
                  {user.role}
                </span>
              </div>

              <div style={{ background: "var(--canvas)", padding: "10px 14px", borderRadius: "var(--radius-md)", marginBottom: 12, fontSize: 13 }}>
                <div><strong>{t.name}:</strong> {user.name}</div>
                <div style={{ marginTop: 2 }}><strong>{t.email}:</strong> {user.email}</div>
                {user.role === "teacher" && (
                  <div style={{ marginTop: 4 }}>
                    <strong>{t("teachers.assignedClasses", "Assigned Classes")}:</strong>{" "}
                    {user.assignedClasses?.length > 0
                      ? user.assignedClasses.map((c) => (c.name ? formatClassLabel(c, lang) : "Class")).join(", ")
                      : t("teachers.noClassesAssigned", "None")}
                  </div>
                )}
              </div>

              {passwordNotice && <div className="alert success" style={{ marginBottom: 10, fontSize: 13 }}>{passwordNotice}</div>}
              {passwordError && <div className="alert error" style={{ marginBottom: 10, fontSize: 13 }}>{passwordError}</div>}

              <form onSubmit={handlePasswordChange} style={{ display: "grid", gap: 10 }}>
                <h4 style={{ margin: 0, fontSize: 14 }}>{t("auth.changePassword", "Change Password")}</h4>
                <div className="responsive-grid-2">
                  <label>
                    {t("auth.currentPassword", "Current Password")} *
                    <input
                      type="password"
                      required
                      value={passwordForm.currentPassword}
                      onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                    />
                  </label>
                  <label>
                    {t("auth.newPassword", "New Password")} *
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={passwordForm.newPassword}
                      onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                      placeholder={t("auth.minCharacters", "Minimum 6 characters")}
                    />
                  </label>
                </div>
                <label>
                  {t("auth.confirmPassword", "Confirm New Password")} *
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={passwordForm.confirmPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  />
                </label>
                <button className="btn secondary" style={{ minHeight: 40, alignSelf: "flex-start", marginTop: 4 }}>
                  <ShieldCheck size={15} /> {t("auth.updatePasswordBtn", "Update Password")}
                </button>
              </form>
            </div>

            {/* Admin-Only Management Section */}
            {user.role === "admin" && (
              <>
                {/* Render Backend Health & Service Status Monitoring */}
                <div className="card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{t("healthMonitoring.title", "Backend Health & Service Status")}</h3>
                      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                        {t("healthMonitoring.subtitle", "Real-time health monitoring of Render API and MongoDB Atlas connection.")}
                      </p>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={`status-pill ${healthStatus.status === "healthy" ? "online" : healthStatus.status === "degraded" ? "warning" : "offline"}`}>
                        <Activity size={13} />
                        {healthStatus.loading ? t("healthMonitoring.checking", "Checking…") : t(`healthMonitoring.${healthStatus.status}`, healthStatus.status)}
                      </span>
                      <button
                        className="btn secondary"
                        onClick={fetchHealthCheck}
                        disabled={healthStatus.loading}
                        style={{ minHeight: 34, fontSize: 12, padding: "4px 10px" }}
                      >
                        <RefreshCw size={13} className={healthStatus.loading ? "spin" : ""} /> {t("healthMonitoring.checkNow", "Check Now")}
                      </button>
                    </div>
                  </div>

                  <div className="responsive-grid-2" style={{ gap: 10, marginBottom: 12 }}>
                    <div style={{ background: "var(--canvas)", padding: "10px 14px", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{t("healthMonitoring.databaseStatus", "Database (MongoDB)")}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: healthStatus.database === "connected" ? "var(--success)" : "var(--danger)" }} />
                        <span>{t(`healthMonitoring.${healthStatus.database}`, healthStatus.database)}</span>
                      </div>
                    </div>

                    <div style={{ background: "var(--canvas)", padding: "10px 14px", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{t("healthMonitoring.responseTime", "Response Time")}</div>
                      <div style={{ fontWeight: 600 }}>
                        {healthStatus.responseTime} ms {healthStatus.responseTime > 0 && healthStatus.responseTime < 500 ? "⚡" : ""}
                      </div>
                    </div>

                    <div style={{ background: "var(--canvas)", padding: "10px 14px", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{t("healthMonitoring.lastCheck", "Last Checked")}</div>
                      <div style={{ fontWeight: 600 }}>{healthStatus.lastCheck || "Just now"}</div>
                    </div>

                    <div style={{ background: "var(--canvas)", padding: "10px 14px", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{t("healthMonitoring.consecutiveFailures", "Consecutive Failures")}</div>
                      <div style={{ fontWeight: 600, color: healthStatus.consecutiveFailures > 0 ? "var(--danger)" : "var(--success)" }}>
                        {formatNumber(healthStatus.consecutiveFailures, lang)}
                      </div>
                    </div>
                  </div>

                  {/* Render Free Plan & Cold-Start Explanatory Notice */}
                  <div style={{ background: "rgba(2, 132, 199, 0.08)", border: "1px solid rgba(2, 132, 199, 0.25)", color: "#0369a1", padding: "10px 14px", borderRadius: "var(--radius-md)", fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                      <div>{t("healthMonitoring.renderFreeTierNote", "Render free services spin down after 15 minutes of inactivity. The scheduled 10-minute check keeps the service warm, but occasional cold-starts (15–30s) may still occur. For continuous uptime, consider an always-on Render plan.")}</div>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <a
                      href="https://dashboard.render.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn secondary"
                      style={{ fontSize: 12, minHeight: 36, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      <HardDrive size={14} /> {t("healthMonitoring.deploymentLogs", "Render Logs")}
                    </a>
                    <a
                      href="https://github.com/Sameersam3909/Madrasa-Amanah/actions/workflows/render-health-check.yml"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn secondary"
                      style={{ fontSize: 12, minHeight: 36, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      <Activity size={14} /> {t("healthMonitoring.workflowRuns", "GitHub Actions Checks")}
                    </a>
                  </div>
                </div>

                {/* Secondary MongoDB Atlas Storage Rotation */}
                <div className="card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{t("storage.title", "MongoDB Secondary Storage & Rotation")}</h3>
                      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                        {t("storage.subtitle", "Dual-destination MongoDB Atlas failover and storage quota rotation.")}
                      </p>
                    </div>
                    <span className={`status-pill ${storageReport?.activeStorage === "secondary" ? "warning" : "online"}`}>
                      {t("storage.active", "Active")}: {storageReport?.activeStorage?.toUpperCase() || "PRIMARY"}
                    </span>
                  </div>

                  {/* Storage Meter */}
                  <div style={{ background: "var(--canvas)", padding: "12px 14px", borderRadius: "var(--radius-md)", marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13 }}>
                      <span><strong>{t("storage.clusterName", "Primary Cluster Storage")}</strong> ({storageReport?.primaryStats?.database || "madrasa_attendance"})</span>
                      <span>
                        {storageReport?.primaryStats?.percentageUsed != null
                          ? `${storageReport.primaryStats.percentageUsed}%`
                          : t("storage.usageUnavailable", "Storage usage unavailable")}
                      </span>
                    </div>

                    <div className="storage-meter">
                      <div
                        className={`storage-meter-fill ${
                          (storageReport?.primaryStats?.percentageUsed || 0) >= 85
                            ? "critical"
                            : (storageReport?.primaryStats?.percentageUsed || 0) >= 70
                            ? "warning"
                            : "normal"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(2, storageReport?.primaryStats?.percentageUsed || 0))}%` }}
                      />
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginTop: 6, flexWrap: "wrap", gap: 4 }}>
                      <span>
                        {t("storage.used", "Used")}: {storageReport?.primaryStats?.dataSizeMB != null ? `${storageReport.primaryStats.dataSizeMB} MB` : "N/A"} / {storageReport?.primaryStats?.limitMB || 512} MB
                      </span>
                      <span>{storageReport?.primaryStats?.maskedUri || "mongodb+srv://primary.mongodb.net"}</span>
                    </div>
                  </div>

                  {/* Secondary Cluster Status */}
                  <div style={{ background: "var(--canvas)", padding: "10px 14px", borderRadius: "var(--radius-md)", marginBottom: 12, fontSize: 13 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                      <div>
                        <strong>{t("storage.secondaryCluster", "Secondary Cluster")}:</strong>{" "}
                        <span style={{ color: storageReport?.secondaryConfigured ? "var(--success)" : "var(--muted)" }}>
                          {storageReport?.secondaryConfigured ? t("storage.configured", "Configured (backup.oqduj9s.mongodb.net)") : t("storage.notConfigured", "Not Configured in Environment")}
                        </span>
                      </div>
                      <span className={`status-pill ${storageReport?.secondaryConfigured ? "online" : "offline"}`}>
                        {storageReport?.secondaryConfigured ? t("storage.ready", "Ready") : t("storage.unconfigured", "Unconfigured")}
                      </span>
                    </div>
                    {storageReport?.secondaryConfigured && storageReport?.secondaryStats?.maskedUri && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {storageReport.secondaryStats.maskedUri}
                      </div>
                    )}
                  </div>

                  <div className="responsive-grid-2">
                    <button
                      className="btn secondary"
                      onClick={verifySecondaryStorage}
                      disabled={storageLoading || !storageReport?.secondaryConfigured}
                      style={{ minHeight: 42, fontSize: 13 }}
                    >
                      <HardDrive size={15} /> {t("storage.verifySecondary", "Verify Secondary Indexes")}
                    </button>
                    <button
                      className="btn primary"
                      onClick={rotateStorageDestination}
                      disabled={storageLoading || !storageReport?.secondaryConfigured || storageReport?.activeStorage === "secondary"}
                      style={{ minHeight: 42, fontSize: 13 }}
                    >
                      <ArrowRightLeft size={15} /> {t("storage.rotateDestination", "Rotate to Secondary")}
                    </button>
                  </div>

                  {/* Past Rotation History */}
                  {storageReport?.rotationHistory?.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <strong style={{ fontSize: 12, color: "var(--muted)" }}>{t("storage.recentRotations", "Recent Storage Rotations")}:</strong>
                      <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                        {storageReport.rotationHistory.map((item, idx) => (
                          <div
                            key={idx}
                            style={{
                              padding: "6px 10px",
                              fontSize: 12,
                              background: "var(--canvas)",
                              borderRadius: 6,
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center"
                            }}
                          >
                            <span>
                              <strong>{item.from} → {item.to}</strong>: {item.reason}
                            </span>
                            <span className="muted" style={{ fontSize: 11 }}>
                              {item.rotatedAt ? formatDateTime(item.rotatedAt, lang) : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* System Settings & Weekly Email Automation */}
                <div className="card">
                  <h3 style={{ marginBottom: 6 }}>{t("settings.systemAutomation", "Weekly Automation & Retention Settings")}</h3>
                  <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                    {t("settings.systemAutomationSub", "Configure automated weekly summary delivery recipient, schedule timezone, and attendance correction limit.")}
                  </p>

                  <form onSubmit={handleSaveSettings} style={{ display: "grid", gap: 12 }}>
                    <label>
                      {t("settings.reportRecipientEmail", "Weekly Report Recipient Email")}
                      <input
                        type="email"
                        value={settingsForm.reportRecipientEmail}
                        onChange={(e) => setSettingsForm({ ...settingsForm, reportRecipientEmail: e.target.value })}
                        placeholder="e.g. 2300030621cseh1@gmail.com"
                      />
                    </label>

                    <div className="responsive-grid-2">
                      <label>
                        {t("settings.scheduleTimezone", "Schedule Timezone")}
                        <input
                          value={settingsForm.reportTimezone}
                          onChange={(e) => setSettingsForm({ ...settingsForm, reportTimezone: e.target.value })}
                          placeholder="Asia/Kolkata"
                        />
                      </label>

                      <label>
                        {t("settings.correctionWindowDays", "Attendance Correction Window (Days)")}
                        <input
                          type="number"
                          min="1"
                          max="90"
                          value={settingsForm.attendanceCorrectionWindowDays}
                          onChange={(e) => setSettingsForm({ ...settingsForm, attendanceCorrectionWindowDays: parseInt(e.target.value, 10) || 7 })}
                        />
                      </label>
                    </div>

                    <label style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={settingsForm.reportAutomationEnabled}
                        onChange={(e) => setSettingsForm({ ...settingsForm, reportAutomationEnabled: e.target.checked })}
                        style={{ width: 20, minHeight: 20 }}
                      />
                      <span style={{ fontSize: 13 }}>{t("settings.enableWeeklyCron", "Enable automated weekly email delivery via cron")}</span>
                    </label>

                    <button className="btn primary" disabled={loading} style={{ minHeight: 44, marginTop: 4 }}>
                      <Save size={16} /> {t("settings.saveSettings", "Save Settings")}
                    </button>
                  </form>
                </div>

                {/* Six-Month Data Retention Policy Status */}
                <div className="card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <h3>{t("settings.dataRetentionPolicy", "Data Retention (6 Months)")}</h3>
                    <span className="status-pill online">{t("settings.days180Policy", "180 Days Policy")}</span>
                  </div>
                  <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                    {t("settings.dataRetentionSub", "Attendance records older than 180 days are identified for archival to keep mobile queries performant.")}
                  </p>
                  <button
                    className="btn secondary full"
                    onClick={async () => {
                      try {
                        const res = await api.get("/admin/retention/status");
                        setNotice(`Retention Status: ${res.data.recordsWithinRetention} active records within 180 days, ${res.data.recordsEligibleForArchival} eligible for archival.`);
                      } catch (err) {
                        setError(errText(err));
                      }
                    }}
                    disabled={loading}
                    style={{ minHeight: 40, fontSize: 13 }}
                  >
                    <History size={15} /> {t("settings.checkRetentionStatus", "Check Retention Status")}
                  </button>
                </div>

                {/* System Backup Export */}
                <div className="card">
                  <h3>{t("settings.fullDatabaseBackup", "Full Database Backup")}</h3>
                  <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                    {t("settings.fullDatabaseBackupSub", "Export structured JSON backup of classes, students, attendance, and audit logs.")}
                  </p>
                  <button
                    className="btn secondary full"
                    onClick={downloadSystemBackup}
                    disabled={loading}
                    style={{ minHeight: 42, fontSize: 13 }}
                  >
                    <HardDrive size={15} /> {t("settings.downloadBackupJson", "Download Full System Backup (.json)")}
                  </button>
                </div>

                {/* Class Management — List, Remove, and Add Classes */}
                <div className="card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{t("classes.classManagement", "Class Management")}</h3>
                      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                        {t("classes.classManagementSub", "View registered classes, add new classrooms, or remove inactive classes.")}
                      </p>
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
                    {classes.map((cls) => (
                      <div
                        key={cls._id || cls.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          background: "var(--canvas)",
                          borderRadius: "var(--radius-md)",
                          border: "1px solid var(--border)",
                          flexWrap: "wrap",
                          gap: 8
                        }}
                      >
                        <div>
                          <strong>{cls.name}</strong>
                          <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>
                            ({localizeSection(cls.section || "morning", lang)}) · {cls.academicYear || "2026"}
                          </span>
                        </div>
                        <button
                          className="btn secondary"
                          onClick={() => handleDeleteClass(cls)}
                          disabled={loading}
                          style={{ color: "var(--danger)", borderColor: "var(--danger)", minHeight: 32, fontSize: 12, padding: "4px 10px" }}
                        >
                          <Trash2 size={13} /> {t("classes.removeClass", "Remove Class")}
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Add Class Form */}
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        const r = await api.post("/classes", classForm);
                        setClasses((prev) => [...prev, r.data]);
                        setClassForm({ name: "", section: "Morning", academicYear: "1447-1448 / 2026" });
                        setNotice(t("classes.classCreated", "Class created successfully."));
                      } catch (err) {
                        setError(errText(err));
                      }
                    }}
                    style={{ display: "grid", gap: 10, padding: 12, background: "var(--card-bg)", borderRadius: "var(--radius-md)", border: "1px dashed var(--border)" }}
                  >
                    <strong style={{ fontSize: 13 }}>{t("classes.addNewClass", "+ Add New Class")}</strong>
                    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
                      <input
                        required
                        value={classForm.name}
                        onChange={(e) => setClassForm({ ...classForm, name: e.target.value })}
                        placeholder={t("classes.classNamePlaceholder", "e.g. Hifz, Nazira, Tajweed")}
                      />
                      <select
                        value={classForm.section}
                        onChange={(e) => setClassForm({ ...classForm, section: e.target.value })}
                      >
                        <option value="Morning">{t.morning}</option>
                        <option value="Evening">{t.evening}</option>
                        <option value="Full Day">{t.fullDay}</option>
                      </select>
                    </div>
                    <button className="btn primary" style={{ minHeight: 38 }}>
                      <Plus size={15} /> {t("classes.createClass", "Create Class")}
                    </button>
                  </form>
                </div>

                {/* Teacher Staff Management — List, Remove, and Add Teachers */}
                <div className="card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{t("teachers.teacherAccounts", "Teacher Management")}</h3>
                      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                        {t("teachers.teacherAccountsSub", "Manage teacher staff, class assignments, or remove teacher accounts.")}
                      </p>
                    </div>
                    <button
                      className="btn primary"
                      onClick={() => {
                        setTeacherForm({ name: "", email: "", password: "", assignedClasses: [] });
                        setShowAddTeacherModal(true);
                      }}
                      style={{ minHeight: 34, fontSize: 12, padding: "4px 12px" }}
                    >
                      <Plus size={14} /> {t("teachers.addTeacher", "Add Teacher")}
                    </button>
                  </div>

                  {teachers.filter(u => u.role === "teacher").length === 0 ? (
                    <p className="muted" style={{ fontSize: 13 }}>{t("teachers.noTeachers", "No teachers registered yet.")}</p>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {teachers.filter(u => u.role === "teacher").map((teacher) => (
                        <div
                          key={teacher._id || teacher.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "10px 14px",
                            background: "var(--canvas)",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid var(--border)",
                            flexWrap: "wrap",
                            gap: 8
                          }}
                        >
                          <div>
                            <strong>{teacher.name}</strong>
                            <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>{teacher.email}</span>
                            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                              {teacher.assignedClasses?.length > 0
                                ? teacher.assignedClasses.map(c => c.name || "Class").join(", ")
                                : "No classes assigned"}
                            </div>
                          </div>
                          <button
                            className="btn secondary"
                            onClick={() => handleDeactivateTeacher(teacher)}
                            style={{ color: "var(--danger)", borderColor: "var(--danger)", minHeight: 32, fontSize: 12, padding: "4px 10px" }}
                          >
                            <UserX size={13} /> {t("teachers.removeTeacher", "Remove Teacher")}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </>
            )}

            {/* Universal Sign Out */}
            <div className="card" style={{ textAlign: "center" }}>
              <button
                onClick={logout}
                className="btn secondary full"
                style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
              >
                <LogOut size={16} /> {t.signout}
              </button>
            </div>
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
                {confirmationModal.className} ({localizeSection(confirmationModal.sessionKey, lang)}) · {confirmationModal.dateKey}
              </p>
            </div>

            <div className="card" style={{ background: "var(--canvas)", padding: "14px", marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, textAlign: "center" }}>
                <div>
                  <small style={{ color: "var(--success)", fontWeight: 700 }}>{t.present}</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{formatNumber(confirmationModal.counts?.present || 0, lang)}</strong>
                </div>
                <div>
                  <small style={{ color: "var(--danger)", fontWeight: 700 }}>{t.absent}</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{formatNumber(confirmationModal.counts?.absent || 0, lang)}</strong>
                </div>
                <div>
                  <small style={{ color: "var(--warning)", fontWeight: 700 }}>{t.late}</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{formatNumber(confirmationModal.counts?.late || 0, lang)}</strong>
                </div>
                <div>
                  <small style={{ color: "var(--info)", fontWeight: 700 }}>{t.excused}</small>
                  <strong style={{ display: "block", fontSize: 20 }}>{formatNumber(confirmationModal.counts?.excused || 0, lang)}</strong>
                </div>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 20, textAlign: "center" }}>
              {t("attendance.persistenceEngine", "Persistence Engine")}: <strong>{confirmationModal.database}</strong>
              <br />
              {t("attendance.timestamp", "Timestamp")}: {formatDateTime(confirmationModal.timestamp, lang)}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn secondary"
                style={{ flex: 1 }}
                onClick={() => setConfirmationModal(null)}
              >
                {t("common.dismiss", "Dismiss")}
              </button>
              <button
                className="btn primary"
                style={{ flex: 1 }}
                onClick={() => {
                  setConfirmationModal(null);
                  setTab("attendance");
                }}
              >
                {t("attendance.viewRegister", "View Register")}
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
                <h3 style={{ marginBottom: 0 }}>{t("notifications.notificationHistory", "Notification History")}</h3>
                {notifications.length > 0 && (
                  <span style={{ background: "var(--primary)", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 10 }}>
                    {formatNumber(notifications.length, lang)}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {notifications.length > 0 && (
                  <button
                    onClick={clearAllNotifications}
                    style={{ background: "none", border: "none", color: "var(--danger)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "4px 8px" }}
                  >
                    {t("notifications.clearAll", "Clear all")}
                  </button>
                )}
                <button
                  onClick={() => setShowNotificationDrawer(false)}
                  style={{ background: "none", border: "none", padding: 6, color: "var(--muted)", cursor: "pointer" }}
                >
                  <X size={20} />
                </button>
              </div>
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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                    <div>
                      <strong style={{ fontSize: 13, display: "block" }}>{n.title}</strong>
                      <small style={{ color: "var(--muted)", fontSize: 11 }}>
                        {formatDateTime(n.timestamp, lang)}
                      </small>
                    </div>
                    <button
                      onClick={() => removeNotification(n.id)}
                      title={t("accessibility.removeNotification", "Remove notification")}
                      style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4, borderRadius: 4 }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>{n.message}</p>
                </div>
              ))}

              {!notifications.length && (
                <Empty title={t("notifications.noNotifications", "No notifications yet")} subtitle={t("notifications.noNotificationsSub", "Saved registers and sync events will appear here.")} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          STUDENT PROFILE & PHOTO MANAGER (MODAL)
          ========================================================= */}
      {viewingStudent && (
        <div className="sheet-overlay" onClick={closeStudentModal}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <p className="eyebrow">{t.studentProfile || "STUDENT PROFILE"}</p>
                <h2 style={{ marginBottom: 0 }}>{localizeStudentName(viewingStudent.name, lang)}</h2>
                <small className="muted">{t.admissionNo}: {viewingStudent.admissionNo}</small>
              </div>
              <button
                onClick={closeStudentModal}
                style={{ background: "transparent", border: "none", color: "var(--muted)", padding: 6, cursor: "pointer" }}
              >
                <X size={22} />
              </button>
            </div>

            {photoSaveError && (
              <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", color: "#991B1B", padding: "10px 14px", borderRadius: 12, marginBottom: 14, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                <AlertCircle size={18} />
                <span>{photoSaveError}</span>
              </div>
            )}

            {/* EXACT MOCKUP CARD FROM USER IMAGE */}
            <div className="photo-manager-card">
              <div className="photo-manager-title">{t("faceMatching.studentPhoto", "Student photo")}</div>

              <div className="photo-manager-avatar-wrap">
                <div className="photo-manager-avatar">
                  {viewingStudent.photoUrl ? (
                    <img src={viewingStudent.photoUrl} alt={localizeStudentName(viewingStudent.name, lang)} />
                  ) : (
                    <User size={38} />
                  )}
                </div>
                <div className="photo-manager-avatar-label">{t("faceMatching.currentRefPhoto", "Current reference photo")}</div>
              </div>

              {!profilePreviewPhoto && !cameraActive && (
                <div>
                  <button
                    className="photo-pill-btn take"
                    onClick={() => startCamera(cameraFacing)}
                  >
                    <Camera size={20} />
                    <span>{t("faceMatching.takePhoto", "Take a photo")}</span>
                  </button>

                  <label
                    htmlFor="profile-gallery-file-input"
                    className="photo-pill-btn choose"
                  >
                    <Image size={20} />
                    <span>{t("faceMatching.chooseExistingPhoto", "Choose existing photo")}</span>
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
                    {t("faceMatching.newImagePreview", "New image preview:")}
                  </div>
                  <img src={profilePreviewPhoto} alt="Preview" className="photo-preview-img" />

                  <div style={{
                    fontSize: 12,
                    fontWeight: 500,
                    marginBottom: 14,
                    padding: "6px 12px",
                    borderRadius: 8,
                    display: "inline-block",
                    background: faceDetectStatus === "detected" ? "rgba(46, 125, 50, 0.25)" : "rgba(230, 81, 0, 0.25)",
                    color: faceDetectStatus === "detected" ? "#4ADE80" : "#FDBA74"
                  }}>
                    {faceDetectStatus === "loading" && t("faceMatching.analyzingPhoto", "Analyzing photo for face detection...")}
                    {faceDetectStatus === "detected" && t("faceMatching.faceDetectedReady", "Face detected & descriptor ready ✓")}
                    {faceDetectStatus === "no-face" && t("faceMatching.noFaceDetectedManual", "No face detected (manual attendance ready)")}
                    {faceDetectStatus === "unavailable" && t("faceMatching.faceModelsOffline", "Face models offline (manual attendance ready)")}
                    {faceDetectStatus === "error" && t("faceMatching.faceAnalysisSkipped", "Face analysis skipped (manual attendance ready)")}
                    {!faceDetectStatus && (profilePreviewDescriptor ? t("faceMatching.faceDetectedReady", "Face descriptor ready ✓") : t("faceMatching.manualAttendanceReady", "Manual attendance ready"))}
                  </div>

                  <div className="photo-preview-actions">
                    <button
                      className="photo-pill-btn choose"
                      style={{ marginBottom: 0 }}
                      disabled={photoSaving}
                      onClick={() => {
                        setProfilePreviewPhoto(null);
                        setProfilePreviewDescriptor(null);
                        setFaceDetectStatus("");
                        setPhotoSaveError("");
                      }}
                    >
                      <RefreshCw size={16} /> {t("faceMatching.retake", "Retake")}
                    </button>
                    <button
                      className="photo-pill-btn take"
                      style={{ marginBottom: 0 }}
                      disabled={photoSaving}
                      onClick={saveStudentPhoto}
                    >
                      <Check size={18} /> {photoSaving ? t("common.saving", "Saving...") : t("faceMatching.savePhoto", "Save photo")}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="card" style={{ padding: "14px", marginTop: 12 }}>
              <strong style={{ display: "block", fontSize: 13, marginBottom: 8 }}>{t("students.studentDetails", "Profile Details")}</strong>
              <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
                <div>{t.guardian}: <strong>{localizeGuardianName(viewingStudent.guardianName, lang) || t("common.notRecorded", "Not recorded")}</strong></div>
                <div>{t.phone}: <strong>{viewingStudent.guardianPhone || t("common.notRecorded", "Not recorded")}</strong></div>
                <div>{t("students.consent", "Photo Consent")}: <strong>{viewingStudent.consentGiven ? t("common.granted", "Granted ✓") : t("common.optedOut", "Opted out")}</strong></div>
                <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>
                  {t("faceMatching.photoPreserveNotice", "* Updating reference photo preserves all historical attendance records safely.")}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          STUDENT COMPLETE PROFILE MODAL
          ========================================================= */}
      {viewingStudentProfile && (
        <div className="sheet-overlay" onClick={() => setViewingStudentProfile(null)}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <p className="eyebrow">{t.studentProfile || "STUDENT PROFILE"}</p>
                <h2 style={{ marginBottom: 2 }}>{localizeStudentName(viewingStudentProfile.name, lang)}</h2>
                <small className="muted">
                  {t.admissionNo}: <strong>{viewingStudentProfile.admissionNo || viewingStudentProfile.admissionNumber}</strong> · {t.class}: {viewingStudentProfile.classId?.name || t("common.unassigned", "Unassigned")}
                </small>
              </div>
              <button
                onClick={() => setViewingStudentProfile(null)}
                style={{ background: "transparent", border: "none", color: "var(--muted)", padding: 6, cursor: "pointer" }}
              >
                <X size={22} />
              </button>
            </div>

            {/* Avatar & Header Card */}
            <div className="card" style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px", marginBottom: 14 }}>
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  overflow: "hidden",
                  background: "var(--primary-subtle)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 26,
                  fontWeight: 700,
                  color: "var(--primary)",
                  flexShrink: 0,
                  border: "2px solid var(--border)"
                }}
              >
                {viewingStudentProfile.photoUrl || viewingStudentProfile.referencePhotoUrl ? (
                  <img
                    src={viewingStudentProfile.photoUrl || viewingStudentProfile.referencePhotoUrl}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  (localizeStudentName(viewingStudentProfile.name, lang)?.[0] || viewingStudentProfile.name?.[0])?.toUpperCase()
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <strong style={{ fontSize: 16 }}>{localizeStudentName(viewingStudentProfile.name, lang)}</strong>
                  <span className={`status-pill ${viewingStudentProfile.active !== false ? "neutral" : "offline"}`}>
                    {viewingStudentProfile.active !== false ? (t.active || "Active") : (t.archived || "Archived")}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {viewingStudentProfile.classId?.name} {viewingStudentProfile.classId?.section ? `(${localizeSection(viewingStudentProfile.classId.section, lang)})` : ""}
                  {viewingStudentProfile.classId?.academicYear ? ` · ${viewingStudentProfile.classId.academicYear}` : ""}
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    className="btn secondary"
                    onClick={() => {
                      setViewingStudent(viewingStudentProfile);
                    }}
                    style={{ minHeight: 30, padding: "4px 10px", fontSize: 11 }}
                  >
                    <Camera size={13} /> {t.changePhoto || "Change Photo"}
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() => {
                      openEditStudent(viewingStudentProfile);
                    }}
                    style={{ minHeight: 30, padding: "4px 10px", fontSize: 11 }}
                  >
                    <Edit3 size={13} /> {t.editDetails || "Edit Details"}
                  </button>
                </div>
              </div>
            </div>

            {/* Profile Detailed Fields */}
            <div className="card" style={{ padding: "16px", marginBottom: 14 }}>
              <h3 style={{ fontSize: 14, marginBottom: 12, borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
                {t("students.studentDetails", "Student Details")}
              </h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px", fontSize: 13 }}>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t("students.fullName", "Full Name")}</span>
                  <strong>{localizeStudentName(viewingStudentProfile.name || viewingStudentProfile.fullName, lang)}</strong>
                </div>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t.admissionNo}</span>
                  <strong>{viewingStudentProfile.admissionNo || viewingStudentProfile.admissionNumber}</strong>
                </div>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t.gender || "Gender"}</span>
                  <span>{viewingStudentProfile.gender ? t[`gender${viewingStudentProfile.gender}`] || viewingStudentProfile.gender : t("common.unspecified", "Unspecified")}</span>
                </div>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t.dob || "Date of Birth"}</span>
                  <span>{viewingStudentProfile.dob || t("common.notRecorded", "Not recorded")}</span>
                </div>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t.enrollmentDate || "Enrollment Date"}</span>
                  <span>{viewingStudentProfile.enrollmentDate || t("common.notRecorded", "Not recorded")}</span>
                </div>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t("students.consent", "Photo Consent")}</span>
                  <span style={{ color: viewingStudentProfile.consentGiven ? "var(--success)" : "var(--muted)", fontWeight: 600 }}>
                    {viewingStudentProfile.consentGiven ? t("common.granted", "Granted ✓") : t("common.optedOut", "Opted out")}
                  </span>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t("students.guardianParent", "Guardian / Parent")}</span>
                  <strong>{localizeGuardianName(viewingStudentProfile.guardianName, lang) || t("common.notRecorded", "Not recorded")}</strong>
                </div>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t("students.guardianPhone", "Guardian Phone")}</span>
                  {viewingStudentProfile.guardianPhone ? (
                    <a href={`tel:${viewingStudentProfile.guardianPhone}`} style={{ color: "var(--primary)", fontWeight: 600 }}>
                      {viewingStudentProfile.guardianPhone}
                    </a>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>{t("common.notRecorded", "Not recorded")}</span>
                  )}
                </div>
                <div>
                  <span style={{ color: "var(--muted)", fontSize: 11, display: "block" }}>{t("students.addressArea", "Address / Area")}</span>
                  <span>{viewingStudentProfile.address || t("common.notRecorded", "Not recorded")}</span>
                </div>
              </div>
            </div>

            {/* Quick Action Bar inside Profile */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                className="btn secondary"
                onClick={() => openTransferClass(viewingStudentProfile)}
                style={{ minHeight: 40 }}
              >
                <ArrowRightLeft size={16} /> {t.transferClass || "Transfer Class"}
              </button>
              <button
                className="btn primary"
                onClick={() => openAttendanceHistory(viewingStudentProfile)}
                style={{ minHeight: 40 }}
              >
                <History size={16} /> {t.attendanceHistory || "Attendance History"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          EDIT STUDENT MODAL
          ========================================================= */}
      {editingStudent && (
        <div className="sheet-overlay" onClick={() => !editingStudent.saving && setEditingStudent(null)}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <p className="eyebrow">{t.editStudent || "EDIT STUDENT"}</p>
                <h2 style={{ marginBottom: 0 }}>{localizeStudentName(editingStudent.name, lang) || "Student"}</h2>
              </div>
              <button
                disabled={editingStudent.saving}
                onClick={() => setEditingStudent(null)}
                style={{ background: "transparent", border: "none", color: "var(--muted)", padding: 6, cursor: "pointer" }}
              >
                <X size={22} />
              </button>
            </div>

            {editingStudent.error && (
              <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", color: "#991B1B", padding: "10px 14px", borderRadius: 12, marginBottom: 14, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                <AlertCircle size={18} />
                <span>{editingStudent.error}</span>
              </div>
            )}

            <form onSubmit={handleSaveStudentEdit} style={{ display: "grid", gap: 14 }}>
              <div className="responsive-grid-2">
                <label>
                  {t.class} *
                  <select
                    value={editingStudent.classId}
                    required
                    onChange={(e) => setEditingStudent({ ...editingStudent, classId: e.target.value })}
                  >
                    {classes.map((c) => (
                      <option key={c._id || c.id} value={c._id || c.id}>
                        {formatClassLabel(c, lang)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  {t.admissionNo} *
                  <input
                    required
                    disabled={user?.role !== "admin"}
                    value={editingStudent.admissionNo}
                    onChange={(e) => setEditingStudent({ ...editingStudent, admissionNo: e.target.value })}
                    title={user?.role !== "admin" ? t("students.onlyAdminAdmissionNo", "Only Administrators can modify admission numbers") : t.admissionNo}
                  />
                  {user?.role !== "admin" ? (
                    <small style={{ color: "var(--muted)", fontSize: 10 }}>{t("students.adminOnly", "Admin only")}</small>
                  ) : (
                    <small style={{ color: "var(--muted)", fontSize: 10 }}>{t("students.validatedUniqueness", "Validated for uniqueness")}</small>
                  )}
                </label>
              </div>

              <label>
                {t.name} *
                <input
                  required
                  value={editingStudent.name}
                  onChange={(e) => setEditingStudent({ ...editingStudent, name: e.target.value })}
                  placeholder={t("students.fullName", "Student full name")}
                />
              </label>

              <div className="responsive-grid-2">
                <label>
                  {t.gender || "Gender"}
                  <select
                    value={editingStudent.gender}
                    onChange={(e) => setEditingStudent({ ...editingStudent, gender: e.target.value })}
                  >
                    <option value="">{t("common.unspecified", "Unspecified")}</option>
                    <option value="Male">{t("common.male", "Male")}</option>
                    <option value="Female">{t("common.female", "Female")}</option>
                  </select>
                </label>

                <label>
                  {t.dob || "Date of Birth"}
                  <input
                    type="date"
                    value={editingStudent.dob}
                    onChange={(e) => setEditingStudent({ ...editingStudent, dob: e.target.value })}
                  />
                </label>
              </div>

              <div className="responsive-grid-2">
                <label>
                  {t.guardian}
                  <input
                    value={editingStudent.guardianName}
                    onChange={(e) => setEditingStudent({ ...editingStudent, guardianName: e.target.value })}
                    placeholder={t("students.guardianParent", "Parent or guardian name")}
                  />
                </label>

                <label>
                  {t.phone}
                  <input
                    type="tel"
                    value={editingStudent.guardianPhone}
                    onChange={(e) => setEditingStudent({ ...editingStudent, guardianPhone: e.target.value })}
                    placeholder={t("students.guardianPhone", "Guardian phone number")}
                  />
                </label>
              </div>

              <div className="responsive-grid-2">
                <label>
                  {t.address || "Address"}
                  <input
                    value={editingStudent.address}
                    onChange={(e) => setEditingStudent({ ...editingStudent, address: e.target.value })}
                    placeholder={t("students.addressArea", "Residential address / locality")}
                  />
                </label>

                <label>
                  {t.enrollmentDate || "Enrollment Date"}
                  <input
                    type="date"
                    value={editingStudent.enrollmentDate}
                    onChange={(e) => setEditingStudent({ ...editingStudent, enrollmentDate: e.target.value })}
                  />
                </label>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                <label style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={editingStudent.active}
                    onChange={(e) => setEditingStudent({ ...editingStudent, active: e.target.checked })}
                    style={{ width: 20, minHeight: 20 }}
                  />
                  <span>{t("students.activeAccountCheck", "Active Student Account (uncheck to deactivate)")}</span>
                </label>

                <label style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={editingStudent.consentGiven}
                    onChange={(e) => setEditingStudent({ ...editingStudent, consentGiven: e.target.checked })}
                    style={{ width: 20, minHeight: 20 }}
                  />
                  <span>{t.consent}</span>
                </label>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={editingStudent.saving}
                  onClick={() => setEditingStudent(null)}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={editingStudent.saving}
                  style={{ minWidth: 120 }}
                >
                  {editingStudent.saving ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <RefreshCw size={14} className="spin" /> {t.saving}
                    </span>
                  ) : (
                    t.saveChanges
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================
          TRANSFER CLASS MODAL
          ========================================================= */}
      {transferringStudent && (
        <div className="sheet-overlay" onClick={() => !loading && setTransferringStudent(null)}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <p className="eyebrow">{t("students.classReassignment", "CLASS REASSIGNMENT")}</p>
                <h2 style={{ marginBottom: 0 }}>{t("students.transferStudentTitle", "Transfer Student")}</h2>
              </div>
              <button
                disabled={loading}
                onClick={() => setTransferringStudent(null)}
                style={{ background: "transparent", border: "none", color: "var(--muted)", padding: 6, cursor: "pointer" }}
              >
                <X size={22} />
              </button>
            </div>

            <div className="card" style={{ padding: "14px", marginBottom: 14, background: "var(--canvas)" }}>
              <div style={{ fontSize: 13 }}>
                {t("reports.student", "Student")}: <strong>{localizeStudentName(transferringStudent.name, lang)}</strong> ({transferringStudent.admissionNo || transferringStudent.admissionNumber})
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                {t("students.currentClass", "Current Class")}: <strong>{transferringStudent.classId?.name || t("common.unassigned", "Unassigned")} {transferringStudent.classId?.section ? `(${localizeSection(transferringStudent.classId.section, lang)})` : ""}</strong>
              </div>
            </div>

            <label style={{ marginBottom: 14 }}>
              {t("students.selectNewTargetClass", "Select New Target Class *")}
              <select
                value={transferTargetClassId}
                onChange={(e) => setTransferTargetClassId(e.target.value)}
                style={{ minHeight: 46 }}
              >
                <option value="">{t("students.chooseDestinationClass", "-- Choose destination class --")}</option>
                {classes.map((c) => (
                  <option key={c._id || c.id} value={c._id || c.id}>
                    {formatClassLabel(c, lang)}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ background: "var(--info-bg)", border: "1px solid #BAE6FD", color: "#0369A1", padding: "10px 14px", borderRadius: 12, marginBottom: 16, fontSize: 12, display: "flex", alignItems: "flex-start", gap: 8 }}>
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>{t("students.historicalContinuity", "Historical Register Continuity")}:</strong> {t("students.historicalContinuityNotice", "Past attendance records will remain safely attached to the class and date on which they were taken.")}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                className="btn secondary"
                disabled={loading}
                onClick={() => setTransferringStudent(null)}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={loading || !transferTargetClassId || String(transferTargetClassId) === String(transferringStudent.classId?._id || transferringStudent.classId)}
                onClick={handleConfirmTransfer}
              >
                {loading ? t("students.transferring", "Transferring…") : t("students.confirmTransfer", "Confirm Class Transfer")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          ATTENDANCE HISTORY MODAL
          ========================================================= */}
      {attendanceHistoryStudent && (
        <div className="sheet-overlay" onClick={() => setAttendanceHistoryStudent(null)}>
          <div className="sheet-content" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <p className="eyebrow">{t.attendanceHistory || "ATTENDANCE RECORD"}</p>
                <h2 style={{ marginBottom: 2 }}>{localizeStudentName(attendanceHistoryStudent.name, lang)}</h2>
                <small className="muted">
                  {t.admissionNo}: <strong>{attendanceHistoryStudent.admissionNo || attendanceHistoryStudent.admissionNumber}</strong> · {t.class}: {attendanceHistoryStudent.classId?.name || "Enrolled"}
                </small>
              </div>
              <button
                onClick={() => setAttendanceHistoryStudent(null)}
                style={{ background: "transparent", border: "none", color: "var(--muted)", padding: 6, cursor: "pointer" }}
              >
                <X size={22} />
              </button>
            </div>

            {studentAttendanceLoading && (
              <div style={{ textAlign: "center", padding: "40px 0", color: "var(--muted)" }}>
                <RefreshCw size={24} className="spin" style={{ margin: "0 auto 10px" }} />
                <p>{t("common.loading", "Loading authoritative attendance ledger...")}</p>
              </div>
            )}

            {!studentAttendanceLoading && studentAttendanceData && (
              <>
                {/* KPI Summary Cards */}
                <div className="att-stats-grid">
                  <div className="att-stat-box" style={{
                    borderColor:
                      studentAttendanceData.stats?.rate >= 80 ? "var(--success)" :
                      studentAttendanceData.stats?.rate >= 60 ? "var(--warning)" : "var(--danger)"
                  }}>
                    <strong style={{
                      color:
                        studentAttendanceData.stats?.rate >= 80 ? "var(--success)" :
                        studentAttendanceData.stats?.rate >= 60 ? "var(--warning)" : "var(--danger)"
                    }}>
                      {formatPercent(studentAttendanceData.stats?.rate ?? 0, lang)}
                    </strong>
                    <span>{t("monitoring.attendanceRate", "Attendance Rate")}</span>
                  </div>
                  <div className="att-stat-box">
                    <strong style={{ color: "var(--success)" }}>{formatNumber(studentAttendanceData.stats?.present || 0, lang)}</strong>
                    <span>{t.present}</span>
                  </div>
                  <div className="att-stat-box">
                    <strong style={{ color: "var(--danger)" }}>{formatNumber(studentAttendanceData.stats?.absent || 0, lang)}</strong>
                    <span>{t.absent}</span>
                  </div>
                  <div className="att-stat-box">
                    <strong style={{ color: "var(--warning)" }}>
                      {formatNumber((studentAttendanceData.stats?.late || 0) + (studentAttendanceData.stats?.excused || 0), lang)}
                    </strong>
                    <span>{t.late} / {t.excused}</span>
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 12, color: "var(--muted)" }}>
                  <span>{t("monitoring.totalSessions", "Total Sessions")}: <strong>{formatNumber(studentAttendanceData.stats?.totalSessions || 0, lang)}</strong></span>
                  <button
                    onClick={() => openAttendanceHistory(attendanceHistoryStudent)}
                    style={{ background: "none", border: "none", color: "var(--primary)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12, padding: 0, minHeight: "auto", fontWeight: 600 }}
                  >
                    <RefreshCw size={12} /> {t("monitoring.reloadHistory", "Reload History")}
                  </button>
                </div>

                {/* Date-Range Filter Controls for Student History */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 14px", flexWrap: "wrap", background: "var(--canvas)", padding: "10px 12px", borderRadius: "var(--radius-md)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 120 }}>
                    <small style={{ fontWeight: 700, color: "var(--muted)" }}>{t.from || "From"}:</small>
                    <input
                      type="date"
                      value={studentHistoryRange.from}
                      onChange={(e) => setStudentHistoryRange((prev) => ({ ...prev, from: e.target.value }))}
                      style={{ minHeight: 32, fontSize: 12, flex: 1 }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 120 }}>
                    <small style={{ fontWeight: 700, color: "var(--muted)" }}>{t.to || "To"}:</small>
                    <input
                      type="date"
                      value={studentHistoryRange.to}
                      onChange={(e) => setStudentHistoryRange((prev) => ({ ...prev, to: e.target.value }))}
                      style={{ minHeight: 32, fontSize: 12, flex: 1 }}
                    />
                  </div>
                  <button
                    className="btn primary"
                    style={{ minHeight: 32, fontSize: 12, padding: "4px 12px" }}
                    onClick={() => openAttendanceHistory(attendanceHistoryStudent, studentHistoryRange)}
                  >
                    <Filter size={13} /> {t("monitoring.filterRange", "Filter Range")}
                  </button>
                  {(studentHistoryRange.from || studentHistoryRange.to) && (
                    <button
                      className="btn secondary"
                      style={{ minHeight: 32, fontSize: 12, padding: "4px 8px" }}
                      onClick={() => {
                        setStudentHistoryRange({ from: "", to: "" });
                        openAttendanceHistory(attendanceHistoryStudent, { from: "", to: "" });
                      }}
                    >
                      {t("common.clear", "Clear")}
                    </button>
                  )}
                </div>

                {/* History Ledger List */}
                <div style={{ maxHeight: "45vh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-md)" }}>
                  {studentAttendanceData.records?.length > 0 ? (
                    <table style={{ margin: 0, width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th>{t.date}</th>
                          <th>{t.session}</th>
                          <th>{t.statusFilter}</th>
                          <th>{t.class}</th>
                          <th>{t.lastUpdated}</th>
                          <th>{t.updatedBy}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {studentAttendanceData.records.map((r) => (
                          <tr key={r._id || `${r.dateKey}-${r.sessionKey}`}>
                            <td style={{ fontWeight: 600 }}>{r.dateKey}</td>
                            <td style={{ textTransform: "capitalize", fontSize: 12 }}>{localizeSection(r.sessionKey, lang)}</td>
                            <td>
                              <span className={`accessible-status-badge status-${r.status}`}>
                                {r.status === "present" && <Check size={13} />}
                                {r.status === "absent" && <X size={13} />}
                                {r.status === "late" && <Clock size={13} />}
                                {r.status === "excused" && <AlertCircle size={13} />}
                                <span>{t[r.status] || r.status}</span>
                              </span>
                            </td>
                            <td style={{ fontSize: 12 }}>{r.classId?.name || "Class"}</td>
                            <td style={{ fontSize: 11, color: "var(--muted)" }}>
                              {r.updatedAt ? formatDate(r.updatedAt, lang) : "-"}
                            </td>
                            <td style={{ fontSize: 11, color: "var(--muted)" }}>
                              {r.updatedBy?.name || r.markedBy?.name || t("teachers.teacher", "Teacher")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>
                      <History size={32} style={{ margin: "0 auto 8px", opacity: 0.5 }} />
                      <p style={{ margin: 0, fontSize: 13 }}>{t("monitoring.noAttendanceRecorded", "No attendance records found for this student.")}</p>
                    </div>
                  )}
                </div>
              </>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn secondary" onClick={() => setAttendanceHistoryStudent(null)}>
                {t("common.close", "Close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          CONFIRMATION DIALOG MODAL
          ========================================================= */}
      {studentConfirmAction && (
        <div className="sheet-overlay" onClick={() => !studentConfirmAction.loading && setStudentConfirmAction(null)}>
          <div className="confirm-dialog-content" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-header">
              <div
                className="confirm-dialog-icon"
                style={{
                  background:
                    studentConfirmAction.type === "delete" ? "var(--danger-bg)" :
                    studentConfirmAction.type === "archive" || studentConfirmAction.type === "deactivate" ? "var(--warning-bg)" : "var(--success-bg)",
                  color:
                    studentConfirmAction.type === "delete" ? "var(--danger)" :
                    studentConfirmAction.type === "archive" || studentConfirmAction.type === "deactivate" ? "var(--warning)" : "var(--success)"
                }}
              >
                {studentConfirmAction.type === "delete" ? <Trash2 size={20} /> :
                 studentConfirmAction.type === "archive" ? <Archive size={20} /> :
                 studentConfirmAction.type === "restore" ? <ArchiveRestore size={20} /> :
                 studentConfirmAction.type === "deactivate" ? <UserX size={20} /> : <UserCheck size={20} />}
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>
                  {studentConfirmAction.type === "delete" ? t("students.deleteStudentPrompt", "Permanently Delete Student?") :
                   studentConfirmAction.type === "archive" ? t("students.archiveStudentPrompt", "Archive Student?") :
                   studentConfirmAction.type === "restore" ? t("students.restoreStudentPrompt", "Restore Student to Active?") :
                   studentConfirmAction.type === "deactivate" ? t("students.deactivateStudentPrompt", "Deactivate Student?") : t("students.activateStudentPrompt", "Activate Student?")}
                </h3>
                <small className="muted">
                  {localizeStudentName(studentConfirmAction.student?.name, lang)} ({studentConfirmAction.student?.admissionNo || studentConfirmAction.student?.admissionNumber})
                </small>
              </div>
            </div>

            {studentConfirmAction.error && (
              <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", color: "#991B1B", padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
                {studentConfirmAction.error}
              </div>
            )}

            <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5, margin: "0 0 12px" }}>
              {studentConfirmAction.type === "delete" && (
                <>
                  <strong style={{ color: "var(--danger)" }}>DANGER:</strong> {t("students.deleteDangerWarning", "This action cannot be undone. Permanently removing this student record will also delete all historical attendance records linked to this admission number.")}
                </>
              )}
              {studentConfirmAction.type === "archive" && (
                t("students.archiveExplanation", "Archiving safely moves this student to the Madrasa archives. All previous attendance history and registers remain intact and can be restored at any time.")
              )}
              {studentConfirmAction.type === "restore" && (
                t("students.restoreExplanation", "Restoring this student will make them active and available for class attendance registers again.")
              )}
              {studentConfirmAction.type === "deactivate" && (
                t("students.deactivateExplanation", "Deactivating this student will keep their records safe but exclude them from regular daily attendance registers.")
              )}
              {studentConfirmAction.type === "activate" && (
                t("students.activateExplanation", "Re-activating this student enables them for daily attendance registers in their assigned class.")
              )}
            </p>

            {studentConfirmAction.type === "delete" && (
              <label style={{ margin: "10px 0" }}>
                <span style={{ fontSize: 12 }}>
                  {t("students.typeAdmissionToConfirm", { admNo: studentConfirmAction.student?.admissionNo || studentConfirmAction.student?.admissionNumber })}
                </span>
                <input
                  type="text"
                  placeholder={studentConfirmAction.student?.admissionNo || studentConfirmAction.student?.admissionNumber}
                  value={studentConfirmAction.confirmAdmNo}
                  onChange={(e) => setStudentConfirmAction({ ...studentConfirmAction, confirmAdmNo: e.target.value })}
                  style={{ minHeight: 40, marginTop: 4 }}
                />
              </label>
            )}

            <div className="confirm-dialog-actions">
              <button
                type="button"
                className="btn secondary"
                disabled={studentConfirmAction.loading}
                onClick={() => setStudentConfirmAction(null)}
                style={{ minHeight: 38 }}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                className={`btn ${studentConfirmAction.type === "delete" ? "danger" : studentConfirmAction.type === "archive" ? "warning" : "primary"}`}
                disabled={
                  studentConfirmAction.loading ||
                  (studentConfirmAction.type === "delete" &&
                    studentConfirmAction.confirmAdmNo.trim() !== (studentConfirmAction.student?.admissionNo || studentConfirmAction.student?.admissionNumber))
                }
                onClick={executeStudentConfirmAction}
                style={{
                  minHeight: 38,
                  background:
                    studentConfirmAction.type === "delete" ? "var(--danger)" :
                    studentConfirmAction.type === "archive" || studentConfirmAction.type === "deactivate" ? "var(--warning)" : "var(--primary)",
                  color: "#fff"
                }}
              >
                {studentConfirmAction.loading ? t("common.processing", "Processing...") :
                 studentConfirmAction.type === "delete" ? t.deletePermanently :
                 studentConfirmAction.type === "archive" ? t.archive :
                 studentConfirmAction.type === "restore" ? t.restore :
                 studentConfirmAction.type === "deactivate" ? t.deactivate : t.activate}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LIVE CAMERA MODAL (GETUSERMEDIA) */}
      {cameraActive && (
        <div className="camera-modal-overlay">
          <div className="camera-modal-content">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "#fff", marginBottom: 10 }}>
              <span style={{ fontWeight: 600 }}>
                {cameraMode === "class-attendance" ? t("faceMatching.classScannerLive", "Class Attendance Scanner (Live)") : t("faceMatching.cameraViewfinder", "Camera Viewfinder")}
              </span>
              <button
                onClick={stopCamera}
                style={{ background: "none", border: "none", color: "#fff", padding: 6, cursor: "pointer" }}
              >
                <X size={24} />
              </button>
            </div>

            <div className="camera-viewfinder">
              <video ref={videoRef} playsInline autoPlay muted />
            </div>

            <div className="camera-snap-bar">
              <button
                onClick={() => startCamera(cameraFacing === "user" ? "environment" : "user", cameraMode)}
                style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: "50%", width: 44, height: 44, display: "grid", placeItems: "center", cursor: "pointer" }}
                title={t("faceMatching.switchCamera", "Switch Camera")}
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

      {/* =========================================================
          TEACHER MANAGEMENT: ADD TEACHER MODAL
          ========================================================= */}
      {showAddTeacherModal && (
        <div className="sheet-overlay" onClick={() => setShowAddTeacherModal(false)}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{t("teachers.addTeacherModalTitle", "Add Teacher Account")}</h3>
              <button className="btn icon-btn" onClick={() => setShowAddTeacherModal(false)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateTeacher} style={{ display: "grid", gap: 12 }}>
              <label>
                {t.name} *
                <input
                  required
                  value={teacherForm.name}
                  onChange={(e) => setTeacherForm({ ...teacherForm, name: e.target.value })}
                  placeholder="e.g. Ustad Ahmed"
                />
              </label>
              <label>
                {t.email} *
                <input
                  type="email"
                  required
                  value={teacherForm.email}
                  onChange={(e) => setTeacherForm({ ...teacherForm, email: e.target.value })}
                  placeholder="teacher@madrasa.org"
                />
              </label>
              <label>
                {t.password} *
                <input
                  type="password"
                  required
                  minLength={6}
                  value={teacherForm.password}
                  onChange={(e) => setTeacherForm({ ...teacherForm, password: e.target.value })}
                  placeholder={t("auth.minCharacters", "Minimum 6 characters")}
                />
              </label>
              <label>
                {t("teachers.assignClasses", "Assign Classes")}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6, maxHeight: 150, overflowY: "auto", border: "1px solid var(--border)", padding: 8, borderRadius: 6 }}>
                  {classes.map((cls) => {
                    const cid = String(cls._id || cls.id);
                    const isChecked = teacherForm.assignedClasses.includes(cid);
                    return (
                      <label key={cid} style={{ flexDirection: "row", alignItems: "center", gap: 6, fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setTeacherForm({ ...teacherForm, assignedClasses: [...teacherForm.assignedClasses, cid] });
                            } else {
                              setTeacherForm({ ...teacherForm, assignedClasses: teacherForm.assignedClasses.filter((id) => id !== cid) });
                            }
                          }}
                        />
                        <span>{formatClassLabel(cls, lang)}</span>
                      </label>
                    );
                  })}
                </div>
              </label>
              <div style={{ display: "flex", gap: 10, marginTop: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn secondary" onClick={() => setShowAddTeacherModal(false)}>
                  {t.cancel}
                </button>
                <button type="submit" className="btn primary" disabled={loading}>
                  {t("teachers.createTeacherBtn", "Create Teacher")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================
          TEACHER MANAGEMENT: RESET PASSWORD MODAL
          ========================================================= */}
      {resetPasswordTeacher && (
        <div className="sheet-overlay" onClick={() => setResetPasswordTeacher(null)}>
          <div className="sheet-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{t("teachers.resetPasswordTitle", "Reset Teacher Password")}</h3>
              <button className="btn icon-btn" onClick={() => setResetPasswordTeacher(null)}>
                <X size={18} />
              </button>
            </div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              Reset password for <strong>{resetPasswordTeacher.name}</strong> ({resetPasswordTeacher.email}).
            </p>
            <form onSubmit={handleResetTeacherPassword} style={{ display: "grid", gap: 12 }}>
              <label>
                {t("teachers.newPassword", "New Password")} *
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newTeacherPassword}
                  onChange={(e) => setNewTeacherPassword(e.target.value)}
                  placeholder={t("auth.minCharacters", "Minimum 6 characters")}
                />
              </label>
              <div style={{ display: "flex", gap: 10, marginTop: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn secondary" onClick={() => setResetPasswordTeacher(null)}>
                  {t.cancel}
                </button>
                <button type="submit" className="btn primary" disabled={loading}>
                  {t("teachers.setNewPassword", "Set New Password")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================
          SESSION INACTIVITY & LIFETIME EXPIRY WARNING MODAL
          ========================================================= */}
      {sessionExpiryWarning && (
        <div className="sheet-overlay" style={{ zIndex: 9999 }}>
          <div className="sheet-content" style={{ maxWidth: 440, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "inline-flex", padding: 14, background: "rgba(234, 88, 12, 0.12)", color: "#ea580c", borderRadius: "50%", marginBottom: 12 }}>
              <Clock size={36} />
            </div>
            <h2 style={{ marginBottom: 8 }}>{t("session.warningTitle", "Session About to Expire")}</h2>
            <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
              {t("session.warningMessage", "You will be automatically signed out due to inactivity in {{time}}.", {
                time: `${Math.floor(sessionCountdown / 60)}:${String(sessionCountdown % 60).padStart(2, "0")}`
              })}
            </p>
            {selectedClass && Object.keys(records).length > 0 && (
              <div style={{ background: "var(--info-bg)", border: "1px solid #BAE6FD", color: "#0369A1", padding: "10px 14px", borderRadius: 10, marginBottom: 16, fontSize: 13, display: "flex", alignItems: "center", gap: 8, textAlign: "start" }}>
                <CheckCircle2 size={18} style={{ flexShrink: 0 }} />
                <span>{t("session.warningAttendanceSaved", "Your attendance draft has been securely saved to this device.")}</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                type="button"
                className="btn secondary"
                onClick={() => logout(t("session.inactivityExpired", "Your session has expired. Please sign in again."))}
                style={{ minHeight: 44, flex: 1 }}
              >
                <LogOut size={16} /> {t("session.signOut", "Sign Out")}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={sessionExtending}
                onClick={handleContinueSession}
                style={{ minHeight: 44, flex: 1 }}
              >
                {sessionExtending ? <RefreshCw size={16} className="spin" /> : <ShieldCheck size={16} />}
                <span>{t("session.continueSession", "Continue Session")}</span>
              </button>
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
          className={`bottom-nav-item ${tab === "monitoring" ? "active" : ""}`}
          onClick={() => setTab("monitoring")}
        >
          <Activity size={20} />
          <span>{t.monitoring}</span>
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
          <span>{t.more}</span>
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
