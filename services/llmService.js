async function generateStoryAnalysis(story, comments) {
  // TODO: Integrate with OpenAI or similar
  console.log(`Generating analysis for: ${story.title}`);
  
  // Mock response
  const isControversial = story.num_comments > story.score / 2;
  
  return {
    summary: `This is an AI-generated summary of the discussion around "${story.title}". The debate centers on key issues raised in the article.`,
    sentimentLabel: isControversial ? 'DIVIDED' : 'CONSENSUS',
    takeaways: [
      "Key point 1 from the discussion.",
      "Key point 2 regarding the impact.",
      "A surprising perspective mentioned by top commenters."
    ],
    topicTags: ["Technology", "News"],
    contentWarning: null
  };
}

async function selectHighlightComments(comments) {
    // Simple heuristic for MVP: pick top score and maybe long ones
    return comments.slice(0, 3).map(c => ({
        id: c.id,
        body: c.body,
        author: c.author,
        score: c.score,
        permalink: c.permalink,
        created_utc: c.created_utc,
        reason: "Top comment"
    }));
}

module.exports = {
  generateStoryAnalysis,
  selectHighlightComments
};
