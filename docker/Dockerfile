# vigent with git, for disposable VMs and CI: the standalone binary, so there's
# no Node in the image. It has no agent CLIs; add the ones you use on top:
#
#   FROM ghcr.io/farming-labs/vigent
#   RUN ...install claude, codex, ...
#
# Built by the Binaries workflow, which unpacks each platform's archive into
# <arch>/ (amd64, arm64) of the build context.
FROM debian:bookworm-slim

ARG TARGETARCH

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	# a repository mounted from the host belongs to another user; without this git refuses to open it
	&& git config --system --add safe.directory '*'

COPY ${TARGETARCH}/ /opt/vigent/
RUN ln -s /opt/vigent/vigent /usr/local/bin/vigent

ENV TERM=xterm-256color
WORKDIR /work
ENTRYPOINT ["vigent"]
