import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "./models.js";
if (!process.env.MONGODB_URI || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  throw new Error("Set MONGODB_URI, ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
}
if (process.env.ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
await mongoose.connect(process.env.MONGODB_URI);
const email = process.env.ADMIN_EMAIL.toLowerCase().trim();
const existing = await User.findOne({ email });
if (existing) {
  console.log("Admin email already exists; no account changed.");
} else {
  await User.create({
    name: process.env.ADMIN_NAME || "Madrasa Administrator",
    email, role: "admin", passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)
  });
  console.log("First admin created. Sign in and keep credentials private.");
}
await mongoose.disconnect();
