#!/bin/bash
# Deploy the Hybrid Video Orchestrator Renderer to Cloud Run Jobs
# Usage: ./scripts/deploy-renderer.sh [PROJECT_ID] [REGION]

set -e

# Configuration
PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project)}}"
REGION="${2:-us-central1}"
JOB_NAME="video-renderer"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${JOB_NAME}"
GCS_BUCKET="${GCS_BUCKET:-${PROJECT_ID}-video-assets}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deploying Hybrid Video Orchestrator Renderer${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Project ID: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Job Name: ${JOB_NAME}"
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
    --project="${PROJECT_ID}"

# Configure Docker for GCR
echo -e "${YELLOW}Configuring Docker for GCR...${NC}"
gcloud auth configure-docker gcr.io --quiet

# Build the container image
echo -e "${YELLOW}Building container image...${NC}"
docker build -t "${IMAGE_NAME}:latest" -f Dockerfile.renderer .

# Push to GCR
echo -e "${YELLOW}Pushing image to GCR...${NC}"
docker push "${IMAGE_NAME}:latest"

# Check if job exists
JOB_EXISTS=$(gcloud run jobs describe "${JOB_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --format="value(name)" 2>/dev/null || echo "")

if [ -n "${JOB_EXISTS}" ]; then
    # Update existing job
    echo -e "${YELLOW}Updating existing Cloud Run Job...${NC}"
    gcloud run jobs update "${JOB_NAME}" \
        --image="${IMAGE_NAME}:latest" \
        --region="${REGION}" \
        --project="${PROJECT_ID}" \
        --memory=8Gi \
        --cpu=4 \
        --task-timeout=3600 \
        --max-retries=1 \
        --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
        --set-env-vars="GCS_BUCKET=${GCS_BUCKET}"
else
    # Create new job
    echo -e "${YELLOW}Creating Cloud Run Job...${NC}"
    gcloud run jobs create "${JOB_NAME}" \
        --image="${IMAGE_NAME}:latest" \
        --region="${REGION}" \
        --project="${PROJECT_ID}" \
        --memory=8Gi \
        --cpu=4 \
        --task-timeout=3600 \
        --max-retries=1 \
        --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
        --set-env-vars="GCS_BUCKET=${GCS_BUCKET}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Job Name: ${JOB_NAME}"
echo "Region: ${REGION}"
echo ""
echo "To manually execute the renderer job:"
echo "  gcloud run jobs execute ${JOB_NAME} \\"
echo "       --region=${REGION} \\"
echo "       --set-env-vars=\"JOB_ID=test-job-123\" \\"
echo "       --set-env-vars=\"EDL_PATH=gs://${GCS_BUCKET}/jobs/test-job-123/edl.json\""
echo ""
echo -e "${YELLOW}Note: The controller service will automatically dispatch render jobs.${NC}"
echo ""
echo "For GPU-accelerated rendering (higher cost), use:"
echo "  gcloud run jobs update ${JOB_NAME} \\"
echo "       --region=${REGION} \\"
echo "       --cpu=8 \\"
echo "       --memory=32Gi \\"
echo "       --set-env-vars=\"USE_GPU=true\""
