#!/bin/bash

echo "🚀 Starting Preview..."
echo ""

# Check if .env files exist
if [ ! -f "apps/server/.env" ]; then
    echo "⚠️  Warning: apps/server/.env not found"
    echo "   Copy .env.example and configure your environment variables"
fi

if [ ! -f "apps/web/.env" ]; then
    echo "⚠️  Warning: apps/web/.env not found"
    echo "   Copy .env.example and configure your environment variables"
fi

echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "🏗️  Building projects..."
npm run build

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build successful!"
    echo ""
    echo "🎯 To start the preview:"
    echo "   npm run dev"
    echo ""
    echo "📍 Services will be available at:"
    echo "   - Web:    http://localhost:3001"
    echo "   - Server: http://localhost:3000"
    echo ""
else
    echo ""
    echo "❌ Build failed. Please check the errors above."
    exit 1
fi
