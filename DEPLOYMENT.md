# Railway Deployment Guide

## Prerequisites

- Railway account ([railway.app](https://railway.app))
- PostgreSQL database (can be provisioned on Railway)
- Groq API key for transcription ([console.groq.com](https://console.groq.com/keys))

## Project Structure

This is a monorepo with two deployable apps:

- `apps/server` - Hono API server (port 3000)
- `apps/web` - Next.js frontend (port 3001)

## Deployment Steps

### 1. Create Railway Project

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Initialize project
railway init
```

### 2. Provision PostgreSQL Database

In Railway dashboard:

1. Click "New" → "Database" → "PostgreSQL"
2. Copy the `DATABASE_URL` connection string

### 3. Configure Environment Variables

#### For Server (apps/server)

```env
DATABASE_URL=<your-railway-postgres-url>
CORS_ORIGIN=<your-frontend-url>
NODE_ENV=production
GROQ_API_KEY=<your-groq-api-key>
WHISPER_MODEL=whisper-large-v3-turbo
```

#### For Web (apps/web)

```env
NEXT_PUBLIC_SERVER_URL=<your-server-url>
```

### 4. Deploy Server

Create `railway.server.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build"
  },
  "deploy": {
    "startCommand": "npm run start --workspace=server",
    "healthcheckPath": "/",
    "numReplicas": 1
  }
}
```

Deploy:

```bash
railway up --service server
```

### 5. Deploy Web

Create `railway.web.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build --workspace=web"
  },
  "deploy": {
    "startCommand": "npm run start --workspace=web",
    "numReplicas": 1
  }
}
```

Deploy:

```bash
railway up --service web
```

### 6. Run Database Migrations

After deploying, run migrations:

```bash
railway run npm run db:push
```

## Alternative: Docker Deployment

### Server Dockerfile

The project includes a Dockerfile at `apps/server/Dockerfile` for containerized deployment.

Build and deploy:

```bash
docker build -f apps/server/Dockerfile -t my-better-t-app-server .
docker push <your-registry>/my-better-t-app-server
```

### Web Dockerfile

Create `apps/web/Dockerfile`:

```dockerfile
FROM node:20-slim AS base

FROM base AS builder
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build --workspace=web

FROM base AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/package.json .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start", "--workspace=web"]
```

## Environment Variables Summary

### Required for Server

- `DATABASE_URL` - PostgreSQL connection string
- `CORS_ORIGIN` - Frontend URL (e.g., https://your-app.railway.app)
- `NODE_ENV` - Set to "production"
- `GROQ_API_KEY` - Your Groq API key
- `WHISPER_MODEL` - whisper-large-v3-turbo (default) or whisper-large-v3

### Required for Web

- `NEXT_PUBLIC_SERVER_URL` - Backend API URL (e.g., https://your-api.railway.app)

## Post-Deployment Checklist

- [ ] Database is provisioned and accessible
- [ ] Environment variables are set correctly
- [ ] Server health check passes at `/`
- [ ] CORS is configured with correct frontend URL
- [ ] Frontend can connect to backend API
- [ ] Groq API key is valid and has quota
- [ ] Database schema is pushed/migrated

## Troubleshooting

### Build Fails

- Ensure Node.js version is 20.x or higher
- Check that all dependencies are installed
- Verify monorepo workspace configuration

### Server Won't Start

- Check DATABASE_URL is valid
- Verify GROQ_API_KEY is set
- Check logs: `railway logs --service server`

### CORS Errors

- Ensure CORS_ORIGIN matches your frontend URL exactly
- Include protocol (https://) in the URL

### Database Connection Issues

- Verify DATABASE_URL format
- Check database is running
- Ensure network connectivity

## Monitoring

View logs:

```bash
railway logs --service server
railway logs --service web
```

## Scaling

Update `numReplicas` in railway.json to scale horizontally.

## Cost Optimization

- Use Railway's free tier for development
- Enable auto-sleep for non-production environments
- Monitor usage in Railway dashboard
