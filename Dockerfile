# MyJournal container image.
#
#   docker build -t myjournal .
#   docker run -d --name myjournal \
#     -p 127.0.0.1:3210:3210 \
#     -v myjournal-data:/data \
#     -e JOURNAL_PASSWORD='a long passphrase' \
#     myjournal
#
# then open http://127.0.0.1:3210. The easier route is docker-compose.yml (see the comments in it).
#
# The product has zero runtime dependencies, so there is no "npm install" step and the image holds
# nothing but Node and the app: no build tools, no tests, no docs.

FROM node:22-alpine

# HOST=0.0.0.0 is required inside a container (the published port is a different network from
# the container's own loopback), and MyJournal refuses to listen on a non-loopback address
# without a password. So a container started without JOURNAL_PASSWORD exits immediately with a
# message that says so. That is deliberate: the secure setup is the default one.
#   - Normal use:  set JOURNAL_PASSWORD, and publish the port on 127.0.0.1 only (-p 127.0.0.1:3210:3210).
#   - Your own login proxy in front, no password wanted: set JOURNAL_INSECURE_ALLOW_NO_AUTH=1
#     and make sure the port is not reachable by anybody else.
ENV HOST=0.0.0.0 \
    PORT=3210 \
    JOURNAL_DATA_DIR=/data

WORKDIR /app

# Only what runs. (.dockerignore keeps everything else out of the build context as well.)
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# The journal database lives here. /data is created and owned by the unprivileged "node" user
# (uid 1000) BEFORE it is declared a volume, because a new named volume inherits the owner of the
# directory it covers. With a bind mount (-v ./journal-data:/data) the host folder must be
# writable by uid 1000 instead.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# The image's built-in "node" user is uid/gid 1000. The numbers are used (not the name) so that
# tools that must verify "does not run as root" (for example Kubernetes runAsNonRoot) can tell.
USER 1000:1000

EXPOSE 3210

# /api/health is public (no login needed) and answers {"ok":true,...}. The check calls
# 127.0.0.1 explicitly: that Host is always on the allow-list, and the server listens on
# 0.0.0.0 (IPv4), so "localhost" resolving to ::1 first cannot trip it up. fetch() is built in,
# so no curl or wget is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# node is PID 1 and handles SIGTERM itself (it finishes running replies, saves what they have
# written and closes the database), so "docker stop" is clean without an init process.
# --disable-warning only hides Node's "SQLite is experimental" notice, as "npm start" does.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
