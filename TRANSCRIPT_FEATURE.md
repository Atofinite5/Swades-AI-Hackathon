# 📝 Transcript Feature Guide

## Where to Find Transcripts

The transcript feature is located on the **Recorder page** at `/recorder`.

## How It Works

### 1. Record Audio
1. Navigate to `/recorder` (or click "Recorder" in the navigation)
2. Click the **"Record"** button to start recording
3. Audio is automatically chunked every 5 seconds
4. You can **Pause/Resume** or **Stop** the recording

### 2. View Chunks
- After recording, you'll see all audio chunks listed
- Each chunk shows:
  - Chunk number
  - Duration
  - Audio format (16kHz PCM)
  - Play/Download buttons

### 3. Transcribe
1. Click the **"Transcribe"** button below the chunks
2. The system will:
   - Process all chunks in parallel (8-16 concurrent jobs)
   - Send them to Groq Whisper API
   - Merge results with deduplication
   - Show progress: "Transcribing X/Y"

### 4. View Transcript
Once transcription is complete, you'll see:

#### Full Transcript
- Complete text with proper punctuation and capitalization
- Filtered for quality (removes hallucinations, low-confidence segments)

#### Metadata
- Language detected
- Total audio duration
- Processing time
- Number of segments

#### Quality Validation
- Shows any quality issues detected:
  - Improper sentence casing
  - Missing punctuation
  - Empty segments

#### Timed Segments
- Click "View Segments" to see timestamped captions
- Each segment shows:
  - Start time
  - End time
  - Text

#### Actions
- **Copy Text** - Copy full transcript to clipboard
- **Download SRT** - Download as subtitle file for video editing

## Features

### Audio Processing
- ✅ 16kHz, 16-bit PCM WAV format
- ✅ Automatic chunking (5-second intervals)
- ✅ SNR (Signal-to-Noise Ratio) detection
- ✅ Light normalization for quiet audio

### Transcription Quality
- ✅ Hallucination detection and filtering
- ✅ Confidence-based segment filtering
- ✅ Deduplication across chunks
- ✅ Proper punctuation and capitalization
- ✅ Quality validation warnings

### Performance
- ✅ Parallel processing (8-16 concurrent jobs)
- ✅ Automatic retry with exponential backoff
- ✅ Progress tracking
- ✅ Error handling

## API Endpoint

The transcription is powered by:
- **Endpoint**: `POST /transcribe`
- **Provider**: Groq Whisper API
- **Model**: `whisper-large-v3-turbo` (configurable)
- **Language**: English (en)

## Example Workflow

```
1. Click "Record" → Start speaking
2. Click "Stop" → Recording saved as chunks
3. Click "Transcribe" → Processing starts
4. View transcript → Full text with timestamps
5. Click "Copy Text" or "Download SRT" → Export
```

## Troubleshooting

### No Transcript Appears
- Check that chunks were recorded successfully
- Verify server is running at `NEXT_PUBLIC_SERVER_URL`
- Check browser console for errors
- Ensure `GROQ_API_KEY` is set on server

### Poor Quality Transcript
- Speak clearly and at normal volume
- Reduce background noise
- Check microphone quality
- Ensure good internet connection

### Transcription Fails
- Check server logs for API errors
- Verify Groq API key has quota
- Check network connectivity
- Try with fewer chunks first

## Technical Details

### Chunk Processing
1. Client records audio in 5-second chunks
2. Each chunk is a separate WAV file
3. Chunks are sent to server for transcription
4. Server merges chunks before sending to Groq
5. Results are merged with overlap handling

### Quality Filters
- `MIN_AVG_LOGPROB = -1` - Minimum confidence threshold
- `MAX_NO_SPEECH_PROB = 0.45` - Maximum silence probability
- Hallucination patterns filtered out
- Duplicate segments removed

### Deduplication
- 2-second overlap between chunks
- Fuzzy text matching
- Confidence-based selection
- Time-based alignment

## Environment Variables

### Server
```env
GROQ_API_KEY=gsk_...
WHISPER_MODEL=whisper-large-v3-turbo
```

### Web
```env
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
```

## Files Involved

- `apps/web/src/app/recorder/page.tsx` - UI with transcript display
- `apps/web/src/hooks/use-transcription.ts` - Transcription logic
- `apps/web/src/hooks/use-recorder.ts` - Audio recording
- `apps/server/src/transcribe.ts` - API endpoint
- `apps/server/src/qa.ts` - Quality assurance

---

**Ready to use!** Navigate to `/recorder` and start recording to see transcripts.
