# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2 AS source
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts

FROM source AS app-build
RUN mkdir -p /artifact/src /artifact/templates && \
    bun build --target=bun --outfile=/artifact/src/app.js packages/api-msg.hena.dev/src/server-entry.ts && \
    cp packages/plugins/session-folder/templates/ground-rules.md /artifact/templates/ground-rules.md

FROM oven/bun:1.4.2 AS application
WORKDIR /app
COPY --from=app-build /artifact /app
ENV STATE_DIRECTORY=/state PERSONA_DIRECTORY=/personas DEFAULT_PERSONA_ID=Persona1 LISTEN_HOST=0.0.0.0 PORT=4700
EXPOSE 4700
ENTRYPOINT ["bun", "/app/src/app.js"]

FROM source AS plugin-build
RUN for name in tools context memory title session-folder; do \
      mkdir -p "/plugins/$name/src" && \
      bun build --target=bun --external '@opencode/*' --external 'effect' --external 'effect/*' \
        --outfile="/plugins/$name/src/index.js" "packages/plugins/$name/src/index.ts" && \
      bun -e 'const manifest = await Bun.file(process.argv[1]).json(); manifest.name = "@ren-ai/plugin-" + process.argv[2]; await Bun.write(process.argv[3], JSON.stringify(manifest));' \
        packages/api-msg.hena.dev/ops/plugin.package.json "$name" "/plugins/$name/package.json" && \
      (cd "/plugins/$name" && printf '[install]\nglobalStore = false\nlinker = "isolated"\nexact = true\n' > bunfig.toml && bun install --ignore-scripts) || exit 1; \
    done
COPY packages/plugins/session-folder/templates /plugins/session-folder/templates

FROM oven/bun:1.4.2 AS plugin
COPY --from=plugin-build /plugins /artifact/plugins
COPY packages/api-msg.hena.dev/ops/install-location.sh /install-location.sh
ENTRYPOINT ["bash", "/install-location.sh"]

# One-off, network-disabled offline exporter. Never ship core/server to the Mac.
FROM source AS migration
WORKDIR /repo/packages/api-msg.hena.dev
ENTRYPOINT ["bun", "ops/offline-export.ts"]
