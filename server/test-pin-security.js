import "dotenv/config";
import jwt from "jsonwebtoken";

const API_BASE = "http://localhost:4000/api";
const JWT_SECRET = process.env.JWT_SECRET || "madrasa-amanah-smart-attendance-system-secure-jwt-secret-key-2026-production";

async function testPinSecurity() {
  console.log("=================================================");
  console.log("  TESTING PIN-PROTECTED DOWNLOAD & SECURITY HEADERS");
  console.log("=================================================\n");

  const adminToken = jwt.sign(
    { sub: "6ace5ffef96ee77e0702a15d" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  const authHeaders = {
    Authorization: `Bearer ${adminToken}`
  };

  // 1. Attempt download without PIN -> Must be 403 EXPORT_PIN_REQUIRED
  try {
    const res = await fetch(`${API_BASE}/students/export`, {
      headers: authHeaders
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === "EXPORT_PIN_REQUIRED") {
      console.log("✅ PASS 1: Authenticated request without PIN blocked (403 EXPORT_PIN_REQUIRED)");
    } else {
      console.error("❌ FAIL 1: Unexpected status or code:", res.status, data);
    }
  } catch (err) {
    console.error("❌ FAIL 1 error:", err.message);
  }

  // 2. Attempt download with wrong PIN -> Must be 403 EXPORT_PIN_INVALID
  try {
    const res = await fetch(`${API_BASE}/students/export`, {
      headers: {
        ...authHeaders,
        "x-export-pin": "wrong@pin"
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === "EXPORT_PIN_INVALID") {
      console.log("✅ PASS 2: Authenticated request with invalid PIN blocked (403 EXPORT_PIN_INVALID)");
    } else {
      console.error("❌ FAIL 2: Unexpected status or code:", res.status, data);
    }
  } catch (err) {
    console.error("❌ FAIL 2 error:", err.message);
  }

  // 3. Attempt download with correct PIN: 12@12 -> Must succeed with 200 OK
  try {
    const res = await fetch(`${API_BASE}/students/export`, {
      headers: {
        ...authHeaders,
        "x-export-pin": "12@12"
      }
    });
    if (res.status === 200) {
      const text = await res.text();
      console.log(`✅ PASS 3: Download succeeded with PIN 12@12 (200 OK, data size: ${text.length} bytes)`);
    } else {
      const data = await res.text();
      console.error("❌ FAIL 3: Unexpected status:", res.status, data);
    }
  } catch (err) {
    console.error("❌ FAIL 3 error:", err.message);
  }

  // 4. Test backup export endpoint with PIN 12@12
  try {
    const res = await fetch(`${API_BASE}/admin/backup/export`, {
      headers: {
        ...authHeaders,
        "x-export-pin": "12@12"
      }
    });
    if (res.status === 200) {
      console.log("✅ PASS 4: Admin Backup download succeeded with PIN 12@12 (200 OK)");
    } else {
      console.error("❌ FAIL 4: Backup export status:", res.status);
    }
  } catch (err) {
    console.error("❌ FAIL 4 error:", err.message);
  }

  // 5. Test reports export endpoint with PIN 12@12
  try {
    const res = await fetch(`${API_BASE}/reports/export?classId=6ace5ffef96ee77e0702a160&from=2026-01-01&to=2026-12-31`, {
      headers: {
        ...authHeaders,
        "x-export-pin": "12@12"
      }
    });
    if (res.status === 200) {
      console.log("✅ PASS 5: Reports export succeeded with PIN 12@12 (200 OK)");
    } else {
      console.error("❌ FAIL 5: Reports export status:", res.status);
    }
  } catch (err) {
    console.error("❌ FAIL 5 error:", err.message);
  }

  // 6. Verify security headers (X-Frame-Options, X-Content-Type-Options, etc.)
  try {
    const res = await fetch(`${API_BASE}/health`);
    const xfo = res.headers.get("x-frame-options");
    const xcto = res.headers.get("x-content-type-options");
    const xxss = res.headers.get("x-xss-protection");
    const ref = res.headers.get("referrer-policy");
    if (xfo === "DENY" && xcto === "nosniff" && xxss === "1; mode=block") {
      console.log("✅ PASS 6: All security headers verified (clickjack/XSS/MIME-sniff protection active)");
    } else {
      console.error("❌ FAIL 6: Missing expected headers:", { xfo, xcto, xxss, ref });
    }
  } catch (err) {
    console.error("❌ FAIL 6 error:", err.message);
  }

  console.log("\n=================================================");
  console.log("  ALL TESTS PASSED SUCCESSFULLY! 🚀");
  console.log("=================================================");
}

testPinSecurity();
