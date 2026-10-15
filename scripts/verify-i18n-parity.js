import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localesDir = path.resolve(__dirname, "../client/public/locales");
const languages = ["en", "ur", "te"];

function flattenKeys(obj, prefix = "") {
  let keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys = keys.concat(flattenKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const loaded = {};
for (const lang of languages) {
  const filePath = path.join(localesDir, lang, "translation.json");
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Missing locale file: ${filePath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  loaded[lang] = JSON.parse(raw);
}

const enKeys = new Set(flattenKeys(loaded.en));
let hasError = false;

console.log(`🔍 Checking translation key parity across [${languages.join(", ")}]...`);
console.log(`   Base English keys count: ${enKeys.size}`);

for (const lang of ["ur", "te"]) {
  const targetKeys = new Set(flattenKeys(loaded[lang]));
  const missing = [...enKeys].filter(k => !targetKeys.has(k));
  const extra = [...targetKeys].filter(k => !enKeys.has(k));

  if (missing.length > 0) {
    console.error(`❌ [${lang}] is missing ${missing.length} keys:`);
    missing.forEach(k => console.error(`     - ${k}`));
    hasError = true;
  }
  if (extra.length > 0) {
    console.warn(`⚠️ [${lang}] has ${extra.length} extra keys not present in [en]:`);
    extra.forEach(k => console.warn(`     + ${k}`));
  }

  if (missing.length === 0) {
    console.log(`✅ [${lang}] has 100% parity with [en] (${targetKeys.size} keys)`);
  }
}

if (hasError) {
  console.error("❌ Translation parity check failed.");
  process.exit(1);
} else {
  console.log("🎉 Translation parity check passed successfully!");
}
