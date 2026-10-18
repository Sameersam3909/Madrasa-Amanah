import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "./models.js";

const mongoUri = process.env.MONGODB_URI || process.env.MONGODB_URI_PRIMARY;
const adminEmail = (process.env.ADMIN_EMAIL || "mdrafiq12118@gmail.com").toLowerCase().trim();
const adminPass = process.env.ADMIN_PASSWORD || "Mdrafiq@12118";
const adminName = process.env.ADMIN_NAME || "Madrasa Administrator";

if (!mongoUri) {
  throw new Error("MONGODB_URI must be set in .env.");
}

await mongoose.connect(mongoUri);
const hash = await bcrypt.hash(adminPass, 12);
let user = await User.findOne({ email: adminEmail });
if (user) {
  user.passwordHash = hash;
  user.name = adminName;
  user.role = "admin";
  user.active = true;
  await user.save();
  console.log(`[SEED] Admin account updated successfully: ${adminEmail}`);
} else {
  await User.create({
    name: adminName,
    email: adminEmail,
    role: "admin",
    passwordHash: hash,
    active: true
  });
  console.log(`[SEED] Admin created successfully: ${adminEmail}`);
}
await mongoose.disconnect();
