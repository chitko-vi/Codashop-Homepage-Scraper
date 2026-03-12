export default async function handler(req, res) {

  const { url } = req.query;

  try {

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = await response.text();

    const productRegex = /"thumbnailUrl":"(.*?)".*?"productName":"(.*?)".*?"productUrl":"(.*?)"/g;

    const results = [];
    let match;

    while ((match = productRegex.exec(html)) !== null) {

      results.push({
        title: match[2],
        url: "https://www.codashop.com" + match[3],
        image: match[1]
      });

    }

    res.status(200).json(results);

  } catch (error) {

    res.status(500).json({ error: error.message });

  }

}
