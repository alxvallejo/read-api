const pm2 = require('pm2');
const { promisify } = require('util');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

// Promisified PM2 methods
const pm2Connect = promisify(pm2.connect.bind(pm2));
const pm2Disconnect = () => pm2.disconnect();
const pm2List = promisify(pm2.list.bind(pm2));
const pm2Start = promisify(pm2.start.bind(pm2));
const pm2Delete = promisify(pm2.delete.bind(pm2));

/**
 * Get status of all PM2 processes
 */
async function getProcessList() {
  await pm2Connect();
  try {
    const list = await pm2List();
    return list.map(proc => ({
      name: proc.name,
      status: proc.pm2_env?.status,
      pm_id: proc.pm_id,
      pid: proc.pid,
      memory: proc.monit?.memory,
      cpu: proc.monit?.cpu,
      uptime: proc.pm2_env?.pm_uptime,
      restarts: proc.pm2_env?.restart_time,
      cron: proc.pm2_env?.cron_restart,
    }));
  } finally {
    pm2Disconnect();
  }
}

/**
 * Apply job configuration to PM2
 * @param {Object} jobConfig - { name, script, cronExpression, enabled }
 */
async function applyJobConfig(jobConfig) {
  await pm2Connect();
  try {
    const { name, script, cronExpression, enabled } = jobConfig;
    const scriptPath = path.join(projectRoot, script);

    // First, try to delete existing process
    try {
      await pm2Delete(name);
    } catch (e) {
      // Process might not exist, that's OK
    }

    if (enabled) {
      // Start with cron configuration
      await pm2Start({
        name,
        script: scriptPath,
        cron_restart: cronExpression,
        autorestart: false,
        watch: false,
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: process.env.DATABASE_URL,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        },
      });
    }

    return { success: true, action: enabled ? 'started' : 'stopped' };
  } finally {
    pm2Disconnect();
  }
}

/**
 * Trigger a job to run immediately
 * @param {string} name - Job name (for logging)
 * @param {string} script - Script path relative to project root
 * @returns {Promise<{success: boolean, exitCode: number, duration: number, output: string}>}
 */
function triggerJob(name, script) {
  const scriptPath = path.join(projectRoot, script);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let output = '';

    console.log(`[PM2Service] Triggering job: ${name} (${scriptPath})`);

    const proc = spawn('node', [scriptPath, '--force'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      cwd: projectRoot,
    });

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      console.log(`[PM2Service] Job ${name} completed with code ${code} in ${duration}ms`);
      resolve({
        success: code === 0,
        exitCode: code,
        duration,
        output: output.slice(-5000), // Last 5KB of output
      });
    });

    proc.on('error', (err) => {
      console.error(`[PM2Service] Job ${name} spawn error:`, err);
      reject(err);
    });
  });
}

module.exports = {
  getProcessList,
  applyJobConfig,
  triggerJob,
};
