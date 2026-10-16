/**
 * MADRASA AMANAH — STUDENT NATURAL ROLL NUMBER & COMPARISON UTILITY
 * Ensures students and records are always sorted in strict ascending
 * numerical roll order (1, 2, 3, 10, 11, 20) across all views and devices.
 */

/**
 * Natural Roll Number comparison function.
 * Supports pure numbers (1, 2, 3, 10, 20), numeric strings, alphanumeric codes (ADM-01),
 * and gracefully falls back to name.
 */
export function compareRollNumbers(a, b) {
  const rollA = String(a?.admissionNo ?? a?.admissionNumber ?? a ?? "").trim();
  const rollB = String(b?.admissionNo ?? b?.admissionNumber ?? b ?? "").trim();

  // Check if both are pure decimal integers
  const numA = parseInt(rollA, 10);
  const numB = parseInt(rollB, 10);
  const isPureNumA = !isNaN(numA) && String(numA) === rollA;
  const isPureNumB = !isNaN(numB) && String(numB) === rollB;

  if (isPureNumA && isPureNumB) {
    if (numA !== numB) return numA - numB;
  } else if (isPureNumA && !isPureNumB) {
    return -1; // Standard numbers (1..20) precede custom codes
  } else if (!isPureNumA && isPureNumB) {
    return 1;
  } else {
    // Alphanumeric natural comparison
    const cmp = rollA.localeCompare(rollB, undefined, { numeric: true, sensitivity: "base" });
    if (cmp !== 0) return cmp;
  }

  // Secondary tie-breaker by name
  const nameA = String(a?.name || a?.fullName || "").trim();
  const nameB = String(b?.name || b?.fullName || "").trim();
  return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
}

/**
 * Sorts students by class first (if differing) and then by roll number ascending.
 */
export function compareStudentsByClassAndRoll(a, b) {
  const classA = String(a?.classId?.name || a?.class?.name || a?.classId || "").trim();
  const classB = String(b?.classId?.name || b?.class?.name || b?.classId || "").trim();

  if (classA && classB && classA !== classB) {
    return classA.localeCompare(classB, undefined, { sensitivity: "base" });
  }

  return compareRollNumbers(a, b);
}

/**
 * Returns a new sorted array of students by roll number.
 */
export function sortStudentsByRoll(students) {
  if (!Array.isArray(students)) return [];
  return [...students].sort(compareRollNumbers);
}
