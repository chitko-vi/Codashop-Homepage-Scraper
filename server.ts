import express from "express";
import { createServer as createViteServer } from "vite";
import { chromium, type Browser, type BrowserContext } from "playwright";
import path from "path";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get(["/scrape", "/api/scrape"], async (req, res) => {
    const { url, category } = req.query;

    if (!url || !category) {
      return res.status(400).json({ error: "Missing url or category parameter" });
    }

    if (typeof url !== "string" || typeof category !== "string") {
      return res.status(400).json({ error: "Invalid url or category parameter" });
    }

    let context: BrowserContext | null = null;

    try {
      const browser = await getBrowser();

      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        viewport: { width: 1440, height: 2000 },
      });

      const page = await context.newPage();

      await page.route("**/*", (route) => {
        const reqUrl = route.request().url().toLowerCase();
        const blocked = [
          "wiz-iframe-intent",
          "intentpreview",
          "analytics",
          "gtm",
          "facebook",
          "hotjar",
        ];

        if (blocked.some((b) => reqUrl.includes(b))) {
          return route.abort();
        }
        return route.continue();
      });

      console.log(`Navigating to ${url} ...`);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await page.evaluate(() => {
        [
          "#intentPreview",
          "wiz-iframe-intent",
          ".modal-backdrop",
          ".popup-overlay",
          "[id*='intent']",
          "[class*='intent']",
        ].forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });

        document.body.style.pointerEvents = "auto";
        document.body.style.overflow = "auto";
      });

      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1200);

      await page.waitForSelector('a[href*="codashop.com"]', { timeout: 15000 }).catch(() => {
        console.log("No product anchors matched early wait, continuing...");
      });

      // ── Step 1: Find and mark the category header ─────────────────────────
      const headerFound = await page.evaluate((categoryName) => {
        const normalize = (value: string) =>
          value
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim();

        const target = normalize(categoryName).toUpperCase();
        const allEls = Array.from(document.querySelectorAll("body *")) as HTMLElement[];

        for (const el of allEls) {
          if (["SCRIPT", "STYLE", "HEAD"].includes(el.tagName)) continue;
          if (el.closest("a, button")) continue;

          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          const elementChildren = Array.from(el.children).filter(
            (c) => !["BR", "SPAN", "B", "I", "EM", "STRONG"].includes(c.tagName)
          );
          if (elementChildren.length > 2) continue;

          const normalised = normalize(el.textContent || "").toUpperCase();
          if (!normalised) continue;

          if (
            normalised === target ||
            normalised.includes(target) ||
            target.includes(normalised)
          ) {
            el.setAttribute("data-coda-target", "category-header");
            return true;
          }
        }

        return false;
      }, category);

      if (!headerFound) {
        const found = await page.evaluate(() => {
          const headings: string[] = [];
          const normalize = (value: string) =>
            value
              .replace(/[\u200B-\u200D\uFEFF]/g, "")
              .replace(/\s+/g, " ")
              .trim();

          const allEls = Array.from(document.querySelectorAll("body *")) as HTMLElement[];

          for (const el of allEls) {
            if (el.closest("a, button")) continue;
            if (["SCRIPT", "STYLE", "HEAD"].includes(el.tagName)) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            const text = normalize(el.textContent || "");
            if (!text || text.length < 2 || text.length > 80) continue;

            const style = window.getComputedStyle(el);
            const fontSize = parseFloat(style.fontSize || "0");
            const fontWeight = parseInt(style.fontWeight || "400", 10);

            const looksHeadingLike =
              /^H[1-6]$/.test(el.tagName) ||
              fontSize >= 20 ||
              fontWeight >= 700 ||
              text === text.toUpperCase();

            if (!looksHeadingLike) continue;
            if (!headings.includes(text)) headings.push(text);
            if (headings.length >= 20) break;
          }

          return headings;
        });

        return res.status(404).json({
          error: `Category "${category}" not found on page`,
          found,
        });
      }

      const categoryHeader = page.locator('[data-coda-target="category-header"]').first();
      await categoryHeader.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);

      // ── Step 2: Click expand / View All button near this category ─────────
      const beforeCount = await page.locator('a[href*="codashop.com"]').count();

      const clicked = await page.evaluate(() => {
        const header = document.querySelector('[data-coda-target="category-header"]') as HTMLElement | null;
        if (!header) return false;

        let container: HTMLElement | null = header.parentElement;

        for (let i = 0; i < 8 && container; i++) {
          const candidates = Array.from(
            container.querySelectorAll("button, a, [role='button']")
          ) as HTMLElement[];

          const expandBtn = candidates.find((el) => {
            const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();

            const looksLikeExpand =
              text.includes("view all") ||
              text.includes("see all") ||
              text.includes("more") ||
              cls.includes("expand") ||
              cls.includes("view") ||
              cls.includes("more") ||
              cls.includes("all");

            const rect = el.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();

            const reasonablyNear =
              rect.top >= headerRect.top - 40 &&
              rect.top <= headerRect.bottom + 1200;

            return looksLikeExpand && reasonablyNear;
          });

          if (expandBtn) {
            expandBtn.click();
            return true;
          }

          container = container.parentElement;
        }

        return false;
      });

      if (clicked) {
        console.log(`Clicked expand/View All near "${category}"`);

        try {
          await page.waitForFunction(
            (prev) => document.querySelectorAll('a[href*="codashop.com"]').length > prev,
            beforeCount,
            { timeout: 5000 }
          );
        } catch {
          await page.waitForTimeout(2200);
        }
      } else {
        console.log(`No expand/View All button detected near "${category}"`);
      }

      // Force lazy-rendering after expansion
      await page.evaluate(() => window.scrollBy(0, 900));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollBy(0, 900));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);

      await categoryHeader.scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);

      // ── Step 3: Extract ONLY products visually inside this section ────────
      const extraction = await page.evaluate(() => {
        const normalize = (value: string) =>
          value
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim();

        const header = document.querySelector('[data-coda-target="category-header"]') as HTMLElement | null;
        if (!header) return { error: "Header marker not found" };

        const headerText = normalize(header.textContent || "").toUpperCase();
        const headerRect = header.getBoundingClientRect();

        const allEls = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
        let nextHeader: HTMLElement | null = null;
        let nextHeaderTop = Number.POSITIVE_INFINITY;

        for (const el of allEls) {
          if (el === header) continue;
          if (header.contains(el) || el.contains(header)) continue;
          if (el.closest("a, button")) continue;
          if (["SCRIPT", "STYLE", "IMG", "SVG"].includes(el.tagName)) continue;

          const rect = el.getBoundingClientRect();
          if (rect.height <= 0 || rect.width <= 0) continue;
          if (rect.top <= headerRect.bottom + 20) continue;

          const text = normalize(el.textContent || "");
          if (!text || text.length < 2 || text.length > 80) continue;

          const textUpper = text.toUpperCase();
          if (textUpper === headerText) continue;

          const childEls = Array.from(el.children).filter(
            (c) => !["BR", "SPAN", "B", "I", "EM", "STRONG"].includes(c.tagName)
          );
          if (childEls.length > 2) continue;

          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize || "0");
          const fontWeight = parseInt(style.fontWeight || "400", 10);

          const looksHeadingLike =
            /^H[1-6]$/.test(el.tagName) ||
            fontSize >= 20 ||
            fontWeight >= 700 ||
            textUpper === text;

          if (!looksHeadingLike) continue;

          if (rect.top < nextHeaderTop) {
            nextHeader = el;
            nextHeaderTop = rect.top;
          }
        }

        const allAnchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
        const results: { title: string; url: string; image: string }[] = [];
        const seen = new Set<string>();

        for (const anchor of allAnchors) {
          const href = anchor.href;
          if (!href || !href.includes("codashop.com")) continue;
          if (href.includes("terms") || href.includes("privacy") || href.includes("faq")) continue;
          if (href.split("/").length < 5) continue;

          const rect = anchor.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          // Must be below the selected header
          if (rect.top <= headerRect.bottom + 10) continue;

          // Must be above the next section header, if found
          if (nextHeader && rect.top >= nextHeaderTop - 10) continue;

          // Must look like a product tile
          const imgEl = anchor.querySelector("img") as HTMLImageElement | null;
          if (!imgEl) continue;

          let image =
            imgEl.currentSrc ||
            imgEl.src ||
            imgEl.getAttribute("data-src") ||
            imgEl.getAttribute("data-lazy-src") ||
            "";

          if (!image) {
            const srcset =
              imgEl.getAttribute("srcset") ||
              imgEl.getAttribute("data-srcset") ||
              "";
            if (srcset) {
              image = srcset.split(",")[0].trim().split(" ")[0];
            }
          }

          if (!image) continue;

          const altText = (imgEl.alt || "").trim();
          const textEl = anchor.querySelector("p, h3, [class*='name'], [class*='title'], span");
          const innerText = textEl ? normalize(textEl.textContent || "") : "";
          const ariaLabel = normalize(anchor.getAttribute("aria-label") || "");
          const title = altText || innerText || ariaLabel;

          if (!title) continue;

          if (!seen.has(href)) {
            seen.add(href);
            results.push({ title, url: href, image });
          }
        }

        return {
          debug: {
            selectedHeader: normalize(header.textContent || ""),
            nextHeaderText: nextHeader ? normalize(nextHeader.textContent || "") : null,
            nextHeaderTop: Number.isFinite(nextHeaderTop) ? nextHeaderTop : null,
          },
          products: results,
        };
      });

      await page.evaluate(() => {
        document.querySelectorAll('[data-coda-target="category-header"]').forEach((el) => {
          el.removeAttribute("data-coda-target");
        });
      });

      if (!extraction || typeof extraction !== "object" || !("products" in extraction)) {
        return res.status(500).json({ error: "Unknown extraction error" });
      }

      if ("error" in extraction) {
        return res.status(500).json({
          error: extraction.error || "Unknown extraction error",
        });
      }

      const { debug, products } = extraction as {
        debug: {
          selectedHeader: string;
          nextHeaderText: string | null;
          nextHeaderTop: number | null;
        };
        products: { title: string; url: string; image: string }[];
      };

      console.log(`Selected header: ${debug.selectedHeader}`);
      console.log(`Next section header: ${debug.nextHeaderText ?? "none"}`);
      console.log(`Found ${products.length} products in "${category}"`);

      if (!Array.isArray(products) || products.length === 0) {
        return res.status(404).json({
          error: `"${category}" section was found but no product tiles were extracted.`,
          debug,
        });
      }

      return res.json(products);
    } catch (error: any) {
      console.error("Scraping error:", error);
      return res.status(500).json({ error: error.message || "Unknown scraping error" });
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
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
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
