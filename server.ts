import express from "express";
import { createServer as createViteServer } from "vite";
import { chromium } from "playwright";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get(["/scrape", "/api/scrape"], async (req, res) => {
    const { url, category, all } = req.query;

    if (!url) {
      return res.status(400).json({ error: "Missing url parameter" });
    }
    if (!all && !category) {
      return res.status(400).json({ error: "Provide category=NAME or all=true" });
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

      await page.route("**/*", (route) => {
        const blocked = ["analytics", "gtm", "facebook", "hotjar", "intentPreview"];
        if (blocked.some((b) => route.request().url().includes(b))) return route.abort();
        return route.continue();
      });

      console.log(`Navigating to ${url}...`);
      await page.goto(url as string, { waitUntil: "domcontentloaded", timeout: 60000 });

      await page.waitForSelector(".product-list", { timeout: 15000 })
        .catch(() => console.log("WARNING: .product-list not found after 15s"));

      // ── MODE: all=true — scrape every category including hidden tiles ───────
      if (all === "true") {

        // Step 1: Count how many sections exist
        const sectionCount = await page.locator(".product-list").count();
        console.log(`Found ${sectionCount} product-list sections`);

        // Step 2: For each section, click its expand button if one exists.
        // We do this BEFORE extracting so hidden tiles are revealed.
        // We use Playwright's locator API (not page.evaluate) because we need
        // to click and wait — page.evaluate can't do async waits between clicks.
        for (let i = 0; i < sectionCount; i++) {
          const section   = page.locator(".product-list").nth(i);
          const expandBtn = section.locator("button.expand-button");

          if (await expandBtn.count() > 0) {
            const titleText = await section.locator(".product-list__title")
              .textContent()
              .catch(() => `section ${i}`);

            const before = await section.locator("a.product-tile").count();
            console.log(`[${titleText?.trim()}] Clicking expand button (${before} tiles visible)...`);

            await expandBtn.first().scrollIntoViewIfNeeded();
            await expandBtn.first().click();

            // Wait for tile count to stabilise (new tiles loaded)
            let prev   = before;
            let stable = 0;
            for (let attempt = 0; attempt < 10; attempt++) {
              await page.waitForTimeout(500);
              const now = await section.locator("a.product-tile").count();
              if (now === prev) {
                stable++;
                if (stable >= 2) break; // stable twice = done loading
              } else {
                stable = 0;
                prev   = now;
              }
            }

            const after = await section.locator("a.product-tile").count();
            console.log(`[${titleText?.trim()}] Tiles after expand: ${after}`);
          }
        }

        // Step 3: Now extract all tiles from all sections.
        // All expand buttons have been clicked so every tile is in the DOM.
        const results = await page.evaluate(() => {
          const allSections = Array.from(document.querySelectorAll(".product-list"));
          const output: {
            category: string;
            position: number;
            title:    string;
            url:      string;
            image:    string;
          }[] = [];

          for (const section of allSections) {
            const titleEl      = section.querySelector(".product-list__title");
            const categoryName = (titleEl?.textContent || "").trim();
            if (!categoryName) continue;

            const tiles = Array.from(
              section.querySelectorAll("a.product-tile")
            ) as HTMLAnchorElement[];

            tiles.forEach((tile, index) => {
              const href = tile.getAttribute("href") || "";
              if (!href) return;

              const fullUrl = href.startsWith("http")
                ? href
                : `https://www.codashop.com${href}`;

              const nameEl = tile.querySelector(".product-name");
              const imgEl  = tile.querySelector("img") as HTMLImageElement | null;
              const title  =
                (nameEl?.textContent || "").trim() ||
                (imgEl?.getAttribute("alt") || "").trim();
              if (!title) return;

              let image = imgEl?.getAttribute("src") || "";
              if (!image && imgEl) {
                const srcset = imgEl.getAttribute("srcset") || "";
                image = srcset.split(",")[0].trim().split(" ")[0];
              }

              output.push({
                category: categoryName,
                position: index + 1,
                title,
                url:   fullUrl,
                image,
              });
            });
          }

          return output;
        });

        if (!Array.isArray(results) || results.length === 0) {
          return res.status(404).json({ error: "No tiles found on this page." });
        }

        console.log(`All-mode: returning ${results.length} total tiles across ${sectionCount} sections`);
        return res.json(results);
      }

      // ── MODE: single category ──────────────────────────────────────────────
      const categoryTarget = (category as string).trim().toUpperCase();

      const allTitles  = await page.locator(".product-list__title").allTextContents();
      const normalised = allTitles.map((t) => t.replace(/\s+/g, " ").trim().toUpperCase());
      const sectionIndex = normalised.findIndex((t) => t === categoryTarget);

      if (sectionIndex === -1) {
        const available = allTitles.map((t) => t.trim()).filter(Boolean);
        return res.status(404).json({
          error: `Category "${category}" not found on this page.`,
          found: available,
        });
      }

      console.log(`Found "${category}" at index ${sectionIndex}`);
      const section = page.locator(".product-list").nth(sectionIndex);

      // Click expand button if present (scoped to this section only)
      const expandBtn = section.locator("button.expand-button");
      if (await expandBtn.count() > 0) {
        const before = await section.locator("a.product-tile").count();
        await expandBtn.first().scrollIntoViewIfNeeded();
        await expandBtn.first().click();
        console.log(`Clicked expand button (${before} tiles before)`);

        let prev   = before;
        let stable = 0;
        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(500);
          const now = await section.locator("a.product-tile").count();
          if (now === prev) { stable++; if (stable >= 2) break; }
          else { stable = 0; prev = now; }
        }
        console.log(`Tiles after expand: ${prev}`);
      }

      // Extract tiles from this section only
      const tileCount = await section.locator("a.product-tile").count();
      console.log(`Extracting ${tileCount} tiles for "${category}"...`);

      const products: { title: string; url: string; image: string }[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < tileCount; i++) {
        const tile = section.locator("a.product-tile").nth(i);
        const href = await tile.getAttribute("href") || "";
        if (!href || seen.has(href)) continue;

        const fullUrl = href.startsWith("http")
          ? href
          : `https://www.codashop.com${href}`;

        const nameEl = tile.locator(".product-name");
        let title    = "";
        if (await nameEl.count() > 0) {
          title = (await nameEl.first().textContent() || "").trim();
        }
        if (!title) {
          const imgEl = tile.locator("img");
          if (await imgEl.count() > 0) {
            title = (await imgEl.first().getAttribute("alt") || "").trim();
          }
        }
        if (!title) continue;

        const imgEl = tile.locator("img");
        let image   = "";
        if (await imgEl.count() > 0) {
          image = await imgEl.first().getAttribute("src") || "";
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
      console.error("Scraping error:", error.message);
      return res.status(500).json({ error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  });

  // ── Vite dev / production static serving ─────────────────────────────────
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
