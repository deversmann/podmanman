FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends systemd && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js quadlets.js quadlet-admin.js container-admin.js container-conversion.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 PODMAN_SOCKET=/run/podman/podman.sock
EXPOSE 3000
USER node
CMD ["node", "server.js"]
