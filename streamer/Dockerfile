FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json .
RUN npm install --omit=dev

COPY server.js .

# Frontend build gets copied here in production:
# docker run ... -v ./frontend/dist:/app/public
# Or build into image: COPY ../frontend/dist ./public

EXPOSE 9090
CMD ["node", "server.js"]
