import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const axeSource = require("axe-core").source;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.json({ status: "ok", message: "Accessibility API running" }));

app.post("/audit", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL requerida" });

  const targetUrl = url.startsWith("http") ? url : `https://${url}`;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (compatible; AccessibilityAuditor/1.0)");

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 25000 });

    const pageTitle = await page.title();

    await page.evaluate(axeSource);
    const axeResults = await page.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
    });

    await browser.close();
    browser = null;

    const violations = axeResults.violations.map((v) => ({
      id: v.id,
      severity: mapImpact(v.impact),
      title: v.help,
      wcag: extractWCAG(v.tags),
      category: mapCategory(v.tags),
      description: v.description,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 3).map((n) => ({
        html: n.html,
        target: n.target?.[0] || "",
        message: n.failureSummary?.replace("Fix any of the following:\n", "").replace("Fix all of the following:\n", ""),
      })),
    }));

    const passes = axeResults.passes.length;
    const total = violations.length + passes;
    const score = calcScore(violations);

    res.json({
      url: targetUrl,
      pageTitle,
      score,
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
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("Audit error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function mapImpact(impact) {
  return { critical: "critical", serious: "serious", moderate: "moderate", minor: "minor" }[impact] || "minor";
}

function extractWCAG(tags) {
  const wcag = tags.find((t) => /wcag\d{3,}/.test(t));
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Audit server running on port ${PORT}`));
