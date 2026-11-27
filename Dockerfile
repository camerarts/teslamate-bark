FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

# 先装依赖再拷代码，利用镜像层缓存：只改代码时不必重装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# 用镜像自带的非 root 用户运行，状态目录提前授权
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]

CMD ["node", "src/index.mjs"]
