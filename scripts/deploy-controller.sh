#!/bin/bash
# Deploy the Hybrid Video Orchestrator Controller to Cloud Run
# Usage: ./scripts/deploy-controller.sh [PROJECT_ID] [REGION]

set -e

# Configuration
PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project)}}"
REGION="${2:-us-central1}"
SERVICE_NAME="video-orchestrator-controller"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
GCS_BUCKET="${GCS_BUCKET:-${PROJECT_ID}-video-assets}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deploying Hybrid Video Orchestrator Controller${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Project ID: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service Name: ${SERVICE_NAME}"
echo "Image: ${IMAGE_NAME}"
echo "GCS Bucket: ${GCS_BUCKET}"
echo ""

# Check if required tools are installed
command -v gcloud >/dev/null 2>&1 || { echo -e "${RED}gcloud is required but not installed.${NC}" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo -e "${RED}docker is required but not installed.${NC}" >&2; exit 1; }

# Check if project is set
if [ -z "${PROJECT_ID}" ]; then
    echo -e "${RED}Error: PROJECT_ID is not set.${NC}"
    echo "Usage: $0 [PROJECT_ID] [REGION]"
    exit 1
fi

# Enable required APIs
echo -e "${YELLOW}Enabling required APIs...${NC}"
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    storage.googleapis.com \
    texttospeech.googleapis.com \
    aiplatform.googleapis.com \
    --project="${PROJECT_ID}"

# Create GCS bucket if it doesn't exist
echo -e "${YELLOW}Checking GCS bucket...${NC}"
if ! gsutil ls -b "gs://${GCS_BUCKET}" >/dev/null 2>&1; then
    echo "Creating bucket: gs://${GCS_BUCKET}"
    gsutil mb -l "${REGION}" "gs://${GCS_BUCKET}"
    gsutil uniformbucketlevelaccess set on "gs://${GCS_BUCKET}"
else
    echo "Bucket already exists: gs://${GCS_BUCKET}"
fi

# Configure Docker for GCR
echo -e "${YELLOW}Configuring Docker for GCR...${NC}"
gcloud auth configure-docker gcr.io --quiet

# Build the container image
echo -e "${YELLOW}Building container image...${NC}"
docker build -t "${IMAGE_NAME}:latest" -f Dockerfile.controller .

# Push to GCR
echo -e "${YELLOW}Pushing image to GCR...${NC}"
docker push "${IMAGE_NAME}:latest"

# Deploy to Cloud Run
echo -e "${YELLOW}Deploying to Cloud Run...${NC}"
gcloud run deploy "${SERVICE_NAME}" \
    --image="${IMAGE_NAME}:latest" \
    --platform=managed \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --memory=2Gi \
    --cpu=2 \
    --timeout=3600 \
    --concurrency=10 \
    --min-instances=0 \
    --max-instances=10 \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
    --set-env-vars="LOCATION=${REGION}" \
    --set-env-vars="GCS_BUCKET=${GCS_BUCKET}" \
    --set-env-vars="RENDERER_JOB_NAME=video-renderer" \
    --allow-unauthenticated

# Get the service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --platform=managed \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --format="value(status.url)")

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Service URL: ${GREEN}${SERVICE_URL}${NC}"
echo ""
echo "Test the service:"
echo "  curl ${SERVICE_URL}/health"
echo ""
echo "Generate a video:"
echo "  curl -X POST ${SERVICE_URL}/generate \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"topic\": \"Introduction to Machine Learning\", \"targetDuration\": 120}'"
echo ""
echo -e "${YELLOW}Note: Set PEXELS_API_KEY environment variable for stock video support:${NC}"
echo "  gcloud run services update ${SERVICE_NAME} \\"
echo "       --region=${REGION} \\"
echo "       --set-env-vars=\"PEXELS_API_KEY=your-api-key\""
