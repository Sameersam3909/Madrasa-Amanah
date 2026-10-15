import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI_PRIMARY || process.env.MONGODB_URI;
await mongoose.connect(uri);
const students = await mongoose.connection.db.collection("students").find({}).toArray();
console.log(`Total students in DB: ${students.length}`);
let mixedCount = 0;
let missingEnCount = 0;
let missingUrCount = 0;
let missingTeCount = 0;

for (const [idx, s] of students.entries()) {
  const hasUrdu = /[\u0600-\u06FF]/.test(s.name || "");
  const hasLatin = /[a-zA-Z]/.test(s.name || "");
  const isMixed = hasUrdu && hasLatin;
  if (isMixed) mixedCount++;
  if (!s.nameEn) missingEnCount++;
  if (!s.nameUr) missingUrCount++;
  if (!s.nameTe) missingTeCount++;

  console.log(`${idx + 1}. [${s.admissionNo}] "${s.name}" ${isMixed ? "⚠️ [MIXED SCRIPT]" : ""} | En: "${s.nameEn || "-"}" | Ur: "${s.nameUr || "-"}" | Te: "${s.nameTe || "-"}"`);
}

console.log("\n--- SUMMARY ---");
console.log(`Total: ${students.length}`);
console.log(`Mixed-Script Names: ${mixedCount}`);
console.log(`Missing nameEn: ${missingEnCount}`);
console.log(`Missing nameUr: ${missingUrCount}`);
console.log(`Missing nameTe: ${missingTeCount}`);

await mongoose.disconnect();
