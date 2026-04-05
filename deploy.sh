#!/bin/bash

echo "🚀 Deploying to Railway..."
echo ""

# Check if changes are committed
if [[ -n $(git status -s) ]]; then
    echo "⚠️  You have uncommitted changes!"
    echo "   Committing all changes..."
    git add -A
    git commit -m "Deploy: $(date '+%Y-%m-%d %H:%M:%S')"
fi

# Push to GitHub
echo "📤 Pushing to GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Code pushed successfully!"
    echo ""
    echo "📋 Next steps:"
    echo "   1. Go to: https://railway.com/project/b18bb067-dca0-442d-9886-73fa0c9fc857"
    echo "   2. Click 'New' → 'GitHub Repo'"
    echo "   3. Select your repo: shwetd19/Swades-AI-Hackathon"
    echo "   4. Set environment variables:"
    echo "      - GROQ_API_KEY=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"
    echo "      - WHISPER_MODEL=whisper-large-v3-turbo"
    echo "      - NODE_ENV=production"
    echo "      - PORT=3000"
    echo ""
    echo "🎉 Railway will auto-deploy in ~3 minutes!"
else
    echo ""
    echo "❌ Push failed!"
    echo "   You may need to authenticate with GitHub first."
    echo "   Run: gh auth login"
fi
