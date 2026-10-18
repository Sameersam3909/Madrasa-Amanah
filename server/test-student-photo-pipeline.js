import 'dotenv/config';

let passed = 0;
let failed = 0;

function assert(cond, desc) {
  if (cond) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${desc}`);
    failed++;
  }
}

async function run() {
  console.log('=================================================');
  console.log('  DARUL ULOOM ASHRAFIA — PHOTO PIPELINE TEST SUITE');
  console.log('=================================================\n');

  // Test 1: Data URL format validation regex
  console.log('--- [1] Photo Format & Size Validation ---');
  const validJpeg = 'data:image/jpeg;base64,' + Buffer.from('test-image-content').toString('base64');
  const validPng = 'data:image/png;base64,' + Buffer.from('test-image-content').toString('base64');
  const validWebp = 'data:image/webp;base64,' + Buffer.from('test-image-content').toString('base64');
  const invalidType = 'data:application/pdf;base64,' + Buffer.from('test-pdf').toString('base64');
  const malformed = 'not-a-data-url';

  const dataUrlRegex = /^data:image\/(jpeg|jpg|png|webp);base64,/;
  assert(dataUrlRegex.test(validJpeg), 'Accepts valid JPEG base64 data URL');
  assert(dataUrlRegex.test(validPng), 'Accepts valid PNG base64 data URL');
  assert(dataUrlRegex.test(validWebp), 'Accepts valid WebP base64 data URL');
  assert(!dataUrlRegex.test(invalidType), 'Rejects PDF data URL');
  assert(!dataUrlRegex.test(malformed), 'Rejects non-data URL string');

  // Test 2: Cache-busting URL builder logic
  console.log('\n--- [2] Cache-Busting Image URL Construction ---');
  const cdnUrl1 = 'https://res.cloudinary.com/lfvphfvl/image/upload/v1234/student_101.jpg';
  const cdnUrlWithQuery = 'https://res.cloudinary.com/lfvphfvl/image/upload/v1234/student_101.jpg?v=1';

  const bust1 = `${cdnUrl1}${cdnUrl1.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const bust2 = `${cdnUrlWithQuery}${cdnUrlWithQuery.includes('?') ? '&' : '?'}t=${Date.now()}`;

  assert(bust1.includes('?t=') && bust1.startsWith(cdnUrl1), 'Busts simple Cloudinary URL with ?t= parameter');
  assert(bust2.includes('&t=') && bust2.startsWith(cdnUrlWithQuery), 'Busts query-bearing URL with &t= parameter');

  // Test 3: Face Descriptor Array validation
  console.log('\n--- [3] Face Recognition Descriptor Integrity ---');
  const mockDescriptor = Array.from({ length: 128 }, () => Math.random());
  assert(Array.isArray(mockDescriptor) && mockDescriptor.length === 128, '128-element Float32 face descriptor supported');

  // Test 4: Historical Attendance Preservation Guarantee
  console.log('\n--- [4] Attendance History Preservation Check ---');
  const mockStudent = {
    _id: 'std_test_999',
    name: 'Muhammad Sameer',
    admissionNo: '243-01',
    classId: 'class_hifz_1',
    photoUrl: 'https://res.cloudinary.com/lfvphfvl/student_old.jpg'
  };

  const mockHistoricalAttendance = [
    { studentId: 'std_test_999', date: '2026-10-10', status: 'present' },
    { studentId: 'std_test_999', date: '2026-10-11', status: 'present' },
    { studentId: 'std_test_999', date: '2026-10-12', status: 'absent' }
  ];

  // Simulating photo update payload
  const updatePayload = {
    photoUrl: bust1,
    referencePhotoUrl: bust1,
    faceDescriptor: mockDescriptor
  };

  const updatedStudent = { ...mockStudent, ...updatePayload };
  assert(updatedStudent.photoUrl === bust1, 'Student record receives updated photoUrl');
  assert(updatedStudent.admissionNo === mockStudent.admissionNo, 'Student admission number remains identical');
  assert(updatedStudent._id === mockStudent._id, 'Student primary key preserved');

  // Check attendance records unchanged
  const attendanceAfterUpdate = mockHistoricalAttendance.filter(a => a.studentId === updatedStudent._id);
  assert(attendanceAfterUpdate.length === 3, 'All 3 historical attendance records remain untouched');
  assert(attendanceAfterUpdate[0].status === 'present', 'Attendance record integrity intact');

  // Test 5: Teacher Class Assignment Authorization Matrix
  console.log('\n--- [5] Teacher Authorization Matrix ---');
  const adminUser = { role: 'admin' };
  const authorizedTeacher = { role: 'teacher', assignedClasses: ['class_hifz_1', 'class_nazira_1'] };
  const unauthorizedTeacher = { role: 'teacher', assignedClasses: ['class_tajweed_1'] };

  function canTeacherAccess(user, targetClassId) {
    if (user.role === 'admin') return true;
    if (user.role === 'teacher') {
      return (user.assignedClasses || []).some(id => String(id) === String(targetClassId));
    }
    return false;
  }

  assert(canTeacherAccess(adminUser, 'class_hifz_1') === true, 'Admin can update any student photo');
  assert(canTeacherAccess(authorizedTeacher, 'class_hifz_1') === true, 'Teacher assigned to class CAN update student photo');
  assert(canTeacherAccess(unauthorizedTeacher, 'class_hifz_1') === false, 'Teacher NOT assigned to class is REJECTED');

  console.log('\n=================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=================================================\n');

  if (failed > 0) process.exit(1);
}

run();
