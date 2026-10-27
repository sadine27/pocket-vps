module.exports = {
  apps: [
    {
      name: 'n8n',
      script: '/data/data/com.termux/files/home/server/start-n8n.sh',
      interpreter: 'bash'
    },
    {
      name: 'file-server',
      script: 'http-server',
      args: '/data/data/com.termux/files/home/server/files -p 3000 --cors -c-1'
    },
    {
      name: 'caddy',
      script: '/data/data/com.termux/files/home/server/start-caddy.sh',
      interpreter: 'bash'
    },
    {
      name: 'duckdns',
      script: '/data/data/com.termux/files/home/server/duckdns-updater.sh',
      interpreter: 'bash'
    },
    {
      // RAG + LLM sidecar on :8082. Runs inside proot and spawns the Termux
      // llama-server binaries as its own children — that session must stay alive,
      // because a llama child outlives a short-lived proot login only as a frozen
      // process (port bound, /health dead). max_memory_restart covers the gateway
      // itself only; the models it spawns are not pm2 children and are reclaimed
      // by its own idle-kill loop.
      name: 'ai-gateway',
      script: '/data/data/com.termux/files/home/server/start-ai-gateway.sh',
      interpreter: 'bash',
      max_memory_restart: '1024M'
    }
  ]
};
