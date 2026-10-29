const path = require('path');
const mongoose = require('mongoose');
const fs = require('fs');
const { Article } = require('./database');

async function exportArticles() {
  try {
    const articles = await Article.find({ is_duplicate: { $ne: true } })
      .sort({ published_at: -1, created_at: -1 })
      .limit(200)
      .lean();
    console.log('Fetched non-duplicate articles:', articles.length);

    const outPath = path.join(__dirname, '..', 'articles.json');
    fs.writeFileSync(outPath, JSON.stringify(articles, null, 2), 'utf8');
    console.log(`Successfully updated ${outPath}`);
  } catch (err) {
    console.error('Export error:', err);
    throw err;
  }
}

module.exports = { exportArticles };
