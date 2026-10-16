/**
 * MADRASA AMANAH — STUDENT NATURAL ROLL NUMBER & COMPARISON UTILITY (SERVER)
 */

export function compareRollNumbers(a, b) {
  const rollA = String(a?.admissionNo ?? a?.admissionNumber ?? a ?? "").trim();
  const rollB = String(b?.admissionNo ?? b?.admissionNumber ?? b ?? "").trim();

  const numA = parseInt(rollA, 10);
  const numB = parseInt(rollB, 10);
  const isPureNumA = !isNaN(numA) && String(numA) === rollA;
  const isPureNumB = !isNaN(numB) && String(numB) === rollB;

  if (isPureNumA && isPureNumB) {
    if (numA !== numB) return numA - numB;
  } else if (isPureNumA && !isPureNumB) {
    return -1;
  } else if (!isPureNumA && isPureNumB) {
    return 1;
  } else {
    const cmp = rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: "base" });
    if (cmp !== 0) return cmp;
  }

  const nameA = String(a?.name || a?.fullName || "").trim();
  const nameB = String(b?.name || b?.fullName || "").trim();
  return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
}

export function compareStudentsByClassAndRoll(a, b) {
  const classA = String(a?.classId?.name || a?.class?.name || a?.classId || "").trim();
  const classB = String(b?.classId?.name || b?.class?.name || b?.classId || "").trim();

  if (classA && classB && classA !== classB) {
    return classA.localeCompare(classB, undefined, { sensitivity: "base" });
  }

  return compareRollNumbers(a, b);
}

export function sortStudentsByRoll(students) {
  if (!Array.isArray(students)) return [];
  return [...students].sort(compareRollNumbers);
}
