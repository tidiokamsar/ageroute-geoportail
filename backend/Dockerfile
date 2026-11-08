FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
EXPOSE 4000
# Sonde d'etat de l'image. Elle ne fait qu'etiqueter le conteneur (healthy / unhealthy) :
# Docker Compose ne redemarre pas un conteneur unhealthy et les etiquettes Traefik sont sur
# le service frontend, pas sur celui-ci. /api/health rend 200 si base et stockage repondent,
# 503 sinon. Image non construite ni essayee au moment de l'ecriture de cette ligne.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# PAS DE `USER node` ICI, volontairement. Le conteneur tourne en root et doit le rester tant que
# le volume nomme bdri_uploads (monte sur /app/uploads, voir docker-compose.yml) appartient a root :
# un utilisateur non privilegie ne pourrait plus ecrire dans ce volume deja peuple, et
# app.ts (mkdirSync de uploads/ et uploads/photos) ainsi que la sonde /api/health (acces en
# ecriture au stockage) echoueraient au demarrage. Pour passer en non-root : creer et chown
# /app/uploads dans l'image, `chown -R 1000:1000` une fois sur le volume existant, puis
# ajouter `USER node`. A essayer sur une copie, jamais directement en production.
CMD ["node", "dist/server.js"]
