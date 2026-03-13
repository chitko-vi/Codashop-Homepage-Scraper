/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import {
  Search, Loader2, ExternalLink, Package,
  AlertCircle, LayoutGrid, List, Copy, Check,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Product {
  title: string;
  url:   string;
  image: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scraping logic (runs fully in the browser — no backend needed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the raw HTML of `pageUrl` through a CORS proxy.
 * Tries two public proxies in sequence so one failure doesn't block everything.
 */
async function fetchHTML(pageUrl: string): Promise<string> {
  const proxies = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(pageUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(pageUrl)}`,
  ];

  for (const proxy of proxies) {
    try {
      const res = await fetch(proxy, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;

      // allorigins wraps content in JSON; corsproxy returns raw HTML
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json?.contents) return json.contents as string;
      } catch {
        // not JSON → it's raw HTML (corsproxy)
      }
      if (text.trim().startsWith("<")) return text;
    } catch {
      // try next proxy
    }
  }

  throw new Error(
    "Could not fetch the page. Both CORS proxies failed. " +
    "Check the URL and try again.",
  );
}

/**
 * Parse `html` and extract every product tile that belongs **only** to the
 * section whose heading matches `category` (case-insensitive).
 *
 * Algorithm
 * ─────────
 * 1. Parse HTML with DOMParser.
 * 2. Scan every element whose text equals the category — find its container.
 * 3. Collect ALL <a> tags with an <img> child INSIDE that container only.
 *    This includes items that are visually hidden behind a "View All" button
 *    because Codashop stores them in the DOM but hides them with CSS.
 * 4. Validate (title + url + image required) and deduplicate on URL.
 */
function scrapeCategory(html: string, pageUrl: string, category: string): Product[] {
  const categoryUpper = category.trim().toUpperCase();

  // Parse into a detached document (safe — scripts won't execute)
  const parser = new DOMParser();
  const doc    = parser.parseFromString(html, "text/html");

  // Set <base> so relative URLs resolve correctly
  const baseEl = doc.createElement("base");
  baseEl.href  = pageUrl;
  doc.head.insertBefore(baseEl, doc.head.firstChild);

  // ── Step 1: Find the heading element that matches the category ────────────
  const allElements = Array.from(doc.querySelectorAll("*"));
  let headingEl: Element | null = null;

  for (const el of allElements) {
    // Only consider leaf-ish text nodes — skip giant containers
    if (el.children.length > 6) continue;
    const text = (el.textContent ?? "").trim().toUpperCase();
    if (text === categoryUpper) {
      headingEl = el;
      break;
    }
  }

  if (!headingEl) {
    // Collect visible section-like headings to help the user
    const hints: string[] = [];
    for (const el of allElements) {
      if (el.children.length > 4) continue;
      const t = (el.textContent ?? "").trim();
      if (t.length >= 2 && t.length <= 60 && !hints.includes(t.toUpperCase())) {
        const parent = el.closest("section, article, div");
        if (parent && parent.querySelectorAll("a img").length > 0) {
          hints.push(t);
        }
      }
    }
    const hintStr = hints.length
      ? `\nAvailable sections found: ${hints.slice(0, 12).join(", ")}`
      : "";
    throw new Error(`Category "${category}" was not found on this page.${hintStr}`);
  }

  // ── Step 2: Walk UP to find the section container ─────────────────────────
  // We want the nearest ancestor that actually contains product anchors.
  let container: Element | null = headingEl.parentElement;

  while (container && container.tagName.toLowerCase() !== "body") {
    const tag = container.tagName.toLowerCase();

    // A <section> or <article> is always a good boundary
    if (tag === "section" || tag === "article") break;

    // A <div> is acceptable if it contains at least 2 anchors with images
    if (tag === "div" && container.querySelectorAll("a img").length >= 2) break;

    container = container.parentElement;
  }

  if (!container || container.tagName.toLowerCase() === "body") {
    throw new Error(
      `Found the "${category}" heading but could not determine its section boundary.`,
    );
  }

  // ── Step 3: Determine where this section ENDS ─────────────────────────────
  // Some pages don't wrap each category in a clean <section>; they just stack
  // <div>s.  To avoid leaking into the next category we check: if the
  // container holds another category-level heading, trim to only the nodes
  // before it.
  //
  // We do this by working with the container itself — we'll only collect
  // anchors that appear BEFORE any sibling heading that belongs to a
  // DIFFERENT category section.

  // Collect direct-child sub-containers in DOM order
  const children = Array.from(container.children);

  // Find the index of a child that contains a DIFFERENT category heading
  // (i.e., another section has started)
  let cutoffIndex = children.length;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Skip the child that contains our own heading
    if (child.contains(headingEl)) continue;

    // Does this child look like a new section heading?
    for (const el of Array.from(child.querySelectorAll("*"))) {
      if (el.children.length > 6) continue;
      const t = (el.textContent ?? "").trim().toUpperCase();
      // Non-empty, different from ours, has its own product links
      if (
        t.length >= 2 &&
        t !== categoryUpper &&
        child.querySelectorAll("a img").length >= 2
      ) {
        cutoffIndex = i;
        break;
      }
    }
    if (cutoffIndex < children.length) break;
  }

  // Build a temporary root containing only the nodes we care about
  const scopeRoot = doc.createElement("div");
  for (let i = 0; i < cutoffIndex; i++) {
    scopeRoot.appendChild(children[i].cloneNode(true));
  }
  // Also include the heading's direct parent chain up to container
  // (in case the heading is in a sibling before the tiles)
  if (cutoffIndex === children.length) {
    // No cutoff found — use the full container as-is
    scopeRoot.innerHTML = container.innerHTML;
  }

  // ── Step 4: Extract all anchors with images from scoped root ─────────────
  const anchors = Array.from(scopeRoot.querySelectorAll("a")) as HTMLAnchorElement[];

  const seen    = new Set<string>();
  const results: Product[] = [];

  for (const a of anchors) {
    const img = a.querySelector("img");
    if (!img) continue;

    // ── URL ──────────────────────────────────────────────────────────────────
    let href = (a.getAttribute("href") ?? "").trim();
    if (!href || href === "#" || href.startsWith("javascript")) continue;

    try { href = new URL(href, pageUrl).href; } catch { continue; }
    if (seen.has(href)) continue;

    // ── Image ────────────────────────────────────────────────────────────────
    const rawImg =
      img.getAttribute("data-src")      ??
      img.getAttribute("data-lazy-src") ??
      img.getAttribute("srcset")?.split(",")[0]?.split(" ")[0]?.trim() ??
      img.getAttribute("src") ??
      "";

    let imgSrc = rawImg.trim();
    if (!imgSrc || imgSrc.startsWith("data:")) continue;

    try { imgSrc = new URL(imgSrc, pageUrl).href; } catch { continue; }

    // ── Title ────────────────────────────────────────────────────────────────
    const titleEl  = a.querySelector(
      "[class*='title'],[class*='name'],[class*='label'],figcaption,p,span",
    );
    const innerTxt = (titleEl?.textContent ?? "").trim();
    const altTxt   = (img.getAttribute("alt") ?? "").trim();
    const ariaLbl  = (a.getAttribute("aria-label") ?? "").trim();
    const titleAtt = (a.getAttribute("title") ?? "").trim();

    const title = innerTxt || altTxt || ariaLbl || titleAtt;
    if (!title) continue;

    seen.add(href);
    results.push({ title, url: href, image: imgSrc });
  }

  if (results.length === 0) {
    throw new Error(
      `The "${category}" section was found but contained no product tiles. ` +
      `The page structure may have changed.`,
    );
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [url,      setUrl]      = useState("https://www.codashop.com/en-ph/");
  const [category, setCategory] = useState("VOUCHERS");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "table">("table");
  const [copied,   setCopied]   = useState(false);

  useEffect(() => { document.title = "Codashop Scraper"; }, []);

  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setProducts([]);

    try {
      const html  = await fetchHTML(url);
      const items = scrapeCategory(html, url, category);
      setProducts(items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    const rows = products.map(p => `${p.title}\t${p.url}\t${p.image}`).join("\n");
    navigator.clipboard.writeText(`Title\tURL\tImage URL\n${rows}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <link
        href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;600;700;800&display=swap"
        rel="stylesheet"
      />

      <style>{`
        :root {
          --bg-main:         #280031;
          --bg-card:         #36004a;
          --bg-card-hover:   #420059;
          --bg-input:        #36004a;
          --bg-topbar:       #1e0026;
          --purple-mid:      #4a1060;
          --border:          #5a2070;
          --border-subtle:   rgba(90,32,112,0.45);
          --headline:        #e7e5f5;
          --text-main:       #e7e5f5;
          --text-muted:      #b09ac8;
          --text-highlight:  #e8f953;
          --button-primary:  #6242fc;
          --button-hover:    #7a5efd;
          --button-disabled: #3a2880;
          --shadow-card:     0 4px 18px rgba(0,0,0,0.35);
          --radius-card:     14px;
          --radius-btn:      10px;
          --radius-input:    10px;
        }

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: var(--bg-main);
          color: var(--text-main);
          font-family: 'Nunito', sans-serif;
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
        }

        .page-wrap {
          max-width: 1200px;
          margin: 0 auto;
          padding: 40px 28px 100px;
        }

        .topbar {
          background: var(--bg-topbar);
          border-bottom: 1px solid var(--border);
          padding: 14px 28px;
          display: flex;
          align-items: center;
          position: sticky;
          top: 0;
          z-index: 100;
        }
        .topbar-logo {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 1.6rem;
          letter-spacing: 2px;
          color: var(--text-main);
        }
        .topbar-logo span { color: var(--text-highlight); }

        .coda-heading {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 3rem;
          letter-spacing: 1px;
          color: var(--headline);
          line-height: 1;
        }
        .coda-sub {
          color: var(--text-muted);
          font-size: 0.88rem;
          font-weight: 600;
          margin-top: 6px;
        }

        .form-card {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          padding: 28px;
          margin: 32px 0 24px;
        }
        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr auto;
          gap: 18px;
          align-items: end;
        }
        @media (max-width: 640px) {
          .form-grid    { grid-template-columns: 1fr; }
          .coda-heading { font-size: 2.2rem; }
        }

        .field-label {
          display: block;
          font-size: 0.68rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--text-muted);
          margin-bottom: 8px;
        }
        .field-input {
          width: 100%;
          background: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: var(--radius-input);
          padding: 12px 16px;
          color: var(--text-main);
          font-family: 'Nunito', sans-serif;
          font-size: 0.9rem;
          font-weight: 600;
          outline: none;
          transition: border-color 0.18s;
        }
        .field-input:focus        { border-color: var(--button-primary); }
        .field-input::placeholder { color: #6a4888; }

        .btn-scrape {
          background: var(--button-primary);
          color: #fff;
          font-family: 'Nunito', sans-serif;
          font-weight: 800;
          font-size: 0.95rem;
          border: none;
          border-radius: var(--radius-btn);
          padding: 12px 28px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
          transition: background 0.18s, transform 0.12s;
        }
        .btn-scrape:hover:not(:disabled) {
          background: var(--button-hover);
          transform: translateY(-1px);
        }
        .btn-scrape:disabled {
          background: var(--button-disabled);
          cursor: not-allowed;
        }

        .view-toggle {
          display: flex;
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-btn);
          padding: 4px;
          gap: 4px;
        }
        .toggle-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 18px;
          border-radius: 7px;
          font-family: 'Nunito', sans-serif;
          font-weight: 700;
          font-size: 0.84rem;
          border: none;
          cursor: pointer;
          transition: background 0.18s, color 0.18s;
        }
        .toggle-btn.active   { background: var(--button-primary); color: #fff; }
        .toggle-btn.inactive { background: transparent; color: var(--text-muted); }
        .toggle-btn.inactive:hover { color: var(--text-main); }

        .results-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 18px;
          flex-wrap: wrap;
          gap: 12px;
        }
        .category-label {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 1.9rem;
          letter-spacing: 1px;
          color: var(--headline);
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .count-badge {
          font-family: 'Nunito', sans-serif;
          font-size: 0.72rem;
          font-weight: 800;
          background: var(--purple-mid);
          color: var(--text-muted);
          padding: 3px 10px;
          border-radius: 20px;
          letter-spacing: 0.06em;
        }

        .btn-copy {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--bg-card);
          border: 1px solid var(--border);
          color: var(--text-muted);
          font-family: 'Nunito', sans-serif;
          font-weight: 700;
          font-size: 0.82rem;
          padding: 8px 16px;
          border-radius: 8px;
          cursor: pointer;
          transition: color 0.18s, border-color 0.18s;
        }
        .btn-copy:hover,
        .btn-copy.copied { color: var(--text-highlight); border-color: var(--text-highlight); }

        .table-wrap {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          overflow: hidden;
          box-shadow: var(--shadow-card);
        }
        .results-table { width: 100%; border-collapse: collapse; }
        .results-table thead tr {
          background: var(--purple-mid);
          border-bottom: 1px solid var(--border);
        }
        .results-table th {
          padding: 14px 18px;
          font-size: 0.67rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--text-muted);
          text-align: left;
        }
        .results-table tbody tr {
          border-bottom: 1px solid var(--border-subtle);
          transition: background 0.14s;
        }
        .results-table tbody tr:last-child { border-bottom: none; }
        .results-table tbody tr:hover      { background: var(--bg-card-hover); }
        .results-table td {
          padding: 12px 18px;
          font-size: 0.875rem;
          vertical-align: middle;
          color: var(--text-main);
        }
        .td-num { color: var(--text-muted); font-weight: 700; width: 40px; }
        .td-thumb img {
          width: 44px; height: 44px;
          border-radius: 8px;
          object-fit: cover;
          background: var(--purple-mid);
          display: block;
        }
        .td-title { font-weight: 700; }
        .td-link a {
          color: var(--text-muted);
          font-family: monospace;
          font-size: 0.78rem;
          text-decoration: none;
          display: block;
          max-width: 260px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: color 0.14s;
        }
        .td-link a:hover { color: var(--text-highlight); }

        .product-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 16px;
        }
        .product-card {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          overflow: hidden;
          box-shadow: var(--shadow-card);
          transition: transform 0.18s, border-color 0.18s;
          cursor: pointer;
        }
        .product-card:hover {
          transform: translateY(-4px);
          border-color: var(--button-primary);
        }
        .product-card .thumb {
          aspect-ratio: 1;
          overflow: hidden;
          background: var(--purple-mid);
        }
        .product-card .thumb img {
          width: 100%; height: 100%;
          object-fit: cover;
          transition: transform 0.4s;
          display: block;
        }
        .product-card:hover .thumb img { transform: scale(1.07); }
        .product-card .card-body { padding: 12px; }
        .product-card .card-title {
          font-weight: 700;
          font-size: 0.82rem;
          color: var(--text-main);
          margin-bottom: 8px;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          min-height: 2.4em;
        }
        .product-card .card-link {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--text-highlight);
          text-decoration: none;
          transition: opacity 0.14s;
        }
        .product-card .card-link:hover { opacity: 0.8; }

        .error-box {
          background: rgba(185,28,28,0.12);
          border: 1px solid rgba(239,68,68,0.35);
          color: #fca5a5;
          padding: 16px 20px;
          border-radius: 12px;
          margin-bottom: 24px;
          display: flex;
          align-items: flex-start;
          gap: 12px;
          font-weight: 600;
          font-size: 0.9rem;
          white-space: pre-line;
        }

        .empty-state {
          text-align: center;
          padding: 90px 20px;
          color: var(--text-muted);
        }
        .empty-state svg { opacity: 0.12; margin: 0 auto 16px; display: block; }
        .empty-state p   { font-weight: 600; font-size: 0.9rem; }
      `}</style>

      {/* Topbar */}
      <div className="topbar">
        <span className="topbar-logo">CODA<span>SCRAPER</span></span>
      </div>

      <div className="page-wrap">

        {/* Heading + toggle */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", flexWrap:"wrap", gap:16 }}>
          <div>
            <motion.h1
              className="coda-heading"
              initial={{ opacity:0, y:-14 }}
              animate={{ opacity:1, y:0 }}
              transition={{ duration:0.35 }}
            >
              TILE SCRAPER
            </motion.h1>
            <p className="coda-sub">
              Insert a Codashop page URL and category name to extract all product tiles
            </p>
          </div>

          <div className="view-toggle">
            <button className={`toggle-btn ${viewMode==="table"?"active":"inactive"}`} onClick={()=>setViewMode("table")}>
              <List size={15}/> Table
            </button>
            <button className={`toggle-btn ${viewMode==="grid"?"active":"inactive"}`} onClick={()=>setViewMode("grid")}>
              <LayoutGrid size={15}/> Grid
            </button>
          </div>
        </div>

        {/* Form */}
        <motion.div className="form-card" initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.1}}>
          <form onSubmit={handleScrape} className="form-grid">
            <div>
              <label className="field-label">Page URL</label>
              <input
                className="field-input"
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://www.codashop.com/en-ph/"
                required
              />
            </div>
            <div>
              <label className="field-label">Category Name (Exact)</label>
              <input
                className="field-input"
                type="text"
                value={category}
                onChange={e => setCategory(e.target.value)}
                placeholder="VOUCHERS"
                required
              />
            </div>
            <div>
              <button className="btn-scrape" type="submit" disabled={loading}>
                {loading
                  ? <><Loader2 size={18} className="animate-spin"/> Scraping…</>
                  : <><Search size={18}/> Start Scrape</>}
              </button>
            </div>
          </form>
        </motion.div>

        {/* Results */}
        <AnimatePresence mode="wait">

          {error && (
            <motion.div className="error-box" key="error"
              initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0}}
            >
              <AlertCircle size={18} style={{flexShrink:0,marginTop:1}}/>
              <span>{error}</span>
            </motion.div>
          )}

          {products.length > 0 ? (
            <motion.div key="results" initial={{opacity:0}} animate={{opacity:1}}>

              <div className="results-header">
                <div className="category-label">
                  {category.toUpperCase()}
                  <span className="count-badge">{products.length} PRODUCTS</span>
                </div>
                <button className={`btn-copy ${copied?"copied":""}`} onClick={copyToClipboard}>
                  {copied ? <><Check size={14}/> Copied!</> : <><Copy size={14}/> Copy TSV</>}
                </button>
              </div>

              {viewMode === "table" ? (
                <div className="table-wrap">
                  <table className="results-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Thumb</th><th>Title</th>
                        <th>Product URL</th><th>Image URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p, i) => (
                        <tr key={i}>
                          <td className="td-num">{i+1}</td>
                          <td className="td-thumb">
                            <img src={p.image} alt={p.title} referrerPolicy="no-referrer"/>
                          </td>
                          <td className="td-title">{p.title}</td>
                          <td className="td-link">
                            <a href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a>
                          </td>
                          <td className="td-link">
                            <a href={p.image} target="_blank" rel="noopener noreferrer">{p.image}</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="product-grid">
                  {products.map((product, idx) => (
                    <motion.div key={idx} className="product-card"
                      initial={{opacity:0,y:18}} animate={{opacity:1,y:0}}
                      transition={{delay:idx*0.025}}
                    >
                      <div className="thumb">
                        <img src={product.image} alt={product.title} referrerPolicy="no-referrer"/>
                      </div>
                      <div className="card-body">
                        <p className="card-title">{product.title}</p>
                        <a href={product.url} target="_blank" rel="noopener noreferrer" className="card-link">
                          View Product <ExternalLink size={11}/>
                        </a>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

            </motion.div>

          ) : !loading && !error && (
            <motion.div key="empty" className="empty-state"
              initial={{opacity:0}} animate={{opacity:1}}
            >
              <Package size={56}/>
              <p>No products to display. Start a scrape to see results.</p>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </>
  );
}
