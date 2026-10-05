# Content OS — single service: Express API + built React app.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/server/db/migrations ./server/db/migrations
COPY --from=build /app/data/sheet_links.json ./data/sheet_links.json
COPY --from=build /app/data/aim-30-day-plan.json ./data/aim-30-day-plan.json
COPY --from=build /app/data/dsr-october-2026.json ./data/dsr-october-2026.json
USER node
EXPOSE 8080
CMD ["node", "dist-server/server/index.js"]
