/**
 * PM2 ecosystem configuration for Matrix Claude Bot.
 *
 * Copy this file to ecosystem.config.cjs and fill in your values.
 * Then: pm2 start ecosystem.config.cjs && pm2 save
 *
 * IMPORTANT: protect this file — it contains secrets.
 *   chmod 600 ecosystem.config.cjs
 */
module.exports = {
  apps: [{
    name: "matrix-claude-bot",
    script: "dist/index.js",
    cwd: "/opt/matrix-claude-bot",
    env: {
      HOME: "/root",
      MATRIX_HOMESERVER_URL: "https://matrix.example.com",
      MATRIX_ACCESS_TOKEN: "syt_your_token",
      MATRIX_ALLOWED_USER_ID: "@you:example.com",
      PROJECTS: "myproject=/home/user/myproject",
      GROQ_API_KEY: "gsk_your_key",
      CLAUDE_CODE_OAUTH_TOKEN: "your_oauth_token",
      LOG_LEVEL: "info",
    },
    max_memory_restart: "200M",
    restart_delay: 5000,
    max_restarts: 10,
    autorestart: true,
  }],
};
