const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { connectDB } = require('./database');
const { sendEmailNotification } = require('./ai_service');

async function main() {
  console.log('=== Starting Exact-Time Email Digest Job ===');
  console.log('Current time (UTC):', new Date().toISOString());

  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const jstHour = jstNow.getUTCHours();
  console.log(`Current time (JST): ${jstNow.toISOString().replace('T', ' ').slice(0, 19)} (Hour: ${jstHour})`);

  try {
    await connectDB();

    // 6時、12時、18時の時間帯に合わせて新着集計範囲を設定
    // 6時は前夜18時以降の12時間分、それ以外は直近6時間分
    const sinceTime = new Date();
    const sinceHours = (jstHour >= 5 && jstHour <= 7) ? 12 : 6;
    sinceTime.setHours(sinceTime.getHours() - sinceHours);

    console.log(`Sending scheduled digest email (range: past ${sinceHours} hours)...`);
    await sendEmailNotification(sinceTime);
    console.log('=== Email Digest sent successfully ===');
  } catch (err) {
    console.error('Digest email error:', err);
    process.exit(1);
  } finally {
    try {
      await mongoose.disconnect();
    } catch (e) {}
  }
}

main();
