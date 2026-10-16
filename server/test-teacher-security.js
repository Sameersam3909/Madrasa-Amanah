import "dotenv/config";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { spawn } from "child_process";
import { User, Class, Student, Attendance } from "./src/models.js";

const API_BASE = "http://localhost:4000/api";
const PIN = process.env.EXPORT_PIN || "12@12";

async function runSecurityTests() {
  console.log("=================================================");
  console.log("  MADRASA AMANAH — TEACHER DATA ISOLATION TESTS");
  console.log("=================================================\n");

  let serverProcess = null;
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 0. Ensure server is running
    let serverRunning = false;
    try {
      const ping = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (ping.ok) serverRunning = true;
    } catch {}

    if (!serverRunning) {
      console.log("  Starting server on port 4000 for test suite...");
      serverProcess = spawn("node", ["src/index.js"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: "4000" }
      });

      // Wait for server to come up
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const ping = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(1000) });
          if (ping.ok) {
            serverRunning = true;
            break;
          }
        } catch {}
      }
      if (!serverRunning) throw new Error("Could not start API server on port 4000");
    }

    // Connect to DB directly for fixtures and verification
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("  Connected to MongoDB Atlas for security fixture setup.\n");

    // 1. Admin login
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "Shaiksameer/3909";
    const adminLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: adminPassword })
    });
    const adminLogin = await adminLoginRes.json();
    assert(adminLoginRes.status === 200 && !!adminLogin.token, "Admin login successful");
    const adminToken = adminLogin.token;
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
      "x-export-pin": PIN
    };

    // Create 3 isolated test classes: Class A, Class B, Class C
    const timestamp = Date.now();
    const classA = await Class.create({
      name: `SecTest Class A ${timestamp}`,
      section: "A",
      academicYear: "2026",
      code: `SCTA-${timestamp}`
    });
    const classB = await Class.create({
      name: `SecTest Class B ${timestamp}`,
      section: "B",
      academicYear: "2026",
      code: `SCTB-${timestamp}`
    });
    const classC = await Class.create({
      name: `SecTest Class C ${timestamp}`,
      section: "C",
      academicYear: "2026",
      code: `SCTC-${timestamp}`
    });

    const classAId = String(classA._id);
    const classBId = String(classB._id);
    const classCId = String(classC._id);

    // Create students in each class
    const studentA = await Student.create({
      admissionNo: `SEC-A-${timestamp}`,
      name: "Tariq ClassA Student",
      classId: classA._id,
      gender: "male",
      guardianName: "Abu Tariq",
      guardianPhone: "9000000001",
      active: true
    });
    const studentB = await Student.create({
      admissionNo: `SEC-B-${timestamp}`,
      name: "Farhan ClassB Student",
      classId: classB._id,
      gender: "male",
      guardianName: "Abu Farhan",
      guardianPhone: "9000000002",
      active: true
    });
    const studentC = await Student.create({
      admissionNo: `SEC-C-${timestamp}`,
      name: "Zaid ClassC Student",
      classId: classC._id,
      gender: "male",
      guardianName: "Abu Zaid",
      guardianPhone: "9000000003",
      active: true
    });

    // Helper to generate teacher JWT
    function createTeacherToken(user) {
      return jwt.sign(
        { sub: String(user._id), role: user.role, email: user.email, sessionStart: Math.floor(Date.now() / 1000) },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
      );
    }

    // Teacher A: Assigned ONLY to Class A
    const teacherA = await User.create({
      name: "Teacher Alpha",
      email: `teacher_alpha_${timestamp}@test.local`,
      passwordHash: "hash123",
      role: "teacher",
      assignedClasses: [classA._id],
      active: true
    });
    await Class.findByIdAndUpdate(classA._id, { $addToSet: { teacherIds: teacherA._id } });

    // Teacher Unassigned: Has NO assigned classes
    const teacherUnassigned = await User.create({
      name: "Teacher Zero",
      email: `teacher_zero_${timestamp}@test.local`,
      passwordHash: "hash123",
      role: "teacher",
      assignedClasses: [],
      active: true
    });

    const teacherAToken = createTeacherToken(teacherA);
    const teacherAHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teacherAToken}`,
      "x-export-pin": PIN
    };

    const teacherZeroToken = createTeacherToken(teacherUnassigned);
    const teacherZeroHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teacherZeroToken}`,
      "x-export-pin": PIN
    };

    console.log("\n--- TEST CASE 1: Teacher A sees only students in Class A ---");
    const tAStudentsRes = await fetch(`${API_BASE}/students`, { headers: teacherAHeaders });
    const tAStudents = await tAStudentsRes.json();
    assert(tAStudentsRes.status === 200, "Teacher A can query students");
    assert(
      tAStudents.some((s) => String(s._id || s.id) === String(studentA._id)),
      "Teacher A sees student in assigned Class A"
    );
    assert(
      !tAStudents.some((s) => String(s._id || s.id) === String(studentB._id)),
      "Teacher A cannot see Class B student in roster"
    );
    assert(
      !tAStudents.some((s) => String(s._id || s.id) === String(studentC._id)),
      "Teacher A cannot see Class C student in roster"
    );

    console.log("\n--- TEST CASE 2: Teacher A cannot view students in Class B through direct API ---");
    const tADirectClassB = await fetch(`${API_BASE}/students?classId=${classBId}`, { headers: teacherAHeaders });
    assert(tADirectClassB.status === 403, "Direct API query for Class B students rejected with 403 Forbidden");

    const tADirectStudentB = await fetch(`${API_BASE}/students/${studentB._id}`, { headers: teacherAHeaders });
    assert(tADirectStudentB.status === 403, "Direct API access to Class B student profile rejected with 403 Forbidden");

    console.log("\n--- TEST CASE 3: Teacher A cannot mark attendance for Class B ---");
    const tAMarkClassB = await fetch(`${API_BASE}/attendance/bulk`, {
      method: "POST",
      headers: teacherAHeaders,
      body: JSON.stringify({
        classId: classBId,
        dateKey: "2026-10-16",
        sessionKey: "morning",
        records: [{ studentId: String(studentB._id), status: "present" }]
      })
    });
    assert(tAMarkClassB.status === 403, "Teacher A marking attendance for Class B rejected with 403 Forbidden");

    console.log("\n--- TEST CASE 4: Teacher A cannot access Class B attendance history ---");
    const tAHistoryClassB = await fetch(`${API_BASE}/attendance?classId=${classBId}&dateKey=2026-10-16`, {
      headers: teacherAHeaders
    });
    assert(tAHistoryClassB.status === 403, "GET /api/attendance for unassigned Class B rejected with 403 Forbidden");

    const tAStudentBAtt = await fetch(`${API_BASE}/students/${studentB._id}/attendance`, {
      headers: teacherAHeaders
    });
    assert(tAStudentBAtt.status === 403, "GET /api/students/:id/attendance for Class B student rejected with 403 Forbidden");

    console.log("\n--- TEST CASE 5: Teacher A cannot export Class B records as PDF or Excel ---");
    const tAExportReports = await fetch(`${API_BASE}/reports/export?classId=${classBId}&from=2026-10-01&to=2026-10-16`, {
      headers: teacherAHeaders
    });
    assert(tAExportReports.status === 403, "Reports export for Class B rejected with 403 Forbidden");

    const tAExportStudents = await fetch(`${API_BASE}/students/export?classId=${classBId}`, {
      headers: teacherAHeaders
    });
    assert(tAExportStudents.status === 403, "Students roster export for Class B rejected with 403 Forbidden");

    const tAExportOrgWide = await fetch(`${API_BASE}/students/export`, {
      headers: teacherAHeaders
    });
    assert(tAExportOrgWide.status === 403, "Teacher organization-wide student export blocked with 403 Forbidden");

    console.log("\n--- TEST CASE 6: Teacher A cannot obtain unauthorized student data using search or filters ---");
    const tASearchFarhan = await fetch(`${API_BASE}/students?search=Farhan`, {
      headers: teacherAHeaders
    });
    const tASearchData = await tASearchFarhan.json();
    assert(
      !tASearchData.some((s) => String(s._id || s.id) === String(studentB._id)),
      "Search for Class B student by Teacher A yields 0 unauthorized results"
    );

    const adminSearchFarhan = await fetch(`${API_BASE}/students?search=Farhan`, {
      headers: adminHeaders
    });
    const adminSearchData = await adminSearchFarhan.json();
    assert(
      adminSearchData.some((s) => String(s._id || s.id) === String(studentB._id)),
      "Admin search for Farhan finds the record across the institution"
    );

    console.log("\n--- TEST CASE 7: Teacher assigned to Classes A and B can access both, but not Class C ---");
    const teacherAB = await User.create({
      name: "Teacher Multi",
      email: `teacher_multi_${timestamp}@test.local`,
      passwordHash: "hash123",
      role: "teacher",
      assignedClasses: [classA._id, classB._id],
      active: true
    });
    await Class.findByIdAndUpdate(classA._id, { $addToSet: { teacherIds: teacherAB._id } });
    await Class.findByIdAndUpdate(classB._id, { $addToSet: { teacherIds: teacherAB._id } });

    const teacherABToken = createTeacherToken(teacherAB);
    const teacherABHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teacherABToken}`,
      "x-export-pin": PIN
    };

    const tABResA = await fetch(`${API_BASE}/students?classId=${classAId}`, { headers: teacherABHeaders });
    assert(tABResA.status === 200, "Multi-class teacher can access Class A");

    const tABResB = await fetch(`${API_BASE}/students?classId=${classBId}`, { headers: teacherABHeaders });
    assert(tABResB.status === 200, "Multi-class teacher can access Class B");

    const tABResC = await fetch(`${API_BASE}/students?classId=${classCId}`, { headers: teacherABHeaders });
    assert(tABResC.status === 403, "Multi-class teacher blocked from unassigned Class C (403 Forbidden)");

    console.log("\n--- TEST CASE 8: Teacher with no assignments sees no student records ---");
    const tZeroClasses = await fetch(`${API_BASE}/classes`, { headers: teacherZeroHeaders });
    const tZeroClassesData = await tZeroClasses.json();
    assert(tZeroClasses.status === 200 && tZeroClassesData.length === 0, "Teacher with no assignments gets 0 classes");

    const tZeroStudents = await fetch(`${API_BASE}/students`, { headers: teacherZeroHeaders });
    const tZeroStudentsData = await tZeroStudents.json();
    assert(tZeroStudents.status === 200 && tZeroStudentsData.length === 0, "Teacher with no assignments gets 0 students");

    console.log("\n--- TEST CASE 9: Admin retains authorized access to institution-wide records ---");
    const adminClasses = await fetch(`${API_BASE}/classes`, { headers: adminHeaders });
    const adminClassesData = await adminClasses.json();
    assert(
      adminClassesData.some((c) => String(c._id) === classAId) &&
      adminClassesData.some((c) => String(c._id) === classBId) &&
      adminClassesData.some((c) => String(c._id) === classCId),
      "Admin sees all institution classes"
    );

    const adminMarkRes = await fetch(`${API_BASE}/attendance/bulk`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        classId: classCId,
        dateKey: "2026-10-16",
        sessionKey: "morning",
        records: [{ studentId: String(studentC._id), status: "present" }]
      })
    });
    assert(adminMarkRes.status === 200, "Admin can mark attendance in any class");

    console.log("\n--- TEST CASE 10: Changing teacher assignment immediately updates authorization ---");
    // Remove Class A from teacherA and assign Class C instead via Admin API
    const reassignRes = await fetch(`${API_BASE}/admin/users/${teacherA._id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        assignedClasses: [classCId]
      })
    });
    assert(reassignRes.status === 200, "Admin successfully changed teacher class assignment");

    // Immediate next request by Teacher A: Class A should now be 403, Class C should now be 200
    const tAPostChangeA = await fetch(`${API_BASE}/students?classId=${classAId}`, { headers: teacherAHeaders });
    assert(tAPostChangeA.status === 403, "Teacher A immediately blocked from previously assigned Class A (403)");

    const tAPostChangeC = await fetch(`${API_BASE}/students?classId=${classCId}`, { headers: teacherAHeaders });
    assert(tAPostChangeC.status === 200, "Teacher A immediately granted access to newly assigned Class C (200)");

    console.log("\n--- TEST CASE 11: Invalid or mismatched student/class relationships rejected ---");
    // Try to mark attendance in Class C with a student from Class B
    const mismatchRes = await fetch(`${API_BASE}/attendance/bulk`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        classId: classCId,
        dateKey: "2026-10-16",
        sessionKey: "morning",
        records: [{ studentId: String(studentB._id), status: "present" }]
      })
    });
    assert(
      mismatchRes.status === 400,
      `Cross-class student mismatch strictly rejected with HTTP 400 (got ${mismatchRes.status})`
    );

    console.log("\n--- TEST CASE 12: Offline sync rejects records for unassigned classes ---");
    const offlineSyncRes = await fetch(`${API_BASE}/sync/attendance`, {
      method: "POST",
      headers: teacherAHeaders, // Teacher A is now assigned ONLY to Class C
      body: JSON.stringify({
        mutationId: `mut_test_${Date.now()}`,
        classId: classBId, // unauthorized!
        dateKey: "2026-10-16",
        sessionKey: "morning",
        records: [{ studentId: String(studentB._id), status: "present" }]
      })
    });
    const syncData = await offlineSyncRes.json();
    const syncResult = Array.isArray(syncData) ? syncData[0] : syncData;
    assert(
      syncResult.status === "error" && syncResult.message.includes("Class access denied"),
      "Offline sync rejects unassigned class with 'Class access denied'"
    );

    console.log("\n--- TEST CASE 13: Cross-class access remains blocked even if params manipulated ---");
    // Attacking face-index API directly
    const faceRes = await fetch(`${API_BASE}/students/face-index?classId=${classAId}`, { headers: teacherAHeaders });
    assert(faceRes.status === 403, "Face index API access denied for unauthorized class (403)");

    // Attacking attendance monitoring directly
    const monitorRes = await fetch(`${API_BASE}/attendance/monitoring?classId=${classAId}&dateKey=2026-10-16`, {
      headers: teacherAHeaders
    });
    assert(monitorRes.status === 403, "Attendance monitoring query for unauthorized class blocked (403)");

    console.log("\n--- TEST CASE 14: Existing features continue to work normally ---");
    const summaryRes = await fetch(
      `${API_BASE}/reports/summary?classId=${classCId}&from=2026-10-01&to=2026-10-16`,
      { headers: teacherAHeaders }
    );
    assert(summaryRes.status === 200, "Teacher can view reports summary for authorized Class C");

    // Clean up test fixtures
    await Student.deleteMany({ _id: { $in: [studentA._id, studentB._id, studentC._id] } });
    await Attendance.deleteMany({ classId: { $in: [classA._id, classB._id, classC._id] } });
    await Class.deleteMany({ _id: { $in: [classA._id, classB._id, classC._id] } });
    await User.deleteMany({ _id: { $in: [teacherA._id, teacherAB._id, teacherUnassigned._id] } });
    console.log("  Cleaned up all temporary test fixtures.");

    console.log("\n=================================================");
    console.log(`  SECURITY TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("=================================================\n");

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error("Test runner error:", err);
    process.exit(1);
  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
    await mongoose.disconnect();
  }
}

runSecurityTests();
