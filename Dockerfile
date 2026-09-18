FROM node:20
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY src/ ./src/
COPY templates/ ./templates/

# data/ and logs/ are mounted as volumes — not copied
RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["node", "src/main.js"]
