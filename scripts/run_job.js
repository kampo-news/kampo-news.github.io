const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { connectDB } = require('./database');
const { runUpdateJob, sendEmailNotification } = require('./ai_service');
const { exportArticles } = require('./export_articles');

async function main() {
  console.log('=== Starting Kampo News Automated Job ===');
  console.log('Current time (UTC):', new Date().toISOString());

  // 日本時間（JST）の現在時刻を取得
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const jstHour = jstNow.getUTCHours();
  console.log(`Current time (JST): ${jstNow.toISOString().replace('T', ' ').slice(0, 19)} (Hour: ${jstHour})`);

  try {
    await connectDB();

    // 1. ニュース巡回・AI要約・重複排除・DB保存
    const sinceTime = new Date();
    // 6時・12時・18時の通知範囲設定（6時は前夜18時以降の12時間分、それ以外は直近6時間分）
    const sinceHours = (jstHour >= 5 && jstHour <= 7) ? 12 : 6;
    sinceTime.setHours(sinceTime.getHours() - sinceHours);

    const newArticlesCount = await runUpdateJob();
    console.log(`Update job completed. Added ${newArticlesCount} new articles.`);

    // 2. 記事一覧（articles.json）の最新出力
    await exportArticles();

    // 3. メール通知の送信判定
    // 6時、12時、18時前後のジョブ、または新着記事がある場合は送信
    // ★ メール送信タイミングの厳格化（変な時間の通知防止）
    // 6時、12時、18時の定時枠のみに限定し、新着記事があっても中途半端な時間（9時や15時等）には送らない
    const isNotifyHour = (jstHour >= 5 && jstHour <= 7) || (jstHour >= 11 && jstHour <= 13) || (jstHour >= 17 && jstHour <= 19);
    
    if (isNotifyHour) {
      console.log(`Triggering scheduled email notification for JST Hour ${jstHour} (range: since ${sinceHours} hours ago)...`);
      await sendEmailNotification(sinceTime);
    } else {
      console.log(`Skipping email notification: Current JST Hour is ${jstHour}. Scheduled email notifications only run at 6:00, 12:00, and 18:00.`);
    }

    console.log('=== All tasks finished successfully ===');
  } catch (err) {
    console.error('Job error:', err);
    process.exit(1);
  } finally {
    try {
      await mongoose.disconnect();
    } catch (e) {}
  }
}

main();
