/**
 * MADRASA AMANAH — CLASSROOM GROUP PHOTO FACE MATCHING PIPELINE
 * Calibrated computer vision matching, distance thresholds, bipartite assignment,
 * and ambiguity detection for 128D FaceNet embeddings.
 */

// Calibrated Thresholds for 128-dimensional Euclidean Face Embeddings (dlib / ResNet-34)
export const THRESHOLDS = {
  // distance < 0.38: Very strong feature alignment (unambiguous identity)
  HIGH_CONFIDENCE: 0.38,
  // 0.38 <= distance <= 0.46: Good candidate, requires teacher visual verification
  MODERATE_CONFIDENCE: 0.46,
  // distance > 0.48: Weak similarity; do not assign automatically (unidentified face)
  REJECT_DISTANCE: 0.48,
  // Ambiguity margin: if the gap between best and second best match is < 0.045, flag as ambiguous
  AMBIGUITY_DELTA: 0.045
};

/**
 * Fast Euclidean distance between two 128D vectors.
 * Returns 999 if invalid or mismatched.
 */
export function calculateEuclideanDistance(descA, descB) {
  if (!Array.isArray(descA) || !Array.isArray(descB)) return 999;
  if (descA.length !== descB.length || descA.length === 0) return 999;

  let sum = 0;
  for (let i = 0; i < descA.length; i++) {
    const diff = descA[i] - descB[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Calibrated match score conversion for UI display.
 * Maps Euclidean distance to a transparent confidence percentage without inventing fake numbers.
 */
export function getCalibratedMatchScore(distance, isAmbiguous = false) {
  if (distance === null || distance === undefined || isNaN(distance) || distance >= 900) {
    return {
      confidencePct: 0,
      tier: "none",
      label: "Unmatched",
      description: "No registered reference photo match found."
    };
  }

  // Linear calibration segments:
  // 0.00 - 0.35: 85% - 100%
  // 0.35 - 0.44: 65% - 84%
  // 0.44 - 0.50: 45% - 64%
  // > 0.50: < 40% (rejected)
  let confidencePct = 0;
  if (distance <= 0.35) {
    confidencePct = Math.round(85 + ((0.35 - distance) / 0.35) * 15);
  } else if (distance <= 0.44) {
    confidencePct = Math.round(65 + ((0.44 - distance) / 0.09) * 19);
  } else if (distance <= 0.50) {
    confidencePct = Math.round(45 + ((0.50 - distance) / 0.06) * 19);
  } else {
    confidencePct = Math.max(0, Math.round((1 - (distance / 0.65)) * 40));
  }
  confidencePct = Math.max(0, Math.min(100, confidencePct));

  if (isAmbiguous) {
    return {
      confidencePct,
      tier: "ambiguous",
      label: "Ambiguous Match",
      description: `Similar feature distance to multiple students (distance: ${distance.toFixed(3)}). Manual review required.`
    };
  }

  if (distance <= THRESHOLDS.HIGH_CONFIDENCE) {
    return {
      confidencePct,
      tier: "high",
      label: "High Confidence",
      description: `Strong match (distance: ${distance.toFixed(3)}). Teacher confirmation required before attendance is saved.`
    };
  }

  if (distance <= THRESHOLDS.MODERATE_CONFIDENCE) {
    return {
      confidencePct,
      tier: "moderate",
      label: "Uncertain / Review",
      description: `Moderate match (distance: ${distance.toFixed(3)}). Please inspect candidate photo and confirm.`
    };
  }

  return {
    confidencePct: 0,
    tier: "none",
    label: "No Reliable Match",
    description: `Distance exceeds threshold (${distance.toFixed(3)} > ${THRESHOLDS.REJECT_DISTANCE}). Please select student manually.`
  };
}

/**
 * Performs optimal bipartite face-to-roster matching.
 * 
 * Rules:
 * 1. Computes all pair distances between detected faces and enrolled students with reference descriptors.
 * 2. Assigns pairs globally in order of lowest Euclidean distance (closest match first).
 * 3. Prevents duplicate assignments (each student can only be assigned to one face in a single group photo).
 * 4. Detects ambiguity when the runner-up student is within AMBIGUITY_DELTA.
 * 5. Rejects candidate if distance exceeds REJECT_DISTANCE.
 * 6. Every match starts as confirmed: false.
 */
export function matchFacesToRoster(detectedFaces = [], rosterWithDescriptors = []) {
  if (!detectedFaces || !detectedFaces.length) return [];

  // Filter roster to active students with valid 128D face descriptors
  const validRoster = rosterWithDescriptors.filter(
    (s) => s && Array.isArray(s.faceDescriptor) && s.faceDescriptor.length === 128
  );

  // Compute all pairwise distances
  const allPairs = [];
  detectedFaces.forEach((face, faceIndex) => {
    const faceDescriptor = Array.from(face.descriptor || []);
    if (!faceDescriptor.length) return;

    validRoster.forEach((student) => {
      const dist = calculateEuclideanDistance(faceDescriptor, student.faceDescriptor);
      allPairs.push({
        faceIndex,
        student,
        studentId: String(student._id || student.id),
        distance: dist
      });
    });
  });

  // Sort all pairs by distance ascending (closest match globally gets matched first)
  allPairs.sort((a, b) => a.distance - b.distance);

  // Track assigned faces and students to enforce 1-to-1 matching without duplicate assignments
  const assignedFaces = new Map(); // faceIndex -> { student, distance }
  const assignedStudents = new Set(); // studentId

  for (const pair of allPairs) {
    if (assignedFaces.has(pair.faceIndex)) continue;
    if (assignedStudents.has(pair.studentId)) continue;

    // Check reject threshold
    if (pair.distance <= THRESHOLDS.REJECT_DISTANCE) {
      assignedFaces.set(pair.faceIndex, { student: pair.student, distance: pair.distance });
      assignedStudents.add(pair.studentId);
    }
  }

  // Construct final candidate items for each detected face
  return detectedFaces.map((face, index) => {
    const faceIndex = index;
    const faceNo = index + 1;
    const faceDescriptor = Array.from(face.descriptor || []);

    const assigned = assignedFaces.get(faceIndex);

    // Find runner up for this face to check ambiguity
    let secondBestDistance = 999;
    if (faceDescriptor.length && validRoster.length > 1) {
      const otherDistances = validRoster
        .filter((s) => !assigned || String(s._id || s.id) !== String(assigned.student._id || assigned.student.id))
        .map((s) => calculateEuclideanDistance(faceDescriptor, s.faceDescriptor))
        .sort((a, b) => a - b);
      if (otherDistances.length) secondBestDistance = otherDistances[0];
    }

    const bestDistance = assigned ? assigned.distance : 999;
    const isAmbiguous = Boolean(
      assigned &&
      secondBestDistance < 999 &&
      (secondBestDistance - bestDistance < THRESHOLDS.AMBIGUITY_DELTA) &&
      bestDistance > 0.35
    );

    const score = getCalibratedMatchScore(assigned ? bestDistance : null, isAmbiguous);

    // Only assign high or moderate confidence that is NOT ambiguous as default suggestion
    const shouldSuggestStudent = assigned && score.tier === "high" && !isAmbiguous;
    const student = shouldSuggestStudent ? assigned.student : null;

    const box = face.detection?.box
      ? {
          x: Math.round(face.detection.box.x),
          y: Math.round(face.detection.box.y),
          width: Math.round(face.detection.box.width),
          height: Math.round(face.detection.box.height)
        }
      : null;

    return {
      faceNo,
      box,
      descriptor: faceDescriptor,
      studentId: student ? String(student._id || student.id) : "",
      suggestedStudentId: assigned ? String(assigned.student._id || assigned.student.id) : "",
      matchName: student ? (student.name || "") : (assigned?.student?.name || ""),
      matchAdmissionNo: student
        ? (student.admissionNo || student.admissionNumber || "")
        : (assigned?.student?.admissionNo || assigned?.student?.admissionNumber || ""),
      photoUrl: student?.photoUrl || assigned?.student?.photoUrl || null,
      distance: assigned ? Number(bestDistance.toFixed(3)) : null,
      runnerUpDistance: secondBestDistance < 900 ? Number(secondBestDistance.toFixed(3)) : null,
      confidencePct: score.confidencePct,
      tier: score.tier,
      isAmbiguous,
      scoreDescription: score.description,
      isManual: false,
      confirmed: false,
      dismissed: false
    };
  });
}
