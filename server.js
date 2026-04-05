import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const axeSource = require("axe-core").source;

const app = express();
app.use(cors());
app.use(express.json());

// ─── Health check ────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ status: "ok" }));

// ─── Main audit endpoint ─────────────────────────────────────────
app.post("/audit", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL requerida" });

  let browser;
  try {
    // 1. Lanzar navegador headless
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (compatible; AccessibilityAuditor/1.0)"
    );

    // 2. Navegar a la URL (timeout 20s)
    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });

    // 3. Capturar HTML y título
    const pageTitle = await page.title();
    const pageHTML = await page.evaluate(() => document.documentElement.outerHTML);

    // 4. Ejecutar axe-core en el contexto de la página
    await page.evaluate(axeSource);
    const axeResults = await page.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
    });

    // 5. Capturar screenshot para el heat map
    const screenshot = await page.screenshot({
      encoding: "base64",
      fullPage: false,
      clip: { x: 0, y: 0, width: 1280, height: 900 },
    });

    await browser.close();
    browser = null;

    // 6. Procesar resultados axe
    const violations = axeResults.violations.map((v) => ({
      id:          v.id,
      severity:    mapImpact(v.impact),
      title:       v.help,
      wcag:        extractWCAG(v.tags),
      category:    mapCategory(v.tags),
      description: v.description,
      helpUrl:     v.helpUrl,
      nodes:       v.nodes.slice(0, 3).map((n) => ({
        html:    n.html,
        target:  n.target?.[0] || "",
        message: n.failureSummary?.replace("Fix any of the following:\n", ""),
      })),
    }));

    const passes = axeResults.passes.length;
    const total  = violations.length + passes;

    // 7. Calcular score
    const score = calcScore(violations);

    res.json({
      url,
      pageTitle,
      violations,
      stats: {
        critical: violations.filter((v) => v.severity === "critical").length,
        serious:  violations.filter((v) => v.severity === "serious").length,
        moderate: violations.filter((v) => v.severity === "moderate").length,
        minor:    violations.filter((v) => v.severity === "minor").length,
        total:    violations.length,
        passedChecks: passes,
        totalChecks:  total,
      },
      score,
      screenshot, // base64 para el frontend
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("Audit error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────
function mapImpact(impact) {
  return { critical: "critical", serious: "serious", moderate: "moderate", minor: "minor" }[impact] || "minor";
}

function extractWCAG(tags) {
  const wcag = tags.find((t) => /wcag\d\d\d/.test(t));
  if (!wcag) return "WCAG";
  const code = wcag.replace("wcag", "");
  return `${code[0]}.${code[1]}.${code.slice(2)}`;
}

function mapCategory(tags) {
  if (tags.some((t) => ["wcag111","wcag121","wcag131","wcag141","wcag143","wcag145"].includes(t))) return "Perceptible";
  if (tags.some((t) => ["wcag211","wcag212","wcag241","wcag243"].includes(t))) return "Operable";
  if (tags.some((t) => ["wcag311","wcag321","wcag331"].includes(t))) return "Comprensible";
  return "Robusto";
}

function calcScore(violations) {
  const weights = { critical: 15, serious: 8, moderate: 4, minor: 1 };
  const penalty = violations.reduce((sum, v) => sum + (weights[v.severity] || 1), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

// ─── Iniciar servidor ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Audit server running on port ${PORT}`));
