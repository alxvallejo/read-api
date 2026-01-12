const OpenAI = require('openai');
const readController = require('../controllers/readController');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
- NEVER use phrases like: "The article discusses", "This piece explores", "The author argues", "According to the article", "The post details"
- Use active voice: "Tesla recalled 500k vehicles" not "500k vehicles were recalled by Tesla"
- Write as if stating facts directly, not describing an article about facts
- Match the tone: punchy for breaking news, substantive for analysis
- Be factual - do not invent information not present in the article
- If article content is unavailable, work with the title but don't pretend you read more
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

async function generateStoryAnalysis(story, comments, articleContent = null) {
  // Fallback if no API key configured
  if (!process.env.OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY not set, using mock response');
    return getMockResponse(story);
  }

  console.log(`Generating OpenAI analysis for: ${story.title}`);

  // Build the prompt based on available content
  let userPrompt = `Post Title: ${story.title}
Subreddit: r/${story.subreddit}
Score: ${story.score} | Comments: ${story.num_comments}`;

  if (articleContent) {
    userPrompt += `\n\nArticle Content:\n${articleContent}`;
  } else {
    userPrompt += `\n\nNote: Article content unavailable. Please summarize based on the title.`;
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
    return {
      summary: parsed.summary || 'Article summary unavailable.',
      sentimentLabel: parsed.sentimentLabel || 'INFORMATIVE',
      takeaways: parsed.takeaways || [],
      topicTags: parsed.topicTags || [],
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
    summary: `Discussion around "${story.title}" is still developing.`,
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
  selectHighlightComments
};
