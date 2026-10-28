# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4 AS source
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts

FROM source AS plugin-build
RUN for name in tools context memory title dice session-folder; do \
      mkdir -p "/plugins/$name/src" && \
      bun build --target=bun --external '@opencode/*' --external 'effect' --external 'effect/*' \
        --outfile="/plugins/$name/src/index.js" "packages/plugins/$name/src/index.ts" && \
      bun -e 'const manifest = await Bun.file(process.argv[1]).json(); manifest.name = "@ren-ai/plugin-" + process.argv[2]; await Bun.write(process.argv[3], JSON.stringify(manifest));' \
        apps/api/ops/plugin.package.json "$name" "/plugins/$name/package.json" && \
      (cd "/plugins/$name" && printf '[install]\nglobalStore = false\nlinker = "isolated"\nexact = true\n' > bunfig.toml && bun install --ignore-scripts) || exit 1; \
    done
COPY packages/plugins/session-folder/templates /plugins/session-folder/templates

FROM oven/bun:1.4.4 AS plugin
COPY --from=plugin-build /plugins /artifact/plugins
COPY apps/api/ops/install-location.sh /install-location.sh
ENTRYPOINT ["bash", "/install-location.sh"]

# One-off, network-disabled offline exporter. Never ship core/server to the Mac.
FROM source AS migration
WORKDIR /repo/apps/api
ENTRYPOINT ["bun", "ops/offline-export.ts"]
