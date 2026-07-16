FROM node:22-alpine
WORKDIR /package
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps
COPY . .
CMD ["npm", "run", "validate"]
