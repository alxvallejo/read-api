const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = process.env.FROM_EMAIL || 'Reddzit Daily <daily@reddzit.com>';

/**
 * Send a welcome email when someone subscribes
 */
async function sendWelcomeEmail(to) {
  if (!process.env.RESEND_API_KEY) {
    console.log('RESEND_API_KEY not set, skipping welcome email');
    return null;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Welcome to Reddzit Daily!',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #ea580c; font-size: 24px; margin-bottom: 16px;">Welcome to Reddzit Daily! 🎉</h1>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            You're now subscribed to the Daily Pulse — a curated summary of the most interesting conversations happening on Reddit.
          </p>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            Every morning, you'll receive an email with:
          </p>
          <ul style="color: #374151; font-size: 16px; line-height: 1.8;">
            <li>Top stories from across Reddit</li>
            <li>AI-generated summaries of each article</li>
            <li>Key takeaways and highlights</li>
          </ul>
          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            — The Reddzit Team
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            You can unsubscribe at any time by clicking the link at the bottom of any email.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('Resend error:', error);
      return null;
    }

    console.log('Welcome email sent:', data?.id);
    return data;
  } catch (err) {
    console.error('Failed to send welcome email:', err.message);
    return null;
  }
}

/**
 * Send the daily newsletter to a list of subscribers
 */
async function sendDailyNewsletter(subscribers, report) {
  if (!process.env.RESEND_API_KEY) {
    console.log('RESEND_API_KEY not set, skipping newsletter send');
    return { sent: 0, failed: 0 };
  }

  const html = generateNewsletterHtml(report);
  const subject = report.title || `Daily Pulse — ${new Date().toLocaleDateString()}`;

  let sent = 0;
  let failed = 0;

  for (const sub of subscribers) {
    try {
      const unsubscribeUrl = `${process.env.PUBLIC_BASE_URL || 'https://reddzit.com'}/unsubscribe?email=${encodeURIComponent(sub.email)}&id=${sub.id}`;
      
      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: sub.email,
        subject,
        html: html.replace('{{UNSUBSCRIBE_URL}}', unsubscribeUrl),
      });

      if (error) {
        console.error(`Failed to send to ${sub.email}:`, error);
        failed++;
      } else {
        sent++;
      }
    } catch (err) {
      console.error(`Error sending to ${sub.email}:`, err.message);
      failed++;
    }
  }

  console.log(`Newsletter sent: ${sent} success, ${failed} failed`);
  return { sent, failed };
}

/**
 * Generate HTML for the daily newsletter
 */
function generateNewsletterHtml(report) {
  const storiesHtml = report.stories.map((story, i) => `
    <div style="margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #e5e7eb;">
      <div style="font-size: 12px; color: #ea580c; font-weight: 600; text-transform: uppercase; margin-bottom: 8px;">
        r/${story.subreddit}
      </div>
      <h2 style="font-size: 20px; color: #111827; margin: 0 0 12px 0; line-height: 1.3;">
        <a href="https://www.reddit.com${story.redditPermalink}" style="color: #111827; text-decoration: none;">
          ${story.title}
        </a>
      </h2>
      <div style="background: #f8fafc; padding: 16px; border-radius: 8px; margin-bottom: 12px;">
        <div style="font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 600; margin-bottom: 8px;">
          Summary ${story.sentimentLabel ? `• ${story.sentimentLabel}` : ''}
        </div>
        <p style="font-size: 14px; color: #374151; line-height: 1.6; margin: 0;">
          ${story.summary || 'No summary available.'}
        </p>
      </div>
      <div style="font-size: 12px; color: #6b7280;">
        ${story.score?.toLocaleString() || 0} points • ${story.numComments?.toLocaleString() || 0} comments
      </div>
    </div>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; margin: 0; padding: 0;">
      <div style="max-width: 600px; margin: 0 auto; background: white;">
        <!-- Header -->
        <div style="background: linear-gradient(to right, #ea580c, #f97316); padding: 24px; text-align: center;">
          <h1 style="color: white; font-size: 28px; margin: 0;">${report.title || 'Daily Pulse'}</h1>
          <p style="color: rgba(255,255,255,0.9); font-size: 14px; margin: 8px 0 0 0;">
            The most interesting conversations on Reddit today
          </p>
        </div>

        <!-- Content -->
        <div style="padding: 24px;">
          ${storiesHtml}
        </div>

        <!-- Footer -->
        <div style="background: #f3f4f6; padding: 24px; text-align: center;">
          <p style="font-size: 12px; color: #6b7280; margin: 0 0 8px 0;">
            You received this email because you subscribed to Reddzit Daily.
          </p>
          <a href="{{UNSUBSCRIBE_URL}}" style="font-size: 12px; color: #9ca3af;">
            Unsubscribe
          </a>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send an admin notification when someone submits feedback
 */
async function sendAdminNotification({ subject, body }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY || !adminEmail) {
    console.log('RESEND_API_KEY or ADMIN_EMAIL not set, skipping admin notification');
    return null;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: adminEmail,
      subject,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          ${body}
        </div>
      `,
    });

    if (error) {
      console.error('Admin notification error:', error);
      return null;
    }

    console.log('Admin notification sent:', data?.id);
    return data;
  } catch (err) {
    console.error('Failed to send admin notification:', err.message);
    return null;
  }
}

module.exports = {
  sendWelcomeEmail,
  sendDailyNewsletter,
  generateNewsletterHtml,
  sendAdminNotification,
};
