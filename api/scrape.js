export default async function handler(req, res) {

  const { url, category } = req.query;

  try {

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = await response.text();

    const productRegex = /"productName":"(.*?)".*?"productUrl":"(.*?)".*?"thumbnailUrl":"(.*?)"/g;

    const results = [];
    let match;

    while ((match = productRegex.exec(html)) !== null) {

      results.push({
        title: match[1],
        url: "https://www.codashop.com" + match[2],
        image: match[3]
      });

    }

    res.status(200).json(results);

  } catch (error) {

    res.status(500).json({ error: error.message });

  }

}
