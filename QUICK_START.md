# 🚀 Quick Start Guide

## Where is the Transcript?

The transcript feature is on the **Recorder page** at `/recorder`

## Step-by-Step

### 1️⃣ Start the App
```bash
npm run dev
```

### 2️⃣ Open Recorder
Navigate to: **http://localhost:3001/recorder**

### 3️⃣ Record Audio
- Click **"Record"** button
- Speak into your microphone
- Click **"Stop"** when done

### 4️⃣ Transcribe
- Click **"Transcribe"** button below the chunks
- Wait for processing (shows progress)

### 5️⃣ View Transcript
You'll see:
- ✅ Full transcript text
- ✅ Audio duration and processing time
- ✅ Quality validation results
- ✅ Timed segments (expandable)
- ✅ Copy and Download buttons

## Features

### Recording
- Real-time waveform visualization
- Pause/Resume capability
- Automatic 5-second chunking
- Play/Download individual chunks

### Transcription
- Parallel processing (fast!)
- Progress indicator
- Quality filtering
- Hallucination detection
- Deduplication

### Export
- Copy text to clipboard
- Download as SRT subtitle file
- View timestamped segments

## Troubleshooting

### Can't see transcript?
1. Check server is running: http://localhost:3000
2. Check browser console for errors
3. Verify GROQ_API_KEY is set in `apps/server/.env`

### Poor quality transcript?
1. Speak clearly and at normal volume
2. Reduce background noise
3. Check microphone quality

### Transcription fails?
1. Check server logs
2. Verify Groq API key has quota
3. Try with fewer chunks first

## Environment Setup

### Required Files

**apps/server/.env**
```env
GROQ_API_KEY=gsk_your_key_here
WHISPER_MODEL=whisper-large-v3-turbo
CORS_ORIGIN=http://localhost:3001
NODE_ENV=development
```

**apps/web/.env**
```env
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
```

### Get Groq API Key
1. Visit https://console.groq.com/keys
2. Sign up (free)
3. Create new API key
4. Copy to `apps/server/.env`

## Documentation

- 📝 **TRANSCRIPT_FEATURE.md** - Detailed feature guide
- 🚀 **DEPLOYMENT.md** - Deploy to Railway
- ✅ **DEPLOYMENT_CHECKLIST.md** - Step-by-step deployment
- 📋 **CHANGES_SUMMARY.md** - What was changed

## Need Help?

1. Check the documentation files above
2. Review server logs: `npm run dev:server`
3. Check browser console for errors
4. Verify environment variables are set

---

**Ready to go!** Just run `npm run dev` and navigate to `/recorder` 🎤
