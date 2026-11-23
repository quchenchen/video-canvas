# syntax=docker/dockerfile:1
# 构建上下文是仓库根目录：docker build -f backend/Dockerfile .
# 画布 Agent 是独立的服务（agent/Dockerfile，镜像 video-canvas-agent），这个镜像里没有 Node。

FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS build

WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ .

ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILDTIME=unknown
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w -X video-canvas/pkg/version.Version=${VERSION} -X video-canvas/pkg/version.GitCommit=${COMMIT} -X video-canvas/pkg/version.BuildTime=${BUILDTIME}" \
    -o /out/server ./cmd/server

FROM alpine:3.22

WORKDIR /app
# 画布 Agent 看视频、截帧需要 ffmpeg / ffprobe（抽帧由 backend 做，Agent 服务不联网也不碰素材）。
RUN apk add --no-cache ffmpeg && addgroup -S app && adduser -S -G app app
COPY --from=build /out/server /app/server
COPY --from=build /src/configs/config.yaml /app/configs/config.yaml
# 命令行安装包由 backend 现场打包下发（/api/v1/cli/download），镜像里只放「会下发的那几项」：
# package.json（版本号来源）、README.md、dist/（tsc 产物）。源码、测试、tsconfig、锁文件都不进镜像——
# 容器只读这几个文件打包，多带一份就多一处与源码不同步的东西。镜像里没有 Node 也能打包。
COPY cli/package.json cli/README.md /app/cli/
COPY cli/dist/ /app/cli/dist/
RUN test -f /app/cli/dist/cli.js \
    || (echo "错误：cli/dist 缺失。先在 cli/ 里 npm ci && npm run build 再构建镜像" >&2; exit 1)
# /run/plugin-runner 是 backend 与 plugin-runner 容器共享 Unix socket 的卷挂载点，首次挂载时命名卷继承这里的属主
# /app/logs 预先建好并交给 app 用户：命名卷首次挂载时继承这个属主，否则日志写不进去
RUN mkdir -p /app/data/assets /app/logs /run/plugin-runner && chown -R app:app /app /run/plugin-runner

USER app:app
EXPOSE 8080
ENTRYPOINT ["/app/server", "-c", "/app/configs/config.yaml"]
