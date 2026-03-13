/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import {
  Search,
  Loader2,
  ExternalLink,
  Package,
  AlertCircle,
  LayoutGrid,
  List,
  Copy,
  Check,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Product {
  title: string;
  url: string;
  image: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Client-side result validation:
 * - Strips items missing title / url / image.
 * - Removes duplicates keyed on url.
 */
function validateAndDedupe(raw: unknown[]): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];

  for (const item of raw) {
    if (
      item == null ||
      typeof item !== "object" ||
      !("title" in item) ||
      !("url" in item) ||
      !("image" in item)
    ) {
      continue;
    }

    const p = item as Product;
    const title = (p.title ?? "").trim();
    const url   = (p.url   ?? "").trim();
    const image = (p.image ?? "").trim();

    if (!title || !url || !image) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    out.push({ title, url, image });
  }

  return out;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const [url,      setUrl]      = useState("https://www.codashop.com/en-ph/");
  const [category, setCategory] = useState("VOUCHERS");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "table">("table");
  const [copied,   setCopied]   = useState(false);

  useEffect(() => {
    document.title = "Codashop Scraper";
  }, []);

  // ── Scrape handler ──────────────────────────────────────────────────────────
  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setProducts([]);

    try {
      /**
       * Extra hint flags forwarded to the server-side scraper:
       *
       * structuralMode=1  → use structural / class-based selectors
       *                     ([data-category], [class*="product"], [class*="tile"])
       *                     instead of matching button or heading text, so the
       *                     scraper works regardless of page language.
       *
       * expandAll=1       → automatically expand any "View All" affordance by
       *                     clicking it or parsing hidden nodes, without relying
       *                     on the button's label text.
       *
       * strictSection=1   → scope tile collection to the matched category
       *                     container only; discard tiles found in other sections.
       */
      const params = new URLSearchParams({
        url,
        category,
        structuralMode: "1",
        expandAll:      "1",
        strictSection:  "1",
      });

      const response = await fetch(`/api/scrape?${params.toString()}`);
      const data     = await response.json();

      if (!response.ok) {
        const hint = data.found?.length
          ? `\nAvailable categories: ${data.found.join(", ")}`
          : "";
        throw new Error((data.error || "Failed to scrape") + hint);
      }

      if (!Array.isArray(data)) {
        throw new Error("Unexpected response format from scraper.");
      }

      // Client-side validation + deduplication
      const clean = validateAndDedupe(data);

      if (clean.length === 0) {
        throw new Error(
          `No valid products found in category "${category}". ` +
          `Check that the category name matches exactly.`
        );
      }

      setProducts(clean);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // ── Copy TSV ────────────────────────────────────────────────────────────────
  const copyToClipboard = () => {
    const rows = products.map(p => `${p.title}\t${p.url}\t${p.image}`).join("\n");
    navigator.clipboard.writeText(`Title\tURL\tImage URL\n${rows}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Fonts ── */}
      <link
        href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;600;700;800&display=swap"
        rel="stylesheet"
      />

      {/* ── Global styles ── */}
      <style>{`
        /* ── Design tokens ───────────────────────────────────── */
        :root {
          --bg-main:            #280031;
          --bg-card:            #36004a;
          --bg-card-hover:      #420059;
          --bg-input:           #36004a;
          --bg-topbar:          #1e0026;
          --purple-mid:         #4a1060;
          --border:             #5a2070;
          --border-subtle:      rgba(90,32,112,0.45);

          --headline:           #e7e5f5;
          --text-main:          #e7e5f5;
          --text-muted:         #b09ac8;
          --text-highlight:     #e8f953;

          --button-primary:     #6242fc;
          --button-hover:       #7a5efd;
          --button-disabled:    #3a2880;

          --shadow-card:        0 4px 18px rgba(0,0,0,0.35);
          --radius-card:        14px;
          --radius-btn:         10px;
          --radius-input:       10px;
        }

        /* ── Reset ───────────────────────────────────────────── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: var(--bg-main);
          color: var(--text-main);
          font-family: 'Nunito', sans-serif;
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
        }

        /* ── Layout ──────────────────────────────────────────── */
        .page-wrap {
          max-width: 1200px;
          margin: 0 auto;
          padding: 40px 28px 100px;
        }

        /* ── Topbar ──────────────────────────────────────────── */
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

        /* ── Page heading ────────────────────────────────────── */
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
          letter-spacing: 0.02em;
        }

        /* ── Form card ───────────────────────────────────────── */
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
          .form-grid { grid-template-columns: 1fr; }
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

        .field-input:focus { border-color: var(--button-primary); }
        .field-input::placeholder { color: #6a4888; }

        /* ── Primary button ──────────────────────────────────── */
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

        /* ── View toggle ─────────────────────────────────────── */
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

        /* ── Results header ──────────────────────────────────── */
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

        /* ── Copy button ─────────────────────────────────────── */
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

        .btn-copy:hover { color: var(--text-highlight); border-color: var(--text-highlight); }
        .btn-copy.copied { color: var(--text-highlight); border-color: var(--text-highlight); }

        /* ── Table ───────────────────────────────────────────── */
        .table-wrap {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          overflow: hidden;
          box-shadow: var(--shadow-card);
        }

        .results-table {
          width: 100%;
          border-collapse: collapse;
        }

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
          width: 44px;
          height: 44px;
          border-radius: 8px;
          object-fit: cover;
          background: var(--purple-mid);
          display: block;
        }

        .td-title { font-weight: 700; color: var(--text-main); }

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

        /* ── Product grid ────────────────────────────────────── */
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
          width: 100%;
          height: 100%;
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

        /* ── Error box ───────────────────────────────────────── */
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

        /* ── Empty state ─────────────────────────────────────── */
        .empty-state {
          text-align: center;
          padding: 90px 20px;
          color: var(--text-muted);
        }

        .empty-state svg {
          opacity: 0.12;
          margin: 0 auto 16px;
          display: block;
        }

        .empty-state p {
          font-weight: 600;
          font-size: 0.9rem;
        }
      `}</style>

      {/* ── Topbar ─────────────────────────────────────────────────────────── */}
      <div className="topbar">
        <span className="topbar-logo">CODA<span>SCRAPER</span></span>
      </div>

      <div className="page-wrap">

        {/* ── Page heading ─────────────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            flexWrap: "wrap",
            gap: 16,
          }}
        >
          <div>
            <motion.h1
              className="coda-heading"
              initial={{ opacity: 0, y: -14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
            >
              TILE SCRAPER
            </motion.h1>
            <p className="coda-sub">
              Insert a Codashop page URL and category name to extract all product tiles
            </p>
          </div>

          {/* ── View toggle ──────────────────────────────────────────────── */}
          <div className="view-toggle">
            <button
              className={`toggle-btn ${viewMode === "table" ? "active" : "inactive"}`}
              onClick={() => setViewMode("table")}
            >
              <List size={15} /> Table
            </button>
            <button
              className={`toggle-btn ${viewMode === "grid" ? "active" : "inactive"}`}
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid size={15} /> Grid
            </button>
          </div>
        </div>

        {/* ── Form ─────────────────────────────────────────────────────────── */}
        <motion.div
          className="form-card"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
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
                {loading ? (
                  <><Loader2 size={18} className="animate-spin" /> Scraping…</>
                ) : (
                  <><Search size={18} /> Start Scrape</>
                )}
              </button>
            </div>
          </form>
        </motion.div>

        {/* ── Results / errors ─────────────────────────────────────────────── */}
        <AnimatePresence mode="wait">

          {error && (
            <motion.div
              className="error-box"
              key="error"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </motion.div>
          )}

          {products.length > 0 ? (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              {/* Results header */}
              <div className="results-header">
                <div className="category-label">
                  {category.toUpperCase()}
                  <span className="count-badge">{products.length} PRODUCTS</span>
                </div>

                <button
                  className={`btn-copy ${copied ? "copied" : ""}`}
                  onClick={copyToClipboard}
                >
                  {copied
                    ? <><Check size={14} /> Copied!</>
                    : <><Copy size={14} /> Copy TSV</>}
                </button>
              </div>

              {/* Table view */}
              {viewMode === "table" ? (
                <div className="table-wrap">
                  <table className="results-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Thumb</th>
                        <th>Title</th>
                        <th>Product URL</th>
                        <th>Image URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p, i) => (
                        <tr key={i}>
                          <td className="td-num">{i + 1}</td>
                          <td className="td-thumb">
                            <img
                              src={p.image}
                              alt={p.title}
                              referrerPolicy="no-referrer"
                            />
                          </td>
                          <td className="td-title">{p.title}</td>
                          <td className="td-link">
                            <a href={p.url} target="_blank" rel="noopener noreferrer">
                              {p.url}
                            </a>
                          </td>
                          <td className="td-link">
                            <a href={p.image} target="_blank" rel="noopener noreferrer">
                              {p.image}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                /* Grid view */
                <div className="product-grid">
                  {products.map((product, idx) => (
                    <motion.div
                      key={idx}
                      className="product-card"
                      initial={{ opacity: 0, y: 18 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.025 }}
                    >
                      <div className="thumb">
                        <img
                          src={product.image}
                          alt={product.title}
                          referrerPolicy="no-referrer"
                        />
                      </div>
                      <div className="card-body">
                        <p className="card-title">{product.title}</p>
                        <a
                          href={product.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="card-link"
                        >
                          View Product <ExternalLink size={11} />
                        </a>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>

          ) : !loading && !error && (
            <motion.div
              key="empty"
              className="empty-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <Package size={56} />
              <p>No products to display. Start a scrape to see results.</p>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </>
  );
}
