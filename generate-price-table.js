import xlsx from "xlsx";
import fs from "fs";
import path from "path";
import readline from "readline";

// ─── Rarity acronyms ──────────────────────────────────────────────────────────

const RARITY_ACRONYMS = {
  "ultra rare":                        "UR",
  "super rare":                        "SR",
  "secret rare":                       "ScR",
  "starlight rare":                    "StR",
  "collector's rare":                  "CR",
  "prismatic collector's rare":        "PCR",
  "prismatic collectors rare":         "PCR",
  "prismatic ultimate rare":           "PUR",
  "prismatic secret rare":             "PSR",
  "prismatic style collector's rares": "PSCR",
  "prismatic style ultimate rare":     "PSUR",
  "platinum secret rare":              "PlSR",
  "platinum secret rares":             "PlSR",
  "platinum rare":                     "PlR",
  "quarter century secret rare":       "QCSR",
  "starfoil rare":                     "SfR",
  "10000 secret rare":                 "10KR",
  "secret pharaoh's rare":             "SPR",
  "common":                            "C",
  "rare":                              "R",
  "ultimate rare":                     "UTR",
};

function getRarityAcronym(rarity) {
  if (!rarity) return rarity;
  return RARITY_ACRONYMS[rarity.trim().toLowerCase()] ?? rarity.trim();
}

// ─── Prompt helper ────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

function askNumber(question, min, max) {
  return new Promise(async (resolve) => {
    while (true) {
      const ans = await ask(question);
      const n = parseInt(ans, 10);
      if (!isNaN(n) && n >= min && n <= max) return resolve(n);
      console.log(`  Please enter a number between ${min} and ${max}.`);
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. List xlsx files in current directory
  const files = fs.readdirSync(".").filter((f) => f.match(/\.xlsx$/i));

  if (files.length === 0) {
    console.log("No .xlsx files found in the current directory.");
    rl.close();
    return;
  }

  console.log("\nAvailable xlsx files:");
  files.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));

  const fileIdx = await askNumber(`\nChoose file (1-${files.length}): `, 1, files.length);
  const filePath = files[fileIdx - 1];

  // 2. List sheets
  const wb = xlsx.readFile(filePath);
  const sheets = wb.SheetNames;

  console.log(`\nSheets in "${filePath}":`);
  sheets.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));

  const sheetIdx = await askNumber(`Choose sheet (1-${sheets.length}): `, 1, sheets.length);
  const sheetName = sheets[sheetIdx - 1];

  // 3. Read sheet and show columns
  const ws = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });

  // Find first non-empty row as header
  const headerRow = rows.find((r) => r.some((c) => c !== null && c !== undefined && c !== ""));
  if (!headerRow) {
    console.log("Sheet appears to be empty.");
    rl.close();
    return;
  }

  console.log(`\nColumns in "${sheetName}":`);
  headerRow.forEach((col, i) => {
    if (col !== null && col !== undefined && col !== "") {
      console.log(`  [${i + 1}] ${col}`);
    }
  });

  const maxCol = headerRow.length;
  const nameColIdx  = (await askNumber(`\nColumn for Card Name  (1-${maxCol}): `, 1, maxCol)) - 1;
  const rarityColIdx = (await askNumber(`Column for Rarity     (1-${maxCol}): `, 1, maxCol)) - 1;
  const priceColIdx  = (await askNumber(`Column for Sell Price (1-${maxCol}): `, 1, maxCol)) - 1;

  // 4. Build price table — skip header row and rows with no price
  const dataRows = xlsx.utils.sheet_to_json(ws, { header: 1 }).slice(1);

  const lines = [];
  for (const row of dataRows) {
    const name   = row[nameColIdx];
    const rarity = row[rarityColIdx];
    const price  = row[priceColIdx];

    // Skip rows with no price or no name
    if (!name || price === null || price === undefined || price === "") continue;

    const acronym    = getRarityAcronym(String(rarity));
    const priceClean = typeof price === "number"
      ? price.toFixed(2).replace(".", ",")
      : String(price).replace(/R\$\s*/i, "").trim();

    lines.push(`${name} ${acronym} - ${priceClean}`);
  }

  if (lines.length === 0) {
    console.log("\nNo rows with a price found.");
    rl.close();
    return;
  }

  // 5. Write output
  const output = lines.join("\n");
  const outFile = "price-table.txt";
  fs.writeFileSync(outFile, output, "utf-8");

  console.log(`\n${lines.length} entries written to ${outFile}:\n`);
  console.log(output);

  rl.close();
}

main();