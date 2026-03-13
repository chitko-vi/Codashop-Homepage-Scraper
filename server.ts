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
      await page.goto(url as string, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Remove overlays/popups that might block interaction
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
      const headerFound = await page.evaluate((categoryName) => {
        const allEls = Array.from(document.querySelectorAll("*"));
        for (const el of allEls) {
          if (["SCRIPT", "STYLE", "HEAD"].includes(el.tagName)) continue;
          const elementChildren = Array.from(el.children).filter(
            (c) => !["BR", "SPAN", "B", "I", "EM", "STRONG"].includes(c.tagName)
          );
          if (elementChildren.length > 2) continue;

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
      }, category as string);

      if (!headerFound) {
        // Return what headings ARE on the page to help debug
        const found = await page.evaluate(() => {
          const headings: string[] = [];
          document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
            const t = (h.textContent || "").trim();
            if (t && t.length < 80) headings.push(t);
          });
          return headings;
        });
        return res.status(404).json({
          error: `Category "${category}" not found on page`,
          found,
        });
      }

      const categoryHeader = page.locator('[data-coda-target="category-header"]').first();
      await categoryHeader.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);

      // ── Step 2: Click expand button (language-agnostic) ───────────────────
      // Looks for a button near the header — by class name, not label text.
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
            const isExpand =
              cls.includes("expand") ||
              cls.includes("view") ||
              cls.includes("more") ||
              cls.includes("all") ||
              cls.includes("see");
            return hasText && hasNoImg && isExpand;
          });

          if (expandBtn) {
            (expandBtn as HTMLElement).click();
            return true;
          }

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
        console.log("Expand button clicked, waiting for content...");
        await page.waitForTimeout(2000);
      }

      // Scroll to load lazy images
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(400);

      // ── Step 3: Extract products scoped ONLY to this section ──────────────
      //
      // THE FIX — why the old code leaked into other categories:
      // The old approach walked UP from the header to find a container with >1
      // link. That container was often a page-level wrapper holding ALL sections.
      // So all products from every section below were collected.
      //
      // THE NEW APPROACH uses compareDocumentPosition:
      // 1. Find the next section heading AFTER our marked header.
      // 2. Collect only anchors that are:
      //    - AFTER our header in DOM order
      //    - BEFORE the next section heading in DOM order
      // This gives us exactly the products in our section and nothing else.
      // It works regardless of nesting depth, button placement, or page language.

      const products = await page.evaluate(() => {
        const header = document.querySelector('[data-coda-target="category-header"]');
        if (!header) return { error: "Header marker not found" };

        const ourText = (header.textContent || "").trim().toUpperCase();

        // Find the next heading-like element that comes AFTER our header
        // and has different text — this marks the start of the next section.
        const headingCandidates = Array.from(document.querySelectorAll(
          "h1, h2, h3, h4, h5, h6, " +
          "[class*='section-title'], [class*='category-title'], " +
          "[class*='section-header'], [class*='category-header'], " +
          "[class*='section-name'], [class*='cat-title']"
        ));

        let nextSectionHeader: Element | null = null;
        for (const h of headingCandidates) {
          // Skip if this IS our header or contains it
          if (h === header || h.contains(header) || header.contains(h)) continue;

          // Check it comes AFTER our header in document order
          const position = header.compareDocumentPosition(h);
          const isAfter = !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
          if (!isAfter) continue;

          // Must have different text (skip decorative duplicates)
          const text = (h.textContent || "").trim().toUpperCase();
          if (!text || text === ourText) continue;

          nextSectionHeader = h;
          break; // first one found = closest next section
        }

        console.log(
          "Next section heading:",
          nextSectionHeader
            ? (nextSectionHeader.textContent || "").trim()
            : "none (using all remaining anchors)"
        );

        // Collect all anchors between our header and the next section header
        const allAnchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
        const results: { title: string; url: string; image: string }[] = [];
        const seen = new Set<string>();

        for (const anchor of allAnchors) {
          const href = anchor.href;
          if (!href || !href.includes("codashop.com")) continue;
          if (href.includes("terms") || href.includes("privacy") || href.includes("faq")) continue;
          if (href.split("/").length < 5) continue;

          // Must come AFTER our header
          const afterHeader = !!(
            header.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING
          );
          if (!afterHeader) continue;

          // Must come BEFORE the next section header (if one exists)
          if (nextSectionHeader) {
            const beforeNext = !!(
              nextSectionHeader.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_PRECEDING
            );
            if (!beforeNext) continue;
          }

          // Must have an image — product tiles always do, nav links don't
          const imgEl = anchor.querySelector("img") as HTMLImageElement | null;
          if (!imgEl) continue;

          // Title: alt text → visible text element → aria-label
          const altText = (imgEl.alt || "").trim();
          const textEl = anchor.querySelector(
            "p, h3, [class*='name'], [class*='title'], span"
          );
          const innerText = textEl ? (textEl.textContent || "").trim() : "";
          const ariaLabel = (anchor.getAttribute("aria-label") || "").trim();
          const title = altText || innerText || ariaLabel;
          if (!title) continue;

          // Image: src → data-src → srcset first item
          let image =
            imgEl.src ||
            imgEl.getAttribute("data-src") ||
            imgEl.getAttribute("data-lazy-src") ||
            "";
          if (!image) {
            const srcset =
              imgEl.getAttribute("srcset") ||
              imgEl.getAttribute("data-srcset") ||
              "";
            if (srcset) image = srcset.split(",")[0].trim().split(" ")[0];
          }

          if (!seen.has(href)) {
            seen.add(href);
            results.push({ title, url: href, image });
          }
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
          error: (products as { error: string }).error || "Unknown extraction error",
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
