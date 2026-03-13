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

    // ── Step 1: Find our category heading ────────────────────────────────────
    const escaped = category.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRegex = new RegExp(">\\s*" + escaped + "\\s*<", "i");
    const headingMatch = html.match(headingRegex);

    if (!headingMatch) {
      return res.status(404).json({
        error: `Category "${category}" not found on this page.`,
        found: findAllHeadings(html),
      });
    }

    const headingPos = html.indexOf(headingMatch[0]);

    // ── Step 2: Find where this section ENDS ─────────────────────────────────
    //
    // THE BUG that was here before:
    // The old code scanned gap-by-gap between </a> and <a> tags.
    // When a gap contained a <button> (the "View All" button), it skipped the
    // gap entirely — even if that same gap ALSO contained the next section
    // heading. So the section boundary was silently skipped and products from
    // the next category bled in.
    //
    // THE FIX:
    // Instead of scanning gaps, we blank out ALL <a>…</a> content by replacing
    // it with null bytes (same length so positions are preserved). Then we search
    // forward for the next heading-like text that is NOT inside an anchor tag.
    // Buttons, divs, and hidden elements are all visible in this search, so the
    // real section boundary is never missed.

    // Replace every <a>…</a> with null bytes of the same length.
    // This preserves string positions while hiding anchor text from our search.
    const blanked = html.replace(/<a[\s\S]*?<\/a>/gi, (m) => "\x00".repeat(m.length));

    // Search from just after our heading
    const searchFrom = headingPos + headingMatch[0].length;
    const searchArea = blanked.substring(searchFrom);

    // Match >TEXT< where TEXT contains no null bytes — meaning it is NOT
    // inside an anchor tag and therefore could be a real section heading.
    const nextHeadingRegex = />([^\x00<>]{2,80})</g;
    let sectionEnd = html.length; // default: use everything until end of page
    let m;

    while ((m = nextHeadingRegex.exec(searchArea)) !== null) {
      const text = m[1].trim();
      if (!text || text.length < 2) continue;

      // Skip our own heading if somehow matched again
      if (text.toUpperCase() === category.trim().toUpperCase()) continue;

      // Must contain at least one letter
      if (!/[A-Za-z]/.test(text)) continue;

      // Skip if it contains characters that indicate a URL, CSS, or code
      if (/[/{}\\<>@#=|]/.test(text)) continue;

      // Skip if it starts with a digit (likely a number, not a heading)
      if (/^\s*\d/.test(text)) continue;

      // Skip common UI strings in any language by checking for substrings
      // that appear in known "expand" affordances
      const lower = text.toLowerCase();
      if (
        lower.includes("view all") ||
        lower.includes("see all") ||
        lower.includes("load more") ||
        lower.includes("show all") ||
        lower.includes("lihat semua") ||
        lower.includes("ver todo") ||
        lower.includes("ver tudo") ||
        lower.includes("xem t") || // xem tất cả
        lower.includes("すべて") ||
        lower.includes("전체보기")
      ) continue;

      // This looks like a real section heading — cut here
      sectionEnd = searchFrom + m.index;
      break;
    }

    // Extract only the HTML for our section
    const sectionHtml = html.substring(headingPos, sectionEnd);

    // ── Step 3: Extract products from the scoped section ─────────────────────
    // Split on </a> and process each chunk.
    // Because sectionHtml is already cut at the next section boundary,
    // only products from our category can appear here.
    const chunks = sectionHtml.split(/<\/a>/i);
    const results = [];
    const seen = new Set();

    for (const chunk of chunks) {
      // Must have a product-style href: relative path with at least 2 segments
      // e.g. /en-ph/roblox-gift-cards — NOT / or /en-ph/
      const hrefMatch = chunk.match(/href="(\/[^"#?]{5,})"/);
      if (!hrefMatch) continue;
      const path = hrefMatch[1];
      if (path.split("/").length < 3) continue;

      // Must have an image (tiles always do; nav links don't)
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

      // Get title: alt text first (most reliable), then <p> text
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

    if (results.length === 0) {
      return res.status(404).json({
        error: `"${category}" section was found but contained no product tiles.`,
        found: findAllHeadings(html),
      });
    }

    return res.status(200).json(results);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ── Helper: collect visible section headings for error hints ─────────────────
function findAllHeadings(html) {
  const blanked = html.replace(/<a[\s\S]*?<\/a>/gi, (m) => "\x00".repeat(m.length));
  const headings = [];
  const regex = />([^\x00<>]{3,60})</g;
  let m;
  while ((m = regex.exec(blanked)) !== null) {
    const text = m[1].trim();
    if (!text || text.length < 3) continue;
    if (!/[A-Za-z]/.test(text)) continue;
    if (/[/{}\\<>@#=]/.test(text)) continue;
    if (/^\d/.test(text)) continue;
    if (!headings.includes(text)) headings.push(text);
    if (headings.length >= 20) break;
  }
  return headings;
}
