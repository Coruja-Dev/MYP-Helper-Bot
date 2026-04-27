import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import xlsx from "xlsx";
import fs from "fs";

chromium.use(StealthPlugin());

import readline from "readline";

// ─── Config ───────────────────────────────────────────────────────────────────

const PROGRESS_FILE = "post-progress.json";

// Column indices (0-based) matching the Pulls sheet
const COL_CODE   = 0; // A
const COL_NAME   = 1; // B
const COL_RARITY = 2; // C
const COL_PRICE  = 5; // F - My Sell Price (blank = keep, skip)

// Posting config
const CONDITION = "NM";   // NM SP MP HP DM
const QUANTITY  = "1";
const FOR_SALE  = "V";    // V=yes, E=no

// Languages available on mypcards
const LANGUAGES = [
  { id: "1",  label: "Português"  },
  { id: "2",  label: "Inglês"     },
  { id: "3",  label: "Espanhol"   },
  { id: "4",  label: "Francês"    },
  { id: "5",  label: "Alemão"     },
  { id: "6",  label: "Italiano"   },
  { id: "7",  label: "Japonês"    },
  { id: "8",  label: "Coreano"    },
  { id: "9",  label: "Russo"      },
  { id: "10", label: "Chinês"     },
  { id: "12", label: "Tailandês"  },
];

const BASE_DELAY = 4000;
const JITTER     = 5000;

// ─── CLI helpers ──────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function askNumber(question, min, max, defaultVal) {
  while (true) {
    const raw = await ask(question);
    if (raw === "" && defaultVal !== undefined) return defaultVal;
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= min && n <= max) return n;
    console.log(`  Enter a number between ${min} and ${max}${defaultVal !== undefined ? ` (or Enter for ${defaultVal})` : ""}.`);
  }
}

function listFiles(extensions) {
  return fs.readdirSync(".").filter((f) =>
    extensions.some((ext) => f.toLowerCase().endsWith(ext))
  );
}

async function pickFile(label, extensions) {
  const files = listFiles(extensions);
  if (files.length === 0) {
    console.log(`No ${extensions.join("/")} files found in current directory.`);
    process.exit(1);
  }
  console.log(`\n${label}:`);
  files.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  const idx = await askNumber(`Choose (1-${files.length}): `, 1, files.length, 1);
  return files[idx - 1];
}

async function pickSheet(xlsxFile) {
  const wb = xlsx.readFile(xlsxFile);
  const sheets = wb.SheetNames;
  if (sheets.length === 1) return sheets[0];
  console.log(`\nSheets in "${xlsxFile}":`);
  sheets.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const idx = await askNumber(`Choose sheet (1-${sheets.length}): `, 1, sheets.length, 1);
  return sheets[idx - 1];
}

// ─── Rarity ID map (from mypcards form) ──────────────────────────────────────
// idfoil values extracted from the estoque/create form select options

const RARITY_IDS = {
  "10000 secret rare":                  "36",
  "collector's rare":                   "26",
  "collectors rare":                    "26",
  "comum":                              "9",
  "common":                             "9",
  "ghost rare":                         "16",
  "gold rare":                          "18",
  "gold secret":                        "24",
  "incomum":                            "10",
  "platinum rare":                      "23",
  "platinum secret rare":               "45",
  "platinum secret rares":              "45",
  "prismatic collector's rare":         "46",
  "prismatic collectors rare":          "46",
  "prismatic secret rare":              "25",
  "prismatic style collector's rares":  "47",
  "prismatic style collector's rares":  "47",
  "prismatic style ultimate rare":      "48",
  "prismatic ultimate rare":            "41",
  "quarter century secret rare":        "32",
  "rara":                               "11",
  "rare":                               "11",
  "rara secreta":                       "14",
  "secret rare":                        "14",
  "secret pharaoh's rare":              "43",
  "starfoil rare":                      "17",
  "starlight rare":                     "29",
  "super rara":                         "12",
  "super rare":                         "12",
  "ultimate rare":                      "15",
  "ultra rara":                         "13",
  "ultra rare":                         "13",
};

function getRarityId(rarity) {
  return RARITY_IDS[rarity?.trim().toLowerCase()] ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay() {
  return BASE_DELAY + Math.random() * JITTER;
}

function loadCookies(cookiesFile) {
  const raw = fs.readFileSync(cookiesFile, "utf-8").trim();

  if (raw.startsWith("[")) {
    return JSON.parse(raw).map((c) => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path ?? "/", expires: c.expirationDate ?? -1,
      httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
      sameSite: c.sameSite === "no_restriction" ? "None"
              : c.sameSite === "strict"         ? "Strict" : "Lax",
    }));
  }

  // Netscape format
  return raw.split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 7) return null;
      const [domain,, path, secure, expires, name, value] = parts;
      return { name, value, domain, path: path ?? "/",
               expires: parseInt(expires) || -1,
               httpOnly: false, secure: secure === "TRUE", sameSite: "Lax" };
    }).filter(Boolean);
}

function buildUrlMap(offersFile) {
  if (!offersFile || !fs.existsSync(offersFile)) return {};
  const lines = fs.readFileSync(offersFile, "utf-8").trim().split("\n").slice(1);
  const map = {};
  for (const line of lines) {
    // CSV fields: card_code, rarity, lowest, highest, average, Tenho, offer_count, card_name, offer_url
    const fields = line.match(/"((?:[^"]|"")*)"/g)?.map((f) => f.slice(1, -1).replace(/""/g, '"'));
    if (!fields || fields.length < 9) continue;
    const code = fields[0].toUpperCase();
    const url  = fields[8];
    if (!map[code]) map[code] = url;
  }
  return map;
}

function loadPullsWithPrices(xlsxFile, sheetName) {
  const wb = xlsx.readFile(xlsxFile);
  const ws = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 }).slice(1);

  return rows
    .filter((r) => r[COL_CODE] && r[COL_PRICE] !== undefined && r[COL_PRICE] !== null && r[COL_PRICE] !== "")
    .map((r) => ({
      code:   String(r[COL_CODE]).trim().toUpperCase(),
      name:   String(r[COL_NAME] ?? "").trim(),
      rarity: String(r[COL_RARITY] ?? "").trim(),
      price:  parseFloat(r[COL_PRICE]),
    }))
    .filter((r) => !isNaN(r.price));
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE)).done ?? []); }
  catch { return new Set(); }
}

function saveProgress(done) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...done] }, null, 2));
}

function progressKey(code, rarity) {
  return `${code}::${rarity}`;
}

// ─── Page helpers ─────────────────────────────────────────────────────────────

async function isRealPage(page) {
  let c = "";
  try { c = await page.content(); } catch {}
  return !c.includes("Just a moment") && !c.includes("cf-error-code") && c.includes("mypcards");
}

async function loadPage(page, url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      for (let i = 0; i < 15; i++) {
        if (await isRealPage(page)) return true;
        console.log(`    Cloudflare (attempt ${attempt}, poll ${i + 1}/15)...`);
        await page.waitForTimeout(4000);
      }
      await page.waitForTimeout(15000);
    } catch (err) {
      console.warn(`    Attempt ${attempt} failed: ${err.message}`);
      if (attempt < 4) await page.waitForTimeout(8000);
    }
  }
  return false;
}

// ─── Post a single card entry ─────────────────────────────────────────────────

async function postCard(page, productId, rarityId, price, languageId) {
  const createUrl = `https://mypcards.com/estoque/create?idproduto=${productId}`;

  const ok = await loadPage(page, createUrl);
  if (!ok) { console.warn(`    Failed to load create page.`); return false; }

  try {
    // Set rarity
    await page.selectOption("#estoque-idfoil", rarityId);

    // Set condition
    await page.selectOption("#estoque-qualidadeestoque", CONDITION);

    // Set language
    await page.selectOption("#estoque-ididioma", languageId ?? "1");

    // Set for sale status
    await page.selectOption("#estoque-statusestoque", FOR_SALE);

    // Set quantity
    await page.fill("#estoque-quantidadeestoque", QUANTITY);

    // Set price — format as "12.50" (dot decimal, no R$)
    const priceStr = price.toFixed(2);
    await page.fill("#estoque-precoestoque", priceStr);

    // Submit
    await page.click("button[type='submit'].btn.hidden-sm");

    // Wait for redirect or success indicator
    await page.waitForURL((url) => !url.includes("/estoque/create"), { timeout: 15000 })
      .catch(() => {}); // may not redirect, that's ok

    const content = await page.content();
    const success = !content.includes("has-error") && !content.includes("campo obrigatório");
    return success;

  } catch (err) {
    console.warn(`    Form error: ${err.message}`);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== MYP Card Poster ===\n");

  // ── Step 1: Pick xlsx source ───────────────────────────────────────────────
  const xlsxFile = await pickFile("Source xlsx file", [".xlsx"]);
  const sheetName = await pickSheet(xlsxFile);

  // ── Step 2: Pick cookies file ──────────────────────────────────────────────
  const cookiesFile = await pickFile("Cookies file", [".json", ".txt"]);

  // ── Step 3: Pick CSV for URL lookup ───────────────────────────────────────
  const csvFiles = listFiles([".csv"]);
  let offersFile = null;
  if (csvFiles.length > 0) {
    console.log("\nOffers CSV for URL lookup (needed to find product IDs):");
    csvFiles.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
    console.log(`  [${csvFiles.length + 1}] Skip (URLs must be in the xlsx)`);
    const idx = await askNumber(`Choose (1-${csvFiles.length + 1}): `, 1, csvFiles.length + 1, 1);
    if (idx <= csvFiles.length) offersFile = csvFiles[idx - 1];
  }

  // ── Step 4: How many cards to post ────────────────────────────────────────
  const allCards = loadPullsWithPrices(xlsxFile, sheetName);
  const done     = loadProgress();
  const pending  = allCards.filter((c) => !done.has(progressKey(c.code, c.rarity)));

  console.log(`\nCards with prices: ${allCards.length}`);
  console.log(`Already posted:    ${done.size}`);
  console.log(`Pending:           ${pending.length}`);

  const limit = await askNumber(
    `\nHow many to post this run? (1-${pending.length}, Enter = all): `,
    1, pending.length, pending.length
  );

  // ── Step 5: Language ───────────────────────────────────────────────────────
  // Check if the sheet has a language column — look for a header containing "idioma" or "language"
  const wbCheck = xlsx.readFile(xlsxFile);
  const wsCheck = wbCheck.Sheets[sheetName];
  const headerRow = xlsx.utils.sheet_to_json(wsCheck, { header: 1 })[0] ?? [];
  const langColIdx = headerRow.findIndex(
    (h) => h && String(h).toLowerCase().match(/idioma|language|lang/)
  );

  let languageId;
  if (langColIdx !== -1) {
    console.log(`\nLanguage column found: "${headerRow[langColIdx]}" (col ${langColIdx + 1}).`);
    console.log("Each card's language will be read from that column.");
    languageId = null; // signal to read per-row
  } else {
    console.log("\nNo language column found — choose a language to apply to all cards:");
    LANGUAGES.forEach((l, i) => console.log(`  [${i + 1}] ${l.label}`));
    const langIdx = await askNumber(`Choose (1-${LANGUAGES.length}, Enter = Português): `, 1, LANGUAGES.length, 1);
    languageId = LANGUAGES[langIdx - 1].id;
    console.log(`Language set to: ${LANGUAGES[langIdx - 1].label}`);
  }

  rl.close();

  const urlMap    = buildUrlMap(offersFile);
  const cards     = allCards; // full list, loop respects done + limit
  const langCol   = langColIdx; // -1 if not found, otherwise col index
  const globalLang = languageId; // null = read per row

  // Validate rarity IDs upfront
  const unknownRarities = [...new Set(
    cards.filter((c) => !getRarityId(c.rarity)).map((c) => c.rarity)
  )];
  if (unknownRarities.length) {
    console.warn(`\nUnknown rarities (will be skipped):\n  ${unknownRarities.join("\n  ")}`);
  }

  console.log(`\nPosting up to ${limit} card(s) from "${xlsxFile}" / sheet "${sheetName}".`);
  console.log(`Cookies: ${cookiesFile}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--start-minimized"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Referer": "https://mypcards.com/",
    },
  });

  await context.addCookies(loadCookies(cookiesFile));
  const page = await context.newPage();

  // Warm up
  console.log("Warming up...");
  await page.goto("https://mypcards.com/yugioh", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000 + Math.random() * 5000);
  console.log("Ready.\n");

  let posted = 0, skipped = 0, failed = 0;

  for (let i = 0; i < cards.length; i++) {
    if (posted + failed >= limit) break;
    const { code, name, rarity, price } = cards[i];
    const key = progressKey(code, rarity);

    if (done.has(key)) {
      console.log(`[${i + 1}/${cards.length}] SKIP (done): ${name} ${rarity}`);
      continue;
    }

    const rarityId = getRarityId(rarity);
    if (!rarityId) {
      console.warn(`[${i + 1}/${cards.length}] SKIP (unknown rarity "${rarity}"): ${name}`);
      skipped++;
      continue;
    }

    const url = urlMap[code];
    if (!url) {
      console.warn(`[${i + 1}/${cards.length}] SKIP (no URL for ${code}): ${name}`);
      skipped++;
      continue;
    }

    // Extract product ID from URL: /produto/XXXXX/slug
    const productId = url.match(/\/produto\/(\d+)\//)?.[1];
    if (!productId) {
      console.warn(`[${i + 1}/${cards.length}] SKIP (can't parse product ID from ${url})`);
      skipped++;
      continue;
    }

    console.log(`[${i + 1}/${cards.length}] ${name} | ${rarity} | R$ ${price.toFixed(2)}`);
    console.log(`    idproduto=${productId} idfoil=${rarityId}`);

    // Determine language for this card
    let cardLang = globalLang;
    if (langCol !== -1) {
      const wb2 = xlsx.readFile(xlsxFile);
      const ws2 = wb2.Sheets[sheetName];
      const rows2 = xlsx.utils.sheet_to_json(ws2, { header: 1 }).slice(1);
      const matchRow = rows2.find(
        (r) => String(r[COL_CODE] ?? "").toUpperCase() === code &&
               String(r[COL_RARITY] ?? "").trim() === rarity
      );
      const rawLang = matchRow?.[langCol];
      const matchedLang = rawLang
        ? LANGUAGES.find((l) => l.label.toLowerCase() === String(rawLang).toLowerCase())
        : null;
      cardLang = matchedLang?.id ?? LANGUAGES[0].id;
      if (!matchedLang && rawLang) {
        console.warn(`    Unknown language "${rawLang}", defaulting to Português.`);
      }
    }

    const success = await postCard(page, productId, rarityId, price, cardLang);

    if (success) {
      console.log(`    Posted.`);
      done.add(key);
      saveProgress(done);
      posted++;
    } else {
      console.warn(`    Failed — will retry next run.`);
      failed++;
    }

    const pause = randomDelay();
    console.log(`    Next in ${(pause / 1000).toFixed(1)}s...`);
    await page.waitForTimeout(pause);
  }

  await browser.close();
  console.log(`\nDone. Posted: ${posted}, Skipped: ${skipped}, Failed: ${failed}`);
}

main();