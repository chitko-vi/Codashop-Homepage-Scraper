/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
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

  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setProducts([]);

    try {
      const response = await fetch(`/api/scrape?url=${encodeURIComponent(url)}&category=${encodeURIComponent(category)}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to scrape data");
      }
      const data = await response.json();
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
    <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      <header className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <motion.h1 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl font-bold tracking-tight mb-2"
          >
            Codashop Scraper Pro
          </motion.h1>
          <p className="text-zinc-500">Production-grade category extraction with strict scoping</p>
        </div>
        
        <div className="flex bg-zinc-100 p-1 rounded-xl">
          <button 
            onClick={() => setViewMode("table")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${viewMode === "table" ? "bg-white shadow-sm text-emerald-600" : "text-zinc-500 hover:text-zinc-700"}`}
          >
            <List className="w-4 h-4" />
            Table
          </button>
          <button 
            onClick={() => setViewMode("grid")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${viewMode === "grid" ? "bg-white shadow-sm text-emerald-600" : "text-zinc-500 hover:text-zinc-700"}`}
          >
            <LayoutGrid className="w-4 h-4" />
            Grid
          </button>
        </div>
      </header>

      <motion.section 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white p-6 rounded-2xl shadow-sm border border-zinc-200 mb-8"
      >
        <form onSubmit={handleScrape} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Page URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.codashop.com/en-ph/"
              className="w-full p-3 rounded-xl border border-zinc-200 focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Category Name (Exact)</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="VOUCHERS"
              className="w-full p-3 rounded-xl border border-zinc-200 focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
              required
            />
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white font-semibold p-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin w-5 h-5" />
                  Scraping...
                </>
              ) : (
                <>
                  <Search className="w-5 h-5" />
                  Start Scrape
                </>
              )}
            </button>
          </div>
        </form>
      </motion.section>

      <AnimatePresence mode="wait">
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl mb-8 flex items-center gap-3"
          >
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p>{error}</p>
          </motion.div>
        )}

        {products.length > 0 ? (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
          >
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-zinc-700">
                Found {products.length} products in "{category}"
              </h2>
              <button 
                onClick={copyToClipboard}
                className="flex items-center gap-2 text-sm font-medium text-zinc-500 hover:text-emerald-600 transition-colors"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? "Copied!" : "Copy TSV"}
              </button>
            </div>

            {viewMode === "table" ? (
              <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-zinc-50 border-b border-zinc-200">
                        <th className="p-4 text-xs font-semibold uppercase tracking-wider text-zinc-400">Title</th>
                        <th className="p-4 text-xs font-semibold uppercase tracking-wider text-zinc-400">URL</th>
                        <th className="p-4 text-xs font-semibold uppercase tracking-wider text-zinc-400">Image URL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {products.map((p, i) => (
                        <tr key={i} className="hover:bg-zinc-50 transition-colors group">
                          <td className="p-4 text-sm font-medium text-zinc-900">{p.title}</td>
                          <td className="p-4 text-sm text-zinc-500 font-mono truncate max-w-xs">
                            <a href={p.url} target="_blank" className="hover:text-emerald-600 underline decoration-zinc-200 underline-offset-4">{p.url}</a>
                          </td>
                          <td className="p-4 text-sm text-zinc-500 font-mono truncate max-w-xs">
                            <a href={p.image} target="_blank" className="hover:text-emerald-600 underline decoration-zinc-200 underline-offset-4">{p.image}</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                {products.map((product, idx) => (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.02 }}
                    className="group bg-white rounded-2xl border border-zinc-200 overflow-hidden hover:shadow-md transition-all"
                  >
                    <div className="aspect-square bg-zinc-100 relative overflow-hidden">
                      <img
                        src={product.image}
                        alt={product.title}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                      />
                    </div>
                    <div className="p-4">
                      <h3 className="font-semibold text-sm mb-3 line-clamp-2 min-h-[2.5rem]">
                        {product.title}
                      </h3>
                      <a
                        href={product.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700"
                      >
                        View Product
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        ) : !loading && !error && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-20 text-zinc-400"
          >
            <Package className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>No products to display. Start a scrape to see results.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
