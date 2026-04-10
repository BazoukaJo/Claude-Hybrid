# Claude Hybrid router — Node only (no npm deps at runtime).
# Ollama runs in docker-compose or on the host; set ROUTER_OLLAMA_HOST / ROUTER_OLLAMA_PORT.
FROM node:22-alpine

WORKDIR /app

COPY router/ ./router/

RUN mkdir -p /app/.claude \
  && printf '%s\n' '{}' > /app/.claude/model-params.json \
  && printf '%s\n' '{}' > /app/.claude/model-params-per-model.json

# Sensible defaults for first boot; mount a file over ./router/hybrid.config.json to customize.
COPY router/hybrid.config.example.json /app/router/hybrid.config.json

ENV NODE_ENV=production
ENV ROUTER_HOST=0.0.0.0

EXPOSE 8082

CMD ["node", "router/server.js"]
