import express from "express";
import { createServer as createViteServer } from "vite";
import { chromium } from "playwright";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get(["/scrape", "/api/scrape"], async (req, res) => {
    const { url, category } = req.query;

    if (!url || !category) {
      return res.status(400).json({ error: "Missing url or category parameter" });
    }

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();

      await page.route("**/*", (route) => {
        const reqUrl = route.request().url();
        const blocked = ["wiz-iframe-intent", "intentPreview", "analytics", "gtm", "facebook", "hotjar"];
        if (blocked.some((b) => reqUrl.includes(b))) return route.abort();
        return route.continue();
      });

      console.log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      await page.evaluate(() => {
        ["#intentPreview", "wiz-iframe-intent", ".modal-backdrop", ".popup-overlay"].forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });
        document.body.style.pointerEvents = "auto";
        document.body.style.overflow = "auto";
      });

      await page.waitForSelector('a[data-testid="product-tile"], a[class*="product-tile"]', { timeout: 15000 })
        .catch(() => console.log("No product tile selector matched, continuing..."));

      // ── Step 1: Find and mark the category header ─────────────────────────
      // Pass category as an argument to avoid closure capture issues with bundlers
      // Use ONLY arrow functions inside evaluate to prevent __name injection
      const headerFound = await page.evaluate((categoryName) => {
        const allEls = Array.from(document.querySelectorAll("*"));
        for (const el of allEls) {
          if (["SCRIPT", "STYLE", "HEAD"].includes(el.tagName)) continue;
          const elementChildren = Array.from(el.children).filter(
            (c) => !["BR", "SPAN", "B", "I", "EM", "STRONG"].includes(c.tagName)
          );
          if (elementChildren.length > 2) continue;

          // Normalise inline — no named function declaration
          const normalised = (el.textContent || "")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim();
          const target = categoryName
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim();

          if (normalised === target) {
            el.setAttribute("data-coda-target", "category-header");
            return true;
          }
        }
        return false;
      }, category as string);  // pass as arg, not closure

      if (!headerFound) {
        return res.status(404).json({ error: `Category "${category}" not found on page` });
      }

      const categoryHeader = page.locator('[data-coda-target="category-header"]').first();
      await categoryHeader.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);

      // ── Step 2: Click expand button (language-agnostic, arrow fns only) ───
      const clicked = await page.evaluate(() => {
        const header = document.querySelector('[data-coda-target="category-header"]');
        if (!header) return false;

        let container = header.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!container) break;
          const buttons = Array.from(container.querySelectorAll("button"));
          const expandBtn = buttons.find((btn) => {
            const hasText = (btn.textContent || "").trim().length > 0;
            const hasNoImg = !btn.querySelector("img");
            const cls = (btn.className || "").toLowerCase();
            const isExpand = cls.includes("expand") || cls.includes("view") || cls.includes("more");
            return hasText && hasNoImg && isExpand;
          });

          if (expandBtn) {
            (expandBtn as HTMLElement).click();
            return true;
          }

          // Fallback: only non-product button in container
          const candidates = buttons.filter((btn) => {
            const txt = (btn.textContent || "").trim();
            return txt.length > 0 && txt.length < 50 && !btn.querySelector("img");
          });
          if (candidates.length === 1) {
            (candidates[0] as HTMLElement).click();
            return true;
          }

          container = container.parentElement;
        }
        return false;
      });

      if (clicked) {
        console.log("Expand button clicked");
        await page.waitForTimeout(2000);
      }

      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(500);

      // ── Step 3: Extract products (arrow fns only) ─────────────────────────
      const products = await page.evaluate(() => {
        const header = document.querySelector('[data-coda-target="category-header"]');
        if (!header) return { error: "Header marker not found" };

        let container = header.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!container) break;
          if (container.querySelectorAll('a[href*="/"]').length > 1) break;
          container = container.parentElement;
        }
        if (!container) return { error: "Section container not found" };

        const anchors = Array.from(container.querySelectorAll("a"));
        const results: { title: string; url: string; image: string }[] = [];
        const seen = new Set<string>();

        for (const anchor of anchors) {
          const href = (anchor as HTMLAnchorElement).href;
          if (
            !href ||
            !href.includes("codashop.com") ||
            href.includes("terms") ||
            href.includes("privacy") ||
            href.split("/").length < 5
          ) continue;

          const imgEl = anchor.querySelector("img") as HTMLImageElement | null;
          const altText = (imgEl ? imgEl.alt : "").trim();
          const textEl = anchor.querySelector("p, h3, [class*='name'], [class*='title'], span");
          const title = altText || (textEl ? textEl.textContent.trim() : "");

          let image = "";
          if (imgEl) {
            const srcset = imgEl.getAttribute("srcset") || imgEl.getAttribute("data-srcset") || "";
            image = imgEl.src || imgEl.dataset.src || srcset.split(",")[0].trim().split(" ")[0] || "";
          }

          if (title && href && !seen.has(href)) {
            seen.add(href);
            results.push({ title, url: href, image });
          }
        }

        return results;
      });

      // Clean up marker
      await page.evaluate(() => {
        document.querySelectorAll('[data-coda-target="category-header"]').forEach((el) => {
          el.removeAttribute("data-coda-target");
        });
      });

      if (!Array.isArray(products)) {
        return res.status(500).json({ error: (products as any).error || "Unknown extraction error" });
      }

      console.log(`Found ${products.length} products in "${category}"`);
      res.json(products);

    } catch (error: any) {
      console.error("Scraping error:", error);
      res.status(500).json({ error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();