// Strips unwanted elements (subscription CTAs, paywall nags, etc.) from
// HTML extracted by node-readability before it's returned to the client.
//
// CSS-module class hashes (e.g. `styles_subscriptionCTA__LOUeY`) change between
// site builds, so rules match on stable identifiers — element ids or the
// un-hashed class substring — rather than the full hashed class name.
//
// To filter a new element going forward, add a rule below: `tag` is the HTML
// tag to remove and `match` is a regex tested against the element's opening
// tag. The whole element (including nested children) is removed.
const REMOVAL_RULES = [
  // NBC News "Subscribe to read this story ad-free" CTA button.
  { tag: 'button', match: /id=["']subscriptionCTA["']/i },
  { tag: 'button', match: /class=["'][^"']*subscriptionCTA/i },
];

// Removes every element matching `{ tag, match }`, correctly handling nested
// same-tag children by tracking open/close depth.
function removeMatchingElements(html, { tag, match }) {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let result = html;
  let searchFrom = 0;

  while (true) {
    openRe.lastIndex = searchFrom;
    const open = openRe.exec(result);
    if (!open) break;

    const openTag = open[0];
    if (!match.test(openTag)) {
      searchFrom = open.index + openTag.length;
      continue;
    }

    const start = open.index;
    const tagScan = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagScan.lastIndex = start + openTag.length;
    let depth = 1;
    let end = -1;
    let scan;
    while ((scan = tagScan.exec(result)) !== null) {
      if (scan[1] === '/') {
        depth--;
        if (depth === 0) {
          end = scan.index + scan[0].length;
          break;
        }
      } else {
        depth++;
      }
    }

    if (end === -1) {
      // No matching close tag — skip past this open tag to avoid looping.
      searchFrom = start + openTag.length;
      continue;
    }

    result = result.slice(0, start) + result.slice(end);
    searchFrom = start;
  }

  return result;
}

function cleanContent(html) {
  if (!html || typeof html !== 'string') return html;
  return REMOVAL_RULES.reduce(removeMatchingElements, html);
}

module.exports = { cleanContent };
