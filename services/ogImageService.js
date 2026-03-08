// services/ogImageService.js
// Generates Open Graph images for quote sharing using satori + sharp

const satori = require('satori').default;
const sharp = require('sharp');
const { LRUCache } = require('lru-cache');

// Cache generated images (max 200 entries, 1 hour TTL)
const imageCache = new LRUCache({
  max: 200,
  ttl: 1000 * 60 * 60,
});

// Font loaded once at startup
let fontData = null;
let fontBoldData = null;

async function loadFonts() {
  if (fontData) return;
  const [regular, bold] = await Promise.all([
    fetch('https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hjQ.ttf').then(r => r.arrayBuffer()),
    fetch('https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYAZ9hjQ.ttf').then(r => r.arrayBuffer()),
  ]);
  fontData = regular;
  fontBoldData = bold;
}

// Truncate text to fit roughly within the card
function truncateText(text, maxChars = 220) {
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars).trimEnd() + '…';
}

// Lighten a hex color by a percentage (0-1) for gradient variation
function lightenHex(hex, amount = 0.15) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

async function generateQuoteImage(quote) {
  // Check cache
  const cacheKey = `${quote.id}-${quote.updatedAt || quote.createdAt}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  await loadFonts();

  const baseBg = quote.displayBg || '#1a1625';
  const midBg = lightenHex(baseBg, 0.08);

  const displayText = truncateText(quote.text);
  const attribution = [
    quote.subreddit ? `r/${quote.subreddit}` : null,
    quote.author ? `u/${quote.author}` : null,
  ].filter(Boolean).join(' · ');

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '60px 70px',
          background: `linear-gradient(135deg, ${baseBg} 0%, ${midBg} 50%, ${baseBg} 100%)`,
          fontFamily: 'Inter',
        },
        children: [
          // Quote mark
          {
            type: 'div',
            props: {
              style: {
                fontSize: '96px',
                color: '#f97316',
                opacity: 0.6,
                lineHeight: 1,
                marginBottom: '16px',
              },
              children: '\u201C',
            },
          },
          // Quote text
          {
            type: 'div',
            props: {
              style: {
                fontSize: displayText.length > 200 ? '32px' : displayText.length > 100 ? '38px' : '48px',
                color: '#ffffff',
                lineHeight: 1.5,
                fontWeight: 400,
                maxHeight: '340px',
                overflow: 'hidden',
              },
              children: displayText,
            },
          },
          // Bottom section
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
                marginTop: 'auto',
                paddingTop: '32px',
              },
              children: [
                // Attribution
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    },
                    children: [
                      quote.postTitle ? {
                        type: 'div',
                        props: {
                          style: {
                    fontSize: '20px',
                            color: '#f97316',
                            fontWeight: 500,
                            maxWidth: '700px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                          children: quote.postTitle.length > 60
                            ? quote.postTitle.substring(0, 60) + '…'
                            : quote.postTitle,
                        },
                      } : null,
                      attribution ? {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '18px',
                            color: 'rgba(255,255,255,0.5)',
                          },
                          children: attribution,
                        },
                      } : null,
                    ].filter(Boolean),
                  },
                },
                // Branding
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '22px',
                      fontWeight: 700,
                      color: '#f97316',
                    },
                    children: 'reddzit',
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Inter', data: fontData, weight: 400, style: 'normal' },
        { name: 'Inter', data: fontBoldData, weight: 700, style: 'normal' },
      ],
    }
  );

  const png = await sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();

  imageCache.set(cacheKey, png);
  return png;
}

module.exports = { generateQuoteImage, loadFonts };
