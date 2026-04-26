import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
console.log("✅ Browser launched");
await browser.close();