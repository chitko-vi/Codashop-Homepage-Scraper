export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { url, category } = req.query;

  if (!url || !category) {
    return res.status(400).json({ error: "Missing url or category parameter" });
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Failed to fetch page: ${response.status}` });
    }

    const html = await response.text();

    // ── Step 1: Find the position of our category heading ─────────────────────
    const categoryUpper = category.trim().toUpperCase();
    const escaped = categoryUpper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Match the category text sitting between > and < (i.e. a text node)
    const headingRegex = new RegExp(">\\s*" + escaped + "\\s*<", "i");
    const headingTestMatch = html.match(headingRegex);

    if (!headingTestMatch) {
      return res.status(404).json({
        error: `Category "${category}" not found on this page.`,
        found: findAllSectionHeadings(html),
      });
    }

    const headingPos = html.indexOf(headingTestMatch[0]);

    // ── Step 2: Find where this section ends ──────────────────────────────────
    //
    // PREVIOUS BUG: scanned gap-by-gap between </a> tags. When a <button>
    // (View All) sat in a gap, the whole gap was skipped — even if it also
    // contained the next section heading. The boundary was missed and products
    // from the next category bled in.
    //
    // FIX: scan forward from our heading looking for the NEXT heading-like
    // HTML element (h1-h6, or a div/span/p/section with a title/heading class).
    // These are real structural headings — UI buttons and product text never use
    // these tags/classes, so we get a clean cut every time.

    const sectionEnd = findNextHeadingPosition(html, headingPos, categoryUpper);
    const sectionHtml = html.substring(headingPos, sectionEnd);

    // ── Step 3: Extract all product tiles from the scoped section ─────────────
    const results = extractProducts(sectionHtml);

    if (results.length === 0) {
      return res.status(404).json({
        error: `"${category}" section was found but contained no product tiles.`,
        hint: "The page structure may differ. Try inspecting the raw HTML.",
        found: findAllSectionHeadings(html),
      });
    }

    return res.status(200).json(results);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// findNextHeadingPosition
//
// Returns the index in `html` of the next section heading that appears AFTER
// `startPos` and has different text than `currentCategory`.
//
// We look for two kinds of heading elements:
//   1. Plain <h1>–<h6> tags            — e.g. <h2>GET YOUR CASHBACK</h2>
//   2. Elements with a title-like class — e.g. <div class="section-title">...
//
// Anything else (buttons, spans without title class, product <p> tags, etc.)
// is ignored, so subtitle text or UI labels can never cause a false cut.
// ─────────────────────────────────────────────────────────────────────────────
function findNextHeadingPosition(html, startPos, currentCategory) {
  // Pattern 1 — plain heading tags: <h1> … </h1>  through  <h6> … </h6>
  const plainHeadingRegex = /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/gi;

  // Pattern 2 — elements whose class contains a title/heading keyword
  const classedHeadingRegex =
    /<(?:div|section|span|p|li|a)[^>]+class="[^"]*(?:section-title|section-header|category-title|category-header|header-title|section-name|cat-title|game-category)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|span|p|li|a)>/gi;

  let earliest = html.length; // default: use the whole page

  // Check plain heading tags
  let m;
  plainHeadingRegex.lastIndex = 0;
  while ((m = plainHeadingRegex.exec(html)) !== null) {
    if (m.index <= startPos) continue;
    const text = m[3].replace(/<[^>]+>/g, "").trim().toUpperCase();
    if (!text || text === currentCategory) continue;
    if (m.index < earliest) { earliest = m.index; break; }
  }

  // Check classed heading elements
  classedHeadingRegex.lastIndex = 0;
  while ((m = classedHeadingRegex.exec(html)) !== null) {
    if (m.index <= startPos) continue;
    if (m.index >= earliest) break; // already found something earlier
    const text = m[1].replace(/<[^>]+>/g, "").trim().toUpperCase();
    if (!text || text === currentCategory) continue;
    earliest = m.index;
    break;
  }

  return earliest;
}

// ─────────────────────────────────────────────────────────────────────────────
// extractProducts
//
// Splits the scoped section HTML on </a> and extracts href + image + title
// from each chunk. Because the HTML is already cut to just the right section,
// nothing from other categories can appear here.
// ─────────────────────────────────────────────────────────────────────────────
function extractProducts(sectionHtml) {
  const chunks = sectionHtml.split(/<\/a>/i);
  const results = [];
  const seen = new Set();

  for (const chunk of chunks) {
    // ── URL: must be a relative product path with at least 2 segments ──────
    const hrefMatch = chunk.match(/href="(\/[^"#?]{5,})"/);
    if (!hrefMatch) continue;
    const path = hrefMatch[1];
    if (path.split("/").length < 3) continue;

    // ── Image: try src, data-src, srcset in order ───────────────────────────
    let image = "";
    const srcMatch = chunk.match(/\bsrc="(https?:\/\/[^"]+)"/);
    if (srcMatch) {
      image = srcMatch[1];
    } else {
      const dataSrc = chunk.match(/data-src="([^"]+)"/);
      if (dataSrc) {
        image = dataSrc[1];
      } else {
        const srcset = chunk.match(/srcset="([^"]+)"/);
        if (srcset) image = srcset[1].split(",")[0].trim().split(" ")[0];
      }
    }
    if (!image) continue;
    if (!image.startsWith("http")) image = "https://cdn1.codashop.com" + image;

    // ── Title: alt text is most reliable, then <p> inner text ───────────────
    let title = "";
    const altMatch = chunk.match(/alt="([^"<>]+)"/);
    if (altMatch) title = altMatch[1].trim();

    if (!title) {
      const pMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (pMatch) title = pMatch[1].replace(/<[^>]+>/g, "").trim();
    }

    if (!title || title.includes("<")) continue;

    const fullUrl = "https://www.codashop.com" + path;
    if (!seen.has(fullUrl)) {
      seen.add(fullUrl);
      results.push({ title, url: fullUrl, image });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// findAllSectionHeadings
//
// Returns a list of heading texts found on the page — shown to the user when
// their category name doesn't match anything.
// ─────────────────────────────────────────────────────────────────────────────
function findAllSectionHeadings(html) {
  const headings = [];
  const regex = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (text && text.length >= 2 && text.length <= 80 && !headings.includes(text)) {
      headings.push(text);
    }
    if (headings.length >= 20) break;
  }
  return headings;
}
