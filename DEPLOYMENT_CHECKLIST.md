# Deployment Checklist ✅

## Build Status
- ✅ Server builds successfully
- ✅ Web builds successfully  
- ✅ TypeScript updated for Node 24 compatibility
- ✅ Dependencies installed and up to date

## Pre-Deployment Steps

### 1. Environment Variables
Set these in Railway dashboard for each service:

#### Server Service
```env
DATABASE_URL=<railway-postgres-url>
CORS_ORIGIN=<your-frontend-url>
NODE_ENV=production
GROQ_API_KEY=<your-groq-api-key>
WHISPER_MODEL=whisper-large-v3-turbo
```

#### Web Service
```env
NEXT_PUBLIC_SERVER_URL=<your-server-url>
```

### 2. Database Setup
- Provision PostgreSQL database in Railway
- Copy DATABASE_URL to server environment
- Run migrations: `railway run npm run db:push`

### 3. API Keys
- Get Groq API key from https://console.groq.com/keys
- Add to server environment variables

## Railway Deployment Options

### Option 1: Monorepo Deployment (Recommended)

Deploy both services from the same repository:

1. Create two services in Railway:
   - `my-better-t-app-server`
   - `my-better-t-app-web`

2. For Server:
   - Root Directory: `/`
   - Build Command: `npm install && npm run build`
   - Start Command: `npm run start --workspace=server`
   - Watch Paths: `apps/server/**`, `packages/**`

3. For Web:
   - Root Directory: `/`
   - Build Command: `npm install && npm run build --workspace=web`
   - Start Command: `npm run start --workspace=web`
   - Watch Paths: `apps/web/**`, `packages/**`

### Option 2: Separate Deployments

Deploy each app independently:

1. Server: Use `apps/server/Dockerfile`
2. Web: Create separate Dockerfile for Next.js

## Post-Deployment Verification

- [ ] Server health check passes at `/`
- [ ] Web app loads successfully
- [ ] CORS is configured correctly
- [ ] Transcription API works
- [ ] Database connection is stable
- [ ] No console errors in browser

## Monitoring

```bash
# View server logs
railway logs --service my-better-t-app-server

# View web logs
railway logs --service my-better-t-app-web
```

## Troubleshooting

### Build Fails
- Check Node.js version (should be 20.x or higher)
- Verify all dependencies are in package.json
- Check build logs for specific errors

### CORS Errors
- Ensure CORS_ORIGIN matches frontend URL exactly
- Include protocol (https://)
- No trailing slash

### Database Connection
- Verify DATABASE_URL format
- Check database is running
- Test connection from Railway shell

### Transcription Fails
- Verify GROQ_API_KEY is set
- Check API key has quota
- Review server logs for errors

## Performance Tips

- Enable Railway's CDN for static assets
- Use Railway's auto-scaling for high traffic
- Monitor database connection pool
- Set up health checks

## Security

- [ ] Environment variables are set (not hardcoded)
- [ ] CORS is properly configured
- [ ] Database uses SSL connection
- [ ] API keys are kept secret
- [ ] .env files are in .gitignore

## Cost Optimization

- Use Railway's free tier for development
- Enable auto-sleep for non-production environments
- Monitor usage in Railway dashboard
- Set up billing alerts

## Next Steps

1. Test the deployment thoroughly
2. Set up monitoring and alerts
3. Configure custom domain (optional)
4. Set up CI/CD pipeline (optional)
5. Add load testing for production readiness
