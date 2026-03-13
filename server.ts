// ── Step 2: Click expand / View All button near this category ──────────────
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
      const cls = (el.className || "").toString().toLowerCase();

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
  try {
    await page.waitForFunction(
      (prev) => document.querySelectorAll('a[href*="codashop.com"]').length > prev,
      beforeCount,
      { timeout: 5000 }
    );
  } catch {
    // fallback: layout may change without anchor count increasing immediately
    await page.waitForTimeout(2000);
  }
}

// Extra scroll to force lazy rendering after expansion
await page.evaluate(() => window.scrollBy(0, 800));
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollBy(0, 800));
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);

// ── Step 3: Extract ONLY products visually inside this section ──────────────
const products = await page.evaluate(() => {
  const header = document.querySelector('[data-coda-target="category-header"]') as HTMLElement | null;
  if (!header) return { error: "Header marker not found" };

  const normalize = (s: string) =>
    s.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();

  const headerText = normalize(header.textContent || "").toUpperCase();
  const headerRect = header.getBoundingClientRect();

  // Find the next heading-like element BELOW this one visually
  const allEls = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
  let nextHeader: HTMLElement | null = null;
  let nextHeaderTop = Number.POSITIVE_INFINITY;

  for (const el of allEls) {
    if (el === header) continue;
    if (header.contains(el) || el.contains(header)) continue;

    const text = normalize(el.textContent || "");
    if (!text || text.length < 2 || text.length > 80) continue;

    // Skip obvious non-headings
    if (el.closest("a, button")) continue;
    if (["SCRIPT", "STYLE", "IMG", "SVG"].includes(el.tagName)) continue;

    const childEls = Array.from(el.children).filter(
      (c) => !["BR", "SPAN", "B", "I", "EM", "STRONG"].includes(c.tagName)
    );
    if (childEls.length > 2) continue;

    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) continue;

    const textUpper = text.toUpperCase();
    if (textUpper === headerText) continue;

    // Must be BELOW current header
    if (rect.top <= headerRect.bottom + 20) continue;

    // Prefer heading-like styling
    const style = window.getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize || "0");
    const fontWeight = parseInt(style.fontWeight || "400", 10);
    const looksHeadingLike =
      /^H[1-6]$/.test(el.tagName) ||
      fontSize >= 20 ||
      fontWeight >= 700 ||
      textUpper === text; // all caps style

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
      if (srcset) image = srcset.split(",")[0].trim().split(" ")[0];
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

  return results;
});
