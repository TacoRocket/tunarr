ARG base_image=ghcr.io/ersatztv/ersatztv-ffmpeg
ARG base_image_tag=7.1.1

# Keep the OCR compiler and static library out of the runtime image.
FROM ${base_image}:${base_image_tag} AS tesseract-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl g++ make autoconf automake libtool pkg-config libleptonica-dev
COPY docker/tesseract.sha256 /tmp/tesseract.sha256
RUN <<EOF
set -eu
cd /tmp
curl -fL --retry 3 https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.3.tar.gz -o tesseract.tar.gz
curl -fL --retry 3 https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata -o eng.traineddata
sha256sum -c tesseract.sha256
tar -xzf tesseract.tar.gz
cd tesseract-5.5.3
./autogen.sh
# Static libtesseract avoids loading an older library from the FFmpeg base image.
./configure --prefix=/opt/tesseract --disable-shared --disable-silent-rules
make -j2
make install
install -m 644 /tmp/eng.traineddata /opt/tesseract/share/tessdata/eng.traineddata
/opt/tesseract/bin/tesseract --version 2>&1 | grep -Fx 'tesseract 5.5.3'
EOF

# Shared FFmpeg runtime; production JavaScript runs on Bun.
FROM ${base_image}:${base_image_tag} AS ffmpeg-base
ENV TUNARR_BIND_ADDR=0.0.0.0
# Expose Tunarr server default port
EXPOSE 8000
# Expose SSDP default port
EXPOSE 1900/udp 

# Update deps
RUN <<EOF
rm /var/lib/dpkg/info/libc-bin.*
apt-get clean
apt-get update --fix-missing
apt-get install libc-bin
apt-get install -y --no-install-recommends ca-certificates curl unzip wget util-linux liblept5 libgomp1
EOF

COPY --from=tesseract-build /opt/tesseract/bin/tesseract /usr/local/bin/tesseract
COPY --from=tesseract-build /opt/tesseract/share/tessdata /opt/tesseract/share/tessdata
COPY --from=tesseract-build /tmp/tesseract-5.5.3/LICENSE /usr/share/doc/tesseract/LICENSE
ENV TESSDATA_PREFIX=/opt/tesseract/share/tessdata
RUN tesseract --version 2>&1 | grep -Fx 'tesseract 5.5.3'

COPY .bun-version /opt/tunarr/bun-version
COPY docker/bun-linux-x64.sha256 /tmp/bun.sha256
ARG TARGETARCH
RUN <<EOF
set -eu
[ "$TARGETARCH" = amd64 ] || { echo 'The fork container currently supports linux/amd64'; exit 1; }
version="$(cat /opt/tunarr/bun-version)"
curl -fL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-x64.zip" -o /tmp/bun.zip
cd /tmp
sha256sum -c bun.sha256
unzip -q bun.zip
install -m 755 bun-linux-x64/bun /usr/local/bin/bun
rm -rf bun.zip bun.sha256 bun-linux-x64
EOF
RUN ln -s /usr/local/bin/ffmpeg /usr/bin/ffmpeg
RUN ln -s /usr/local/bin/ffprobe /usr/bin/ffprobe
RUN curl -sfS https://dotenvx.sh | sh
ENV NODE_ENV=production
ENTRYPOINT [ "dotenvx", "run", "--", "/usr/local/bin/bun", "/tunarr/app/bundle.cjs" ]
CMD [ "server" ]

# Build/test tools stay out of the final image. One version pin owns this toolchain.
FROM ffmpeg-base AS build-tools
COPY .nvmrc /tmp/build-node-version
RUN <<EOF
set -eu
version="$(cat /tmp/build-node-version)"
archive="node-v${version}-linux-x64.tar.gz"
curl -fL --retry 3 "https://nodejs.org/dist/v${version}/${archive}" -o "/tmp/${archive}"
curl -fL --retry 3 "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o /tmp/node-checksums
cd /tmp
grep "  ${archive}$" node-checksums | sha256sum -c -
tar -xzf "$archive" --strip-components=1 -C /usr/local
rm "$archive" node-checksums build-node-version
EOF
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g corepack@latest
RUN corepack enable && corepack enable pnpm
RUN pnpm --version
ENV NODE_ENV=development

# Add Tunarr sources
FROM build-tools AS sources
WORKDIR /tunarr
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .pnpmfile.cjs ./
COPY scripts ./scripts
COPY server/ ./server
COPY shared/ ./shared
COPY types ./types
COPY web ./web
COPY patches ./patches

# Dev container
FROM build-tools AS dev
EXPOSE 5173
WORKDIR /tunarr

COPY ./server server
COPY ./web web
COPY ./shared shared
COPY ./types types
COPY ./scripts scripts
COPY ./patches patches
COPY README.md README.md
COPY package.json package.json
COPY pnpm-lock.yaml pnpm-lock.yaml
COPY .pnpmfile.cjs .pnpmfile.cjs
COPY pnpm-workspace.yaml pnpm-workspace.yaml
COPY turbo.json turbo.json

RUN pnpm install --frozen-lockfile
RUN pnpm turbo clean
ENTRYPOINT [ "pnpm" ]
CMD [ "turbo", "dev" ]

# Step for caching production deps
FROM sources AS prod-deps
ARG NODE_ENVIRONMENT
ENV NODE_ENV=${NODE_ENVIRONMENT:-production}
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM sources AS build-full-stack
ARG is_edge_build
ARG tunarr_version
ARG tunarr_build
# Build common modules
RUN <<EOF
touch .env
echo TUNARR_VERSION="${tunarr_version}" >> .env
echo TUNARR_BUILD="${tunarr_build}" >> .env
echo TUNARR_EDGE_BUILD=${is_edge_build} >> .env
echo TUNARR_BUILD_BASE_TAG=${base_image_tag} >> .env
cat .env
cp .env server/.env
cp .env web/.env
EOF
# Install deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo clean
# Bundle web in a separate task
RUN NODE_OPTIONS=--max-old-space-size=32768 pnpm turbo bundle --filter=@tunarr/web
RUN pnpm turbo package-container --filter=@tunarr/server

### Full stack ###
FROM ffmpeg-base AS full-stack
WORKDIR /tunarr
COPY --from=build-full-stack /tunarr/.env /tunarr/.env
COPY --from=build-full-stack /tunarr/server/dist /tunarr/app
COPY --from=build-full-stack /tunarr/server/bin/meilisearch /tunarr/bin/meilisearch
COPY --from=build-full-stack /tunarr/server/bin/ersatztv-channel /tunarr/bin/ersatztv-channel
COPY --chmod=755 docker/tunarr /tunarr/tunarr
