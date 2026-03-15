// api/scrape.js
// Runs on Vercel as a serverless function.
// Fetches the Codashop page server-side (no CORS issue) and parses
// it using the exact class names from the real Codashop HTML:
//
//   <div class="product-list">
//     <div class="product-list__title">VOUCHERS</div>
//     <div class="grid-container">
//       <a class="product-tile" href="/en-ph/...">
//         <img src="..." alt="Product Name">
//         <div class="product-name">Product Name</div>
//       </a>
//     </div>
//     <div class="expand-container">
//       <button class="expand-button">View All</button>
//     </div>
//   </div>

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { url, category } = req.query;
  if (!url || !category) {
    return res.status(400).json({ error: "Missing url or category parameter" });
  }

  const categoryTarget = category.trim().toUpperCase();

  // ── Fetch the page HTML server-side ──────────────────────────────────────
  let html;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Failed to fetch page: ${response.status}` });
    }
    html = await response.text();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  // ── Find all product-list sections ───────────────────────────────────────
  // Split the HTML on each opening <div ... class="product-list" ...>
  // so each chunk is one category section.
  const sections = splitIntoSections(html);

  if (sections.length === 0) {
    return res.status(404).json({
      error: "No product-list sections found. The page structure may have changed.",
    });
  }

  // ── Find the section whose title matches our category ─────────────────────
  const availableTitles = [];
  let matchedSection = null;

  for (const section of sections) {
    const title = extractTitle(section);
    if (title) availableTitles.push(title);
    if (title && title.toUpperCase() === categoryTarget) {
      matchedSection = section;
    }
  }

  if (!matchedSection) {
    return res.status(404).json({
      error: `Category "${category}" not found on this page.`,
      found: availableTitles,
    });
  }

  // ── Extract tiles from the matched section ONLY ───────────────────────────
  const products = extractTiles(matchedSection, url);

  if (products.length === 0) {
    return res.status(404).json({
      error: `"${category}" section found but contained no product tiles.`,
      found: availableTitles,
    });
  }

  return res.status(200).json(products);
}

// ─────────────────────────────────────────────────────────────────────────────
// splitIntoSections
//
// Splits the full HTML into individual product-list chunks.
// Each chunk starts at <div class="product-list"> and ends just before
// the next one starts — so tiles from different categories can never mix.
// ─────────────────────────────────────────────────────────────────────────────
function splitIntoSections(html) {
  // Match the opening tag of each .product-list div
  // Codashop uses: <div data-v-... class="product-list" data-testid="product-list">
  const sectionStartRegex = /<div[^>]*class="[^"]*product-list[^"]*"[^>]*>/g;
  const positions = [];
  let m;

  while ((m = sectionStartRegex.exec(html)) !== null) {
    // Skip if this is product-list__title or product-list__something
    // We only want the root product-list, not sub-elements
    const tag = m[0];
    if (/class="[^"]*product-list__/.test(tag)) continue;
    positions.push(m.index);
  }

  if (positions.length === 0) return [];

  // Slice HTML between consecutive positions
  const sections = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = positions[i + 1] || html.length;
    sections.push(html.substring(start, end));
  }
  return sections;
}

// ─────────────────────────────────────────────────────────────────────────────
// extractTitle
//
// Pulls text from <div class="product-list__title">...</div>
// ─────────────────────────────────────────────────────────────────────────────
function extractTitle(sectionHtml) {
  const match = sectionHtml.match(
    /class="[^"]*product-list__title[^"]*"[^>]*>([\s\S]*?)<\/div>/
  );
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// extractTiles
//
// Finds every <a class="product-tile"> inside the section and pulls:
//   - href  → product URL
//   - src   → tile image
//   - alt   → fallback title
//   - .product-name text → primary title
//
// Note on "View All":
// Codashop is a Nuxt SSR app. The initial HTML only contains the VISIBLE
// tiles (typically 12). The hidden tiles load dynamically when the button
// is clicked. Without a real browser we can only get the visible tiles.
// All visible tiles are included here — nothing is cut short.
// ─────────────────────────────────────────────────────────────────────────────
function extractTiles(sectionHtml, pageUrl) {
  // Split on </a> — each chunk is one anchor tag's content
  const chunks = sectionHtml.split(/<\/a>/i);
  const results = [];
  const seen = new Set();

  for (const chunk of chunks) {
    // Must be a product-tile anchor
    if (!chunk.includes('class="product-tile"') && !chunk.includes("product-tile")) continue;

    // Must have an href pointing to a product path
    const hrefMatch = chunk.match(/href="(\/[^"#?]+)"/);
    if (!hrefMatch) continue;
    const path = hrefMatch[1];
    // Skip short paths like /en-ph/ — needs at least 3 segments
    if (path.split("/").filter(Boolean).length < 2) continue;

    const fullUrl = `https://www.codashop.com${path}`;
    if (seen.has(fullUrl)) continue;

    // Image: prefer src, then first item of srcset
    let image = "";
    const srcMatch = chunk.match(/\bsrc="(https?:\/\/[^"]+)"/);
    if (srcMatch) {
      image = srcMatch[1];
    } else {
      const srcsetMatch = chunk.match(/srcset="([^"]+)"/);
      if (srcsetMatch) {
        image = srcsetMatch[1].split(",")[0].trim().split(" ")[0];
      }
    }
    if (!image) continue;

    // Title: prefer .product-name div text, fall back to img alt
    let title = "";
    const nameMatch = chunk.match(/class="[^"]*product-name[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (nameMatch) {
      title = nameMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
    }
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
