module.exports = {
  apps: [
    {
      name: 'bot-whatsapp-master-pro-v6',
      script: 'index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        SERVER_MODE: 'oracle-vps',
        AUTH_DIR: 'auth'
      }
    }
  ]
}
