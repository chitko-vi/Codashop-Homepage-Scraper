// api/scrape.js
// Two modes:
//   ?url=...&category=VOUCHERS   → single category (original behaviour)
//   ?url=...&all=true            → all categories with position tracking

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { url, category, all } = req.query;

  if (!url) return res.status(400).json({ error: "Missing url parameter" });
  if (!all && !category) return res.status(400).json({ error: "Provide category=NAME or all=true" });

  // ── Fetch page HTML ───────────────────────────────────────────────────────
  let html;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) return res.status(502).json({ error: `Failed to fetch page: ${response.status}` });
    html = await response.text();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  const sections = splitIntoSections(html);
  if (sections.length === 0) {
    return res.status(404).json({ error: "No product-list sections found. Page structure may have changed." });
  }

  // ── Mode: all categories ──────────────────────────────────────────────────
  if (all === "true") {
    const results = [];
    for (const section of sections) {
      const categoryName = extractTitle(section);
      if (!categoryName) continue;
      const tiles = extractTiles(section);
      tiles.forEach((tile, index) => {
        results.push({ category: categoryName, position: index + 1, ...tile });
      });
    }
    if (results.length === 0) return res.status(404).json({ error: "No tiles found on this page." });
    return res.status(200).json(results);
  }

  // ── Mode: single category ─────────────────────────────────────────────────
  const categoryTarget = category.trim().toUpperCase();
  const availableTitles = [];
  let matchedSection = null;

  for (const section of sections) {
    const title = extractTitle(section);
    if (title) availableTitles.push(title);
    if (title && title.toUpperCase() === categoryTarget) matchedSection = section;
  }

  if (!matchedSection) {
    return res.status(404).json({ error: `Category "${category}" not found.`, found: availableTitles });
  }

  const products = extractTiles(matchedSection);
  if (products.length === 0) {
    return res.status(404).json({ error: `"${category}" found but contained no product tiles.`, found: availableTitles });
  }

  return res.status(200).json(products);
}

// ── Split full HTML into one chunk per .product-list ─────────────────────────
function splitIntoSections(html) {
  const regex = /<div[^>]*class="[^"]*product-list[^"]*"[^>]*>/g;
  const positions = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    if (/class="[^"]*product-list__/.test(m[0])) continue; // skip sub-elements
    positions.push(m.index);
  }
  if (positions.length === 0) return [];
  return positions.map((start, i) => html.substring(start, positions[i + 1] || html.length));
}

// ── Extract title from .product-list__title ───────────────────────────────────
function extractTitle(sectionHtml) {
  const match = sectionHtml.match(/class="[^"]*product-list__title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, "").trim();
}

// ── Extract all a.product-tile elements from a section ────────────────────────
function extractTiles(sectionHtml) {
  const chunks  = sectionHtml.split(/<\/a>/i);
  const results = [];
  const seen    = new Set();

  for (const chunk of chunks) {
    if (!chunk.includes("product-tile")) continue;

    const hrefMatch = chunk.match(/href="(\/[^"#?]+)"/);
    if (!hrefMatch) continue;
    const path = hrefMatch[1];
    if (path.split("/").filter(Boolean).length < 2) continue;

    const fullUrl = `https://www.codashop.com${path}`;
    if (seen.has(fullUrl)) continue;

    // Image: src first, then first item of srcset
    let image = "";
    const srcMatch = chunk.match(/\bsrc="(https?:\/\/[^"]+)"/);
    if (srcMatch) {
      image = srcMatch[1];
    } else {
      const srcsetMatch = chunk.match(/srcset="([^"]+)"/);
      if (srcsetMatch) image = srcsetMatch[1].split(",")[0].trim().split(" ")[0];
    }
    if (!image) continue;

    // Title: .product-name first, then img alt
    let title = "";
    const nameMatch = chunk.match(/class="[^"]*product-name[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (nameMatch) title = nameMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
    if (!title) {
      const altMatch = chunk.match(/\balt="([^"]+)"/);
      if (altMatch) title = altMatch[1].replace(/&amp;/g, "&").trim();
    }
    if (!title) continue;

    seen.add(fullUrl);
    results.push({ title, url: fullUrl, image });
  }

  return results;
}
