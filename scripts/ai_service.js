const axios = require('axios');
const Parser = require('rss-parser');
const { Article } = require('./database');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
require('dotenv').config();
const turndownService = new TurndownService();
const parser = new Parser();

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
let genAI = null;

// HTML取得時の文字化け（Shift_JISなど）を防ぐヘルパー関数
async function fetchHtmlWithEncoding(url, options = {}) {
  const https = require('https');
  const finalOptions = {
    ...options,
    responseType: 'arraybuffer',
    // 古いSSL証明書を持つサイト（大正製薬等）への対応
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  };
  const res = await axios.get(url, finalOptions);
  
  const htmlBinary = res.data.toString('binary');
  const charsetMatch = htmlBinary.match(/charset=["']?([a-zA-Z0-9\-_]+)["']?/i);
  let charset = 'utf-8';
  if (charsetMatch) {
    charset = charsetMatch[1].toLowerCase();
  }
  
  let decodedHtml;
  try {
    const decoder = new TextDecoder(charset);
    decodedHtml = decoder.decode(res.data);
  } catch (e) {
    const decoder = new TextDecoder('utf-8');
    decodedHtml = decoder.decode(res.data);
  }
  
  return { html: decodedHtml, finalUrl: res.request?.res?.responseUrl || url };
}


const FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.5-flash"
];
let currentModelIndex = 0;

function getModel() {
  if (!genAI) return null;
  return genAI.getGenerativeModel({
    model: FALLBACK_MODELS[currentModelIndex],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          is_relevant: { type: SchemaType.BOOLEAN },
          relevance_reason: { type: SchemaType.STRING },
          summary: { type: SchemaType.STRING },
          tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          topic_name: { type: SchemaType.STRING },
          category: { type: SchemaType.STRING, enum: ['product', 'news'] },
          published_at: { type: SchemaType.STRING }
        },
        required: ["is_relevant", "relevance_reason", "summary", "tags", "topic_name", "category"]
      }
    }
  });
}

function getDeduplicationModel() {
  if (!genAI) return null;
  return genAI.getGenerativeModel({
    model: FALLBACK_MODELS[currentModelIndex],
    generationConfig: {
      responseMimeType: "application/json"
    }
  });
}

if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// 実行中の状態を保持
let isUpdating = false;
let lastUpdateCount = 0;

// 漢方・生薬ニュースを取得する（Bing News & Note RSS）
async function fetchAINews() {
  const bingQueries = [
    '漢方', '生薬', '和漢薬',
    // 薬事・行政・法規制・業界動向（薬機法や厚労省関連）
    '漢方 薬機法', '漢方 厚生労働省', '生薬 薬価基準',
    '漢方薬 ガイドライン', '漢方薬 添付文書改訂',
    '漢方薬 自主回収', '漢方薬 出荷調整', '漢方薬 供給不足',
    '日本漢方生薬製剤協会', '生薬 原料 栽培',
    // 業界メディア・公的ソース
    'site:yakuji.co.jp 漢方', 'site:medical.nikkeibp.co.jp 漢方',
    'site:mhlw.go.jp 漢方', 'site:pmda.go.jp 漢方',
    'site:prtimes.jp 漢方', 'site:prtimes.jp 生薬',
    'site:prtimes.jp ツムラ', 'site:prtimes.jp クラシエ 漢方',
    'site:prtimes.jp 小太郎漢方', 'site:prtimes.jp 養命酒',
    // 主要漢方メーカーの専門ニュース
    'ツムラ 漢方', 'クラシエ 漢方', '小太郎漢方製薬',
    'ウチダ和漢薬', '三和生薬', '大杉製薬 漢方', '松浦薬業 漢方',
    '栃本天海堂 生薬', '本草製薬 漢方', 'イスクラ産業 漢方',
    '剤盛堂薬品 漢方', 'JPS製薬 漢方', '養命酒 生薬', 'ロート製薬 和漢'
  ];
  const results = [];

  // Bing News RSS
  for (const q of bingQueries) {
    try {
      const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS&cc=jp`;
      const feed = await parser.parseURL(url);
      results.push(...feed.items.slice(0, 30).map(item => {
        // Bingのapiclickから元のURLを抽出
        let linkUrl = item.link;
        if (linkUrl.includes('bing.com/news/apiclick')) {
          try {
            const parsed = new URL(linkUrl);
            const realUrl = parsed.searchParams.get('url');
            if (realUrl) linkUrl = realUrl;
          } catch(e) {}
        }
        return {
          title: item.title,
          link: linkUrl,
          pubDate: item.pubDate,
          contentSnippet: item.contentSnippet || item.content,
          category: 'news',
          isDirectScrape: false
        };
      }));
    } catch (e) {
      console.warn('Bing RSS parse error:', e.message);
    }
  }

  // Google News RSS（漢方・生薬・製薬メーカー関連の高鮮度ニュース）
  const googleQueries = [
    '漢方 OR 生薬',
    'ツムラ OR クラシエ OR 小太郎漢方',
    '漢方薬 出荷調整 OR 漢方薬 供給',
    '薬事日報 漢方 OR 日本経済新聞 漢方',
    '日漢協 OR 生薬 栽培'
  ];

  for (const gq of googleQueries) {
    try {
      const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(gq)}&hl=ja&gl=JP&ceid=JP:ja`;
      const gFeed = await parser.parseURL(gUrl);
      results.push(...gFeed.items.slice(0, 30).map(item => ({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        contentSnippet: item.contentSnippet || item.content,
        category: 'news',
        isDirectScrape: false
      })));
    } catch (e) {
      console.warn('Google News RSS parse error:', e.message);
    }
  }

  return results;
}

async function fetchPharmaSitesViaRSS() {
  let results = [];
  
  // 直接スクレイピングによる取得（全会員企業対応）
  const directSites = [
    // 既存（動作確認済み）
    { name: '小太郎漢方', url: 'https://www.kotaro.co.jp/category/news_release/' },
    { name: 'イスクラ産業', url: 'https://www.iskra.co.jp/news/' },
    { name: '三和生薬', url: 'https://www.sanwashoyaku.co.jp/' },
    { name: 'ホノミ漢方', url: 'https://www.zaiseido.co.jp/topics/' },
    // 新規追加（URL疎通確認済み）
    { name: 'アスゲン製薬', url: 'https://www.asgen.co.jp/news/' },
    { name: 'アリナミン製薬', url: 'https://alinamin-pharma.co.jp/news/' },
    { name: 'アルプス薬品工業', url: 'https://www.alps-pharm.co.jp/news/' },
    { name: 'ウチダ和漢薬', url: 'https://www.uchidawakanyaku.co.jp/' },
    { name: '大木製薬', url: 'https://www.ohkiseiyaku.com/news/' },
    { name: '大草薬品', url: 'https://www.okusa.co.jp/' },
    { name: '大杉製薬', url: 'https://ohsugi-kanpo.co.jp/' },
    { name: '太田胃散', url: 'https://www.ohta-isan.co.jp/whatsnew/' },
    { name: '大峰堂薬品工業', url: 'https://www.ominedo.co.jp/' },
    { name: '北日本製薬', url: 'https://www.999jp.co.jp/' },
    { name: '救心製薬', url: 'https://www.kyushin.co.jp/' },
    { name: '皇漢薬品研究所', url: 'https://kohkan.co.jp/news/' },
    { name: '興和', url: 'https://www.kowa.co.jp/news/index.htm' },
    { name: '小西製薬', url: 'https://konishi-ph.jp/' },
    { name: '小林製薬', url: 'https://www.kobayashi.co.jp/newsrelease/' },
    { name: '阪本漢法製薬', url: 'https://sakampow.com/news/' },
    { name: '佐藤製薬', url: 'https://www.sato-seiyaku.co.jp/newsrelease/' },
    { name: '三宝製薬', url: 'https://www.sampo-seiyaku.co.jp/' },
    { name: 'JPS製薬', url: 'https://www.jps-pharm.com/news/' },
    { name: 'ゼリア新薬', url: 'https://www.zeria.co.jp/information/' },
    { name: '全薬工業', url: 'https://www.zenyaku.co.jp/news/' },
    { name: '第一三共ヘルスケア', url: 'https://www.daiichisankyo-hc.co.jp/' },
    { name: '大幸薬品', url: 'https://www.seirogan.co.jp/' },
    { name: '大正製薬', url: 'https://www.taisho.co.jp/' },
    { name: '建林松鶴堂', url: 'https://kanpou-tatebayashi.jp/' },
    { name: '常磐植物化学研究所', url: 'https://www.tokiwaph.co.jp/information/' },
    { name: '栃本天海堂', url: 'https://www.tochimoto.co.jp/' },
    { name: '長野県製薬', url: 'https://www.hyakuso.co.jp/news/' },
    { name: '日本粉末薬品', url: 'https://www.nfy.co.jp/' },
    { name: '本草製薬', url: 'https://www.honzo.co.jp/' },
    { name: '松浦薬業', url: 'https://www.matsuura-gp.co.jp/' },
    { name: '龍角散', url: 'https://www.ryukakusan.co.jp/' },
    { name: 'ロート製薬', url: 'https://www.rohto.co.jp/news/' },
    { name: '和漢薬研究所', url: 'https://www.capony-wakanyaku.co.jp/' },
  ];

  for (const site of directSites) {
    try {
      const { html, finalUrl: finalBaseUrl } = await fetchHtmlWithEncoding(site.url, { timeout: 10000 });
      const dom = new JSDOM(html);
      const links = Array.from(dom.window.document.querySelectorAll('a'))
        .filter(a => a.href && a.textContent)
        .map(a => {
          const container = a.closest('li, tr, dt, dd, article, section') || a.parentElement || a;
          return { 
            href: new URL(a.href, finalBaseUrl).href, 
            text: a.textContent.trim().replace(/\s+/g, ' '),
            containerText: container.textContent.trim().replace(/\s+/g, ' ')
          };
        });

      let extractedCount = 0;
      for (const link of links) {
        // ナビゲーションや静的カタログ等の無関係なリンクを除外
        const skipWords = [
          'プライバシー', '会社概要', '企業理念', '採用情報', 'お問い合わせ', 'サイトマップ',
          'ホーム', 'English', '一覧', 'IR情報', 'サステナビリティ', '添付文書', '医療関係者',
          'お求めの方', '製品情報', 'ラインナップ', 'オンラインショップ', '商品一覧', '検索',
          '相談窓口', 'SDGs', '木曽再発見', 'アクセス制限', 'よくあるご質問', 'Q&A', '利用規約',
          'リンク集', '特定商取引', 'ログイン', 'マイページ', 'カタログ', 'OEM受託', '周辺情報'
        ];
        if (link.text.length < 8 || skipWords.some(w => link.text.includes(w) || link.containerText.includes(w))) {
          continue;
        }

        // 静的カタログや製品検索ページなどのURLパターンを除外
        const urlLower = link.href.toLowerCase();
        if (urlLower.includes('/lineup/') || urlLower.includes('/product/') || 
            urlLower.includes('/check.html') || urlLower.includes('search') || 
            urlLower.includes('/shop') || urlLower.includes('/catalog')) {
          continue;
        }

        // 過去の日付（例: 2026.09.15）を抽出。日付が全く記載されていない静的リンクは除外
        const dateMatch = link.containerText.match(/(20\d{2})[\/\.年](0?[1-9]|1[0-2])([\/\.月](0?[1-9]|[12]\d|3[01]))?/);
        if (!dateMatch) {
          // 日付が明記されていないリンクは固定ページやメニューの可能性が高いためスキップ
          continue;
        }

        const year = parseInt(dateMatch[1], 10);
        const currentYear = new Date().getFullYear();
        if (year < currentYear - 1) continue; // 1年以上前はスキップ

        const month = dateMatch[2].padStart(2, '0');
        const day = dateMatch[4] ? dateMatch[4].padStart(2, '0') : '01';
        const pubDateStr = `${year}-${month}-${day}`;

        if (extractedCount >= 5) break; // 各サイト最大5件まで

        results.push({
          title: `【${site.name} 公式】${link.text}`,
          link: link.href,
          pubDate: pubDateStr,
          category: 'product',
          contentSnippet: link.text,
          isDirectScrape: true
        });
        extractedCount++;
      }
    } catch (e) {
      console.warn(`Failed to fetch pharma site directly ${site.name}:`, e.message);
    }
  }

  return results;
}

async function processArticleWithGemini(articleText, title, category) {
  if (!genAI) {
    throw new Error('GEMINI_API_KEY is missing or invalid.');
  }

  const prompt = `
以下の記事を精査し、「漢方・生薬・和漢薬」または「製薬業界自体（薬機法、厚労省行政、法規制、ガイドライン、薬価、出荷調整、業界再編）」に関する重要ニュースであるかを厳正に吟味してください。

【タイトル】
${title}

【本文】
${articleText}

━━━━━━━━━━━━━━━━━━━━━━━━━━
【審査基準（is_relevant の判定ルール）】
━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 合格（is_relevant = true とする基準）:
1. 漢方薬・生薬・和漢薬に関する具体的なニュース（新処方・新製品の発売、販売終了、自主回収、供給不足、出荷調整、栽培・原料調達、薬理研究など）
2. 製薬業界全体および漢方・生薬に関わる法律・行政・制度動向（薬機法、添付文書改訂、薬価改定、厚労省方針、PMDA通達、日漢協の指針・声明など）
3. 漢方製薬企業（ツムラ、クラシエ、小太郎漢方、三和生薬、ウチダ和漢薬など）の重要な経営、決算、業務提携、事業再編、生産設備投資

■ 不合格（is_relevant = false として除外する基準）:
1. 単なるウェブサイトの固定案内・カタログページ（製品一覧、成分カタログ、医療関係者向けアクセス確認画面、添付文書一覧、お問い合わせ案内、OEM受託案内など、新たなニュース・出来事ではないもの）
2. 芸能人のCM出演、タレントの発表会・インタビュー、エンタメ・タブロイド記事
3. 漢方・生薬に直接関わらない一般の医薬品・日用品・健康食品（目薬、ビタミン剤、一般の風邪薬、サプリメント一般、消臭剤など）
4. 個人のブログ、体験談、アフィリエイト、Note、一般的な季節の健康・美容コラム
5. 過去の古い記事の再掲載、または単なる神社の祭りなどの地域行事

━━━━━━━━━━━━━━━━━━━━━━━━━━
【出力JSONフォーマット】
- is_relevant: 上記審査基準に基づき、漢方・生薬・製薬業界（法律等）のニュースとして相応しい場合は true、不合格なら false
- relevance_reason: 判定した理由（なぜ合格か、またはなぜ不合格か）を1文で明記
- summary: is_relevant が true の場合、記事の要点を3〜4文で要約。false の場合は "UNRELATED"
- category: 製品の具体的なアクション（新発売、販売終了、回収、出荷調整など）は "product"、法規制や業界動向・企業ニュースは "news"
- tags: 主要な企業名または生薬・漢方名（最大2件、例: ["ツムラ", "出荷調整"]）
- topic_name: 主要な出来事を示す簡潔な名詞句（例: "医療用漢方製剤の出荷調整", "薬機法改正に伴う規制見直し"）
- published_at: ニュースが世間に発表・配信された日付を "YYYY-MM-DD" で抽出（本文やタイトルから明確に特定できる場合のみ。特定できない場合や未来の日付は ""）
`;

  let maxRetries = FALLBACK_MODELS.length * 2;
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      const activeModel = getModel();
      const result = await activeModel.generateContent(prompt);
      return JSON.parse(result.response.text());
    } catch (error) {
      if (error.status === 429 || (error.message && error.message.includes('429'))) {
        console.log(`[429 Quota Exceeded] Model ${FALLBACK_MODELS[currentModelIndex]} hit rate limit. Switching model...`);
        currentModelIndex = (currentModelIndex + 1) % FALLBACK_MODELS.length;
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3秒待機して再試行
      } else {
        console.warn(`Gemini API Error with ${FALLBACK_MODELS[currentModelIndex]}:`, error.message);
        currentModelIndex = (currentModelIndex + 1) % FALLBACK_MODELS.length;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    attempts++;
  }
  return null; // 全モデルで失敗した場合は例外でジョブを止めずにnullを返して次の記事へ進む
}

// 全体のフロー: 取得 -> 未保存の記事を抽出 -> AI処理 -> DB保存
async function runUpdateJob() {
  if (isUpdating) {
    console.log('Update job is already running, skipping.');
    return 0;
  }
  
  isUpdating = true;
  console.log('Starting AI News update job...');
  let processedCount = 0;
  let newArticleIds = [];

  try {
    const items = await fetchAINews();

    // デモ・テスト用: 画面の「処理中」バナーを確認できるよう、少し待機
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 全17社のサイトをRSS経由で抽出してアイテムに追加
    const pharmaItems = await fetchPharmaSitesViaRSS();
    items.push(...pharmaItems);

    // DBの記事数を取得して足切りラインを動的に設定
    // 週末や連休、前日夕方の発表も拾えるよう、直近3日間（72時間前）を足切りラインとする
    const dbArticleCount = await Article.countDocuments();
    let timeLimitDate = new Date();
    timeLimitDate.setDate(timeLimitDate.getDate() - 3);
    timeLimitDate.setHours(0, 0, 0, 0);
    const timeLimit = timeLimitDate.getTime();
    console.log(`Time Limit Set: ${timeLimitDate.toISOString()} (DB count: ${dbArticleCount})`);

    // DBの既存タイトルを取得して、過去のジョブを含めた全体での重複を排除する
    const existingArticles = await Article.find({}, 'title').lean();
    const allExistingTitles = existingArticles.map(r => r.title);

    const uniqueItemsMap = new Map();
    for (const item of items) {
      // 公式サイト直接取得の記事(isDirectScrape)はpubDateがなくても追加する
      // Bing RSSの記事は当日0時以降のもののみ
      const isNew = item.isDirectScrape || !item.pubDate || new Date(item.pubDate).getTime() >= timeLimit;
      if (isNew) {
        if (!uniqueItemsMap.has(item.link)) {
          uniqueItemsMap.set(item.link, item);
        }
      } else {
        console.log(`Skipping old article (older than time limit): ${item.title}`);
      }
    }
    const uniqueItems = Array.from(uniqueItemsMap.values());

    // 1. 各記事の本文スクレイピングと初期オブジェクト構築
    const rawCandidates = [];
    for (const item of uniqueItems) {
      const exists = await Article.findOne({ url: item.link }).lean();
      if (exists) {
        continue; // 既に保存済みならスキップ
      }

      console.log(`Scraping content: ${item.title}`);
      let contentToProcess = item.contentSnippet || item.content || item.title;

      try {
        const finalUrl = item.link;
        if (finalUrl.toLowerCase().endsWith('.pdf')) {
          contentToProcess = '（PDF形式のニュースリリースです。詳細はリンク先をご参照ください）';
        } else {
          const { html } = await fetchHtmlWithEncoding(finalUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
            timeout: 10000
          });

          const dom = new JSDOM(html, { url: finalUrl });
          const document = dom.window.document;
          
          document.querySelectorAll('img').forEach(img => {
            if (img.src) img.src = img.src;
          });
          document.querySelectorAll('a').forEach(a => {
            if (a.href) a.href = a.href;
          });

          const reader = new Readability(document);
          const article = reader.parse();
          if (article && article.content) {
            contentToProcess = turndownService.turndown(article.content);
          }
        }
      } catch (e) {
        console.warn(`Failed to scrape article content for ${item.link}:`, e.message);
      }

      // 短すぎる記事の足切り
      if (!item.isDirectScrape && item.category !== 'news' && (contentToProcess.length < 200 || contentToProcess === item.title || contentToProcess === item.contentSnippet)) {
        console.log(`Skipping: Article content is too short or missing. (${contentToProcess.length} chars)`);
        continue;
      }

      rawCandidates.push({
        item,
        title: item.title,
        link: item.link,
        url: item.link,
        published_at: item.pubDate ? new Date(item.pubDate) : null,
        contentToProcess
      });
    }

    // 2. 新規記事リスト内での事前重複排除（新規同士の比較）
    const selectedNewCandidates = [];
    const newProcessed = new Set();

    for (let i = 0; i < rawCandidates.length; i++) {
      const a = rawCandidates[i];
      if (newProcessed.has(i)) continue;

      const group = [{ candidate: a, index: i }];
      newProcessed.add(i);

      for (let j = i + 1; j < rawCandidates.length; j++) {
        const b = rawCandidates[j];
        if (newProcessed.has(j)) continue;

        if (areDuplicateArticles(a, b)) {
          group.push({ candidate: b, index: j });
          newProcessed.add(j);
        }
      }

      // グループ内でスコア（一般公開優先 ＞ 本文文字数最大）が最も高いものを1件選定
      group.sort((x, y) => getArticleScore(y.candidate) - getArticleScore(x.candidate));
      const best = group[0].candidate;
      selectedNewCandidates.push(best);

      if (group.length > 1) {
        console.log(`[新規内重複排除] ${group.length}件の中から最良記事を選定 (キープ: ${best.title.slice(0, 30)}, Score: ${getArticleScore(best)})`);
        for (let k = 1; k < group.length; k++) {
          console.log(`   除外: ${group[k].candidate.title.slice(0, 30)} (Score: ${getArticleScore(group[k].candidate)})`);
        }
      }
    }

    // 3. 既存ニュースとの比較（既存と新規の突き合わせ）
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const recentExisting = await Article.find({
      published_at: { $gte: twoWeeksAgo },
      is_duplicate: { $ne: true }
    }).lean();

    for (const cand of selectedNewCandidates) {
      const { item, contentToProcess } = cand;

      // 既存記事との重複チェック（AI処理前にタイトルレベルで事前判定）
      const matchedExisting = recentExisting.find(ex => areDuplicateArticles(cand, ex));
      if (matchedExisting) {
        const candScore = getArticleScore(cand);
        const exScore = getArticleScore(matchedExisting);
        
        // 新情報が追加されていない場合（既存と同等以下、または新規が会員限定）はスルー
        const hasSignificantNewInfo = (candScore > exScore * 1.15) || (isPaywallArticle(matchedExisting.title, matchedExisting.original_content, matchedExisting.url) && !isPaywallArticle(cand.title, contentToProcess, cand.link));
        
        if (!hasSignificantNewInfo) {
          console.log(`[既存重複スルー] 既存記事が存在し新情報がないため登録をスキップ: ${cand.title.slice(0, 40)} (新規Score: ${candScore} <= 既存Score: ${exScore})`);
          continue;
        }
      }

      console.log(`Processing AI for: ${cand.title}`);
      try {
        const apiResult = await processArticleWithGemini(contentToProcess, cand.title, item.category);
        await new Promise(resolve => setTimeout(resolve, 10000));

        if (!apiResult || !apiResult.is_relevant || (apiResult.summary && (apiResult.summary.includes('UNRELATED') || apiResult.summary.includes('SPAM')))) {
          console.log(`[除外] 業界無関係または不適合な記事をスキップ: ${cand.title}`);
          console.log(`       理由: ${apiResult?.relevance_reason || '不合格判定'}`);
          continue;
        }

        // 日付特定
        let finalDate = cand.published_at;
        if (!finalDate && apiResult.published_at && apiResult.published_at !== "") {
          const parsedAiDate = new Date(apiResult.published_at);
          if (!isNaN(parsedAiDate.getTime()) && parsedAiDate <= new Date()) {
            finalDate = parsedAiDate;
          }
        }
        if (!finalDate || finalDate.getTime() < timeLimit) {
          console.log(`[除外] 古い記事または日付特定不可のため破棄: ${cand.title}`);
          continue;
        }

        // AI生成のtopic_nameを加味して既存記事と再突き合わせ
        cand.topic_name = apiResult.topic_name || '';
        const recheckExisting = recentExisting.find(ex => areDuplicateArticles(cand, ex));
        if (recheckExisting) {
          const candScore = getArticleScore(cand);
          const exScore = getArticleScore(recheckExisting);
          const hasSignificantNewInfo = (candScore > exScore * 1.15) || (isPaywallArticle(recheckExisting.title, recheckExisting.original_content, recheckExisting.url) && !isPaywallArticle(cand.title, contentToProcess, cand.link));
          
          if (!hasSignificantNewInfo) {
            console.log(`[既存重複スルー(AI判定後)] 新情報なしのためスキップ: ${cand.title.slice(0, 40)}`);
            continue;
          } else {
            console.log(`[既存記事の更新] より情報量が多い新規記事を採用し、既存記事(${recheckExisting._id})を重複化: ${cand.title.slice(0, 40)}`);
            await Article.updateOne({ _id: recheckExisting._id }, { $set: { is_duplicate: true } });
          }
        }

        const newDoc = await Article.create({
          title: cand.title,
          url: cand.link,
          published_at: finalDate,
          original_content: contentToProcess,
          translated_title: cand.title,
          summary: apiResult.summary || '',
          tags: JSON.stringify(apiResult.tags || []),
          translated_content: contentToProcess,
          topic_name: apiResult.topic_name || '',
          category: apiResult.category || item.category || 'news',
          relevance_reason: apiResult.relevance_reason || ''
        });

        newArticleIds.push(newDoc._id);
        processedCount++;
      } catch (e) {
        if (e.code !== 11000 && !e.message.includes('DEEPL_API_KEY')) {
          console.error('Database error during processing:', e);
        }
      }
    }

    // 全記事の取得・保存完了後、重複排除処理を実行
    if (newArticleIds.length > 0) {
      await deduplicateRecentArticles(newArticleIds);
    }

    // 最新記事データをJSONにエクスポート
    try {
      const { exportArticles } = require('./export_articles');
      await exportArticles();
    } catch (expErr) {
      console.error('Failed to auto-export articles:', expErr);
    }
  } catch (e) {
    console.error('Update job error:', e);
  } finally {
    isUpdating = false;
    lastUpdateCount = processedCount;
    console.log(`Update job finished. Added ${processedCount} new articles.`);
    

  }
  
  return processedCount;
}

// --- 重複記事判定・優先順位付けヘルパー ---
function isPaywallArticle(title, content, url) {
  const text = ((title || '') + ' ' + (content || '')).toLowerCase();
  const paywallKeywords = [
    '会員限定',
    '有料会員',
    '有料記事',
    'この記事は会員登録が必要です',
    '会員登録して続きを読む',
    'ログインして続きを読む',
    '続きを読む（会員登録）',
    '続きを読むには会員登録',
    'ここから先は有料',
    '有料プラン',
    '定期購読'
  ];
  return paywallKeywords.some(kw => text.includes(kw));
}

function cleanTitle(title) {
  if (!title) return '';
  return title
    .replace(/^【[^】]*】\s*/, '')
    .replace(/^[[^]]*]\s*/, '')
    .replace(/\s+[-–|]\s+[^-–|]+$/, '') // 末尾のメディア名
    .replace(/[\s\u3000]+/g, '')
    .replace(/[「」『』【】\[\]\(\)（）"'`、。！？!?,\.・…\-=+]/g, '')
    .toLowerCase();
}

function cleanTopic(topic) {
  if (!topic) return '';
  return topic
    .replace(/[\s\u3000]+/g, '')
    .replace(/[「」『』【】\[\]\(\)（）"'`、。！？!?,\.・…\-=+]/g, '')
    .toLowerCase();
}

function getArticleScore(a) {
  const title = a.title || '';
  const content = a.original_content || a.contentToProcess || '';
  const url = a.url || a.link || '';
  const isPaywall = isPaywallArticle(title, content, url);
  const len = content.length;
  // 会員限定記事は大幅に減点（一般公開記事が常に優先されるようにする）
  return isPaywall ? len - 100000 : len;
}

function areDuplicateArticles(a, b) {
  const dateA = a.published_at ? new Date(a.published_at).getTime() : 0;
  const dateB = b.published_at ? new Date(b.published_at).getTime() : 0;
  if (dateA && dateB && Math.abs(dateA - dateB) > 14 * 24 * 60 * 60 * 1000) {
    return false;
  }

  const hasCompanyA = (a.title || '').match(/^【(.*?)(\s*公式)?】/);
  const hasCompanyB = (b.title || '').match(/^【(.*?)(\s*公式)?】/);
  if (hasCompanyA && hasCompanyB && hasCompanyA[1] !== hasCompanyB[1]) {
    return false;
  }

  const cleanA = cleanTitle(a.title);
  const cleanB = cleanTitle(b.title);

  if (cleanA && cleanB) {
    if (cleanA === cleanB) return true;

    const boilerplate = /^(一般用医薬品|新発売|医療用漢方製剤|製品案内|お知らせ|ニュースリリース)[:：]?/;
    const strippedA = cleanA.replace(boilerplate, '');
    const strippedB = cleanB.replace(boilerplate, '');

    if (strippedA && strippedB) {
      if (strippedA === strippedB) return true;
      let strippedPrefixLen = 0;
      const strippedMinLen = Math.min(strippedA.length, strippedB.length);
      while (strippedPrefixLen < strippedMinLen && strippedA[strippedPrefixLen] === strippedB[strippedPrefixLen]) {
        strippedPrefixLen++;
      }
      if (strippedPrefixLen >= 12 && (strippedPrefixLen / strippedMinLen >= 0.7)) {
        return true;
      }
      if ((strippedA.includes(strippedB) && strippedB.length >= 12 && strippedB.length / strippedA.length >= 0.8) ||
          (strippedB.includes(strippedA) && strippedA.length >= 12 && strippedA.length / strippedB.length >= 0.8)) {
        return true;
      }
    }
  }

  const topicA = cleanTopic(a.topic_name);
  const topicB = cleanTopic(b.topic_name);
  if (topicA && topicB) {
    if (topicA === topicB && topicA.length >= 8) return true;
    let topicPrefixLen = 0;
    const topicMin = Math.min(topicA.length, topicB.length);
    while (topicPrefixLen < topicMin && topicA[topicPrefixLen] === topicB[topicPrefixLen]) {
      topicPrefixLen++;
    }
    if (topicPrefixLen >= 12 && (topicPrefixLen / topicMin >= 0.8)) {
      return true;
    }
  }

  return false;
}

function getStatus() {
  return { isUpdating, lastUpdateCount };
}

async function deduplicateRecentArticles(newArticleIds) {
  console.log('Starting high-precision deduplication for recent articles...');
  try {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const activeArticles = await Article.find({
      published_at: { $gte: twoWeeksAgo },
      is_duplicate: { $ne: true }
    }).sort({ published_at: -1, created_at: -1 }).lean();

    if (activeArticles.length < 2) return;

    const processed = new Set();
    const groups = [];

    for (let i = 0; i < activeArticles.length; i++) {
      const a = activeArticles[i];
      if (processed.has(a._id.toString())) continue;

      const group = [a];
      processed.add(a._id.toString());

      for (let j = i + 1; j < activeArticles.length; j++) {
        const b = activeArticles[j];
        if (processed.has(b._id.toString())) continue;

        if (areDuplicateArticles(a, b)) {
          group.push(b);
          processed.add(b._id.toString());
        }
      }

      if (group.length > 1) {
        groups.push(group);
      }
    }

    for (const group of groups) {
      group.sort((a, b) => getArticleScore(b) - getArticleScore(a));
      const best = group[0];
      const duplicates = group.slice(1);

      const duplicateIds = duplicates.map(d => d._id);
      if (duplicateIds.length > 0) {
        await Article.updateMany(
          { _id: { $in: duplicateIds } },
          { $set: { is_duplicate: true } }
        );
        console.log(`[重複除外マーク] キープ: ${best.title.slice(0, 30)} (Score: ${getArticleScore(best)})`);
        duplicates.forEach(d => {
          console.log(`   除外対象: ${d.title.slice(0, 30)} (Score: ${getArticleScore(d)})`);
        });
      }
    }
    console.log('High-precision deduplication finished.');
  } catch (err) {
    console.error('Error during deduplication:', err);
  }
}

async function sendLineNotification(sinceTime) {
  // メール通知に移行済みのため、こちらはメール送信を呼び出す
  return sendEmailNotification(sinceTime);
}

async function sendEmailNotification(sinceTime) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('Gmail credentials not set. Skipping email notification.');
    return;
  }
  try {
    const newArticles = await Article.find({ created_at: { $gte: sinceTime }, is_duplicate: { $ne: true } }).sort({ created_at: -1 }).lean();
    if (newArticles.length === 0) {
      console.log('No new articles for email notification.');
      return;
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    const appUrl = process.env.APP_URL || '';
    const newsArticles    = newArticles.filter(a => (a.category || 'news') === 'news');
    const productArticles = newArticles.filter(a => a.category === 'product');

    // HTMLメール本文を組み立て
    const buildSection = (title, emoji, items, limit = 8) => {
      if (items.length === 0) return '';
      let html = `<h2 style="color:#2e6b3e;border-bottom:2px solid #2e6b3e;padding-bottom:6px;">${emoji} ${title}</h2><ul style="padding-left:16px;">`;
      items.slice(0, limit).forEach(a => {
        const displayTitle = (a.topic_name && a.topic_name !== '一般ニュース') ? a.topic_name : a.title;
        const pub = a.published_at ? new Date(a.published_at).toLocaleDateString('ja-JP') : '';
        html += `<li style="margin-bottom:10px;">
          <a href="${a.url}" style="color:#1a56db;font-weight:bold;text-decoration:none;">${displayTitle}</a>
          ${pub ? `<span style="color:#888;font-size:12px;margin-left:8px;">${pub}</span>` : ''}
          ${a.summary ? `<p style="color:#444;font-size:13px;margin:4px 0 0 0;">${a.summary}</p>` : ''}
        </li>`;
      });
      if (items.length > limit) {
        html += `<li style="color:#888;">…他 ${items.length - limit} 件</li>`;
      }
      html += '</ul>';
      return html;
    };

    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const htmlBody = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#f9f9f9;">
  <div style="background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h1 style="color:#2e6b3e;margin-top:0;">📰 漢方ニュース 新着 ${newArticles.length} 件</h1>
    <p style="color:#888;font-size:13px;">配信時刻: ${now}</p>
    ${buildSection('ニュース', '📋', newsArticles)}
    ${buildSection('製品情報', '💊', productArticles)}
    ${appUrl ? `<div style="margin-top:24px;text-align:center;"><a href="${appUrl}" style="background:#2e6b3e;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">アプリで全件確認する →</a></div>` : ''}
  </div>
</body>
</html>`;

    await transporter.sendMail({
      from: `"漢方ニュース" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.GMAIL_USER,
      subject: `📰 漢方ニュース 新着${newArticles.length}件 (${now})`,
      html: htmlBody
    });
    console.log('Email notification sent successfully.');
  } catch (err) {
    console.error('Error sending email notification:', err.message);
  }
}

module.exports = {
  runUpdateJob,
  sendLineNotification,
  sendEmailNotification,
  getStatus,
  deduplicateRecentArticles,
  fetchAINews
};
