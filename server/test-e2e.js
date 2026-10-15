const API_BASE = 'http://localhost:4000/api';

async function runTests() {
  console.log('--- STARTING MADRASA AMANAH E2E ACCEPTANCE TESTS ---');
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
    // 1. Health check
    const healthRes = await fetch(`${API_BASE}/health`);
    const healthData = await healthRes.json();
    assert(healthRes.status === 200 && (healthData.status === 'healthy' || healthData.status === 'ok'), 'Health endpoint responds with healthy/ok');
    console.log(`   Database: ${healthData.databaseDetails?.provider || healthData.database?.provider || healthData.database} (${healthData.databaseDetails?.state || healthData.database?.state || healthData.database}), uptime: ${healthData.uptime}s`);

    // 2. Authentication: Invalid Login
    const invalidLoginRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'wrongpassword' })
    });
    assert(invalidLoginRes.status === 401, 'Invalid login rejected with 401 Unauthorized');

    // 3. Authentication: Valid Admin Login
    const loginRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'Shaiksameer/3909' })
    });
    const loginData = await loginRes.json();
    assert(loginRes.status === 200 && !!loginData.token, 'Admin login succeeded and returned JWT');
    const token = loginData.token;
    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'x-export-pin': '12@12'
    };

    // 4. Fetch classes
    const classesRes = await fetch(`${API_BASE}/classes`, { headers: authHeaders });
    const classesData = await classesRes.json();
    assert(classesRes.status === 200 && classesData.length > 0, `Classes fetched (${classesData.length} found)`);
    const targetClass = classesData[0];
    const targetClassId = targetClass._id;
    console.log(`   Using class: "${targetClass.name}" (${targetClassId})`);

    // 5. Create a test student (using both alias and canonical field names)
    const testAdmNo = `TEST-${Date.now()}`;
    const createStudentRes = await fetch(`${API_BASE}/students`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        admissionNumber: testAdmNo,
        fullName: 'Muhammad Bilal Test',
        classId: targetClassId,
        gender: 'male',
        guardianName: 'Ibrahim Test',
        guardianPhone: '+91 9876543210'
      })
    });
    const createdStudent = await createStudentRes.json();
    assert(createStudentRes.status === 201, `Student created (HTTP ${createStudentRes.status})`);
    assert(createdStudent.admissionNumber === testAdmNo || createdStudent.admissionNo === testAdmNo, 'Student admission number matches');
    const studentId = createdStudent._id;
    console.log(`   Created student: ${studentId} (${createdStudent.fullName || createdStudent.name})`);

    // 6. Read back student by ID
    const getStudentRes = await fetch(`${API_BASE}/students/${studentId}`, { headers: authHeaders });
    const studentData = await getStudentRes.json();
    assert(getStudentRes.status === 200, `GET /students/:id returned ${getStudentRes.status}`);
    assert(studentData.fullName === 'Muhammad Bilal Test' || studentData.name === 'Muhammad Bilal Test', 'Read back test student successfully');

    // 7. Update student profile (PUT with alias fields)
    const updateRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        fullName: 'Muhammad Bilal Test Updated',
        referencePhotoUrl: 'https://res.cloudinary.com/lfvphfvl/image/upload/v1/test_student.jpg'
      })
    });
    const updatedData = await updateRes.json();
    assert(updateRes.status === 200, `Student update returned ${updateRes.status}`);
    assert(
      (updatedData.fullName === 'Muhammad Bilal Test Updated' || updatedData.name === 'Muhammad Bilal Test Updated'),
      'Student name updated'
    );
    assert(
      (updatedData.referencePhotoUrl || updatedData.photoUrl || '').includes('cloudinary'),
      'Cloudinary reference preserved'
    );

    // 8. Submit attendance (accepts date/session aliases)
    const testDate = '2026-10-13';
    const testSession = 'morning';
    const records = [
      { studentId: studentId, status: 'present', note: 'First session' }
    ];

    const attRes1 = await fetch(`${API_BASE}/attendance/bulk`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        classId: targetClassId,
        date: testDate,
        session: testSession,
        records: records
      })
    });
    const attData1 = await attRes1.json();
    assert(attRes1.status === 200, `Attendance bulk save returned ${attRes1.status}`);
    assert(attData1.confirmed === true, 'Attendance has authoritative confirmed flag');
    assert(attData1.stats?.present === 1 || attData1.statusCounts?.present === 1, 'Attendance stats reflect 1 present');
    assert(!!attData1.persistedAt || !!attData1.confirmedAt, `Server returned timestamp: ${attData1.persistedAt || attData1.confirmedAt}`);
    assert(attData1.database === 'MongoDB Atlas', `Database reported as: ${attData1.database}`);

    // 9. Repeated save / duplicate submission test
    const attRes2 = await fetch(`${API_BASE}/attendance/bulk`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        classId: targetClassId,
        dateKey: testDate,
        sessionKey: testSession,
        records: records
      })
    });
    assert(attRes2.status === 200, 'Repeated attendance save returns HTTP 200');

    // Verify duplicate records were not created
    const verifyAttRes = await fetch(`${API_BASE}/attendance?classId=${targetClassId}&dateKey=${testDate}&sessionKey=${testSession}`, {
      headers: authHeaders
    });
    const verifyAttData = await verifyAttRes.json();
    const matches = verifyAttData.filter(r => {
      const sid = r.studentId?._id || r.studentId;
      return sid === studentId;
    });
    assert(matches.length === 1, `Idempotency verified: exactly ${matches.length} attendance record(s) for student (expected 1)`);

    // 10. Sync Center mutation test (batch mutations[] format)
    const mutationId = `mut-${Date.now()}`;
    const syncRes = await fetch(`${API_BASE}/sync/attendance`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        mutations: [
          {
            mutationId: mutationId,
            classId: targetClassId,
            date: testDate,
            session: testSession,
            records: [{ studentId: studentId, status: 'late', note: 'Arrived after prayer' }]
          }
        ]
      })
    });
    const syncData = await syncRes.json();
    assert(syncRes.status === 200, `Sync endpoint returned ${syncRes.status}`);
    assert(syncData.results?.[0]?.status === 'applied', `Sync mutation status: ${syncData.results?.[0]?.status}`);

    // Resend exact same mutation (idempotency test)
    const syncResRetry = await fetch(`${API_BASE}/sync/attendance`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        mutations: [
          {
            mutationId: mutationId,
            classId: targetClassId,
            date: testDate,
            session: testSession,
            records: [{ studentId: studentId, status: 'late', note: 'Arrived after prayer' }]
          }
        ]
      })
    });
    const syncRetryData = await syncResRetry.json();
    assert(syncResRetry.status === 200, 'Duplicate sync returns 200');
    assert(
      syncRetryData.results?.[0]?.status === 'duplicate' || syncRetryData.results?.[0]?.status === 'applied',
      `Duplicate sync mutation handled safely (status: ${syncRetryData.results?.[0]?.status})`
    );

    // 11. Report Downloads Verification (CSV, XLSX, PDF)
    console.log('--- Testing Report Downloads (Filenames & Content) ---');
    const formats = ['csv', 'xlsx', 'pdf'];
    for (const fmt of formats) {
      const exportRes = await fetch(`${API_BASE}/reports/export?classId=${targetClassId}&startDate=${testDate}&endDate=${testDate}&format=${fmt}`, {
        headers: authHeaders
      });

      assert(exportRes.status === 200, `${fmt.toUpperCase()} export responded with 200 OK`);
      const disposition = exportRes.headers.get('content-disposition') || '';
      assert(disposition.includes('filename='), `${fmt.toUpperCase()} Content-Disposition with filename: ${disposition.slice(0, 80)}`);
      assert(
        !disposition.includes('undefined') && !/filename="[0-9a-fA-F-]{36}\.[a-z]+"/.test(disposition),
        `${fmt.toUpperCase()} filename is descriptive, not a UUID`
      );

      const buffer = await exportRes.arrayBuffer();
      assert(buffer.byteLength > 50, `${fmt.toUpperCase()} byte length valid (${buffer.byteLength} bytes)`);

      const contentType = exportRes.headers.get('content-type') || '';
      if (fmt === 'csv') {
        assert(contentType.includes('text/csv'), `CSV Content-Type: ${contentType}`);
      } else if (fmt === 'xlsx') {
        assert(contentType.includes('spreadsheetml'), `XLSX Content-Type: ${contentType}`);
      } else if (fmt === 'pdf') {
        assert(contentType.includes('application/pdf'), `PDF Content-Type: ${contentType}`);
      }
    }

    // 12. Weekly Excel Report & Email Automation Tests
    console.log('--- Testing Weekly Excel Reports & Email Automation ---');
    const weeklyExcelRes = await fetch(`${API_BASE}/reports/weekly-excel`, {
      headers: authHeaders
    });
    assert(weeklyExcelRes.status === 200, 'Weekly Excel report responded with 200 OK');
    const weeklyDisp = weeklyExcelRes.headers.get('content-disposition') || '';
    assert(weeklyDisp.includes('Madrasa-Amanah-Weekly-Attendance'), `Weekly Excel filename matches pattern: ${weeklyDisp.slice(0, 80)}`);
    const weeklyBuf = await weeklyExcelRes.arrayBuffer();
    assert(weeklyBuf.byteLength > 1000, `Weekly Excel workbook byte length valid (${weeklyBuf.byteLength} bytes)`);

    // 13. Weekly Email Trigger Endpoint Test
    const emailTriggerRes = await fetch(`${API_BASE}/reports/send-weekly-email`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ recipientEmail: '2300030621cseh1@gmail.com' })
    });
    const emailTriggerData = await emailTriggerRes.json();
    assert(emailTriggerRes.status === 200, 'Weekly email trigger responded with 200 OK');
    assert(emailTriggerData.recipient === '2300030621cseh1@gmail.com', `Target recipient matches: ${emailTriggerData.recipient}`);
    assert(emailTriggerData.bytes > 1000, `Generated email attachment size: ${emailTriggerData.bytes} bytes`);
    assert(typeof emailTriggerData.summary?.rate === 'string', `Report attendance rate computed: ${emailTriggerData.summary?.rate}%`);

    // 14. Email Status Endpoint Test
    const emailStatusRes = await fetch(`${API_BASE}/reports/email-status`, { headers: authHeaders });
    const emailStatusData = await emailStatusRes.json();
    assert(emailStatusRes.status === 200, 'Email status endpoint returned 200 OK');
    assert(Boolean(emailStatusData.recipientEmail && emailStatusData.recipientEmail.includes('@')), `Report recipient email configured properly (${emailStatusData.recipientEmail})`);

    // 15. Student Roster Export Tests (CSV & XLSX)
    console.log('--- Testing Student Roster Exports ---');
    const studentCsvRes = await fetch(`${API_BASE}/students/export?format=csv`, { headers: authHeaders });
    assert(studentCsvRes.status === 200, 'Student roster CSV responded with 200 OK');
    const studentCsvDisp = studentCsvRes.headers.get('content-disposition') || '';
    assert(studentCsvDisp.includes('Madrasa-Amanah-Students'), `Student CSV filename is descriptive: ${studentCsvDisp.slice(0, 80)}`);
    const studentCsvBuf = await studentCsvRes.arrayBuffer();
    assert(studentCsvBuf.byteLength > 50, `Student CSV byte length valid (${studentCsvBuf.byteLength} bytes)`);

    const studentXlsxRes = await fetch(`${API_BASE}/students/export?format=xlsx`, { headers: authHeaders });
    assert(studentXlsxRes.status === 200, 'Student roster XLSX responded with 200 OK');
    const studentXlsxDisp = studentXlsxRes.headers.get('content-disposition') || '';
    assert(studentXlsxDisp.includes('Madrasa-Amanah-Students'), `Student XLSX filename is descriptive: ${studentXlsxDisp.slice(0, 80)}`);
    const studentXlsxBuf = await studentXlsxRes.arrayBuffer();
    assert(studentXlsxBuf.byteLength > 1000, `Student XLSX byte length valid (${studentXlsxBuf.byteLength} bytes)`);

    // 16. Six-Month Retention & Backup Tests
    console.log('--- Testing Six-Month Retention & Backups ---');
    const retentionRes = await fetch(`${API_BASE}/admin/retention/status`, { headers: authHeaders });
    const retentionData = await retentionRes.json();
    assert(retentionRes.status === 200, 'Retention status endpoint returned 200 OK');
    assert(retentionData.retentionDays === 180, 'Retention policy is configured to 180 days (6 months)');
    assert(typeof retentionData.totalRecords === 'number', `Total records tracked: ${retentionData.totalRecords}`);

    const retentionArchiveRes = await fetch(`${API_BASE}/admin/retention/archive`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ confirmPurge: false })
    });
    const retentionArchiveData = await retentionArchiveRes.json();
    assert(retentionArchiveRes.status === 200, 'Retention archive dry-run returned 200 OK');

    const backupRes = await fetch(`${API_BASE}/admin/backup/export`, { headers: authHeaders });
    assert(backupRes.status === 200, 'System backup responded with 200 OK');
    const backupDisp = backupRes.headers.get('content-disposition') || '';
    assert(backupDisp.includes('Madrasa-Amanah-Backup'), `Backup filename is descriptive: ${backupDisp.slice(0, 80)}`);
    const backupJson = await backupRes.json();
    assert(backupJson.metadata?.system?.includes('Madrasa Amanah'), 'Backup package contains valid system metadata');
    assert(Array.isArray(backupJson.classes) && Array.isArray(backupJson.students), 'Backup package contains classes and students arrays');


    // 11. Testing Admin Diagnostics & Data Integrity
    const diagRes = await fetch(`${API_BASE}/admin/diagnostics`, { headers: authHeaders });
    assert(diagRes.status === 200, 'Admin diagnostics responded with 200 OK');
    const diagData = await diagRes.json();
    assert(diagData.status === 'connected', `Database status: ${diagData.status} (${diagData.database?.provider})`);
    assert(typeof diagData.counts?.activeStudents === 'number', `Active students reported: ${diagData.counts?.activeStudents}`);

    // 12. Testing Student Lifecycle: Archival & Restoration
    const archiveRes = await fetch(`${API_BASE}/students/${studentId}/archive`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ reason: 'Graduated / Inactive test' })
    });
    assert(archiveRes.status === 200, 'Student archive returned 200 OK');
    const archiveData = await archiveRes.json();
    assert(archiveData.student?.active === false, 'Student marked active: false on archive');

    const restoreRes = await fetch(`${API_BASE}/students/${studentId}/restore`, {
      method: 'POST',
      headers: authHeaders
    });
    assert(restoreRes.status === 200, 'Student restore returned 200 OK');
    const restoreData = await restoreRes.json();
    assert(restoreData.student?.active === true, 'Student restored active: true');

    // 13. Permanent Cleanup with Admission Number Confirmation
    const deleteRes = await fetch(`${API_BASE}/students/${studentId}`, {
      method: 'DELETE',
      headers: authHeaders,
      body: JSON.stringify({ confirmAdmissionNo: testAdmNo })
    });
    assert(deleteRes.status === 200, `Cleaned up test student ${testAdmNo}`);

  } catch (err) {
    console.error('❌ UNHANDLED ERROR IN TESTS:', err);
    failures++;
  }

  console.log('\n--- E2E TEST RESULTS ---');
  if (failures === 0) {
    console.log('🎉 ALL INTEGRATION TESTS PASSED PERFECTLY!');
    process.exit(0);
  } else {
    console.error(`💥 ${failures} TEST(S) FAILED!`);
    process.exit(1);
  }
}

runTests();
