import { chromium } from "playwright";

const URL = "https://mypcards.com/yugioh/rarity-collection-5?pagina=1";

async function main() {
  const browser = await chromium.launch({
    headless: false, // important for Cloudflare
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("🌐 Navigating...");

  await page.goto(URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("📄 Page loaded (DOM ready)");

  // 🔍 Step 1: Check if Cloudflare is active
  let passed = false;

  for (let i = 0; i < 10; i++) {
    const html = await page.content();

    if (!html.includes("Just a moment")) {
      console.log("✅ Passed Cloudflare");
      passed = true;
      break;
    }

    console.log(`⏳ Cloudflare challenge... (${i + 1}/10)`);
    await page.waitForTimeout(3000);
  }

  if (!passed) {
    console.log("❌ Still blocked by Cloudflare");
    await browser.close();
    return;
  }

  // 🔍 Step 2: Check DOM
  const liCount = await page.evaluate(() =>
    document.querySelectorAll("li").length
  );

  const streamCount = await page.evaluate(() =>
    document.querySelectorAll("li[class*='stream']").length
  );

  console.log("📊 DOM stats:");
  console.log("Total <li>:", liCount);
  console.log("Stream items:", streamCount);

  // 🔍 Step 3: Dump snippet
  const html = await page.content();
  console.log("\n--- HTML SNIPPET ---");
  console.log(html.slice(0, 500));
  console.log("--- END SNIPPET ---\n");

  // 🔍 Step 4: Try extracting ONE card manually
  const sample = await page.evaluate(() => {
    const el = document.querySelector("li[class*='stream']");
    if (!el) return null;

    const card = el.querySelector(".card");
    if (!card) return "no .card";

    const name = card.querySelector("h3")?.innerText;
    const href = card.querySelector("a.bt-offers")?.getAttribute("href");

    return { name, href };
  });

  console.log("🧪 Sample extraction:", sample);

  console.log("\n👀 Browser left open for manual inspection.");
}

main();