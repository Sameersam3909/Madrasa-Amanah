import dotenv from "dotenv";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

import { User, Class, Student, Attendance } from "./src/models.js";

const API_BASE = "http://localhost:4000/api";

async function runMultipleClassTests() {
  console.log("=================================================");
  console.log("  DARUL ULOOM ASHRAFIA — MULTIPLE CLASS ASSIGNMENT");
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
        cwd: __dirname,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: "4000" }
      });
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

    await mongoose.connect(process.env.MONGODB_URI);
    console.log("  Connected to MongoDB Atlas for verification.\n");

    // 1. Sign in as Admin
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "Shaiksameer/3909";
    const adminLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: adminPassword })
    });
    const adminLoginData = await adminLoginRes.json();
    assert(adminLoginRes.status === 200 && adminLoginData.token, "Admin authentication succeeded");
    const adminToken = adminLoginData.token;

    // 2. Load classes
    const classesRes = await fetch(`${API_BASE}/classes`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const classes = await classesRes.json();
    assert(Array.isArray(classes) && classes.length >= 2, "Loaded active classes dynamically");
    const class1Id = String(classes[0]._id || classes[0].id);
    const class2Id = String(classes[1]._id || classes[1].id);
    let class3Id = "";
    if (classes.length >= 3) {
      class3Id = String(classes[2]._id || classes[2].id);
    } else {
      const extraClass = await Class.create({
        name: "Test Dynamic Class 3",
        section: "Evening",
        academicYear: "2026-2027",
        active: true
      });
      class3Id = String(extraClass._id);
    }

    // 3. Create a test teacher assigned only to Class 1
    const testTeacherEmail = `teacher.multi.${Date.now()}@darululoom.com`;
    const teacherCreateRes = await fetch(`${API_BASE}/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: "Ustad Multi Test",
        email: testTeacherEmail,
        password: "TeacherPassword@123",
        assignedClasses: [class1Id]
      })
    });
    const teacherCreateData = await teacherCreateRes.json();
    const teacherId = teacherCreateData.user?._id || teacherCreateData.user?.id;

    const teacherLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testTeacherEmail, password: "TeacherPassword@123" })
    });
    const teacherLoginData = await teacherLoginRes.json();
    const teacherToken = teacherLoginData.token;
    assert(teacherLoginRes.status === 200 && teacherToken, "Teacher assigned only to Class 1 logged in");

    console.log("\n--- [1] Create Student with Single Initial Class ---");
    const testAdmissionNo = `MC-${Date.now().toString().slice(-5)}`;
    const studentCreateRes = await fetch(`${API_BASE}/students`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        admissionNo: testAdmissionNo,
        name: "Sameer MultiClass Test",
        classIds: [class1Id],
        guardianName: "Muhammad Parent",
        guardianPhone: "+91 98765 43210"
      })
    });
    const studentCreateData = await studentCreateRes.json();
    const testStudentId = String(studentCreateData._id || studentCreateData.id);
    assert(studentCreateRes.status === 201, "Student created with HTTP 201");
    assert(studentCreateData.classIds.length === 1, "Student initialized with 1 class assignment");

    console.log("\n--- [2] Add Second Class Without Removing First (Manage Classes) ---");
    const addSecondClassRes = await fetch(`${API_BASE}/students/${testStudentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        classIds: [class1Id, class2Id],
        classId: class1Id
      })
    });
    const addSecondData = await addSecondClassRes.json();
    assert(addSecondClassRes.status === 200, "Student updated with multiple classes");
    const assignedIds2 = addSecondData.classIds.map((c) => String(c._id || c.id || c));
    assert(assignedIds2.includes(class1Id), "Student remains assigned to Class 1");
    assert(assignedIds2.includes(class2Id), "Student now also assigned to Class 2");
    assert(assignedIds2.length === 2, "Student has exactly 2 classes assigned");

    console.log("\n--- [3] Assign Three Classes Simultaneously ---");
    const addThirdClassRes = await fetch(`${API_BASE}/students/${testStudentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        classIds: [class1Id, class2Id, class3Id],
        classId: class1Id
      })
    });
    const addThirdData = await addThirdClassRes.json();
    const assignedIds3 = addThirdData.classIds.map((c) => String(c._id || c.id || c));
    assert(assignedIds3.length === 3, "Student assigned to 3 classes simultaneously");
    assert(
      assignedIds3.includes(class1Id) && assignedIds3.includes(class2Id) && assignedIds3.includes(class3Id),
      "All 3 classes verified in student record"
    );

    console.log("\n--- [4] Verify Roster Inclusion & Non-Duplication in Class Rosters ---");
    const class1Roster = await (await fetch(`${API_BASE}/students?classId=${class1Id}`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const inC1 = class1Roster.filter((s) => String(s._id || s.id) === testStudentId);
    assert(inC1.length === 1, "Student appears exactly once in Class 1 roster");

    const class2Roster = await (await fetch(`${API_BASE}/students?classId=${class2Id}`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const inC2 = class2Roster.filter((s) => String(s._id || s.id) === testStudentId);
    assert(inC2.length === 1, "Student appears exactly once in Class 2 roster");

    const class3Roster = await (await fetch(`${API_BASE}/students?classId=${class3Id}`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const inC3 = class3Roster.filter((s) => String(s._id || s.id) === testStudentId);
    assert(inC3.length === 1, "Student appears exactly once in Class 3 roster");

    console.log("\n--- [5] Remove One Class Intentionally (Deselection) ---");
    const removeRes = await fetch(`${API_BASE}/students/${testStudentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        classIds: [class1Id, class3Id],
        classId: class1Id
      })
    });
    const removeData = await removeRes.json();
    const remainingIds = removeData.classIds.map((c) => String(c._id || c.id || c));
    assert(!remainingIds.includes(class2Id), "Class 2 intentionally deselected and removed");
    assert(remainingIds.includes(class1Id) && remainingIds.includes(class3Id), "Classes 1 and 3 safely retained");
    assert(remainingIds.length === 2, "Student now belongs to exactly 2 classes");

    console.log("\n--- [6] Validation: Rejection of Empty Classes Array (0 Classes) ---");
    const emptyClassRes = await fetch(`${API_BASE}/students/${testStudentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ classIds: [] })
    });
    assert(emptyClassRes.status === 400, "Empty classIds array rejected with HTTP 400");

    console.log("\n--- [7] Validation: Rejection of Malformed / Invalid Class IDs ---");
    const malformedRes = await fetch(`${API_BASE}/students/${testStudentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ classIds: ["not-a-valid-objectid"] })
    });
    assert(malformedRes.status === 400, "Malformed class ID string rejected with HTTP 400");

    console.log("\n--- [8] Security: Teacher Blocked From Modifying Student Classes ---");
    const teacherModRes = await fetch(`${API_BASE}/students/${testStudentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${teacherToken}`
      },
      body: JSON.stringify({ classIds: [class1Id] })
    });
    assert(teacherModRes.status === 403, "Teacher modifying student class assignments rejected with HTTP 403");

    console.log("\n--- [9] Independent Attendance Marking Across Multiple Classes on Same Date ---");
    const todayStr = new Date().toISOString().slice(0, 10);

    // Class 1 Morning: Present
    const markC1 = await fetch(`${API_BASE}/attendance/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        classId: class1Id,
        dateKey: todayStr,
        sessionKey: "morning",
        source: "manual",
        records: [{ studentId: testStudentId, status: "present", note: "Present Class 1" }]
      })
    });
    assert(markC1.status === 200, "Attendance marked Present in Class 1 morning session");

    // Class 3 Evening: Absent on same date
    const markC3 = await fetch(`${API_BASE}/attendance/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        classId: class3Id,
        dateKey: todayStr,
        sessionKey: "evening",
        source: "manual",
        records: [{ studentId: testStudentId, status: "absent", note: "Absent Class 3" }]
      })
    });
    assert(markC3.status === 200, "Attendance marked Absent in Class 3 evening session on same date");

    const historyRes = await fetch(`${API_BASE}/students/${testStudentId}/attendance`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const historyData = await historyRes.json();
    const r1 = historyData.records.find((r) => String(r.classId?._id || r.classId) === class1Id);
    const r3 = historyData.records.find((r) => String(r.classId?._id || r.classId) === class3Id);
    assert(!!r1 && r1.status === "present", "Class 1 session status recorded as Present");
    assert(!!r3 && r3.status === "absent", "Class 3 session status recorded as Absent independently");

    console.log("\n--- [10] Historical Register Continuity Upon Class Reassignment ---");
    // Remove student from Class 3 and assign to Class 1 & 2
    await fetch(`${API_BASE}/students/${testStudentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ classIds: [class1Id, class2Id] })
    });
    const historyAfterReassign = await (await fetch(`${API_BASE}/students/${testStudentId}/attendance`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    })).json();
    const c3HistoryPreserved = historyAfterReassign.records.some(
      (r) => String(r.classId?._id || r.classId) === class3Id && r.status === "absent"
    );
    assert(c3HistoryPreserved, "Class 3 historical attendance safely preserved after student unassigned from Class 3");

    console.log("\n--- [11] Export Roster Reflects Multiple Classes ---");
    const exportCsvRes = await fetch(`${API_BASE}/students/export?format=csv`, {
      headers: { Authorization: `Bearer ${adminToken}`, "x-export-pin": "12@12" }
    });
    const exportCsvText = await exportCsvRes.text();
    assert(exportCsvRes.status === 200, "CSV export returned HTTP 200");
    assert(exportCsvText.includes(testAdmissionNo), "Export contains multi-class student admission number");

    console.log("\n--- [12] Teacher Class Access Boundaries for Multi-Class Student ---");
    // Teacher assigned only to Class 1 can access student through Class 1
    const tClass1Res = await fetch(`${API_BASE}/students?classId=${class1Id}`, {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    const tClass1Students = await tClass1Res.json();
    assert(
      tClass1Students.some((s) => String(s._id || s.id) === testStudentId),
      "Teacher assigned to Class 1 can see multi-class student in Class 1"
    );

    // Teacher assigned only to Class 1 is blocked from querying Class 2
    const tClass2Res = await fetch(`${API_BASE}/students?classId=${class2Id}`, {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    assert(tClass2Res.status === 403, "Teacher accessing unassigned Class 2 blocked with HTTP 403 Forbidden");

    console.log("\n--- [13] Cleanup Temporary Fixtures ---");
    await Student.findByIdAndDelete(testStudentId);
    await Attendance.deleteMany({ studentId: testStudentId });
    if (teacherId) await User.findByIdAndDelete(teacherId);
    assert(true, "Temporary test student, attendance records, and teacher cleaned up");

    console.log("\n=================================================");
    console.log(`  MULTIPLE-CLASS RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("=================================================\n");
  } catch (err) {
    console.error("❌ Test suite encountered an error:", err);
    failed++;
  } finally {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
    }
    await mongoose.disconnect();
  }
}

runMultipleClassTests();
