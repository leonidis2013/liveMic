# LiveMic: bridge server + web dashboard for Shure SLX-D receivers
FROM node:22-alpine

ENV NODE_ENV=production \
    CONFIG=/data/config.json \
    PORT=8080

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# the config lives outside the image, mounted at /data (read only is fine)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
