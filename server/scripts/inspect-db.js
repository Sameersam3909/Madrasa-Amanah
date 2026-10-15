import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI_PRIMARY || process.env.MONGODB_URI;
await mongoose.connect(uri);

const classes = await mongoose.connection.db.collection("classes").find({}).toArray();
console.log(`\n=== CLASSES (${classes.length}) ===`);
classes.forEach((c, idx) => {
  console.log(`${idx + 1}. [${c._id}] "${c.name}" | Section: "${c.section || ""}" | Code: "${c.code || ""}" | Active: ${c.active} | Teachers: ${(c.teacherIds || []).length}`);
});

const users = await mongoose.connection.db.collection("users").find({}).toArray();
console.log(`\n=== USERS (${users.length}) ===`);
users.forEach((u, idx) => {
  console.log(`${idx + 1}. [${u._id}] "${u.name}" (${u.email}) | Role: ${u.role} | Active: ${u.active} | Assigned: ${(u.assignedClasses || []).length}`);
});

const attendanceCount = await mongoose.connection.db.collection("attendances").countDocuments();
console.log(`\n=== ATTENDANCE RECORDS: ${attendanceCount} ===`);

await mongoose.disconnect();
