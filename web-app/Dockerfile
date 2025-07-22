# Use Node.js official image as base
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Set build-time environment variables
# These are used by Astro during the build process
ARG MYSQL_HOST=localhost
ARG MYSQL_PORT=3306
ARG MYSQL_USER=root
ARG MYSQL_PASSWORD=password
ARG MYSQL_DATABASE=forum
ARG DISCORD_INVITE_URL=https://discord.gg/your-invite-code
ARG BANNER_EVERY_N=4

# Make environment variables available during build
ENV MYSQL_HOST=$MYSQL_HOST
ENV MYSQL_PORT=$MYSQL_PORT
ENV MYSQL_USER=$MYSQL_USER
ENV MYSQL_PASSWORD=$MYSQL_PASSWORD
ENV MYSQL_DATABASE=$MYSQL_DATABASE
ENV DISCORD_INVITE_URL=$DISCORD_INVITE_URL
ENV BANNER_EVERY_N=$BANNER_EVERY_N

# Build the application
RUN npm run build

# Production stage - use nginx to serve static files
FROM nginx:alpine

# Copy built static files from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx configuration if needed
# COPY nginx.conf /etc/nginx/nginx.conf

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]