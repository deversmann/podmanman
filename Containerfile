FROM node:22-alpine
WORKDIR /app
COPY package.json server.js quadlets.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 PODMAN_SOCKET=/run/podman/podman.sock
EXPOSE 3000
USER node
CMD ["node", "server.js"]
