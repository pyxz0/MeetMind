# MeetMind 前端镜像：构建静态资源后交给 nginx 托管
#
# 基础镜像可用构建参数替换为国内源：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine \
#                --build-arg NGINX_IMAGE=docker.m.daocloud.io/library/nginx:1.27-alpine .
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

# ---------- 构建 ----------
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# 生产走同源反向代理，接口前缀用相对路径 /api。
# 必须在 build 时传入：Vite 会把 import.meta.env 静态替换进产物。
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# ---------- 运行 ----------
FROM ${NGINX_IMAGE} AS runtime

# 站点配置就在本目录，构建上下文可直接 COPY
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]