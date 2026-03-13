/**
 * scraper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Codashop tile scraper — section-scoped, language-independent.
 *
 * Key behaviours
 * ──────────────
 * 1. Loads the target page with Puppeteer so JS-rendered content is present.
 * 2. Finds the section whose heading matches the requested category (case-
 *    insensitive, trimmed) without relying on any link-text heuristics.
 * 3. If a "View All" affordance exists inside that section it is triggered
 *    by CSS class — never by button label — so it works in every language.
 * 4. Collects product tiles from WITHIN THAT SECTION ONLY; the DOM walk
 *    never crosses into adjacent sections.
 * 5. Validates every result (title + url + image required) and deduplicates
 *    on URL before returning.
 */

import puppeteer, { Browser, Page } from "puppeteer";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ScrapedProduct {
  title: string;
  url:   string;
  image: string;
}

export interface ScrapeOptions {
  /** Full page URL, e.g. https://www.codashop.com/en-ph/ */
  url: string;
  /** Category heading text as it appears on the page, e.g. "VOUCHERS" */
  category: string;
  /** Milliseconds to wait after clicking "View All" (default 2 500) */
  expandWaitMs?: number;
  /** Puppeteer navigation timeout in ms (default 30 000) */
  timeoutMs?: number;
}

export interface ScrapeError {
  error:  string;
  found?: string[];
}

// ─── CSS class patterns (language-independent selectors) ─────────────────────

/**
 * Patterns used to recognise a "View All / See All / Load More" trigger.
 * We match on class names only — never on visible text.
 */
const VIEW_ALL_CLASS_PATTERNS = [
  "view-all",
  "viewall",
  "view_all",
  "see-all",
  "seeall",
  "load-more",
  "loadmore",
  "show-more",
  "showmore",
  "show-all",
  "showall",
  "btn-more",
  "more-btn",
  "expand",
];

/**
 * CSS selector that matches any element whose class attribute contains one
 * of the VIEW_ALL_CLASS_PATTERNS.
 */
function buildViewAllSelector(): string {
  return VIEW_ALL_CLASS_PATTERNS.map(p => `[class*="${p}"]`).join(", ");
}

// ─── Section-heading selectors ────────────────────────────────────────────────

/** Tags that are likely to carry a category section heading. */
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "p", "span", "div"];

/** Class substrings that indicate a section-title element. */
const HEADING_CLASS_HINTS = [
  "title",
  "heading",
  "section-name",
  "category-name",
  "label",
  "header",
];

// ─── Product-tile selectors ───────────────────────────────────────────────────

/**
 * Returns an array of candidate anchor selectors for product tiles,
 * ordered from most- to least-specific.
 */
function tileSelectors(): string[] {
  return [
    // Explicit data attributes
    "[data-gamename] a",
    "[data-product] a",
    "[data-category-item] a",
    // Class-fragment selectors
    "[class*='tile'] a",
    "[class*='product-card'] a",
    "[class*='game-card'] a",
    "[class*='item-card'] a",
    "[class*='product-item'] a",
    "[class*='game-item'] a",
    // Anchor is itself the tile
    "a[class*='tile']",
    "a[class*='product']",
    "a[class*='game']",
    "a[class*='item']",
    // Broad fallback: any anchor that has an img child
    "a:has(img)",
  ];
}

// ─── Helper: find the category section element ────────────────────────────────

/**
 * Runs inside the browser (page.evaluate) — finds the outermost container
 * whose heading text matches `categoryUpper` (case-insensitive, trimmed).
 *
 * Returns the container's unique `data-scraper-id` attribute value so the
 * caller can re-select it after "View All" expansion.
 */
async function findCategorySectionId(
  page: Page,
  categoryUpper: string,
): Promise<string | null> {
  return page.evaluate(
    (categoryUpper, headingTags, headingClassHints) => {
      // Walk every element that could be a section heading
      const candidates = Array.from(
        document.querySelectorAll(
          headingTags
            .map(tag => {
              const classSelectors = headingClassHints
                .map(h => `${tag}[class*="${h}"]`)
                .join(", ");
              return `${tag}, ${classSelectors}`;
            })
            .join(", "),
        ),
      );

      for (const el of candidates) {
        const text = (el.textContent ?? "").trim().toUpperCase();
        if (text !== categoryUpper) continue;

        // Walk UP to find the nearest block-level section container
        let container: Element | null = el;
        while (container) {
          const tag = container.tagName.toLowerCase();
          if (["section", "article"].includes(tag)) break;
          if (tag === "div") {
            // Accept this div if it contains more than just the heading
            const anchors = container.querySelectorAll("a");
            if (anchors.length > 0) break;
          }
          container = container.parentElement;
        }

        if (!container) continue;

        // Tag it so we can re-find it after DOM mutations
        const id = "scraper-section-" + Math.random().toString(36).slice(2);
        container.setAttribute("data-scraper-id", id);
        return id;
      }

      return null;
    },
    categoryUpper,
    HEADING_TAGS,
    HEADING_CLASS_HINTS,
  );
}

// ─── Helper: list all visible category headings (for error hints) ─────────────

async function listVisibleCategories(page: Page): Promise<string[]> {
  return page.evaluate((headingTags) => {
    const seen = new Set<string>();
    const results: string[] = [];

    for (const tag of headingTags) {
      for (const el of Array.from(document.querySelectorAll(tag))) {
        const text = (el.textContent ?? "").trim();
        if (text.length < 2 || text.length > 80) continue;
        if (seen.has(text.toUpperCase())) continue;
        // Must have a sibling/cousin anchor to be a real section heading
        const container = el.closest("section, article, div");
        if (!container) continue;
        if (container.querySelectorAll("a").length < 2) continue;
        seen.add(text.toUpperCase());
        results.push(text);
      }
    }

    return results;
  }, HEADING_TAGS);
}

// ─── Helper: click "View All" inside section, wait for new tiles ──────────────

async function expandViewAll(
  page: Page,
  sectionId: string,
  waitMs: number,
): Promise<void> {
  const selector = buildViewAllSelector();

  // Count tiles before expansion
  const before = await page.evaluate(
    (sectionId, selector) => {
      const section = document.querySelector(`[data-scraper-id="${sectionId}"]`);
      if (!section) return 0;

      // Find the "view all" trigger INSIDE this section
      const trigger = section.querySelector(selector) as HTMLElement | null;
      if (!trigger) return -1; // signals "no trigger found"

      trigger.click();
      return section.querySelectorAll("a").length;
    },
    sectionId,
    selector,
  );

  if (before === -1) return; // no view-all button in this section

  // Wait for new tiles to appear or for timeout
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const after = await page.evaluate(
      (sectionId) =>
        document
          .querySelector(`[data-scraper-id="${sectionId}"]`)
          ?.querySelectorAll("a").length ?? 0,
      sectionId,
    );
    if (after > before) break;
  }
}

// ─── Helper: extract product tiles from section ───────────────────────────────

async function extractTilesFromSection(
  page: Page,
  sectionId: string,
  baseUrl: string,
): Promise<ScrapedProduct[]> {
  return page.evaluate(
    (sectionId, tileSelectorsArr, baseUrl) => {
      const section = document.querySelector(
        `[data-scraper-id="${sectionId}"]`,
      );
      if (!section) return [];

      const results: Array<{ title: string; url: string; image: string }> = [];
      const seen = new Set<string>();

      for (const sel of tileSelectorsArr) {
        const anchors = Array.from(section.querySelectorAll(sel)) as HTMLAnchorElement[];

        for (const a of anchors) {
          // ── Resolve URL ──────────────────────────────────────────────────
          let href = (a.href ?? "").trim();
          if (!href || href === "#" || href.startsWith("javascript")) continue;

          // Make absolute
          try {
            href = new URL(href, baseUrl).href;
          } catch {
            continue;
          }

          if (seen.has(href)) continue;

          // ── Resolve image ────────────────────────────────────────────────
          const img = a.querySelector("img") as HTMLImageElement | null;
          if (!img) continue;

          // Prefer high-resolution src variants
          const rawSrc =
            img.getAttribute("data-src") ??
            img.getAttribute("data-lazy-src") ??
            img.getAttribute("srcset")?.split(",")[0]?.split(" ")[0]?.trim() ??
            img.src ??
            "";

          let imgSrc = rawSrc.trim();
          if (!imgSrc || imgSrc.startsWith("data:")) continue;

          try {
            imgSrc = new URL(imgSrc, baseUrl).href;
          } catch {
            continue;
          }

          // ── Resolve title ────────────────────────────────────────────────
          const altText = img.getAttribute("alt")?.trim() ?? "";
          const ariaLabel = a.getAttribute("aria-label")?.trim() ?? "";
          const titleAttr = a.getAttribute("title")?.trim() ?? "";

          // Look for an explicit title element inside the anchor
          const titleEl = a.querySelector(
            "[class*='title'], [class*='name'], [class*='label'], figcaption, p, span",
          );
          const innerText = titleEl?.textContent?.trim() ?? "";

          const title = innerText || altText || ariaLabel || titleAttr;
          if (!title) continue;

          seen.add(href);
          results.push({ title, url: href, image: imgSrc });
        }

        // Stop trying selectors once we have results
        if (results.length > 0) break;
      }

      return results;
    },
    sectionId,
    tileSelectors(),
    baseUrl,
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  return _browser;
}

export async function scrapeCategory(
  opts: ScrapeOptions,
): Promise<ScrapedProduct[] | ScrapeError> {
  const {
    url,
    category,
    expandWaitMs = 2500,
    timeoutMs   = 30_000,
  } = opts;

  const categoryUpper = category.trim().toUpperCase();

  const browser = await getBrowser();
  const page    = await browser.newPage();

  try {
    // Block heavy assets to speed things up
    await page.setRequestInterception(true);
    page.on("request", req => {
      const rt = req.resourceType();
      if (["font", "media", "websocket"].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36",
    );

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: timeoutMs,
    });

    // Extra wait for lazy-loaded content
    await new Promise(r => setTimeout(r, 1500));

    // ── 1. Find the section container ──────────────────────────────────────
    const sectionId = await findCategorySectionId(page, categoryUpper);

    if (!sectionId) {
      const found = await listVisibleCategories(page);
      return {
        error: `Category "${category}" not found on this page.`,
        found,
      };
    }

    // ── 2. Expand "View All" if present (language-independent) ─────────────
    await expandViewAll(page, sectionId, expandWaitMs);

    // ── 3. Extract tiles ONLY from the matched section ─────────────────────
    const raw = await extractTilesFromSection(page, sectionId, url);

    if (raw.length === 0) {
      const found = await listVisibleCategories(page);
      return {
        error: `Category "${category}" was found but contained no product tiles.`,
        found,
      };
    }

    // ── 4. Final dedupe pass ────────────────────────────────────────────────
    const seen = new Set<string>();
    const clean: ScrapedProduct[] = [];
    for (const p of raw) {
      if (!p.title || !p.url || !p.image) continue;
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      clean.push(p);
    }

    return clean;

  } finally {
    await page.close();
  }
}
