// Plainly — News Pipeline v2
// RSS feeds → scrape full article text → Gemini rewrites → Supabase

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import Parser from 'rss-parser';
import { parse as parseHTML } from 'node-html-parser';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_KEY) {
  console.error('❌ Missing environment variables. Check your GitHub secrets.');
  process.exit(1);
}

const db     = createClient(SUPABASE_URL, SUPABASE_KEY);
const parser = new Parser({ timeout: 10000 });

const FEEDS = [
  { url: 'https://www.abc.net.au/news/feed/51120/rss.xml',                     section: 'aus',    label: 'ABC News Business' },
  { url: 'https://www.abc.net.au/news/feed/45910/rss.xml',                     section: 'aus',    label: 'ABC News Top Stories' },
  { url: 'https://www.theguardian.com/australia-news/rss',                     section: 'aus',    label: 'Guardian Australia' },
  { url: 'https://www.smh.com.au/rss/business.xml',                            section: 'aus',    label: 'SMH Business' },
  { url: 'https://www.smh.com.au/rss/money.xml',                               section: 'aus',    label: 'SMH Money' },
  { url: 'https://feeds.reuters.com/reuters/worldNews',                        section: 'world',  label: 'Reuters World' },
  { url: 'https://feeds.reuters.com/reuters/businessNews',                     section: 'world',  label: 'Reuters Business' },
  { url: 'https://www.theguardian.com/world/rss',                              section: 'world',  label: 'Guardian World' },
  { url: 'https://feeds.reuters.com/reuters/companyNews',                      section: 'us',     label: 'Reuters US Companies' },
  { url: 'https://www.theguardian.com/us-news/rss',                            section: 'us',     label: 'Guardian US' },
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/',              section: 'us',     label: 'MarketWatch' },
  { url: 'https://www.theguardian.com/business/rss',                           section: 'biz',    label: 'Guardian Business' },
  { url: 'https://www.smh.com.au/rss/business/companies.xml',                  section: 'biz',    label: 'SMH Companies' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews',                   section: 'tech',   label: 'Reuters Technology' },
  { url: 'https://www.theguardian.com/technology/rss',                         section: 'tech',   label: 'Guardian Technology' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index',                    section: 'tech',   label: 'Ars Technica' },
  { url: 'https://www.abc.net.au/news/feed/2942460/rss.xml',                   section: 'pol',    label: 'ABC News Politics' },
  { url: 'https://www.theguardian.com/australia-news/australian-politics/rss', section: 'pol',    label: 'Guardian AU Politics' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                    section: 'crypto', label: 'CoinDesk' },
  { url: 'https://decrypt.co/feed',                                            section: 'crypto', label: 'Decrypt' },
  { url: 'https://www.theblock.co/rss.xml',                                    section: 'crypto', label: 'The Block' },
];

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

async function scrapeArticle(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; Plainly/1.0; +https://plainly.finance)',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      timeout: 12000,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const root = parseHTML(html);
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
    return text.length > 200 ? text.substring(0, 4000) : null;
  } catch {
    return null;
  }
}

async function processWithGemini(item, fullText) {
  const hasFullText   = !!fullText;
  const sourceContent = hasFullText
    ? `Full article text:\n${fullText}`
    : `RSS summary only:\n${item.summary}`;

  const prompt = `You are the AI editor for Plainly — a finance and news site written in plain English for young Australians (Year 11-12 level).

Source outlet: ${item.source}
Original headline: ${item.title}
${sourceContent}

${!hasFullText ? '⚠ Only a summary was available. Write conservatively — only include details clearly stated. Do not invent specifics, quotes, or numbers.' : ''}

Tasks:
1. Rewrite headline in plain English (max 12 words, accurate)
2. Write a deck — one sentence on why this matters to a young Australian (max 25 words)
3. Article body: 4-5 paragraphs, 2 subheadings with <h3> tags, one <blockquote> with attributed quote. Plain English, strictly neutral, only facts from source.
4. Wrap finance terms: <span class="ft" data-term="TERM" data-ctx="5-7 word summary">TERM</span>
5. Classify section: aus, world, us, biz, tech, pol, or crypto
6. Short flag label (e.g. "Monetary Policy", "Bitcoin", "Housing")
7. List 2-4 real outlets covering this story with 1 sentence each on their angle
8. Two complementary hex colours for image placeholder
9. Set "reliable" false if source material too thin

Return ONLY raw JSON, no markdown, no backticks:
{"headline":"...","deck":"...","section":"aus|world|us|biz|tech|pol|crypto","flag":"...","body_html":"...","sources":[{"n":"Outlet","d":"angle"}],"terms":["term1"],"colors":["#hex1","#hex2"],"reliable":true}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1500 },
      }),
    });
    const data  = await res.json();
    const text  = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error(`  ✗ Gemini error: ${err.message}`);
    return null;
  }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-').substring(0, 70);
}

async function alreadyExists(slug) {
  const { data } = await db.from('articles').select('id').eq('slug', slug).limit(1);
  return data && data.length > 0;
}

async function storeArticle(processed, original) {
  const slug = slugify(processed.headline || original.title);
  const { error } = await db.from('articles').insert({
    slug,
    section:      processed.section    || original.section || 'world',
    flag:         processed.flag       || 'News',
    headline:     processed.headline   || original.title,
    deck:         processed.deck       || '',
    body_html:    processed.body_html  || '',
    sources:      processed.sources    || [{ n: original.source, d: 'Original reporting' }],
    terms:        processed.terms      || [],
    image_colors: processed.colors     || ['#2d4a6b', '#1a3347'],
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

async function main() {
  console.log('🗞️  Plainly pipeline v2 —', new Date().toISOString());
  const feedResults = await Promise.all(FEEDS.map(fetchFeed));
  const allItems    = feedResults.flat();
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (!item.title || seen.has(item.title)) return false;
    seen.add(item.title); return true;
  });
  console.log(`Found ${unique.length} unique articles`);
  const toProcess = [];
  for (const item of unique) {
    if (!(await alreadyExists(slugify(item.title)))) toProcess.push(item);
  }
  console.log(`New to process: ${toProcess.length}`);
  if (toProcess.length === 0) { await cleanOldArticles(); return; }
  let stored = 0, skipped = 0, errors = 0;
  for (const item of toProcess) {
    console.log(`\n→ [${item.section}] ${item.source}: ${item.title.substring(0, 65)}`);
    let fullText = null;
    if (item.url) {
      process.stdout.write('  Scraping...');
      fullText = await scrapeArticle(item.url);
      console.log(fullText ? ` ✓ ${fullText.length} chars` : ' ✗ using RSS summary');
    }
    const result = await processWithGemini(item, fullText);
    if (!result) { errors++; continue; }
    if (result.reliable === false) { console.log('  ↩ Skipped — too thin'); skipped++; continue; }
    await storeArticle(result, item);
    stored++;
    await new Promise(r => setTimeout(r, 800));
  }
  await cleanOldArticles();
  console.log(`\n✅ Done. Stored: ${stored} | Skipped: ${skipped} | Errors: ${errors}`);
}

main().catch(err => { console.error('Pipeline failed:', err); process.exit(1); });
