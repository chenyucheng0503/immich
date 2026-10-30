FROM ghcr.io/immich-app/immich-server:v3.2.4@sha256:d317916b28090c33eb36b308464ea391f8b7df1d850fcfea227a39ec879718c2
COPY core.cjs store.cjs service.cjs /opt/sony-creative-look/
WORKDIR /opt/sony-creative-look
LABEL org.opencontainers.image.source="https://github.com/chenyucheng0503/immich" \
      org.opencontainers.image.title="Sony 创意外观 XMP"
ENTRYPOINT ["node", "/opt/sony-creative-look/service.cjs"]
CMD ["serve"]
