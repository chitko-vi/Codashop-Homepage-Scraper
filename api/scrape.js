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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Failed to fetch page: ${response.status}` });
    }

    const html = await response.text();

    // ── Step 1: Find the category label ────────────────────────────────────
    const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const startIdx = html.search(new RegExp(">\\s*" + escaped + "\\s*<", "i"));

    if (startIdx === -1) {
      // Return available categories to help debug
      const categoryMatches = [];
      const catRegex = /class="[^"]*(?:section-title|category-title|header-title)[^"]*"[^>]*>([\s\S]*?)<\//g;
      let catMatch;
      while ((catMatch = catRegex.exec(html)) !== null) {
        const text = catMatch[1].replace(/<[^>]+>/g, "").trim();
        if (text) categoryMatches.push(text);
      }
      return res.status(404).json({
        error: `Category "${category}" not found`,
        hint: "Try one of these detected headers",
        found: categoryMatches.slice(0, 20),
      });
    }

    const afterLabel = html.substring(startIdx + category.length);

    // ── Step 2: Cut section at next real category header ───────────────────
    // Skip UI buttons (View All / View Less etc.) — identified by <button> tag in gap
    // Real headers appear as plain text between </a> and <a> with no <button> wrapper
    const UI_TEXTS = [
      "view all", "view less", "see all", "see less", "see more",
      "show all", "show less", "load more", "查看全部", "收起",
      "ver todo", "すべて見る", "전체보기", "lihat semua", "xem tất cả",
    ];

    let cutAt = afterLabel.length;
    let productsSeen = 0;
    let searchPos = 0;

    while (searchPos < afterLabel.length) {
      const closeTag = afterLabel.indexOf("</a>", searchPos);
      if (closeTag === -1) break;
      const afterClose = closeTag + 4;
      const nextOpen = afterLabel.indexOf("<a ", afterClose);
      if (nextOpen === -1) break;

      const preceding = afterLabel.substring(Math.max(0, closeTag - 600), closeTag);
      if (/href="\/[^"]{5,}"/.test(preceding)) productsSeen++;

      if (productsSeen >= 1) {
        const gap = afterLabel.substring(afterClose, nextOpen);
        const gapLower = gap.toLowerCase();

        // Skip if gap contains a <button> (it's a UI expand control)
        if (gapLower.includes("<button")) {
          searchPos = nextOpen + 1;
          continue;
        }

        const gapText = gap.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

        // Skip known UI button texts
        const isUIText = UI_TEXTS.some((t) => gapText.toLowerCase().includes(t));
        if (isUIText) {
          searchPos = nextOpen + 1;
          continue;
        }

        // If short text with letters → real category header → stop
        const looksLikeHeader =
          gapText.length >= 2 &&
          gapText.length <= 120 &&
          /\p{L}/u.test(gapText) &&
          !gapText.includes("http") &&
          !gapText.includes("/") &&
          !gapText.includes("{");

        if (looksLikeHeader) {
          cutAt = afterClose;
          break;
        }
      }

      searchPos = nextOpen + 1;
    }

    const section = afterLabel.substring(0, cutAt);

    // ── Step 3: Extract products from section ──────────────────────────────
    const chunks = section.split(/<\/a>/);
    const results = [];
    const seen = new Set();

    for (const chunk of chunks) {
      const hrefMatch = chunk.match(/href="(\/[^"#?]+)"/);
      if (!hrefMatch) continue;
      const path = hrefMatch[1];
      if (path === "/" || path.split("/").length < 3) continue;

      // Title: alt → <p> text → stripped text
      let title = "";
      const altMatch = chunk.match(/alt="([^"<>]+)"/);
      if (altMatch) title = altMatch[1].trim();

      if (!title) {
        const pMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        if (pMatch) title = pMatch[1].replace(/<[^>]+>/g, "").trim();
      }

      if (!title) {
        const stripped = chunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const parts = stripped.split("  ").filter((s) => s.trim().length > 1);
        if (parts.length) title = parts[parts.length - 1].trim();
      }

      if (!title || title.includes("<")) continue;

      // Image: src → srcset first item → data-src
      let image = "";
      const srcMatch = chunk.match(/\bsrc="(https?:\/\/[^"]+)"/);
      if (srcMatch) {
        image = srcMatch[1];
      } else {
        const srcsetMatch = chunk.match(/srcset="([^"]+)"/);
        if (srcsetMatch) image = srcsetMatch[1].split(",")[0].trim().split(" ")[0];
      }
      if (!image) {
        const dataSrcMatch = chunk.match(/data-src="([^"]+)"/);
        if (dataSrcMatch) image = dataSrcMatch[1];
      }
      if (image && !image.startsWith("http")) {
        image = "https://cdn1.codashop.com" + image;
      }

      const fullUrl = "https://www.codashop.com" + path;
      if (!seen.has(fullUrl)) {
        seen.add(fullUrl);
        results.push({ title, url: fullUrl, image });
      }
    }

    return res.status(200).json(results);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
