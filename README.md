# Codashop Scraper API

A production-ready web scraper for Codashop products using Playwright and Express.

## Features
- Scrape products from specific categories on Codashop.
- Robust selector strategy that works across different country pages.
- API endpoint for programmatic access.
- Modern React UI for testing.

## Local Setup

1. **Clone the repository**
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Install Playwright browsers**
   ```bash
   npx playwright install chromium
   ```
4. **Run the development server**
   ```bash
   npm run dev
   ```
   The app will be available at `http://localhost:3000`.

## API Usage

**Endpoint:** `/api/scrape`

**Parameters:**
- `url`: The full Codashop country page URL (e.g., `https://www.codashop.com/en-ph/`)
- `category`: The name of the category to scrape (e.g., `Vouchers`)

**Example Request:**
```bash
curl "http://localhost:3000/api/scrape?url=https://www.codashop.com/en-ph/&category=Vouchers"
```

## Deployment on Render

1. **Create a new Web Service** on Render.
2. **Connect your GitHub repository**.
3. **Configure the service:**
   - **Environment:** `Node`
   - **Build Command:** `npm install && npx playwright install chromium --with-deps && npm run build`
   - **Start Command:** `node server.ts`
4. **Add Environment Variables:**
   - `NODE_ENV`: `production`
5. **Render Disk (Optional):** Playwright browsers are installed in the cache, so you might want to ensure the build command includes the browser installation.

Note: Render's native environment might require additional dependencies for Playwright. Using the `playwright install --with-deps` command in the build step is recommended.

## Selectors Optimization
The scraper uses a combination of text-based filtering and generic element traversal to find categories and products. This makes it resilient to minor class name changes and helps it work across different regional versions of Codashop which share a similar layout structure.
