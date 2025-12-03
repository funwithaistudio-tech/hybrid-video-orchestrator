# Hybrid Video Orchestrator

A production-ready video generation system that orchestrates AI services (Gemini, Imagen, Text-to-Speech, Pexels) with FFmpeg rendering on Google Cloud Platform.

**Target**: Generate 80-100 premium educational videos in 48 hours using Google Cloud native services with GPU rendering.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Cloud Run Controller                             │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────┐ │
│  │ Gemini  │  │ Imagen  │  │   TTS    │  │ Pexels  │  │ EDL Builder  │ │
│  │ Script  │  │ Images  │  │  Audio   │  │ Videos  │  │   & GCS      │ │
│  └────┬────┘  └────┬────┘  └────┬─────┘  └────┬────┘  └──────┬───────┘ │
│       │            │            │             │               │         │
│       └────────────┴────────────┴─────────────┴───────────────┘         │
│                                 │                                        │
│                    ┌────────────▼───────────────┐                       │
│                    │  Dispatch Cloud Run Job    │                       │
│                    └────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Cloud Run Jobs (Renderer)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Download     │  │ Ken Burns   │  │ Audio Mix    │  │ Upload      │ │
│  │ Assets       │→ │ + Render    │→ │ + Combine    │→ │ to GCS      │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Features

- **AI-Powered Script Generation**: Uses Gemini to create educational video scripts with scene breakdowns
- **Automatic Asset Generation**: 
  - Imagen for AI-generated images
  - Cloud Text-to-Speech for narration
  - Pexels API for stock video footage
- **Professional Video Effects**: Ken Burns pan/zoom effects, transitions, and audio mixing
- **Cloud-Native**: Serverless deployment on Cloud Run and Cloud Run Jobs
- **EDL-Based Workflow**: Industry-standard Edit Decision List format for reproducible renders
- **Scalable**: Process multiple videos in parallel with auto-scaling

## Prerequisites

- Google Cloud Platform account with billing enabled
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and configured
- Docker installed locally
- Pexels API key (free at [pexels.com/api](https://www.pexels.com/api/))

## Project Structure

```
hybrid-video-orchestrator/
├── src/
│   ├── controller.js     # Cloud Run service (API + orchestration)
│   └── entrypoint.js     # Cloud Run Jobs (FFmpeg rendering)
├── schema/
│   └── edl-schema.json   # EDL JSON Schema
├── scripts/
│   ├── deploy-controller.sh
│   └── deploy-renderer.sh
├── Dockerfile.controller  # Controller service image
├── Dockerfile.renderer    # Renderer job image
├── package.json
└── README.md
```

## Quick Start

### 1. Clone and Configure

```bash
git clone https://github.com/funwithaistudio-tech/hybrid-video-orchestrator.git
cd hybrid-video-orchestrator

# Set your project ID
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
gcloud config set project $PROJECT_ID
```

### 2. Deploy the Controller Service

```bash
chmod +x scripts/deploy-controller.sh
./scripts/deploy-controller.sh $PROJECT_ID $REGION
```

This will:
- Enable required GCP APIs
- Create a GCS bucket for assets
- Build and push the controller container
- Deploy to Cloud Run

### 3. Deploy the Renderer Job

```bash
chmod +x scripts/deploy-renderer.sh
./scripts/deploy-renderer.sh $PROJECT_ID $REGION
```

### 4. Configure Pexels API Key (Optional but Recommended)

```bash
gcloud run services update video-orchestrator-controller \
    --region=$REGION \
    --set-env-vars="PEXELS_API_KEY=your-pexels-api-key"
```

### 5. Generate a Video

```bash
# Get the service URL
SERVICE_URL=$(gcloud run services describe video-orchestrator-controller \
    --region=$REGION --format="value(status.url)")

# Generate a video
curl -X POST "${SERVICE_URL}/generate" \
    -H "Content-Type: application/json" \
    -d '{
        "topic": "Introduction to Machine Learning",
        "targetDuration": 120,
        "options": {
            "width": 1920,
            "height": 1080,
            "fps": 30
        }
    }'
```

### 6. Check Job Status

```bash
curl "${SERVICE_URL}/jobs/{job-id}"
```

## API Reference

### Generate Video
**POST** `/generate`

```json
{
    "topic": "Your video topic",
    "targetDuration": 120,
    "options": {
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "format": "mp4",
        "codec": "h264",
        "voice": {
            "languageCode": "en-US",
            "name": "en-US-Neural2-D",
            "ssmlGender": "MALE"
        }
    }
}
```

### Render Custom EDL
**POST** `/render`

```json
{
    "edl": {
        "version": "1.0.0",
        "metadata": { ... },
        "assets": { ... },
        "timeline": { ... }
    }
}
```

### Get Job Status
**GET** `/jobs/{jobId}`

Returns:
- `status`: "processing" | "rendering" | "completed"
- `outputPath`: GCS path to final video (when completed)

### Health Check
**GET** `/health`

## EDL Schema

The Edit Decision List (EDL) format defines the video structure:

```json
{
    "version": "1.0.0",
    "metadata": {
        "title": "Video Title",
        "description": "Description",
        "outputSettings": {
            "width": 1920,
            "height": 1080,
            "fps": 30,
            "format": "mp4"
        }
    },
    "assets": {
        "visual_scene_1": {
            "type": "generated-image",
            "source": "gs://bucket/path/image.png"
        },
        "audio_scene_1": {
            "type": "generated-audio",
            "source": "gs://bucket/path/audio.mp3",
            "duration": 10.5
        }
    },
    "timeline": {
        "duration": 120,
        "tracks": [
            {
                "id": "video-main",
                "type": "video",
                "clips": [
                    {
                        "id": "clip_1",
                        "assetId": "visual_scene_1",
                        "startTime": 0,
                        "duration": 10,
                        "effects": [
                            {
                                "type": "ken-burns",
                                "params": {
                                    "startZoom": 1.0,
                                    "endZoom": 1.2,
                                    "easing": "ease-in-out"
                                }
                            }
                        ]
                    }
                ]
            },
            {
                "id": "audio-narration",
                "type": "audio",
                "clips": [...]
            }
        ]
    }
}
```

See `schema/edl-schema.json` for the complete JSON Schema.

## Environment Variables

### Controller Service

| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | Required |
| `LOCATION` | GCP region | `us-central1` |
| `GCS_BUCKET` | Storage bucket for assets | `hybrid-video-assets` |
| `PEXELS_API_KEY` | Pexels API key for stock videos | Optional |
| `GEMINI_MODEL` | Gemini model name | `gemini-1.5-pro` |
| `IMAGEN_MODEL` | Imagen model name | `imagegeneration@006` |
| `RENDERER_JOB_NAME` | Cloud Run Job name | `video-renderer` |

### Renderer Job

| Variable | Description | Default |
|----------|-------------|---------|
| `JOB_ID` | Unique job identifier | Required |
| `EDL_PATH` | GCS path to EDL JSON | Required |
| `GCS_BUCKET` | Storage bucket | Required |
| `WORK_DIR` | Local working directory | `/tmp/render` |
| `USE_GPU` | Enable GPU acceleration | `false` |

## Cost Optimization

### Estimated Costs per Video (2 minutes)

| Service | Estimated Cost |
|---------|---------------|
| Gemini API | ~$0.05 |
| Imagen API | ~$0.20 (10 images) |
| Text-to-Speech | ~$0.10 |
| Pexels API | Free |
| Cloud Run (Controller) | ~$0.01 |
| Cloud Run Jobs (Renderer) | ~$0.10 |
| Cloud Storage | ~$0.01 |
| **Total** | **~$0.47 per video** |

### Tips for Cost Reduction

1. Use `gemini-1.5-flash` for faster, cheaper script generation
2. Cache generated assets for reuse
3. Use lower resolution during testing (720p)
4. Enable GPU only for final renders

## Scaling for Batch Production

For 80-100 videos in 48 hours:

```bash
# Increase controller concurrency
gcloud run services update video-orchestrator-controller \
    --region=$REGION \
    --concurrency=50 \
    --max-instances=20

# Increase renderer resources for faster processing
gcloud run jobs update video-renderer \
    --region=$REGION \
    --cpu=8 \
    --memory=16Gi \
    --parallelism=10
```

## Troubleshooting

### Common Issues

**"Failed to generate image with Imagen"**
- Check that Vertex AI API is enabled
- Verify your project has access to Imagen
- Check quota limits

**"No Pexels videos found"**
- Ensure PEXELS_API_KEY is set correctly
- Try broader search queries

**"Render job failed"**
- Check Cloud Run Jobs logs: `gcloud run jobs executions logs read <execution-id>`
- Verify GCS bucket permissions
- Check if assets were downloaded correctly

### View Logs

```bash
# Controller logs
gcloud run services logs read video-orchestrator-controller --region=$REGION

# Renderer logs
gcloud run jobs executions list video-renderer --region=$REGION
gcloud run jobs executions logs read <execution-id> --region=$REGION
```

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run controller locally
export GOOGLE_CLOUD_PROJECT=your-project
export GCS_BUCKET=your-bucket
npm start

# Test renderer locally (requires FFmpeg)
export EDL_PATH=gs://your-bucket/path/to/edl.json
export JOB_ID=test-job-123
npm run render
```

### Running Tests

```bash
npm test
```

## License

MIT License - See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Acknowledgments

- Google Cloud AI services (Gemini, Imagen, Text-to-Speech)
- Pexels for free stock video API
- FFmpeg for video processing
