# One image for every Node role of the lab: the record store, the build, the server and the clients.
# The Angular packages are the published ones, pinned by package-lock.json.
FROM node:24.20.0-bookworm-slim
# tc, for the "link" service of compose.yml. Nothing else uses it.
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
WORKDIR /lab
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
