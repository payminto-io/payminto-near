# syntax=docker/dockerfile:1.7
# Local-only helper image for the compose `local` profile: anvil plus the precompiled contracts and deploy script.
FROM ghcr.io/foundry-rs/foundry:v1.5.0
WORKDIR /home/foundry/contracts
COPY --chown=foundry:foundry contracts/foundry.toml contracts/remappings.txt ./
COPY --chown=foundry:foundry contracts/lib lib
COPY --chown=foundry:foundry contracts/src src
COPY --chown=foundry:foundry contracts/script script
COPY --chown=foundry:foundry docker/deploy-local.sh /usr/local/bin/deploy-local.sh
# Compile at build time so `up` needs no network for solc.
RUN mkdir -p deployments && forge build
