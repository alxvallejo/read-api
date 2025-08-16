#!/bin/bash

set -e  # Exit on any error

echo "🚀 Starting Read-API Deployment..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Are you in the read-api directory?"
    exit 1
fi

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull origin master

# Install dependencies
echo "📦 Installing production dependencies..."
npm ci --production

# Check if PM2 is being used
if command -v pm2 &> /dev/null; then
    echo "🔄 Restarting API with PM2..."
    pm2 restart read-api --update-env || pm2 start server.js --name read-api -i 2
    pm2 save
    echo "📊 PM2 Status:"
    pm2 status
elif [ -f "/etc/systemd/system/read-api.service" ]; then
    echo "🔄 Restarting API with systemd..."
    sudo systemctl restart read-api
    sudo systemctl status read-api --no-pager
else
    echo "⚠️ No process manager found!"
    echo "Starting with node directly (not recommended for production)..."
    echo "Consider installing PM2: npm install -g pm2"
    # Kill existing node process on port 3000 if exists
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    # Start in background
    nohup node server.js > read-api.log 2>&1 &
    echo "API started with PID: $!"
fi

# Wait a moment for the service to start
sleep 3

# Test the API
echo "✅ Testing API endpoint..."
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/)
if [ "$RESPONSE" = "200" ]; then
    echo "✅ API is running successfully!"
    echo "🌍 API endpoint: http://localhost:3000"
else
    echo "⚠️ API returned HTTP status: $RESPONSE"
    echo "Check logs for more information:"
    if command -v pm2 &> /dev/null; then
        pm2 logs read-api --lines 20 --nostream
    else
        tail -n 20 read-api.log 2>/dev/null || echo "No logs available"
    fi
fi

echo "✅ Deployment complete! 🎉"