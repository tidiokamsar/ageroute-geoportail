FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# `npm ci` : installation exacte depuis package-lock.json (echoue si le verrou et package.json divergent).
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Pas de `USER` non privilegie : nginx ecoute sur le port 80 (< 1024) et ecrit dans /var/cache/nginx.
EXPOSE 80
