import mongoose from "mongoose";

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (uri && !uri.includes("127.0.0.1") && !uri.includes("localhost")) {
    try {
      console.log("Connecting to MongoDB Atlas at:", uri.replace(/:([^@]+)@/, ":****@"));
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });
      console.log("Connected to MongoDB Atlas cluster successfully.");
      return;
    } catch (err) {
      console.warn("MongoDB Atlas connection attempt failed:", err.message);
      console.warn("(If this is an IP whitelist issue in Atlas, ensure 0.0.0.0/0 is permitted in Network Access.)");
      console.log("Falling back gracefully to local/in-memory database so the system never breaks...");
    }
  }

  // Try local URI if provided
  if (uri && (uri.includes("127.0.0.1") || uri.includes("localhost"))) {
    try {
      console.log("Attempting local MongoDB connection...");
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
      console.log("Connected to local MongoDB.");
      return;
    } catch {
      console.log("Local MongoDB not reachable on port 27017.");
    }
  }

  // Seamless fallback to MongoMemoryServer for development / offline resilience
  console.log("Starting embedded MongoMemoryServer for instant execution...");
  try {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const mongod = await MongoMemoryServer.create({
      instance: { dbName: "madrasa_attendance" }
    });
    const memoryUri = mongod.getUri();
    await mongoose.connect(memoryUri);
    console.log("Connected to embedded MongoDB instance at:", memoryUri);
  } catch (err) {
    console.error("Failed to start MongoMemoryServer fallback:", err.message);
    throw err;
  }
}
