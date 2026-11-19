# eFutures QA platform. The base image already has Chromium and its system
# libraries, which the UI automation (Playwright) needs.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app
ENV NODE_ENV=production
# Listen on all interfaces inside the container (the default is 127.0.0.1 only).
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Everything the platform writes (testers, settings, test cases, runs, screenshots,
# the encryption key) lives in /app/data: mount a persistent volume there.
RUN mkdir -p /app/data /app/logs && chown -R pwuser:pwuser /app/data /app/logs
VOLUME ["/app/data", "/app/logs"]

EXPOSE 4321
USER pwuser
CMD ["node", "src/server.js"]
