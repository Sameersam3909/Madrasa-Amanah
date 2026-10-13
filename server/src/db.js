import mongoose from "mongoose";
import path from "path";
import fs from "fs";

let dbEngine = "unknown";
let memoryServerInstance = null;

export async function connectDB() {
  const isProduction = process.env.NODE_ENV === "production";
  const uri = process.env.MONGODB_URI;

  // 1. Production Mode: MongoDB Atlas is required and non-negotiable
  if (isProduction) {
    if (!uri) {
      const msg = "FATAL: MONGODB_URI environment variable is required in production.";
      console.error(msg);
      throw new Error(msg);
    }
    console.log("Connecting to Production MongoDB Atlas at:", uri.replace(/:([^@]+)@/, ":****@"));
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
      dbEngine = "MongoDB Atlas (Production)";
      console.log("Connected to MongoDB Atlas cluster successfully.");
      return;
    } catch (err) {
      console.error("FATAL: Failed to connect to MongoDB Atlas in production:", err.message);
      console.error("Verify that IP 0.0.0.0/0 is whitelisted in MongoDB Atlas Network Access.");
      throw err;
    }
  }

  // 2. Development Mode: Try provided MONGODB_URI first
  if (uri && !uri.includes("127.0.0.1") && !uri.includes("localhost")) {
    try {
      console.log("Attempting MongoDB Atlas connection at:", uri.replace(/:([^@]+)@/, ":****@"));
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      dbEngine = "MongoDB Atlas";
      console.log("Connected to MongoDB Atlas cluster successfully.");
      return;
    } catch (err) {
      console.warn("MongoDB Atlas connection attempt failed:", err.message);
      console.warn("(Ensure your current IP or 0.0.0.0/0 is permitted in Atlas Network Access.)");
      console.log("Falling back to local persistent database so student records are never lost...");
    }
  }

  // 3. Try local standard MongoDB (port 27017)
  if (uri && (uri.includes("127.0.0.1") || uri.includes("localhost"))) {
    try {
      console.log("Attempting local MongoDB connection...");
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
      dbEngine = "Local MongoDB";
      console.log("Connected to local MongoDB.");
      return;
    } catch {
      console.log("Local MongoDB not reachable on port 27017.");
    }
  }

  // 4. Development Persistent Storage Fallback
  // Uses MongoMemoryServer configured with disk persistence (.mongo-local-store)
  // Ensures newly added students, classes and attendance records persist across server restarts!
  const localStoreDir = path.resolve(process.cwd(), ".mongo-local-store");
  if (!fs.existsSync(localStoreDir)) {
    fs.mkdirSync(localStoreDir, { recursive: true });
  }

  console.log(`Starting persistent local database engine at: ${localStoreDir}...`);
  try {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    memoryServerInstance = await MongoMemoryServer.create({
      instance: {
        dbPath: localStoreDir,
        storageEngine: "wiredTiger"
      }
    });
    const memoryUri = memoryServerInstance.getUri();
    await mongoose.connect(memoryUri);
    dbEngine = "Persistent Local Storage (WiredTiger)";
    console.log(`Connected to persistent local database. Data is safely stored in ${localStoreDir}`);
  } catch (err) {
    console.error("Failed to start persistent local storage engine:", err.message);
    throw err;
  }
}

export function getDatabaseInfo() {
  const state = mongoose.connection.readyState;
  const stateMap = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
  return {
    status: stateMap[state] || "unknown",
    connected: state === 1,
    engine: dbEngine,
    databaseName: mongoose.connection.name || "madrasa_attendance",
    host: mongoose.connection.host ? mongoose.connection.host.replace(/.*@/, "") : "local"
  };
}
