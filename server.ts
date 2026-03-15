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
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();

      // Block trackers to speed up loading
      await page.route("**/*", (route) => {
        const blocked = ["analytics", "gtm", "facebook", "hotjar", "intentPreview"];
        if (blocked.some((b) => route.request().url().includes(b))) return route.abort();
        return route.continue();
      });

      console.log(`Navigating to ${url}...`);
      await page.goto(url as string, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Wait for at least one product-list to appear
      await page
        .waitForSelector(".product-list", { timeout: 15000 })
        .catch(() => console.log("Timeout waiting for .product-list, continuing..."));

      // ── Step 1: Find the right product-list by matching its title ───────────
      //
      // The real HTML structure from Codashop is:
      //
      //  <div class="product-list">
      //    <div class="product-list__title">VOUCHERS</div>
      //    <div class="grid-container">
      //      <a class="product-tile" href="/en-ph/...">...</a>
      //      <a class="product-tile" href="/en-ph/...">...</a>
      //    </div>
      //    <div class="expand-container">
      //      <button class="expand-button">View All</button>
      //    </div>
      //  </div>
      //
      // So we find the .product-list whose .product-list__title matches our
      // category, then click its .expand-button, then collect all .product-tile
      // inside it. We never touch any other .product-list on the page.

      const categoryTarget = (category as string).trim().toUpperCase();

      const sectionFound = await page.evaluate((target) => {
        const allLists = Array.from(document.querySelectorAll(".product-list"));
        for (const list of allLists) {
          const titleEl = list.querySelector(".product-list__title");
          if (!titleEl) continue;
          const titleText = (titleEl.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase();
          if (titleText === target) {
            list.setAttribute("data-coda-target", "active-section");
            return true;
          }
        }
        return false;
      }, categoryTarget);

      if (!sectionFound) {
        // Tell the user what categories are actually available
        const available = await page.evaluate(() => {
          return Array.from(document.querySelectorAll(".product-list__title"))
            .map((el) => (el.textContent || "").trim())
            .filter(Boolean);
        });
        return res.status(404).json({
          error: `Category "${category}" not found on this page.`,
          found: available,
        });
      }

      // ── Step 2: Click "View All" / expand button inside this section only ───
      //
      // The button has class "expand-button" and sits inside "expand-container".
      // We click it only if it exists inside our marked section.
      // We do NOT look at button text — so this works in any language.

      const expandClicked = await page.evaluate(() => {
        const section = document.querySelector('[data-coda-target="active-section"]');
        if (!section) return false;
        const btn = section.querySelector("button.expand-button") as HTMLElement | null;
        if (!btn) return false;
        btn.click();
        return true;
      });

      if (expandClicked) {
        console.log("Expand button clicked — waiting for hidden tiles to load...");
        // Wait for new tiles to appear: poll until tile count stops growing
        let prevCount = 0;
        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(500);
          const count = await page.evaluate(() => {
            const section = document.querySelector('[data-coda-target="active-section"]');
            return section ? section.querySelectorAll("a.product-tile").length : 0;
          });
          if (count > prevCount) {
            prevCount = count;
          } else {
            break; // count stabilised — all tiles loaded
          }
        }
        console.log(`Tiles after expand: ${prevCount}`);
      } else {
        console.log("No expand button found — using visible tiles only.");
      }

      // ── Step 3: Extract all product tiles from this section ONLY ────────────
      //
      // We collect every a.product-tile inside our marked .product-list.
      // Because we scoped to a single .product-list, tiles from other
      // categories are physically impossible to appear here.

      const products = await page.evaluate(() => {
        const section = document.querySelector('[data-coda-target="active-section"]');
        if (!section) return { error: "Section marker lost" };

        const tiles = Array.from(section.querySelectorAll("a.product-tile")) as HTMLAnchorElement[];
        const results: { title: string; url: string; image: string }[] = [];
        const seen = new Set<string>();

        for (const tile of tiles) {
          const href = tile.href || "";
          if (!href || seen.has(href)) continue;

          // Title: prefer .product-name text, fall back to img alt
          const nameEl = tile.querySelector(".product-name");
          const imgEl  = tile.querySelector("img");
          const title  =
            (nameEl?.textContent || "").trim() ||
            (imgEl?.getAttribute("alt") || "").trim();
          if (!title) continue;

          // Image: prefer src (already resolved by browser), fall back to srcset
          let image = imgEl?.src || "";
          if (!image && imgEl) {
            const srcset = imgEl.getAttribute("srcset") || "";
            image = srcset.split(",")[0].trim().split(" ")[0];
          }

          seen.add(href);
          results.push({ title, url: href, image });
        }

        return results;
      });

      // Clean up marker
      await page.evaluate(() => {
        const el = document.querySelector('[data-coda-target="active-section"]');
        if (el) el.removeAttribute("data-coda-target");
      });

      if (!Array.isArray(products)) {
        return res.status(500).json({ error: (products as any).error || "Extraction failed" });
      }

      if (products.length === 0) {
        return res.status(404).json({
          error: `"${category}" section found but no product tiles inside.`,
        });
      }

      console.log(`Returning ${products.length} products for "${category}"`);
      return res.json(products);

    } catch (error: any) {
      console.error("Scraping error:", error);
      return res.status(500).json({ error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  });

  // ── Dev / production static serving ──────────────────────────────────────
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
