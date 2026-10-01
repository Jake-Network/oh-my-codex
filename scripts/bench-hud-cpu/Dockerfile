ARG UBUNTU_VERSION=24.04
FROM ubuntu:${UBUNTU_VERSION}

ARG NODE_VERSION=22.20.0
ARG TMUX_VERSION=apt
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN if [ "$TMUX_VERSION" != apt ]; then \
      build_packages='build-essential bison libevent-dev libncurses-dev pkg-config'; \
    else \
      build_packages=''; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      inotify-tools \
      jq \
      procps \
      tmux \
      xz-utils \
      $build_packages \
    && case "$TARGETARCH" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 2 ;; \
    esac \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && tar -xJf "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -C /usr/local --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && if [ "$TMUX_VERSION" != apt ]; then \
      curl -fsSLO "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"; \
      tar -xzf "tmux-${TMUX_VERSION}.tar.gz"; \
      cd "tmux-${TMUX_VERSION}"; \
      ./configure; \
      make -j2; \
      make install; \
      cd /; \
      rm -rf "tmux-${TMUX_VERSION}" "tmux-${TMUX_VERSION}.tar.gz"; \
    fi \
    && rm -rf /var/lib/apt/lists/*

COPY run-in-container.sh /bench/run-in-container.sh
COPY hook-slots.cjs /bench/hook-slots.cjs
COPY trace-preload.cjs /bench/trace-preload.cjs
COPY trace-tmux.sh /bench/tmux

RUN chmod +x /bench/run-in-container.sh /bench/tmux

ENTRYPOINT ["/bench/run-in-container.sh"]
