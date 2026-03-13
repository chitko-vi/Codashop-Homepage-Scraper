/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { Search, Loader2, ExternalLink, Package, AlertCircle, LayoutGrid, List, Copy, Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Product {
  title: string;
  url: string;
  image: string;
}

export default function App() {
  const [url, setUrl] = useState("https://www.codashop.com/en-ph/");
  const [category, setCategory] = useState("VOUCHERS");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "table">("table");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = "Codashop Scraper";
  }, []);

  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setProducts([]);
    try {
      const params = new URLSearchParams({ url, category });
      const response = await fetch(`/api/scrape?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        const hint = data.found?.length ? `\nAvailable categories: ${data.found.join(", ")}` : "";
        throw new Error((data.error || "Failed to scrape") + hint);
      }
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No products found in category "${category}". Check the category name matches exactly.`);
      }
      setProducts(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    const text = products.map(p => `${p.title}\t${p.url}\t${p.image}`).join("\n");
    navigator.clipboard.writeText(`Title\tURL\tImage URL\n${text}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <link
        href="https://fonts.googleapis.com/css2?family=Bangers&family=Nunito:wght@400;600;700;800&display=swap"
        rel="stylesheet"
      />

      <style>{`
        :root {
          --bg-main:          #280031;
          --headline:         #3c1f42;
          --text-main:        #e7e5f5;
          --text-highlight:   #e8f953;
          --button-primary:   #6242fc;
          --button-primary-hover: #7a5efd;

          --bg-deep:          #280031;
          --bg-card:          #3a1044;
          --bg-card-hover:    #4a1858;
          --bg-input:         #3a1044;
          --purple-mid:       #4e1f5c;
          --text-muted:       #b8a8d8;
          --border:           #5a2870;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: var(--bg-main);
          color: var(--text-main);
          font-family: 'Nunito', sans-serif;
          min-height: 100vh;
        }

        body::before {
          content: '';
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
          background-size: 40px 40px;
          pointer-events: none;
          z-index: 0;
        }

        .page-wrap {
          position: relative;
          z-index: 1;
          max-width: 1200px;
          margin: 0 auto;
          padding: 32px 24px 80px;
        }

        .coda-heading {
          font-family: 'Bangers', cursive;
          font-size: 2.8rem;
          letter-spacing: 0.04em;
          color: var(--headline);
          text-shadow:
            3px 3px 0 #7c3aed,
            -1px -1px 0 #7c3aed,
            1px -1px 0 #7c3aed,
            -1px 1px 0 #7c3aed;
          line-height: 1;
        }

        .coda-sub {
          color: var(--text-muted);
          font-size: 0.9rem;
          font-weight: 600;
          margin-top: 6px;
          letter-spacing: 0.02em;
        }

        .topbar {
          background: linear-gradient(90deg, #1a0030, #3a0855, #1a0030);
          border-bottom: 1px solid var(--border);
          padding: 12px 24px;
          display: flex;
          align-items: center;
          gap: 12px;
          position: sticky;
          top: 0;
          z-index: 100;
        }

        .topbar-logo {
          font-family: 'Bangers', cursive;
          font-size: 1.5rem;
          letter-spacing: 0.08em;
          color: var(--text-main);
        }

        .topbar-logo span { color: var(--text-highlight); }

        .form-card {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 24px;
          margin: 32px 0 24px;
          position: relative;
          overflow: hidden;
        }

        .form-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 3px;
          background: linear-gradient(90deg, var(--button-primary), var(--text-highlight), var(--button-primary));
        }

        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr auto;
          gap: 16px;
          align-items: end;
        }

        @media (max-width: 640px) {
          .form-grid { grid-template-columns: 1fr; }
          .coda-heading { font-size: 2rem; }
        }

        .field-label {
          display: block;
          font-size: 0.7rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--text-muted);
          margin-bottom: 8px;
        }

        .field-input {
          width: 100%;
          background: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 12px 16px;
          color: var(--text-main);
          font-family: 'Nunito', sans-serif;
          font-size: 0.9rem;
          font-weight: 600;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }

        .field-input:focus {
          border-color: var(--button-primary);
          box-shadow: 0 0 0 3px rgba(98,66,252,0.25);
        }

        .field-input::placeholder { color: #7a5a9a; }

        .btn-scrape {
          background: var(--button-primary);
          color: #fff;
          font-family: 'Nunito', sans-serif;
          font-weight: 800;
          font-size: 0.95rem;
          border: none;
          border-radius: 10px;
          padding: 12px 28px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
          transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
          box-shadow: 0 4px 14px rgba(98,66,252,0.35);
        }

        .btn-scrape:hover:not(:disabled) {
          background: var(--button-primary-hover);
          transform: translateY(-1px);
          box-shadow: 0 6px 20px rgba(98,66,252,0.5);
        }

        .btn-scrape:disabled {
          background: #3a2a80;
          cursor: not-allowed;
          box-shadow: none;
        }

        .view-toggle {
          display: flex;
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 4px;
          gap: 4px;
        }

        .toggle-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          border-radius: 7px;
          font-family: 'Nunito', sans-serif;
          font-weight: 700;
          font-size: 0.85rem;
          border: none;
          cursor: pointer;
          transition: all 0.2s;
        }

        .toggle-btn.active {
          background: var(--button-primary);
          color: #fff;
        }

        .toggle-btn.inactive {
          background: transparent;
          color: var(--text-muted);
        }

        .toggle-btn.inactive:hover { color: var(--text-highlight); }

        .results-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          flex-wrap: wrap;
          gap: 12px;
        }

        .category-label {
          font-family: 'Bangers', cursive;
          font-size: 1.8rem;
          letter-spacing: 0.05em;
          color: var(--headline);
          text-shadow: 2px 2px 0 #7c3aed;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .count-badge {
          font-family: 'Nunito', sans-serif;
          font-size: 0.75rem;
          font-weight: 800;
          background: var(--purple-mid);
          color: var(--text-muted);
          padding: 3px 10px;
          border-radius: 20px;
          letter-spacing: 0.05em;
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
          transition: all 0.2s;
        }

        .btn-copy:hover { color: var(--text-highlight); border-color: var(--text-highlight); }
        .btn-copy.copied { color: var(--text-highlight); border-color: var(--text-highlight); }

        .table-wrap {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: 14px;
          overflow: hidden;
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
          padding: 14px 16px;
          font-size: 0.68rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--text-muted);
          text-align: left;
        }

        .results-table tbody tr {
          border-bottom: 1px solid rgba(90,40,112,0.5);
          transition: background 0.15s;
        }

        .results-table tbody tr:last-child { border-bottom: none; }
        .results-table tbody tr:hover { background: var(--bg-card-hover); }

        .results-table td {
          padding: 12px 16px;
          font-size: 0.875rem;
          vertical-align: middle;
          color: var(--text-main);
        }

        .td-num { color: var(--text-muted); font-weight: 700; width: 40px; }

        .td-thumb img {
          width: 44px;
          height: 44px;
          border-radius: 10px;
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
          transition: color 0.15s;
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
          border-radius: 14px;
          overflow: hidden;
          transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
          cursor: pointer;
        }

        .product-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 32px rgba(0,0,0,0.4);
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

        .product-card:hover .thumb img { transform: scale(1.08); }

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
          transition: color 0.15s;
        }

        .product-card .card-link:hover { color: #f4ff80; }

        .error-box {
          background: rgba(185,28,28,0.15);
          border: 1px solid rgba(239,68,68,0.4);
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
          padding: 80px 20px;
          color: var(--text-muted);
        }

        .empty-state svg {
          opacity: 0.15;
          margin: 0 auto 16px;
          display: block;
        }

        .empty-state p {
          font-weight: 600;
          font-size: 0.9rem;
        }
      `}</style>

      {/* Top bar */}
      <div className="topbar">
        <span className="topbar-logo">CODA<span>SCRAPER</span></span>
      </div>

      <div className="page-wrap">

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
          <div>
            <motion.h1
              className="coda-heading"
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              TILE SCRAPER
            </motion.h1>
            <p className="coda-sub">Insert a Codashop page URL and category name to extract all product tiles</p>
          </div>

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

        {/* Form */}
        <motion.div
          className="form-card"
          initial={{ opacity: 0, y: 16 }}
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
                {loading
                  ? <><Loader2 size={18} className="animate-spin" /> Scraping...</>
                  : <><Search size={18} /> Start Scrape</>
                }
              </button>
            </div>
          </form>
        </motion.div>

        <AnimatePresence mode="wait">

          {/* Error */}
          {error && (
            <motion.div
              className="error-box"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </motion.div>
          )}

          {/* Results */}
          {products.length > 0 ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} key="results">

              <div className="results-header">
                <div className="category-label">
                  {category.toUpperCase()}
                  <span className="count-badge">{products.length} PRODUCTS</span>
                </div>
                <button
                  className={`btn-copy ${copied ? "copied" : ""}`}
                  onClick={copyToClipboard}
                >
                  {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy TSV</>}
                </button>
              </div>

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
                            <img src={p.image} alt={p.title} referrerPolicy="no-referrer" />
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
                    <motion.div
                      key={idx}
                      className="product-card"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.025 }}
                    >
                      <div className="thumb">
                        <img src={product.image} alt={product.title} referrerPolicy="no-referrer" />
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
              className="empty-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              key="empty"
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
