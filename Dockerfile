# Use Node.js 20 Alpine as base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src ./src

# Expose port for HTTP transport (optional)
EXPOSE 8080

# Default command runs stdio transport
CMD ["node", "src/index.js"]
