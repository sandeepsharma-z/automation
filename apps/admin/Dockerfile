FROM node:20-alpine

WORKDIR /app
COPY apps/admin/package.json ./apps/admin/package.json
WORKDIR /app/apps/admin
RUN npm install

WORKDIR /app
COPY . /app
WORKDIR /app/apps/admin
