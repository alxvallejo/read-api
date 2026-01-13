require('dotenv').config();

// Toggle jobs on/off here
const ENABLED = {
  'read-api': true,
  'global-briefing': true,
  'hourly-pulse': true,
  'daily-report': false,  // Disabled
};

const allApps = [
  // Main API server
  {
    name: 'read-api',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      DATABASE_URL: process.env.DATABASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
      REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
      REDDIT_REDIRECT_URI: process.env.REDDIT_REDIRECT_URI,
      USER_AGENT: process.env.USER_AGENT,
      CORS_ORIGIN: process.env.CORS_ORIGIN,
      FRONTEND_DIST_DIR: process.env.FRONTEND_DIST_DIR,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
      ADMIN_USERNAMES: process.env.ADMIN_USERNAMES,
    },
  },

  // Global Briefing - runs every 6 hours (0:00, 6:00, 12:00, 18:00 UTC)
  {
    name: 'global-briefing',
    script: 'jobs/generateGlobalBriefing.js',
    cron_restart: '0 0,6,12,18 * * *',
    autorestart: false,
    watch: false,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: process.env.DATABASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    },
  },

  // Hourly Pulse - runs every hour (top posts from r/all)
  {
    name: 'hourly-pulse',
    script: 'jobs/generateHourlyPulseReport.js',
    cron_restart: '0 6-23 * * *', // Every hour from 6am-11pm UTC (skip dead hours)
    autorestart: false,
    watch: false,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: process.env.DATABASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    },
  },

  // Daily Report - runs once daily at 11:00 UTC (6am ET)
  {
    name: 'daily-report',
    script: 'jobs/generateDailyReport.js',
    cron_restart: '0 11 * * *',
    autorestart: false,
    watch: false,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: process.env.DATABASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    },
  },
];

module.exports = {
  apps: allApps.filter(app => ENABLED[app.name]),
};
