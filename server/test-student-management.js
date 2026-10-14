import 'dotenv/config';

const API_BASE = 'http://localhost:4000/api';

async function runTests() {
  console.log('--- TESTING COMPLETE ADMIN STUDENT MANAGEMENT ---');
  let failures = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`❌ FAIL: ${message}`);
      failures++;
    } else {
      console.log(`✅ PASS: ${message}`);
    }
  }

  try {
    // 1. Sign in as Admin
    const adminLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'Shaiksameer/3909' })
    });
    const adminLoginData = await adminLoginRes.json();
    assert(adminLoginRes.status === 200 && !!adminLoginData.token, 'Admin login succeeded');
    const adminToken = adminLoginData.token;
    const adminHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` };

    // 2. Fetch classes
    const classesRes = await fetch(`${API_BASE}/classes`, { headers: adminHeaders });
    const classes = await classesRes.json();
    assert(classesRes.status === 200 && classes.length >= 1, `Classes fetched (${classes.length} classes available)`);
    const c1 = classes[0];
    const c2 = classes[1] || classes[0];

    // 3. Create a test student with full details
    const testAdm = `ADM-TEST-${Date.now().toString().slice(-5)}`;
    const studentPayload = {
      admissionNo: testAdm,
      name: 'Zaid Al-Mansoor',
      gender: 'Male',
      dob: '2014-05-12',
      guardianName: 'Tariq Al-Mansoor',
      guardianPhone: '9876501234',
      address: 'House 42, Green Valley, Hyderabad',
      enrollmentDate: '2026-01-10',
      classId: c1._id,
      consentGiven: true
    };

    const createRes = await fetch(`${API_BASE}/students`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(studentPayload)
    });
    const createdStudent = await createRes.json();
    assert(createRes.status === 201, `Student enrolled successfully (HTTP ${createRes.status})`);
    assert(createdStudent.admissionNo === testAdm, 'Admission number correctly set');
    assert(createdStudent.dob === '2014-05-12', 'Date of birth correctly stored');
    assert(createdStudent.address.includes('Green Valley'), 'Address correctly stored');
    assert(createdStudent.gender === 'Male', 'Gender correctly stored');
    const studentId = createdStudent._id || createdStudent.id;

    // 4. Test duplicate admission number rejection
    const dupRes = await fetch(`${API_BASE}/students`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        admissionNo: testAdm,
        name: 'Another Student',
        classId: c1._id
      })
    });
    assert(dupRes.status === 400, 'Duplicate admission number rejected with HTTP 400');

    // 5. Query students list with filters
    const activeRes = await fetch(`${API_BASE}/students?status=active&classId=${c1._id}`, { headers: adminHeaders });
    const activeList = await activeRes.json();
    assert(activeRes.status === 200 && activeList.some(s => s.admissionNo === testAdm), 'New student appears in active list');

    // Search filter test
    const searchRes = await fetch(`${API_BASE}/students?search=${encodeURIComponent(testAdm)}`, { headers: adminHeaders });
    const searchList = await searchRes.json();
    assert(searchRes.status === 200 && searchList.length === 1 && searchList[0].admissionNo === testAdm, 'Search by admission number finds exact student');

    // 6. Update student details without erasing unprovided optional fields
    const patchRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        guardianPhone: '9876509999'
      })
    });
    const patchedStudent = await patchRes.json();
    assert(patchRes.status === 200, 'Student updated successfully via PATCH');
    assert(patchedStudent.guardianPhone === '9876509999', 'Updated phone number reflected');
    assert(patchedStudent.dob === '2014-05-12', 'Unmodified DOB preserved (not erased)');
    assert(patchedStudent.address.includes('Green Valley'), 'Unmodified address preserved (not erased)');

    // 7. Update admission number by Admin (allowed)
    const newAdm = `${testAdm}-UPD`;
    const admUpdateRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ admissionNo: newAdm })
    });
    const admUpdated = await admUpdateRes.json();
    assert(admUpdateRes.status === 200 && admUpdated.admissionNo === newAdm, 'Admin updated admission number successfully');

    // 8. Class Transfer
    if (classes.length > 1) {
      const transferRes = await fetch(`${API_BASE}/students/${studentId}`, {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({ classId: c2._id })
      });
      const transferred = await transferRes.json();
      assert(transferRes.status === 200 && String(transferred.classId?._id || transferred.classId) === String(c2._id), 'Student transferred to class 2 successfully');
    }

    // 9. Attendance record and attendance history test
    const attDate = '2026-10-14';
    await fetch(`${API_BASE}/attendance/bulk`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        classId: classes.length > 1 ? c2._id : c1._id,
        dateKey: attDate,
        sessionKey: 'morning',
        records: [{ studentId, status: 'present', note: 'Attendance verified' }]
      })
    });

    const historyRes = await fetch(`${API_BASE}/students/${studentId}/attendance`, { headers: adminHeaders });
    const historyData = await historyRes.json();
    assert(historyRes.status === 200, 'GET /students/:id/attendance returned HTTP 200');
    assert(historyData.stats?.totalSessions >= 1, `Attendance stats computed (${historyData.stats?.totalSessions} sessions)`);
    assert(historyData.stats?.present >= 1, 'Present count recorded in stats');
    assert(historyData.stats?.rate === 100, 'Attendance rate computed accurately (100%)');
    assert(historyData.records?.length >= 1, 'Attendance ledger records list returned');

    // 10. Student Archival (Soft Delete)
    const archiveRes = await fetch(`${API_BASE}/students/${studentId}/archive`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ reason: 'Student moved' })
    });
    assert(archiveRes.status === 200, 'POST /students/:id/archive returned 200');

    // Check archived filter
    const archivedQueryRes = await fetch(`${API_BASE}/students?status=archived`, { headers: adminHeaders });
    const archivedList = await archivedQueryRes.json();
    assert(archivedList.some(s => s._id === studentId || s.id === studentId), 'Archived student appears in status=archived list');

    // Ensure student does NOT appear in active list
    const activeQueryAfterArchive = await fetch(`${API_BASE}/students?status=active`, { headers: adminHeaders });
    const activeListAfter = await activeQueryAfterArchive.json();
    assert(!activeListAfter.some(s => s._id === studentId || s.id === studentId), 'Archived student excluded from active list');

    // 11. Student Restore
    const restoreRes = await fetch(`${API_BASE}/students/${studentId}/restore`, {
      method: 'POST',
      headers: adminHeaders
    });
    assert(restoreRes.status === 200, 'POST /students/:id/restore returned 200');

    const activeQueryAfterRestore = await fetch(`${API_BASE}/students?status=active`, { headers: adminHeaders });
    const activeListRestored = await activeQueryAfterRestore.json();
    assert(activeListRestored.some(s => s._id === studentId || s.id === studentId), 'Restored student appears in active list again');

    // 12. Student Export
    const exportCsvRes = await fetch(`${API_BASE}/students/export?format=csv`, { headers: adminHeaders });
    assert(exportCsvRes.status === 200, 'GET /students/export?format=csv returned 200');
    const csvText = await exportCsvRes.text();
    assert(csvText.includes('Admission No') && csvText.includes(newAdm), 'CSV export contains headers and student record');

    const exportXlsxRes = await fetch(`${API_BASE}/students/export?format=xlsx`, { headers: adminHeaders });
    assert(exportXlsxRes.status === 200, 'GET /students/export?format=xlsx returned 200');

    // 13. Test Teacher Permissions Isolation
    // Create a temporary teacher
    const teacherEmail = `teacher_${Date.now()}@example.com`;
    const createTeacherRes = await fetch(`${API_BASE}/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Ustadh Test',
        email: teacherEmail,
        password: 'TeacherPassword123!',
        role: 'teacher',
        assignedClasses: [c1._id]
      })
    });
    const createdTeacher = await createTeacherRes.json();
    assert(createTeacherRes.status === 201, 'Teacher account created for permission testing');

    // Sign in as Teacher
    const teacherLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: teacherEmail, password: 'TeacherPassword123!' })
    });
    const teacherLogin = await teacherLoginRes.json();
    const teacherHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${teacherLogin.token}` };

    // Teacher cannot delete student
    const teacherDeleteRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: 'DELETE',
      headers: teacherHeaders
    });
    assert(teacherDeleteRes.status === 403, 'Teacher deletion rejected with HTTP 403 Forbidden');

    // Teacher cannot archive student
    const teacherArchiveRes = await fetch(`${API_BASE}/students/${studentId}/archive`, {
      method: 'POST',
      headers: teacherHeaders
    });
    assert(teacherArchiveRes.status === 403, 'Teacher archival rejected with HTTP 403 Forbidden');

    // Teacher cannot modify admin accounts
    const teacherModAdminRes = await fetch(`${API_BASE}/admin/users/${createdTeacher.id}`, {
      method: 'PATCH',
      headers: teacherHeaders,
      body: JSON.stringify({ role: 'admin' })
    });
    assert(teacherModAdminRes.status === 403, 'Teacher modifying admin users rejected with HTTP 403');

    // 14. Permanent Delete by Admin (Cleanup)
    const delRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: 'DELETE',
      headers: adminHeaders,
      body: JSON.stringify({ confirmAdmissionNo: newAdm })
    });
    assert(delRes.status === 200, 'Student permanently removed by Admin with confirmation number');

    console.log(`\n========================================`);
    if (failures === 0) {
      console.log('🎉 ALL STUDENT MANAGEMENT TESTS PASSED (0 failures)!');
    } else {
      console.error(`💥 TEST SUITE FINISHED WITH ${failures} FAILURE(S).`);
    }
    console.log(`========================================\n`);

  } catch (err) {
    console.error('Fatal error during test run:', err);
  }
}

runTests();
