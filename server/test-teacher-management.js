import dotenv from "dotenv";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

import { User, Class, Student, Attendance } from "./src/models.js";

const API_BASE = "http://localhost:4000/api";

async function runTeacherManagementTests() {
  console.log("=================================================");
  console.log("  DARUL ULOOM ASHRAFIA — TEACHER MANAGEMENT SUITE");
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
    assert(adminLoginRes.status === 200 && !!adminLoginData.token, "Admin authentication succeeded");
    const adminToken = adminLoginData.token;
    const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };

    // Get an existing class
    const classesRes = await fetch(`${API_BASE}/classes`, { headers: adminHeaders });
    const classes = await classesRes.json();
    assert(Array.isArray(classes) && classes.length > 0, "Classes loaded dynamically");
    const testClass = classes[0];
    const testClassId = String(testClass._id || testClass.id);

    // Grab an existing student to verify student name is NEVER polluted into teacher
    const sampleStudent = await Student.findOne({ active: true });
    const sampleStudentName = sampleStudent ? sampleStudent.name : "Sample Student";

    // --- TEST 1: Create Teacher with dedicated Teacher Name ---
    const timestamp = Date.now().toString().slice(-5);
    const dedicatedTeacherName = `Ustad Ahmed Qasmi ${timestamp}`;
    const teacherEmail = `ustad.ahmed.${timestamp}@madrasa.org`;
    const initialPassword = `UstadPass#${timestamp}`;

    console.log("\n--- [1] Dedicated Teacher Name & Account Creation ---");
    const createRes = await fetch(`${API_BASE}/admin/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: dedicatedTeacherName,
        email: teacherEmail,
        password: initialPassword,
        role: "teacher",
        assignedClasses: [testClassId]
      })
    });
    const createdData = await createRes.json();
    assert(createRes.status === 201, "Teacher account created with HTTP 201");
    assert(createdData.name === dedicatedTeacherName, `Teacher name matches entered teacher name: "${dedicatedTeacherName}"`);
    assert(createdData.name !== sampleStudentName, `Teacher name is NOT contaminated by student name ("${sampleStudentName}")`);
    assert(!createdData.password && !createdData.passwordHash, "Teacher creation response does NOT expose password or passwordHash");
    const teacherId = createdData.id || createdData._id;

    // --- TEST 2: Reject Short Password on Creation ---
    console.log("\n--- [2] Password Validation on Teacher Creation ---");
    const shortPwdRes = await fetch(`${API_BASE}/admin/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Ustad Invalid ${timestamp}`,
        email: `invalid.${timestamp}@madrasa.org`,
        password: "short", // < 8 characters
        role: "teacher"
      })
    });
    assert(shortPwdRes.status === 400, "Password under 8 characters rejected with HTTP 400 on creation");

    // --- TEST 3: Teacher List Does Not Expose Credentials ---
    console.log("\n--- [3] Credential Protection in Teacher Directory ---");
    const listRes = await fetch(`${API_BASE}/admin/users`, { headers: adminHeaders });
    const usersList = await listRes.json();
    assert(listRes.status === 200, "Teacher directory fetched successfully");
    const foundTeacher = usersList.find((u) => String(u._id || u.id) === String(teacherId));
    assert(!!foundTeacher, "Created teacher found in admin teacher list");
    assert(foundTeacher.name === dedicatedTeacherName, "Teacher name in directory is accurate");
    assert(foundTeacher.password === undefined, "Password field is undefined in user list");
    assert(foundTeacher.passwordHash === undefined, "Password hash is undefined in user list");

    // --- TEST 4: Teacher Login with Initial Credentials ---
    console.log("\n--- [4] Teacher Authentication Workflow ---");
    const teacherLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: teacherEmail, password: initialPassword })
    });
    const teacherLoginData = await teacherLoginRes.json();
    assert(teacherLoginRes.status === 200 && !!teacherLoginData.token, "Teacher logged in with initial password");
    const teacherToken = teacherLoginData.token;
    const teacherHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${teacherToken}` };

    // --- TEST 5: Teacher Role Permissions Isolation ---
    console.log("\n--- [5] Teacher Permission Boundary Protection ---");
    const teacherListTeachersRes = await fetch(`${API_BASE}/admin/users`, { headers: teacherHeaders });
    assert(teacherListTeachersRes.status === 403, "Teacher accessing /api/admin/users strictly blocked with HTTP 403");

    const teacherCreateTeacherRes = await fetch(`${API_BASE}/admin/users`, {
      method: "POST",
      headers: teacherHeaders,
      body: JSON.stringify({ name: "Hacker Teacher", email: "hacker@test.org", password: "Password123#" })
    });
    assert(teacherCreateTeacherRes.status === 403, "Teacher creating teacher accounts blocked with HTTP 403");

    // --- TEST 6: Admin Edit Teacher Details ---
    console.log("\n--- [6] Admin Editing Teacher Details & Class Assignments ---");
    const updatedTeacherName = `Hazrat Maulana Ahmed ${timestamp}`;
    const editRes = await fetch(`${API_BASE}/admin/users/${teacherId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        name: updatedTeacherName,
        assignedClasses: [testClassId]
      })
    });
    const editData = await editRes.json();
    assert(editRes.status === 200, "Teacher details updated successfully via PATCH");
    assert(editData.name === updatedTeacherName, `Teacher name updated to "${updatedTeacherName}"`);
    assert(editData.password === undefined && editData.passwordHash === undefined, "Edit response does not leak credentials");

    // --- TEST 7: Teacher Deactivation & Reactivation ---
    console.log("\n--- [7] Account Status Management (Deactivate / Activate) ---");
    const deactRes = await fetch(`${API_BASE}/admin/users/${teacherId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ active: false })
    });
    assert(deactRes.status === 200, "Teacher deactivated via PATCH active: false");

    // Deactivated teacher cannot log in
    const deactLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: teacherEmail, password: initialPassword })
    });
    assert(deactLoginRes.status === 401 || deactLoginRes.status === 403, "Deactivated teacher login rejected");

    // Reactivate teacher
    const reactRes = await fetch(`${API_BASE}/admin/users/${teacherId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ active: true })
    });
    assert(reactRes.status === 200, "Teacher re-activated via PATCH active: true");

    // --- TEST 8: Admin Password Reset Workflow ---
    console.log("\n--- [8] Admin Password Reset & Credential Confidentiality ---");
    const newPassword = `NewSecurePass#${timestamp}`;

    // Reject short password
    const shortResetRes = await fetch(`${API_BASE}/admin/users/${teacherId}/reset-password`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ newPassword: "short" })
    });
    assert(shortResetRes.status === 400, "Password reset with under 8 characters rejected with HTTP 400");

    // Non-admin cannot reset password
    const unauthorizedResetRes = await fetch(`${API_BASE}/admin/users/${teacherId}/reset-password`, {
      method: "POST",
      headers: teacherHeaders,
      body: JSON.stringify({ newPassword })
    });
    assert(unauthorizedResetRes.status === 403, "Non-admin resetting teacher password rejected with HTTP 403");

    // Admin resets password
    const resetRes = await fetch(`${API_BASE}/admin/users/${teacherId}/reset-password`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ newPassword })
    });
    const resetData = await resetRes.json();
    assert(resetRes.status === 200, "Admin successfully reset teacher password");
    assert(resetData.message && !resetData.password, "Reset response confirms completion without revealing password");

    // Old password no longer works
    const oldLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: teacherEmail, password: initialPassword })
    });
    assert(oldLoginRes.status === 401, "Old password rejected after reset (HTTP 401)");

    // New password works
    const newLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: teacherEmail, password: newPassword })
    });
    assert(newLoginRes.status === 200, "Teacher successfully logged in with newly reset password");

    // --- TEST 9: Student Integrity Verification ---
    console.log("\n--- [9] Student Integrity Verification ---");
    if (sampleStudent) {
      const studentAfter = await Student.findById(sampleStudent._id);
      assert(studentAfter.name === sampleStudent.name, `Existing student "${studentAfter.name}" name is completely preserved`);
      assert(studentAfter.admissionNo === sampleStudent.admissionNo, "Student admission number remains intact");
    }

    // --- CLEANUP ---
    console.log("\n--- [10] Cleanup Test Teacher Account ---");
    const delRes = await fetch(`${API_BASE}/admin/users/${teacherId}?permanent=true`, {
      method: "DELETE",
      headers: adminHeaders
    });
    assert(delRes.status === 200, "Test teacher account deleted cleanly");

    console.log(`\n=================================================`);
    console.log(`  TEACHER MANAGEMENT RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`=================================================\n`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("Test runner error:", err);
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {}
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
    }
  }
}

runTeacherManagementTests();
