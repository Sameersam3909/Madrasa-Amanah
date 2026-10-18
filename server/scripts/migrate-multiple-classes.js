import "dotenv/config";
import mongoose from "mongoose";
import { Student, Class } from "../src/models.js";

async function migrateMultipleClasses() {
  console.log("=================================================");
  console.log("  DARUL ULOOM ASHRAFIA — MULTIPLE CLASS MIGRATION");
  console.log("=================================================\n");

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI environment variable is missing.");
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    console.log("  Connected to MongoDB cluster.");

    const totalStudents = await Student.countDocuments({});
    console.log(`  Total student records in database: ${totalStudents}`);

    const cursor = Student.find({}).cursor();
    let updatedCount = 0;
    let alreadyMigrated = 0;
    let missingClassCount = 0;

    for (let student = await cursor.next(); student != null; student = await cursor.next()) {
      let needsSave = false;

      // Extract existing assignments
      let currentIds = [];
      if (Array.isArray(student.classIds) && student.classIds.length > 0) {
        currentIds = student.classIds.map((id) => String(id));
      } else if (student.classId) {
        currentIds = [String(student.classId)];
      }

      // Deduplicate and filter valid IDs
      const uniqueIds = Array.from(new Set(currentIds)).filter(
        (id) => id && mongoose.Types.ObjectId.isValid(id)
      );

      if (uniqueIds.length === 0) {
        missingClassCount++;
      }

      // Check if classIds array matches uniqueIds
      const existingArray = (student.classIds || []).map((id) => String(id));
      const isArrayEqual =
        existingArray.length === uniqueIds.length &&
        existingArray.every((id, idx) => id === uniqueIds[idx]);

      if (!isArrayEqual) {
        student.classIds = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
        needsSave = true;
      }

      // Ensure classId points to primary class (classIds[0]) for backwards compatibility
      if (uniqueIds.length > 0) {
        const primaryClassId = String(student.classId || "");
        if (primaryClassId !== uniqueIds[0]) {
          student.classId = new mongoose.Types.ObjectId(uniqueIds[0]);
          needsSave = true;
        }
      }

      if (needsSave) {
        await student.save();
        updatedCount++;
      } else {
        alreadyMigrated++;
      }
    }

    console.log(`\n--- MIGRATION SUMMARY ---`);
    console.log(`  Total Students Processed : ${totalStudents}`);
    console.log(`  Records Updated          : ${updatedCount}`);
    console.log(`  Already Compliant        : ${alreadyMigrated}`);
    console.log(`  Unassigned Students      : ${missingClassCount}`);
    console.log(`=================================================`);
    console.log(`✅ MULTIPLE-CLASS MIGRATION COMPLETED SUCCESSFULLY`);
    console.log(`=================================================\n`);
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

migrateMultipleClasses();
