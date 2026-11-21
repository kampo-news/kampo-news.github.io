const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { connectDB } = require('./database');
const { runUpdateJob } = require('./ai_service');
const { exportArticles } = require('./export_articles');

async function main() {
  console.log('=== Starting Kampo News Crawler & AI Update Job (30-min prior) ===');
  console.log('Current time (UTC):', new Date().toISOString());

  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  console.log(`Current time (JST): ${jstNow.toISOString().replace('T', ' ').slice(0, 19)}`);

  try {
    await connectDB();

    // 1. ニュース巡回・AI要約・重複排除・DB保存
    const newArticlesCount = await runUpdateJob();
    console.log(`Update job completed. Added ${newArticlesCount} new articles.`);

    // 2. 記事一覧（articles.json）の最新出力
    await exportArticles();

    console.log('=== Crawler & Updater finished successfully ===');
  } catch (err) {
    console.error('Crawler job error:', err);
    process.exit(1);
  } finally {
    try {
      await mongoose.disconnect();
    } catch (e) {}
  }
}

main();
