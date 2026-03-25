// Plainly — News Pipeline v2
// RSS feeds → scrape full article text → Gemini rewrites → Supabase
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import Parser from 'rss-parser';
import { parse as parseHTML } from 'node-html-parser';
import fs from 'fs';
import path from 'path';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_KEY) {
  console.error('❌ Missing environment variables. Check your GitHub secrets.');
  process.exit(1);
}

const db     = createClient(SUPABASE_URL, SUPABASE_KEY);
const parser = new Parser({ timeout: 10000 });

// ─── FEEDS ───────────────────────────────────────────────────────────────────
// Reuters RSS has been blocked since 2023. Replaced with AP News, BBC, FT.
// SMH /rss/money.xml and /rss/business/companies.xml return 404 — fixed URLs.
const FEEDS = [
  // Australia
  { url: 'https://www.smh.com.au/rss/business.xml',                            section: 'aus',    label: 'SMH Business' },
  { url: 'https://www.theguardian.com/australia-news/rss',                     section: 'aus',    label: 'Guardian Australia' },
  // World
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                        section: 'world',  label: 'BBC World' },
  { url: 'https://www.theguardian.com/world/rss',                              section: 'world',  label: 'Guardian World' },
  // US
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/',              section: 'us',     label: 'MarketWatch' },
  { url: 'https://www.theguardian.com/us-news/rss',                            section: 'us',     label: 'Guardian US' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',                     section: 'biz',    label: 'BBC Business' },
  // Business
  { url: 'https://www.theguardian.com/business/rss',                           section: 'biz',    label: 'Guardian Business' },
  // Tech
  { url: 'https://feeds.arstechnica.com/arstechnica/index',                    section: 'tech',   label: 'Ars Technica' },
  { url: 'https://www.theguardian.com/technology/rss',                         section: 'tech',   label: 'Guardian Technology' },
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',                   section: 'tech',   label: 'BBC Technology' },
  // Politics
  { url: 'https://www.theguardian.com/australia-news/australian-politics/rss', section: 'pol',    label: 'Guardian AU Politics' },
  { url: 'https://www.abc.net.au/news/feed/2942460/rss.xml',                   section: 'pol',    label: 'ABC News Politics' },
  // Crypto
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                    section: 'crypto', label: 'CoinDesk' },
  { url: 'https://decrypt.co/feed',                                            section: 'crypto', label: 'Decrypt' },
  { url: 'https://www.theblock.co/rss.xml',                                    section: 'crypto', label: 'The Block' },
];

// Topics that are NOT relevant to Plainly — filtered before sending to Gemini
// Block list — anything matching these is dropped immediately
const BLOCK_KEYWORDS = [
  // Sport — all of it
  'AFL', 'NRL', 'cricket', 'tennis', 'golf', 'rugby', 'NBA', 'NFL', 'EPL',
  'Premier League', 'World Cup', 'Olympics', 'Matildas', 'Socceroos',
  'Rapid Recap', 'Match Report', 'fixture', 'grand final', 'season preview',
  'Suns', 'Storm', 'Raiders', 'Roosters', 'Warriors', 'Broncos', 'Swans',
  'Ashes', 'BBL', 'A-League', 'league', 'football club', 'soccer',
  // Crime & courts — not finance crime
  'murder', 'stabbing', 'rape', 'assault', 'charged with', 'tribunal',
  'sentenced', 'inquest', 'missing person', 'manhunt', 'shooting',
  'robbery', 'theft', 'stolen', 'burglar', 'drug bust',
  // Entertainment & lifestyle
  'celebrity', 'reality TV', 'music', 'movie', 'film', 'Oscars', 'Grammy',
  'Chappell Roan', 'Taylor Swift', 'recipe', 'horoscope', 'crossword',
  'relationship', 'dating', 'fashion', 'diet', 'fitness',
  // Weather & natural disasters
  'cyclone', 'bushfire', 'flood warning', 'weather forecast', 'heatwave',
  'earthquake', 'tsunami', 'wildfire',
  // Too local/soft
  'urban design', 'council', 'local government', 'traffic', 'parking',
  'school', 'hospital', 'aged care', 'disability', 'suburb',
  // Misc
  'Live Blog', 'live updates', 'quiz', 'crossword', 'horoscope',
  'obituary', 'letters to the editor',
];

function isRelevant(title) {
  const t = title.toLowerCase();
  // Hard block — drop anything matching these
  if (BLOCK_KEYWORDS.some(kw => t.includes(kw.toLowerCase()))) return false;
  return true;
}

// ─── FEED FETCHING ────────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).slice(0, 8).map(item => ({
      title:       item.title || '',
      summary:     item.contentSnippet || item.summary || item.content || '',
      url:         item.link || item.guid || '',
      publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
      source:      feed.label,
      section:     feed.section,
    }));
  } catch (err) {
    console.warn(`  ⚠ Feed failed [${feed.label}]: ${err.message}`);
    return [];
  }
}

// ─── ARTICLE SCRAPING ─────────────────────────────────────────────────────────

async function scrapeArticle(url) {
  if (!url) return { text: null, imageUrl: null };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; Plainly/1.0; +https://plainly.finance)',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      timeout: 12000,
    });
    if (!res.ok) return { text: null, imageUrl: null };
    const html = await res.text();
    const root = parseHTML(html);

    // Extract og:image before removing elements
    const rawImage = root.querySelector('meta[property="og:image"]')?.getAttribute('content')
      || root.querySelector('meta[name="twitter:image"]')?.getAttribute('content')
      || null;
    // Filter out outlet logos and generic placeholder images
    const logoPatterns = ['logo', 'placeholder', 'default', 'fallback', 'icon', 'avatar', 'brand', 'abc-logo', 'bbc-logo'];
    const ogImage = rawImage && !logoPatterns.some(p => rawImage.toLowerCase().includes(p)) ? rawImage : null;

    for (const el of root.querySelectorAll('script, style, nav, header, footer, aside, .ad, .advertisement, .related, .comments, .social, .share, .newsletter, .paywall, [class*="sidebar"], [class*="promo"], [class*="subscribe"]')) {
      el.remove();
    }
    const containers = ['article','[data-testid="article-body"]','.article-body','.article__body','.story-body','.post-content','.entry-content','main','.content'];
    let text = '';
    for (const selector of containers) {
      const el = root.querySelector(selector);
      if (el) {
        const paras = el.querySelectorAll('p');
        text = paras.map(p => p.text.trim()).filter(t => t.length > 40).join('\n\n');
        if (text.length > 300) break;
      }
    }
    if (text.length < 300) {
      text = root.querySelectorAll('p').map(p => p.text.trim()).filter(t => t.length > 40).join('\n\n');
    }
    return {
      text: text.length > 200 ? text.substring(0, 4000) : null,
      imageUrl: ogImage,
    };
  } catch {
    return { text: null, imageUrl: null };
  }
}

// ─── GEMINI PROCESSING ────────────────────────────────────────────────────────

async function processWithGemini(item, fullText) {
  const hasFullText   = !!fullText;
  const sourceContent = hasFullText
    ? `Full article text:\n${fullText}`
    : `RSS summary only:\n${item.summary}`;

  const prompt = `You are editor of Plainly — finance and geopolitics news in plain English for Australians aged 16-25. Only cover: economics, markets, business, geopolitics, war, trade, crypto, major policy. Reject anything else.

Source: ${item.source} | Headline: ${item.title}
${sourceContent}
${!hasFullText ? 'RSS summary only — be conservative, no invented details.' : ''}

Return ONLY raw JSON, no markdown, no backticks, using exactly these keys:
{"headline":"max 10 words","deck":"1 sentence why it matters to young Australians, max 20 words","section":"aus|world|us|biz|tech|pol|crypto","flag":"2-3 word topic","body_html":"3 short paragraphs + 1 h3 subheading + 1 blockquote, wrap finance terms in <span class=\"ft\" data-term=\"TERM\">TERM</span>","sources":[{"n":"Outlet","d":"angle in 8 words"}],"terms":["term1"],"colors":["#2d4a6b","#1a3347"],"reliable":true}

Set reliable:false if story is sport, crime, entertainment, weather, or too thin.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 4000 },
      }),
    });
    if (!res.ok) {
      console.error(`  ✗ Gemini HTTP error: ${res.status} ${res.statusText}`);
      const errBody = await res.text();
      console.error(`  ✗ Gemini error body: ${errBody.substring(0, 300)}`);
      return null;
    }

    const data = await res.json();

    // Log any API-level error (quota exceeded, invalid key, etc.)
    if (data.error) {
      console.error(`  ✗ Gemini API error ${data.error.code}: ${data.error.message}`);
      return null;
    }

    // Log finish reason if generation was blocked or stopped early
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      console.error(`  ✗ Gemini stopped early: ${candidate.finishReason}`);
    }

    const raw = candidate?.content?.parts?.[0]?.text || '';

    if (!raw) {
      console.error('  ✗ Gemini returned empty response — full response:', JSON.stringify(data).substring(0, 400));
      return null;
    }

    // Strip any markdown fences Gemini sneaks in despite instructions
    let clean = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    // If Gemini wrapped in an outer object (e.g. {"article":{...}} or {"result":{...}}),
    // unwrap one level
    const parsed = JSON.parse(clean);
    const result = (parsed && typeof parsed === 'object' && !parsed.headline && Object.keys(parsed).length === 1)
      ? Object.values(parsed)[0]
      : parsed;

    // Normalise alternate key names Gemini occasionally uses
    if (!result.headline && result.title)       result.headline  = result.title;
    if (!result.deck     && result.subheadline) result.deck      = result.subheadline;
    if (!result.deck     && result.summary)     result.deck      = result.summary;
    if (!result.body_html && result.body)       result.body_html = result.body;
    if (!result.colors   && result.color_palette) result.colors  = result.color_palette;

    // Validate we got the minimum required fields
    if (!result.headline) {
      console.error(`  ✗ Gemini response missing headline. Keys returned: ${Object.keys(result).join(', ')}`);
      console.error(`  ✗ Raw (first 300 chars): ${raw.substring(0, 300)}`);
      return null;
    }

    return result;
  } catch (err) {
    console.error(`  ✗ Gemini error: ${err.message}`);
    return null;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-').substring(0, 70);
}

async function alreadyExists(slug) {
  const { data } = await db.from('articles').select('id').eq('slug', slug).limit(1);
  return data && data.length > 0;
}

async function storeArticle(processed, original, imageUrl = null) {
  const slug = slugify(processed.headline);
  const { error } = await db.from('articles').insert({
    slug,
    section:      processed.section    || original.section || 'world',
    flag:         processed.flag       || 'News',
    headline:     processed.headline,
    deck:         processed.deck       || '',
    body_html:    processed.body_html  || '',
    sources:      processed.sources    || [{ n: original.source, d: 'Original reporting' }],
    terms:        processed.terms      || [],
    image_colors: processed.colors     || ['#2d4a6b', '#1a3347'],
    image_url:    imageUrl              || null,
    original_url: original.url         || null,
    published_at: original.publishedAt || new Date().toISOString(),
  });
  if (error) {
    if (error.code === '23505') { console.log(`  ↩ Duplicate, skipping`); }
    else { console.error('  ✗ Supabase error:', error.message); }
  } else {
    console.log(`  ✓ Stored: ${processed.headline}`);
  }
}

async function cleanOldArticles() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const { error, count } = await db.from('articles').delete({ count: 'exact' }).lt('published_at', cutoff.toISOString());
  if (error) { console.error('Cleanup error:', error.message); }
  else { console.log(`🗑️  Cleaned ${count || 0} old articles`); }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🗞️  Plainly pipeline v2 —', new Date().toISOString());
  const feedResults = await Promise.all(FEEDS.map(fetchFeed));
  const allItems    = feedResults.flat();
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (!item.title || seen.has(item.title)) return false;
    if (!isRelevant(item.title)) {
      console.log(`  ↩ Filtered (off-topic): ${item.title.substring(0, 60)}`);
      return false;
    }
    seen.add(item.title); return true;
  });
  console.log(`Found ${unique.length} unique articles`);

  const toProcess = [];
  for (const item of unique) {
    if (!(await alreadyExists(slugify(item.title)))) toProcess.push(item);
  }
  console.log(`New to process: ${toProcess.length}`);

  if (toProcess.length === 0) { await cleanOldArticles(); return; }

  // Cap at 3 per run — keeps well within 30min GitHub Actions timeout
  const batch = toProcess.slice(0, 3);
  console.log(`Processing batch of ${batch.length} (capped at 3 to avoid timeout)`);

  let stored = 0, skipped = 0, errors = 0;
  console.log('  Waiting 15s before starting to avoid rate limits...');
  await new Promise(r => setTimeout(r, 15000));
  for (const item of batch) {
    console.log(`\n→ [${item.section}] ${item.source}: ${item.title.substring(0, 65)}`);
    let fullText = null;
    let imageUrl = null;
    if (item.url) {
      process.stdout.write('  Scraping...');
      const scraped = await scrapeArticle(item.url);
      fullText = scraped.text;
      imageUrl = scraped.imageUrl;
      console.log(fullText ? ` ✓ ${fullText.length} chars${imageUrl ? ' + image' : ''}` : ' ✗ using RSS summary');
    }
    const result = await processWithGemini(item, fullText);
    if (!result) { errors++; continue; }
    if (result.reliable === false) { console.log('  ↩ Skipped — too thin'); skipped++; continue; }

    await storeArticle(result, item, imageUrl);

    // Save article JSON to file
    const safeTitle = (result.headline)
      .replace(/[^a-z0-9 ]/gi, '_')
      .toLowerCase()
      .substring(0, 70);
    const outputDir = path.join(process.cwd(), 'public', 'articles');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${safeTitle}.json`);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
    console.log(`  💾 Saved to output: ${filePath}`);

    stored++;
    await new Promise(r => setTimeout(r, 30000));  // 30s delay = safely under 5 RPM free tier limit
  }
  await cleanOldArticles();
  console.log(`\n✅ Done. Stored: ${stored} | Skipped: ${skipped} | Errors: ${errors}`);
}

main().catch(err => { console.error('Pipeline failed:', err); process.exit(1); });
