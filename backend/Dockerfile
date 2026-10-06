# Face to Face — API (Node.js / Express / Prisma). Build : docker build -t facetoface-api ./backend
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# --ignore-scripts : le « postinstall » du projet appelle scripts/prisma-generate.cjs, pas encore copié à ce stade (prisma generate est lancé plus bas).
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `prisma` (CLI) est nécessaire au runtime pour « migrate deploy » : on garde donc aussi ce paquet.
RUN npm ci --omit=dev --ignore-scripts && npm i --no-save prisma@6.19.3 --ignore-scripts && npx prisma generate
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Les migrations s'appliquent AVANT le démarrage (une seule instance à la fois : voir DEPLOYMENT.md).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
