FROM ghcr.io/immich-app/immich-server:v3.2.4@sha256:d317916b28090c33eb36b308464ea391f8b7df1d850fcfea227a39ec879718c2

# 只覆盖本仓库改动的服务端模块，保留原版其他文件（含 RAW 清理校验的删除模块）。
COPY overlay/server/dist/ /usr/src/app/server/dist/
RUN rm -rf /build/www
COPY overlay/www/ /build/www/
COPY raw-cleanup/ /opt/immich-raw-cleanup/
COPY build-manifest.json /opt/immich-custom/build-manifest.json

ARG SOURCE_COMMIT
ARG SOURCE_REF=master
ENV IMMICH_REPOSITORY=chenyucheng0503/immich \
    IMMICH_REPOSITORY_URL=https://github.com/chenyucheng0503/immich \
    IMMICH_SOURCE_REF=${SOURCE_REF} \
    IMMICH_SOURCE_COMMIT=${SOURCE_COMMIT} \
    IMMICH_SOURCE_URL=https://github.com/chenyucheng0503/immich/commit/${SOURCE_COMMIT} \
    IMMICH_LOG_PREVIEW_DIR=/var/lib/immich-log-preview
LABEL org.opencontainers.image.source="https://github.com/chenyucheng0503/immich" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.title="Immich RAW 清理与 Log 预览"
