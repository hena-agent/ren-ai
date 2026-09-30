# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2 AS source
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts

FROM source AS app-build
RUN mkdir /artifact && bun build --target=bun --outfile=/artifact/app.js packages/api-msg.hena.dev/src/server-entry.ts

FROM oven/bun:1.4.2 AS application
WORKDIR /app
COPY --from=app-build /artifact/app.js /app/app.js
ENV STATE_DIRECTORY=/state PERSONA_DIRECTORY=/personas LISTEN_HOST=0.0.0.0 PORT=4700
EXPOSE 4700
ENTRYPOINT ["bun", "/app/app.js"]

FROM source AS plugin-build
RUN mkdir /plugin && bun build --target=bun --packages=external --outfile=/plugin/index.js packages/api-msg.hena.dev/src/opencode/remote-plugin.ts
COPY packages/api-msg.hena.dev/ops/plugin.package.json /plugin/package.json
WORKDIR /plugin
RUN printf '[install]\nglobalStore = false\nlinker = "isolated"\nexact = true\n' > bunfig.toml && bun install --production --ignore-scripts

FROM oven/bun:1.4.2 AS plugin
COPY --from=plugin-build /plugin /artifact/plugin
COPY packages/api-msg.hena.dev/ops/install-location.sh /install-location.sh
ENTRYPOINT ["bash", "/install-location.sh"]

# One-off, network-disabled offline exporter. Never ship core/server to the Mac.
FROM source AS migration
WORKDIR /repo/packages/api-msg.hena.dev
ENTRYPOINT ["bun", "ops/offline-export.ts"]
