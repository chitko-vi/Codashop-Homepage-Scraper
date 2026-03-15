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

      // Block irrelevant requests to speed things up
      await page.route("**/*", (route) => {
        const reqUrl = route.request().url();
        const blocked = ["wiz-iframe-intent", "intentPreview", "analytics", "gtm", "facebook", "hotjar"];
        if (blocked.some((b) => reqUrl.includes(b))) return route.abort();
        return route.continue();
      });

      console.log(`Navigating to ${url}...`);
      await page.goto(url as string, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Remove any overlays/popups that could block interaction
      await page.evaluate(() => {
        ["#intentPreview", "wiz-iframe-intent", ".modal-backdrop", ".popup-overlay"].forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });
        document.body.style.pointerEvents = "auto";
        document.body.style.overflow = "auto";
      });

      // Wait for product tiles to appear
      await page
        .waitForSelector('a[data-testid="product-tile"], a[class*="product-tile"], a img', {
          timeout: 15000,
        })
        .catch(() => console.log("No specific tile selector matched, continuing..."));

      // ── Step 1: Find and mark the category header ───────────────────────────
      const headerFound = await page.evaluate((categoryName) => {
        const allEls = Array.from(document.querySelectorAll("*"));
        for (const el of allEls) {
          if (["SCRIPT", "STYLE", "HEAD"].includes(el.tagName)) continue;

          // Only check elements that are leaf-ish (not giant containers)
          const meaningfulChildren = Array.from(el.children).filter(
            (c) => !["BR", "SPAN", "B", "I", "EM", "STRONG"].includes(c.tagName)
          );
          if (meaningfulChildren.length > 2) continue;

          const normalised = (el.textContent || "")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase();

          const target = categoryName
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase();

          if (normalised === target) {
            el.setAttribute("data-coda-target", "category-header");
            return true;
          }
        }
        return false;
      }, category as string);

      if (!headerFound) {
        // Collect available headings to help the user
        const available = await page.evaluate(() => {
          const headings: string[] = [];
          document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
            const t = (h.textContent || "").trim();
            if (t && t.length < 80) headings.push(t);
          });
          return headings.slice(0, 20);
        });
        return res.status(404).json({
          error: `Category "${category}" not found on page`,
          found: available,
        });
      }

      // Scroll the header into view so expand buttons become interactive
      const categoryHeader = page.locator('[data-coda-target="category-header"]').first();
      await categoryHeader.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);

      // ── Step 2: Click the expand / "View All" button if one exists ──────────
      // We look for it ONLY inside the category's section, identified by DOM
      // position — never by button label text so this works in any language.
      const clicked = await page.evaluate(() => {
        const header = document.querySelector('[data-coda-target="category-header"]');
        if (!header) return false;

        // Walk UP from header to find a section-like ancestor that contains buttons
        let container = header.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!container || container.tagName === "BODY") break;

          const buttons = Array.from(container.querySelectorAll("button"));

          // Find a button that looks like a "show more" control:
          // - has visible text
          // - no image inside (not a product card button)
          // - short text (not a description)
          const expandBtn = buttons.find((btn) => {
            const txt = (btn.textContent || "").trim();
            if (!txt || txt.length > 60 || btn.querySelector("img")) return false;
            const cls = (btn.className || "").toLowerCase();
            // Prefer buttons with expand-like class names
            if (
              cls.includes("expand") ||
              cls.includes("view") ||
              cls.includes("more") ||
              cls.includes("all") ||
              cls.includes("see")
            ) return true;
            // Also accept the only non-product button in the container
            return buttons.filter((b) => {
              const t = (b.textContent || "").trim();
              return t.length > 0 && t.length < 60 && !b.querySelector("img");
            }).length === 1;
          });

          if (expandBtn) {
            (expandBtn as HTMLElement).click();
            return true;
          }

          container = container.parentElement;
        }
        return false;
      });

      if (clicked) {
        console.log("Expand button clicked, waiting for tiles...");
        await page.waitForTimeout(2000);
      }

      // Scroll to load any lazy images
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(400);

      // ── Step 3: Extract products scoped STRICTLY to this section ───────────
      //
      // THE KEY FIX — previous bug:
      // The old code walked up from the header to find a container with 2+ links.
      // That container was often the entire page, so products from other categories
      // leaked in.
      //
      // THE FIX — use compareDocumentPosition:
      // This browser API tells us the exact DOM order relationship between any two
      // nodes. We collect tiles that are:
      //   (a) AFTER our category header in DOM order
      //   (b) BEFORE the next h1-h6 heading in DOM order
      // This works at any nesting depth, with any DOM structure, in any language.

      const products = await page.evaluate(() => {
        const header = document.querySelector('[data-coda-target="category-header"]');
        if (!header) return { error: "Header marker not found" };

        // Find the next h1-h6 heading that comes after our header in DOM order
        const allHeadings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"));
        const nextHeading = allHeadings.find((h) => {
          // DOCUMENT_POSITION_FOLLOWING = 4 means h comes after header
          return !!(header.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
        }) || null;

        // Collect all anchor tags that look like product tiles:
        // - contain an image
        // - link to a codashop.com product page (≥5 path segments)
        // - not a terms/privacy/footer link
        const allAnchors = Array.from(document.querySelectorAll("a")) as HTMLAnchorElement[];

        const scopedTiles = allAnchors.filter((a) => {
          // Must have an image child
          if (!a.querySelector("img")) return false;

          // Must be a product URL
          const href = a.href || "";
          if (!href.includes("codashop.com")) return false;
          if (href.includes("terms") || href.includes("privacy") || href.includes("about")) return false;
          if (href.split("/").length < 5) return false;

          // Must come AFTER our header in DOM order
          // DOCUMENT_POSITION_FOLLOWING = 4
          const afterHeader = !!(header.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
          if (!afterHeader) return false;

          // Must come BEFORE the next section heading (if one exists)
          if (nextHeading) {
            // DOCUMENT_POSITION_PRECEDING = 2
            const beforeNextHeading = !!(nextHeading.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
            if (!beforeNextHeading) return false;
          }

          return true;
        });

        // Extract data from each scoped tile
        const results: { title: string; url: string; image: string }[] = [];
        const seen = new Set<string>();

        for (const anchor of scopedTiles) {
          const href = anchor.href;
          if (seen.has(href)) continue;

          const imgEl = anchor.querySelector("img") as HTMLImageElement | null;

          // Title: alt text first, then any named text element inside the anchor
          const altText = (imgEl?.alt || "").trim();
          const textEl = anchor.querySelector(
            "p, h3, [class*='name'], [class*='title'], span"
          );
          const innerText = (textEl?.textContent || "").trim();
          const title = altText || innerText;
          if (!title) continue;

          // Image: prefer data-src (lazy load) over src
          let image = "";
          if (imgEl) {
            const srcset = imgEl.getAttribute("srcset") || imgEl.getAttribute("data-srcset") || "";
            image =
              imgEl.getAttribute("data-src") ||
              imgEl.src ||
              srcset.split(",")[0].trim().split(" ")[0] ||
              "";
          }

          seen.add(href);
          results.push({ title, url: href, image });
        }

        return results;
      });

      // Clean up the marker attribute
      await page.evaluate(() => {
        document.querySelectorAll('[data-coda-target="category-header"]').forEach((el) => {
          el.removeAttribute("data-coda-target");
        });
      });

      if (!Array.isArray(products)) {
        return res.status(500).json({
          error: (products as any).error || "Unknown extraction error",
        });
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
