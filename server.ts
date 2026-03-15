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
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
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

      // Wait for product lists to render
      await page.waitForSelector(".product-list", { timeout: 15000 })
        .catch(() => console.log("Timeout waiting for .product-list, continuing..."));

      const categoryTarget = (category as string).trim().toUpperCase();

      // ── Step 1: Find the index of the matching .product-list ───────────────
      //
      // Real Codashop HTML structure (confirmed from actual page):
      //
      //   <div class="product-list">
      //     <div class="product-list__title">VOUCHERS</div>
      //     <div class="grid-container">
      //       <a class="product-tile" href="/en-ph/...">
      //         <img src="..." alt="Product Name">
      //         <div class="product-name">Product Name</div>
      //       </a>
      //       ... more tiles ...
      //     </div>
      //     <div class="expand-container">
      //       <button class="expand-button">View All</button>  ← may or may not exist
      //     </div>
      //   </div>
      //   <div class="product-list">   ← next category, completely separate
      //     <div class="product-list__title">GET YOUR CASHBACK</div>
      //     ...
      //   </div>
      //
      // Every category is its own isolated .product-list div.
      // We find the one whose .product-list__title matches, then work
      // ONLY inside that div. We never touch any other .product-list.

      // Get all product-list titles to find the right index
      const titles = await page.locator(".product-list__title").allTextContents();
      const normalizedTitles = titles.map((t) => t.replace(/\s+/g, " ").trim().toUpperCase());
      const sectionIndex = normalizedTitles.findIndex((t) => t === categoryTarget);

      if (sectionIndex === -1) {
        const available = titles.map((t) => t.trim()).filter(Boolean);
        return res.status(404).json({
          error: `Category "${category}" not found on this page.`,
          found: available,
        });
      }

      console.log(`Found "${category}" at product-list index ${sectionIndex}`);

      // Get the specific .product-list element at that index
      const section = page.locator(".product-list").nth(sectionIndex);

      // ── Step 2: Click "View All" / expand button if it exists ──────────────
      //
      // The button has class "expand-button" and sits inside "expand-container".
      // We look for it ONLY inside our specific section locator.
      // We click by class — never by text — so this works in every language.

      const expandBtn = section.locator("button.expand-button");
      const expandExists = await expandBtn.count();

      if (expandExists > 0) {
        console.log("Expand button found — clicking...");
        await expandBtn.first().scrollIntoViewIfNeeded();
        await expandBtn.first().click();

        // Wait for new tiles to appear by polling tile count
        let prevCount = 0;
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(400);
          const count = await section.locator("a.product-tile").count();
          console.log(`  Tile count after expand: ${count}`);
          if (i > 0 && count === prevCount) break; // stable — done loading
          prevCount = count;
        }
        console.log(`Tiles after expand: ${prevCount}`);
      } else {
        console.log("No expand button — using all visible tiles.");
      }

      // ── Step 3: Collect all product tiles from THIS section ONLY ───────────
      //
      // section.locator("a.product-tile") is SCOPED to the section element.
      // It physically cannot return tiles from any other .product-list.

      const tileCount = await section.locator("a.product-tile").count();
      console.log(`Total tiles in section: ${tileCount}`);

      const products: { title: string; url: string; image: string }[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < tileCount; i++) {
        const tile = section.locator("a.product-tile").nth(i);

        // URL
        const href = await tile.getAttribute("href") || "";
        if (!href || seen.has(href)) continue;
        const fullUrl = href.startsWith("http")
          ? href
          : `https://www.codashop.com${href}`;

        // Title: .product-name is the most reliable, fall back to img alt
        const nameEl = tile.locator(".product-name");
        const nameCount = await nameEl.count();
        let title = "";
        if (nameCount > 0) {
          title = (await nameEl.first().textContent() || "").trim();
        }
        if (!title) {
          const imgEl = tile.locator("img");
          if (await imgEl.count() > 0) {
            title = (await imgEl.first().getAttribute("alt") || "").trim();
          }
        }
        if (!title) continue;

        // Image: get src from the img element (browser resolves it to absolute)
        let image = "";
        const imgEl = tile.locator("img");
        if (await imgEl.count() > 0) {
          image = await imgEl.first().getAttribute("src") || "";
          // If src is empty try srcset first item
          if (!image) {
            const srcset = await imgEl.first().getAttribute("srcset") || "";
            image = srcset.split(",")[0].trim().split(" ")[0];
          }
        }

        seen.add(href);
        products.push({ title, url: fullUrl, image });
      }

      if (products.length === 0) {
        return res.status(404).json({
          error: `"${category}" section found but contained no product tiles.`,
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
