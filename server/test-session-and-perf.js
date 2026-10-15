import "dotenv/config";
import jwt from "jsonwebtoken";
import { spawn } from "child_process";

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const API_BASE = `http://localhost:${PORT}/api`;
const ROOT_HEALTH = `http://localhost:${PORT}/health`;

async function isServerRunning() {
  try {
    const res = await fetch(ROOT_HEALTH, { signal: AbortSignal.timeout(1000) });
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

async function waitForServer(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await isServerRunning()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function runSuite() {
  console.log("==================================================================");
  console.log("  MADRASA AMANAH — SESSION SECURITY & PERFORMANCE TEST SUITE");
  console.log("==================================================================\n");

  let serverProcess = null;
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Ensure backend is running
    const alreadyRunning = await isServerRunning();
    if (!alreadyRunning) {
      console.log(`Starting Madrasa backend on port ${PORT}...`);
      serverProcess = spawn("node", ["src/index.js"], {
        cwd: __dirname,
        stdio: "inherit",
        env: { ...process.env, PORT: String(PORT) }
      });
      const ready = await waitForServer(15000);
      if (!ready) {
        throw new Error("Backend server failed to start within 15 seconds.");
      }
    }

    // 2. Health Endpoint Verification: GET /health (Lightweight, credential-safe)
    const t0 = Date.now();
    const healthRes = await fetch(ROOT_HEALTH);
    const healthDuration = Date.now() - t0;
    const healthData = await healthRes.json();

    assert(healthRes.status === 200, "GET /health returns HTTP 200 OK");
    assert(healthData.status === "ok", "GET /health returns status: 'ok'");
    assert(healthData.service === "madrasa-attendance-api", "GET /health identifies service correctly");
    assert(healthData.database === "connected", "GET /health reports MongoDB connected");
    assert(typeof healthData.uptime === "number" && healthData.uptime >= 0, "GET /health includes server uptime");
    assert(Boolean(healthData.timestamp), "GET /health includes ISO-8601 timestamp");
    assert(!JSON.stringify(healthData).includes("mongodb+srv://"), "GET /health never exposes database credentials or connection strings");
    assert(healthDuration < 500, `GET /health responds rapidly (${healthDuration}ms < 500ms)`);

    // 3. Health Endpoint Verification: GET /api/health (Alias path)
    const apiHealthRes = await fetch(`${API_BASE}/health`);
    const apiHealthData = await apiHealthRes.json();
    assert(apiHealthRes.status === 200 && apiHealthData.status === "ok", "GET /api/health responds with HTTP 200 and status: 'ok'");

    // 4. Performance Measurement: X-Response-Time header on protected endpoints
    // Sign in as Admin
    const loginRes = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL || "admin@example.com",
        password: process.env.ADMIN_PASSWORD || "Shaiksameer/3909"
      })
    });
    const loginData = await loginRes.json();
    assert(loginRes.status === 200 && Boolean(loginData.token), "Admin login successful");
    assert(Boolean(loginData.session), "Login payload includes session configuration");
    assert(loginData.session.inactivitySeconds === 7200, "Session inactivity window configured to 7200s (2 hours)");
    assert(loginData.session.maxLifetimeSeconds === 10800, "Session max lifetime configured to 10800s (3 hours)");

    const adminToken = loginData.token;
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json"
    };

    // 5. Query classes with lean & measure X-Response-Time
    const classesRes = await fetch(`${API_BASE}/classes`, { headers: adminHeaders });
    const classes = await classesRes.json();
    const xResponseTime = classesRes.headers.get("x-response-time");
    assert(classesRes.status === 200 && Array.isArray(classes), `Classes query returned ${classes.length} classes`);
    assert(Boolean(xResponseTime), `X-Response-Time performance header is present (${xResponseTime})`);

    // 6. Pagination & fast query on /api/students
    const page1Res = await fetch(`${API_BASE}/students?page=1&limit=5`, { headers: adminHeaders });
    const page1Students = await page1Res.json();
    const totalCount = page1Res.headers.get("x-total-count");
    const pageHeader = page1Res.headers.get("x-page");
    const limitHeader = page1Res.headers.get("x-limit");

    assert(page1Res.status === 200, "GET /api/students with pagination returns HTTP 200");
    assert(page1Students.length <= 5, `Pagination limits page size correctly (${page1Students.length} items)`);
    assert(Boolean(totalCount), `X-Total-Count header is populated (${totalCount})`);
    assert(pageHeader === "1" && limitHeader === "5", "X-Page and X-Limit headers are accurately returned");

    // 7. Session Inactivity Expiry Enforcement (Simulated via expired token)
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredInactivityToken = jwt.sign(
      {
        sub: loginData.user.id,
        sessionStart: nowSec - 7300, // 2h 1m ago
        lastActivity: nowSec - 7300
      },
      process.env.JWT_SECRET || "madrasa-amanah-smart-attendance-system-secure-jwt-secret-key-2026-production",
      { expiresIn: "0s" } // expired inactivity window
    );

    const expiredRes = await fetch(`${API_BASE}/classes`, {
      headers: { Authorization: `Bearer ${expiredInactivityToken}` }
    });
    const expiredData = await expiredRes.json();
    assert(expiredRes.status === 401, "Expired inactivity session returns HTTP 401 Unauthorized");
    assert(
      expiredData.code === "SESSION_INACTIVITY_EXPIRED",
      `Expired session returns code: 'SESSION_INACTIVITY_EXPIRED' (got: ${expiredData.code})`
    );

    // 8. Session Renewal: POST /api/auth/refresh-session within allowed window
    const refreshRes = await fetch(`${API_BASE}/auth/refresh-session`, {
      method: "POST",
      headers: adminHeaders
    });
    const refreshData = await refreshRes.json();
    assert(refreshRes.status === 200, "POST /api/auth/refresh-session returns HTTP 200 OK");
    assert(Boolean(refreshData.token), "Refresh returns a new signed JWT token");
    assert(
      refreshData.remainingTotalSeconds > 0 && refreshData.remainingTotalSeconds <= 10800,
      `Refresh respects remaining total lifetime cap (${refreshData.remainingTotalSeconds}s remaining)`
    );

    // 9. Absolute 3-Hour Maximum Session Lifetime Cap Enforcement
    const maxExceededToken = jwt.sign(
      {
        sub: loginData.user.id,
        sessionStart: nowSec - 11000, // 3h 3m ago (started > 3 hours ago)
        lastActivity: nowSec - 10
      },
      process.env.JWT_SECRET || "madrasa-amanah-smart-attendance-system-secure-jwt-secret-key-2026-production",
      { expiresIn: "60s" } // token technically unexpired, but total session exceeded 3h
    );

    const maxExceededReq = await fetch(`${API_BASE}/classes`, {
      headers: { Authorization: `Bearer ${maxExceededToken}` }
    });
    const maxExceededData = await maxExceededReq.json();
    assert(maxExceededReq.status === 401, "Request exceeding 3-hour absolute lifetime returns HTTP 401 Unauthorized");
    assert(
      maxExceededData.code === "SESSION_MAX_EXCEEDED",
      `Exceeded max lifetime returns code: 'SESSION_MAX_EXCEEDED' (got: ${maxExceededData.code})`
    );

    // 10. Attempting to refresh after 3-hour absolute maximum lifetime
    const maxRefreshReq = await fetch(`${API_BASE}/auth/refresh-session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${maxExceededToken}` }
    });
    assert(maxRefreshReq.status === 401, "POST /api/auth/refresh-session strictly rejects sessions beyond 3h cap");

    console.log("\n==================================================================");
    console.log(`  SESSION & PERFORMANCE SUITE: ${passed} PASSED, ${failed} FAILED`);
    console.log("==================================================================\n");

    if (failed > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("Test execution failed:", err);
    process.exitCode = 1;
  } finally {
    if (serverProcess) {
      console.log("Terminating spawned test server...");
      serverProcess.kill("SIGTERM");
    }
  }
}

runSuite();
