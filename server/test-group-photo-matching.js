import assert from "node:assert";
import {
  calculateEuclideanDistance,
  getCalibratedMatchScore,
  matchFacesToRoster,
  THRESHOLDS
} from "../client/src/utils/faceMatching.js";

console.log("=================================================");
console.log("  MADRASA AMANAH — GROUP PHOTO FACE MATCHING TEST");
console.log("=================================================\n");

// Test 1: Distance calculation
const vecA = new Array(128).fill(0.1);
const vecB = new Array(128).fill(0.1);
const distZero = calculateEuclideanDistance(vecA, vecB);
assert.strictEqual(distZero, 0, "Identical vectors must have 0 distance");

const vecC = new Array(128).fill(0.2);
const distPos = calculateEuclideanDistance(vecA, vecC);
assert(distPos > 0, "Different vectors must have positive distance");
console.log("✅ PASS: Euclidean distance calculation is accurate");

// Test 2: Threshold calibrations
assert.strictEqual(THRESHOLDS.HIGH_CONFIDENCE, 0.38);
assert.strictEqual(THRESHOLDS.MODERATE_CONFIDENCE, 0.46);
assert.strictEqual(THRESHOLDS.REJECT_DISTANCE, 0.48);
assert.strictEqual(THRESHOLDS.AMBIGUITY_DELTA, 0.045);
console.log("✅ PASS: Calibrated thresholds configured as specified (0.38, 0.46, 0.48, 0.045)");

// Test 3: Score and tier categorization
const scoreHigh = getCalibratedMatchScore(0.30, false);
assert.strictEqual(scoreHigh.tier, "high");
assert(scoreHigh.confidencePct >= 85);

const scoreAmbiguous = getCalibratedMatchScore(0.40, true);
assert.strictEqual(scoreAmbiguous.tier, "ambiguous");
assert.strictEqual(scoreAmbiguous.label, "Ambiguous Match");

const scoreReject = getCalibratedMatchScore(0.55, false);
assert.strictEqual(scoreReject.tier, "none");
assert.strictEqual(scoreReject.confidencePct, 0);
console.log("✅ PASS: Score classification correctly distinguishes high, ambiguous, and rejected matches");

// Test 4: Bipartite matching strictly prevents duplicate student assignments across faces
const dummyStudent1 = {
  _id: "s1",
  name: "Zaid Khan",
  admissionNo: "101",
  faceDescriptor: new Array(128).fill(0.1)
};
const dummyStudent2 = {
  _id: "s2",
  name: "Umar Farooq",
  admissionNo: "102",
  faceDescriptor: new Array(128).fill(0.5)
};

// Two faces both close to Student 1, but Face 1 is closer (0.05 away) and Face 2 is (0.15 away)
const face1Desc = new Array(128).fill(0.1 + 0.005);
const face2Desc = new Array(128).fill(0.1 + 0.015);

const detectedFaces = [
  { descriptor: face1Desc, detection: { box: { x: 10, y: 10, width: 50, height: 50 } } },
  { descriptor: face2Desc, detection: { box: { x: 100, y: 10, width: 50, height: 50 } } }
];

const results = matchFacesToRoster(detectedFaces, [dummyStudent1, dummyStudent2]);
assert.strictEqual(results.length, 2);

// Check that Student 1 is assigned to at most ONE face!
const assignedStudentIds = results.map(r => r.studentId).filter(Boolean);
const uniqueAssigned = new Set(assignedStudentIds);
assert.strictEqual(assignedStudentIds.length, uniqueAssigned.size, "No student may be assigned to multiple faces!");
console.log("✅ PASS: Duplicate student assignments across faces strictly prevented");

// Test 5: Every match begins unconfirmed
assert.strictEqual(results[0].confirmed, false);
assert.strictEqual(results[1].confirmed, false);
console.log("✅ PASS: Detected faces start in unconfirmed state requiring teacher review");

// Test 6: Distance > 0.48 must not be assigned
const farFaceDesc = new Array(128).fill(0.9);
const farResult = matchFacesToRoster([{ descriptor: farFaceDesc }], [dummyStudent1]);
assert.strictEqual(farResult[0].studentId, "", "Far face (> 0.48 distance) must not have an assigned student");
assert.strictEqual(farResult[0].tier, "none");
console.log("✅ PASS: Distant/unknown faces labeled as No Reliable Match");

console.log("\n=================================================");
console.log("  ALL GROUP PHOTO FACE MATCHING TESTS PASSED (6/6)");
console.log("=================================================");
