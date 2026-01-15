const OpenAI = require('openai');
const readController = require('../controllers/readController');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Model selection
const MODELS = {
  PREMIUM: 'gpt-5.2',           // For global briefings (executive summary)
  STANDARD: 'gpt-5.2-chat-latest', // For pro user reports (faster/cheaper)
  FALLBACK: 'gpt-4o-mini',      // Fallback if needed
};

const EXECUTIVE_SUMMARY_PROMPT = `You are a senior editor at The Economist writing a briefing for intelligent, busy professionals. Your task is to synthesize multiple trending stories into a cohesive 2-3 paragraph executive summary.

Style requirements:
- Write with authority and insight, not hedging or filler
- Connect stories thematically where possible - find the narrative thread
- Include specific numbers, names, and details - never vague generalities
- Be opinionated where warranted - take a stance on significance
- Write in present tense for immediacy

FORBIDDEN PHRASES (never use these):
- "In today's fast-paced world"
- "It's worth noting that"
- "Interestingly enough"
- "At the end of the day"
- "Moving forward"
- "The landscape is changing"
- "Time will tell"
- "Only time will tell"
- "It remains to be seen"
- "This is a developing story"
- "Stay tuned"
- "What do you think?"
- "Let us know in the comments"
- Any phrase starting with "In a world where"

Respond with valid JSON only:
{
  "executiveSummary": "2-3 paragraphs of insightful analysis connecting the stories",
  "briefingTitle": "A compelling 5-8 word title for this briefing"
}`;

const ANALYSIS_PROMPT = `You are a sharp news editor writing brief summaries for a daily digest. Your summaries should feel like you're telling a friend the most interesting thing you read today.

Respond with valid JSON only, no markdown. Use this exact structure:
{
  "summary": "2-4 sentences that get straight to the point",
  "sentimentLabel": "one of: INFORMATIVE, OPINION, BREAKING, ANALYSIS, ENTERTAINMENT",
  "takeaways": ["bullet 1", "bullet 2", "bullet 3"],
  "topicTags": ["Tag1", "Tag2"],
  "contentWarning": null or "warning text if needed"
}

Writing rules:
- Lead with the most interesting or important fact - no throat-clearing
- Do NOT repeat or paraphrase the post title or obvious headline facts; assume the user can already see the title
- Focus on context, implications, what's new, who/why/what it means, not re-stating the headline
- NEVER use phrases like: "The article discusses", "This piece explores", "The author argues", "According to the article", "The post details", "Discussion around", "The discussion around"
- Use active voice: "Tesla recalled 500k vehicles" not "500k vehicles were recalled by Tesla"
- Write as if stating facts directly, not describing an article about facts
- Match the tone: punchy for breaking news, substantive for analysis
- Be factual - do not invent information not present in the article
- If article content is unavailable, work with the title but expand with likely context/implications without rephrasing it
- Keep takeaways actionable and specific (under 15 words each)
- Use 1-3 topic tags that describe the subject matter`;

async function fetchArticleContent(url) {
  if (!url || url.includes('reddit.com') || url.includes('redd.it')) {
    return null; // Skip Reddit self-posts
  }
  
  try {
    const result = await readController.readUrl(url, null);
    if (result && result.content) {
      // Strip HTML tags and limit length
      const text = result.content
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000); // Limit to ~4000 chars to stay within token limits
      return text;
    }
  } catch (e) {
    console.log(`Failed to fetch article content: ${e.message}`);
  }
  return null;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[“”"'’‘]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sharesHeadline(sentence, title) {
  const titleTokens = new Set(normalizeText(title).split(' ').filter(w => w.length > 3));
  if (titleTokens.size === 0) return false;
  const sentTokens = new Set(normalizeText(sentence).split(' ').filter(w => w.length > 3));
  if (sentTokens.size === 0) return false;
  let overlap = 0;
  for (const t of titleTokens) if (sentTokens.has(t)) overlap++;
  const jaccard = overlap / new Set([...titleTokens, ...sentTokens]).size;
  const coverage = overlap / titleTokens.size; // how much of the title is repeated
  return jaccard >= 0.6 || coverage >= 0.7;
}

function removeHeadlineRepetition(summary, title) {
  if (!summary || !title) return summary;

  // 1) Remove exact title occurrences (case-insensitive)
  try {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    summary = summary.replace(re, '').replace(/\s{2,}/g, ' ').trim();
  } catch (_) {}

  // 2) Drop a first sentence that largely repeats the title
  const parts = summary.split(/(?<=[.!?])\s+/);
  if (parts.length > 0 && sharesHeadline(parts[0], title)) {
    parts.shift();
  }
  const cleaned = parts.join(' ').trim();
  return cleaned.length > 0 ? cleaned : summary.trim();
}

/**
 * Generate executive summary for a global briefing using GPT-5.2
 * @param {Array} stories - Array of story objects with title, subreddit, score, summary
 * @returns {Object} { executiveSummary, briefingTitle }
 */
async function generateExecutiveSummary(stories) {
  if (!process.env.OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY not set, using mock executive summary');
    return {
      executiveSummary: 'A diverse set of stories trending across Reddit today.',
      briefingTitle: 'Today on Reddit'
    };
  }

  console.log(`Generating executive summary for ${stories.length} stories using ${MODELS.PREMIUM}`);

  // Build story summaries for context
  const storyContext = stories.map((s, i) => 
    `${i + 1}. [r/${s.subreddit}] ${s.title}\n   Score: ${s.score} | ${s.summary || 'No summary available'}`
  ).join('\n\n');

  const userPrompt = `Here are the top ${stories.length} trending stories from Reddit right now:\n\n${storyContext}\n\nWrite an executive summary that synthesizes these into a compelling briefing.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODELS.PREMIUM,
      messages: [
        { role: 'system', content: EXECUTIVE_SUMMARY_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
      max_tokens: 1000,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content);
    return {
      executiveSummary: parsed.executiveSummary || 'Summary generation failed.',
      briefingTitle: parsed.briefingTitle || 'Reddit Briefing'
    };
  } catch (error) {
    console.error('Executive summary generation error:', error.message);
    return {
      executiveSummary: 'Unable to generate executive summary at this time.',
      briefingTitle: 'Reddit Briefing'
    };
  }
}

/**
 * Generate story analysis
 * @param {Object} story - Reddit post object
 * @param {Array} comments - Optional comments array
 * @param {string} articleContent - Optional article text
 * @param {Object} options - { usePremiumModel: boolean }
 */
async function generateStoryAnalysis(story, comments, articleContent = null, options = {}) {
  const { usePremiumModel = false } = options;
  
  // Fallback if no API key configured
  if (!process.env.OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY not set, using mock response');
    return getMockResponse(story);
  }

  const model = usePremiumModel ? MODELS.PREMIUM : MODELS.STANDARD;
  console.log(`Generating analysis for: ${story.title} using ${model}`);

  // Build the prompt based on available content
  let userPrompt = `Post Title (do not restate): ${story.title}
Subreddit: r/${story.subreddit}
Score: ${story.score} | Comments: ${story.num_comments}`;

  if (articleContent) {
    userPrompt += `\n\nArticle Content:\n${articleContent}`;
  } else {
    userPrompt += `\n\nNote: Article content unavailable. Please summarize based on the title.`;
  }

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content);

    // Enforce no-headline-repetition post-processing
    const cleanedSummary = removeHeadlineRepetition(parsed.summary || '', story.title);

    return {
      summary: cleanedSummary || 'Context unavailable beyond the headline.',
      sentimentLabel: parsed.sentimentLabel || 'INFORMATIVE',
      takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways : [],
      topicTags: Array.isArray(parsed.topicTags) ? parsed.topicTags : [],
      contentWarning: parsed.contentWarning || null
    };
  } catch (error) {
    console.error('OpenAI API error:', error.message);
    return getMockResponse(story);
  }
}

function getMockResponse(story) {
  const isControversial = story.num_comments > story.score / 2;
  return {
    summary: null, // No generic placeholder - let the title speak for itself
    sentimentLabel: isControversial ? 'DIVIDED' : 'UNCERTAIN',
    takeaways: [],
    topicTags: [],
    contentWarning: null
  };
}

async function selectHighlightComments(comments) {
  // Pick top 3 by score, preferring longer substantive comments
  const sorted = [...comments]
    .filter(c => c.body && c.body.length > 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Fallback to any comments if none are long enough
  const selected = sorted.length > 0 ? sorted : comments.slice(0, 3);

  return selected.map((c, i) => ({
    id: c.id,
    body: c.body,
    author: c.author,
    score: c.score,
    permalink: c.permalink,
    created_utc: c.created_utc,
    reason: i === 0 ? 'Top comment' : 'Highly upvoted'
  }));
}

module.exports = {
  generateStoryAnalysis,
  generateExecutiveSummary,
  selectHighlightComments,
  MODELS,
};
