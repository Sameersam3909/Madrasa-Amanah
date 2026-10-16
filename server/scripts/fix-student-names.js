import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI_PRIMARY || process.env.MONGODB_URI;
await mongoose.connect(uri);

const students = await mongoose.connection.db.collection("students").find({}).toArray();
console.log(`Checking ${students.length} students...`);

let fixedCount = 0;

for (const s of students) {
  let needsUpdate = false;
  let newName = s.name;
  let newNameEn = s.nameEn;
  let newNameUr = s.nameUr;

  // Specific fixes for known corrupted punctuation from Urdu keyboard:
  if (s.admissionNo === "1" || s.name === "Md۔saeed") {
    newName = "Md. Saeed";
    newNameEn = "Md. Saeed";
    newNameUr = "محمد سعید";
    needsUpdate = true;
  } else if (s.admissionNo === "5" || s.name === "A۔Farhan Baig") {
    newName = "A. Farhan Baig";
    newNameEn = "A. Farhan Baig";
    newNameUr = "اے فرحان بیگ";
    needsUpdate = true;
  } else {
    // General check: if name contains Urdu dot (U+06D4) with Latin letters
    if (/[a-zA-Z]/.test(s.name) && s.name.includes("\u06D4")) {
      newName = s.name
        .replace(/([a-zA-Z])\u06D4\s*/g, "$1. ")
        .replace(/\s*\u06D4\s*([a-zA-Z])/g, ". $1")
        .replace(/\u06D4/g, ".")
        .replace(/\s+/g, " ")
        .trim();
      if (!newNameEn) newNameEn = newName;
      needsUpdate = true;
    }
    if (!s.nameEn && /^[a-zA-Z\s.,'-]+$/.test(s.name)) {
      newNameEn = s.name;
      needsUpdate = true;
    }
  }

  if (needsUpdate) {
    await mongoose.connection.db.collection("students").updateOne(
      { _id: s._id },
      { $set: { name: newName, nameEn: newNameEn, ...(newNameUr ? { nameUr: newNameUr } : {}), updatedAt: new Date() } }
    );
    console.log(`✓ Fixed student [${s.admissionNo}]: "${s.name}" -> "${newName}" (En: "${newNameEn}", Ur: "${newNameUr || ""}")`);
    fixedCount++;
  }
}

console.log(`\nCompleted! Fixed ${fixedCount} students.`);
await mongoose.disconnect();
