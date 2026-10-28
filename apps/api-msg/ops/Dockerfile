FROM oven/bun:1.4.4
WORKDIR /app
COPY --chmod=444 api-msg.js api-msg-verify.js ./
USER bun
ENV LISTEN_HOST=0.0.0.0 PORT=4700
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "/app/api-msg-verify.js"]
ENTRYPOINT ["bun", "/app/api-msg.js"]
