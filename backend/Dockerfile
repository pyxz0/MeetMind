# MeetMind 后端镜像
#
# 三个阶段：
#   deps    只装依赖，供 migrate 服务复用（含 prisma CLI）
#   builder 生成 Prisma Client 并编译 TypeScript
#   runtime 只带运行期产物，非 root 运行
#
# 基础镜像可用构建参数替换为国内源：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine .
ARG NODE_IMAGE=node:24-alpine

# ---------- 依赖 ----------
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
COPY prisma7.config.ts ./

RUN npm ci

# ---------- 构建 ----------
FROM deps AS builder

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# prisma generate 只需 schema，不需要真实连库；
# 但 prisma7.config.ts 通过 env() 读取 DATABASE_URL，缺失会直接报错，
# 因此这里给一个构建期占位串（不会跨阶段传递到 runtime）。
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

RUN npx prisma generate && npm run build

# 裁掉 devDependencies，运行期只留生产依赖
RUN npm prune --omit=dev

# ---------- 运行 ----------
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
EXPOSE 3000

# wget 用于容器健康检查
RUN apk add --no-cache tzdata wget

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma7.config.ts ./

RUN mkdir -p /app/uploads \
    && addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app

USER app

# 迁移不在启动命令里执行：由 compose 的 migrate 服务先跑完，
# 避免多副本同时迁移，也让 runtime 镜像不需要 prisma CLI。
CMD ["node", "dist/main.js"]