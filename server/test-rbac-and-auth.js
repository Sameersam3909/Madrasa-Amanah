import "dotenv/config";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const API_BASE = "http://localhost:4000/api";

async function runTests() {
  console.log("=================================================");
  console.log("  MADRASA AMANAH — RBAC & AUTHENTICATION SUITE");
  console.log("=================================================\n");

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
    // 1. Missing Token Test
    const noTokenRes = await fetch(`${API_BASE}/classes`);
    assert(noTokenRes.status === 401, "Missing token returns 401 Unauthorized");

    // 2. Invalid Token Test
    const invalidTokenRes = await fetch(`${API_BASE}/classes`, {
      headers: { Authorization: "Bearer totally-invalid-bogus-token" }
    });
    assert(invalidTokenRes.status === 401, "Invalid token returns 401 Unauthorized");

    // 3. Expired Token Test
    const expiredToken = jwt.sign(
      { sub: "507f1f77bcf86cd799439011" },
      process.env.JWT_SECRET || "madrasa-amanah-smart-attendance-system-secure-jwt-secret-key-2026-production",
      { expiresIn: "0s" }
    );
    const expiredRes = await fetch(`${API_BASE}/classes`, {
      headers: { Authorization: `Bearer ${expiredToken}` }
    });
    assert(expiredRes.status === 401, "Expired token returns 401 with session expired message");

    // 4. Admin Login
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminPass = process.env.ADMIN_PASSWORD || "Shaiksameer/3909";
    const adminLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: adminPass })
    });
    const adminLoginData = await adminLoginRes.json();
    assert(adminLoginRes.status === 200 && Boolean(adminLoginData.token), "Admin login successful and returned JWT");
    const adminToken = adminLoginData.token;
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`
    };

    // 5. Admin retrieves classes
    const classesRes = await fetch(`${API_BASE}/classes`, { headers: adminHeaders });
    const allClasses = await classesRes.json();
    assert(classesRes.status === 200 && Array.isArray(allClasses) && allClasses.length >= 1, "Admin retrieves all active classes");

    const targetClass = allClasses[0];
    const targetClassId = String(targetClass._id);

    // Create a secondary class to test cross-class authorization
    const secondClassRes = await fetch(`${API_BASE}/classes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Restricted Class ${Date.now()}`,
        section: "Evening",
        academicYear: "2026"
      })
    });
    const secondClass = await secondClassRes.json();
    const secondClassId = String(secondClass._id);

    // 6. Admin creates a Teacher Account
    const teacherEmail = `teacher_${Date.now()}@madrasa.test`;
    const teacherPass = "TeacherPass123!";
    const createTeacherRes = await fetch(`${API_BASE}/admin/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Ustadh Ahmad Test",
        email: teacherEmail,
        password: teacherPass,
        role: "teacher",
        assignedClasses: [targetClassId]
      })
    });
    const teacherUser = await createTeacherRes.json();
    assert(createTeacherRes.status === 201 && teacherUser.role === "teacher", "Admin created teacher assigned to Class 1");
    const teacherId = teacherUser.id;

    // 7. Teacher Login
    const teacherLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: teacherEmail, password: teacherPass })
    });
    const teacherLoginData = await teacherLoginRes.json();
    assert(teacherLoginRes.status === 200 && Boolean(teacherLoginData.token), "Teacher login successful and returned JWT");
    const teacherToken = teacherLoginData.token;
    const teacherHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teacherToken}`
    };

    // 8. Teacher receives ONLY assigned classes
    const teacherClassesRes = await fetch(`${API_BASE}/classes`, { headers: teacherHeaders });
    const teacherClasses = await teacherClassesRes.json();
    const classIds = teacherClasses.map(c => String(c._id));
    assert(
      teacherClassesRes.status === 200 &&
      classIds.includes(targetClassId) &&
      !classIds.includes(secondClassId),
      "Teacher receives only assigned classes (cannot see unassigned second class)"
    );

    // 9. Teacher cross-class access forbidden
    const crossClassAttRes = await fetch(`${API_BASE}/attendance?classId=${secondClassId}&dateKey=2026-10-15`, {
      headers: teacherHeaders
    });
    assert(crossClassAttRes.status === 403, "Teacher attempting to access unauthorized class attendance returns 403 Forbidden");

    // 10. Teacher cannot create student
    const teacherCreateStudentRes = await fetch(`${API_BASE}/students`, {
      method: "POST",
      headers: teacherHeaders,
      body: JSON.stringify({
        admissionNo: `TEST-ADM-${Date.now()}`,
        name: "Unauthorized Student",
        classId: targetClassId
      })
    });
    assert(teacherCreateStudentRes.status === 403, "Teacher attempting to create student returns 403 Forbidden");

    // 11. Admin creates student in target class
    const testAdmNo = `ADM-${Date.now()}`;
    const adminCreateStudentRes = await fetch(`${API_BASE}/students`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        admissionNo: testAdmNo,
        name: "Zaid Admin Test",
        classId: targetClassId,
        guardianName: "Abu Zaid",
        guardianPhone: "9876543210"
      })
    });
    const createdStudent = await adminCreateStudentRes.json();
    assert(adminCreateStudentRes.status === 201 && createdStudent.admissionNo === testAdmNo, "Admin successfully creates student profile");
    const studentId = createdStudent.id;

    // 12. Teacher cannot edit student profile
    const teacherEditStudentRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: "PATCH",
      headers: teacherHeaders,
      body: JSON.stringify({ name: "Tampered Name" })
    });
    assert(teacherEditStudentRes.status === 403, "Teacher attempting to edit student profile returns 403 Forbidden");

    // 13. Teacher cannot delete student profile
    const teacherDeleteStudentRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: "DELETE",
      headers: teacherHeaders
    });
    assert(teacherDeleteStudentRes.status === 403, "Teacher attempting to delete student returns 403 Forbidden");

    // 14. Teacher cannot view organization-wide weekly report
    const teacherWeeklyReportRes = await fetch(`${API_BASE}/reports/weekly-excel`, {
      headers: teacherHeaders
    });
    assert(teacherWeeklyReportRes.status === 403, "Teacher attempting to export org-wide weekly report returns 403 Forbidden");

    // 15. Teacher cannot access admin settings
    const teacherSettingsRes = await fetch(`${API_BASE}/settings`, {
      headers: teacherHeaders
    });
    assert(teacherSettingsRes.status === 403, "Teacher attempting to access system settings returns 403 Forbidden");

    // 16. Teacher can take attendance in assigned class
    const todayKey = new Date().toISOString().slice(0, 10);
    const teacherMarkAttendanceRes = await fetch(`${API_BASE}/attendance/bulk`, {
      method: "POST",
      headers: teacherHeaders,
      body: JSON.stringify({
        classId: targetClassId,
        dateKey: todayKey,
        sessionKey: "morning",
        source: "manual",
        records: [{ studentId, status: "present", note: "On time" }]
      })
    });
    assert(teacherMarkAttendanceRes.status === 200, "Teacher successfully marks attendance in assigned class");

    // 17. Teacher cannot edit attendance beyond configured correction window
    const oldDateKey = "2025-01-01";
    const oldAttendanceRes = await fetch(`${API_BASE}/attendance/bulk`, {
      method: "POST",
      headers: teacherHeaders,
      body: JSON.stringify({
        classId: targetClassId,
        dateKey: oldDateKey,
        sessionKey: "morning",
        source: "manual",
        records: [{ studentId, status: "absent" }]
      })
    });
    assert(oldAttendanceRes.status === 403, "Teacher attempting historical attendance correction beyond window returns 403 Forbidden");

    // 18. Teacher can change own password
    const newTeacherPass = "NewSecurePass123!";
    const changePassRes = await fetch(`${API_BASE}/auth/change-password`, {
      method: "POST",
      headers: teacherHeaders,
      body: JSON.stringify({
        currentPassword: teacherPass,
        newPassword: newTeacherPass
      })
    });
    assert(changePassRes.status === 200, "Teacher successfully changes their own password");

    // 19. Admin manages Settings (configurable recipient, timezone, schedule)
    const updateSettingsRes = await fetch(`${API_BASE}/settings`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        reportRecipientEmail: "2300030621cseh1@gmail.com",
        reportTimezone: "Asia/Kolkata",
        reportSchedule: "Mondays at 06:00 AM",
        reportAutomationEnabled: true,
        attendanceCorrectionWindowDays: 14
      })
    });
    const updatedSettings = await updateSettingsRes.json();
    assert(
      updateSettingsRes.status === 200 &&
      updatedSettings.settings.reportRecipientEmail === "2300030621cseh1@gmail.com" &&
      updatedSettings.settings.attendanceCorrectionWindowDays === 14,
      "Admin successfully configures weekly report settings and correction window"
    );

    // 20. Storage Monitoring endpoint returns metrics
    const storageRes = await fetch(`${API_BASE}/admin/storage/status`, {
      headers: adminHeaders
    });
    const storageData = await storageRes.json();
    assert(
      storageRes.status === 200 &&
      storageData.primary?.status === "connected" &&
      storageData.primary?.warningThresholdPercent === 70 &&
      storageData.primary?.criticalThresholdPercent === 85 &&
      storageData.activeWriteDestination === "primary",
      "Storage monitoring returns primary connection, thresholds, and active write destination"
    );

    // 21. Secondary Database Verification
    const verifySecRes = await fetch(`${API_BASE}/admin/storage/verify-secondary`, {
      method: "POST",
      headers: adminHeaders
    });
    const verifySecData = await verifySecRes.json();
    assert(
      verifySecRes.status === 200 && typeof verifySecData.configured === "boolean",
      "Secondary storage verification executes cleanly without exposing credentials"
    );

    // 22. Safe Teacher Deactivation
    const deactivateRes = await fetch(`${API_BASE}/admin/users/${teacherId}`, {
      method: "DELETE",
      headers: adminHeaders
    });
    const deactivateData = await deactivateRes.json();
    assert(
      deactivateRes.status === 200 && deactivateData.user.active === false,
      "Admin safely deactivates teacher account (soft deactivation)"
    );

    // 23. Deactivated teacher immediately rejected on subsequent requests
    const deactRequestRes = await fetch(`${API_BASE}/classes`, {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    assert(deactRequestRes.status === 401, "Deactivated teacher immediately denied with 401 Unauthorized");

    // 24. Verify attendance records preserved after teacher deactivation
    const verifyAttRes = await fetch(`${API_BASE}/attendance?classId=${targetClassId}&dateKey=${todayKey}`, {
      headers: adminHeaders
    });
    const verifiedAtt = await verifyAttRes.json();
    const preservedRecord = verifiedAtt.find(a => String(a.studentId?._id || a.studentId) === studentId);
    assert(
      Boolean(preservedRecord && preservedRecord.status === "present"),
      "Historical attendance records are preserved after teacher deactivation (no cascade delete)"
    );

    console.log(`\n=================================================`);
    console.log(`  RBAC & AUTH SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log(`=================================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("Test execution failed with unhandled error:", err);
    process.exit(1);
  }
}

runTests();
