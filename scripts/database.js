const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
  title: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  published_at: { type: Date, required: true },
  original_content: { type: String },
  translated_title: { type: String },
  summary: { type: String },
  tags: { type: String },
  translated_content: { type: String },
  topic_name: { type: String },
  category: { type: String, default: 'news' },
  relevance_reason: { type: String },
  is_duplicate: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

const Article = mongoose.model('Article', articleSchema);

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn('MONGO_URI is not set. Database connection skipped.');
    return;
  }
  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected successfully.');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    throw err;
  }
}

module.exports = {
  connectDB,
  Article
};
