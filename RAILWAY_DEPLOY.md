# Railway Deployment - Quick Guide

## ✅ Ready to Deploy!

All files are configured. Just push and deploy.

## Step 1: Push to GitHub

```bash
git push origin main
```

## Step 2: Deploy on Railway

Go to: https://railway.com/project/b18bb067-dca0-442d-9886-73fa0c9fc857

### Option A: Connect GitHub (Recommended)
1. Click **"New"** → **"GitHub Repo"**
2. Select: `shwetd19/Swades-AI-Hackathon`
3. Railway will auto-detect and build

### Option B: CLI Deploy
```bash
railway login
railway link b18bb067-dca0-442d-9886-73fa0c9fc857
railway up
```

## Step 3: Set Environment Variables

In Railway dashboard, add these variables:

### Required:
- `GROQ_API_KEY` = `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`
- `WHISPER_MODEL` = `whisper-large-v3-turbo`
- `NODE_ENV` = `production`
- `PORT` = `3000`

### Optional (if using database):
- `DATABASE_URL` = (your PostgreSQL URL from Railway)
- `CORS_ORIGIN` = `*` (or your frontend URL)

## What Railway Will Do

1. ✅ Detect Node.js project
2. ✅ Run `npm install`
3. ✅ Run `npm run build` (builds server to dist/)
4. ✅ Start with `node dist/index.mjs`
5. ✅ Health check at `/`

## Files Configured

- ✅ `Procfile` - Start command
- ✅ `nixpacks.toml` - Build configuration
- ✅ `railway.toml` - Railway settings
- ✅ `apps/server/package.json` - Fixed start script

## After Deployment

Your API will be available at:
```
https://your-app.railway.app
```

Test it:
```bash
curl https://your-app.railway.app/
```

Should return: `OK`

## Troubleshooting

### Build fails?
- Check Railway logs
- Verify Node version (should be 20.x)
- Ensure all dependencies are in package.json

### Server won't start?
- Check environment variables are set
- Verify GROQ_API_KEY is correct
- Check Railway logs for errors

### Health check fails?
- Server must respond at `/` endpoint
- Check PORT environment variable
- Verify server is listening on correct port

## Deploy Time

- Build: ~2-3 minutes
- Deploy: ~30 seconds
- Total: ~3-4 minutes

---

**Ready!** Just push to GitHub and connect in Railway dashboard! 🚀
