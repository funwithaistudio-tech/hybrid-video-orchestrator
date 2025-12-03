/**
 * Hybrid Video Orchestrator - Controller Service
 * 
 * Cloud Run service that orchestrates video generation using:
 * - Google Gemini for script/scene generation
 * - Imagen for AI-generated images
 * - Cloud Text-to-Speech for narration
 * - Pexels API for stock video footage
 * 
 * Generates EDL (Edit Decision List) JSON and dispatches render jobs to Cloud Run Jobs.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
const { VertexAI } = require('@google-cloud/vertexai');
const textToSpeech = require('@google-cloud/text-to-speech');
const axios = require('axios');

// Configuration from environment variables
const config = {
  port: process.env.PORT || 8080,
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.PROJECT_ID,
  location: process.env.LOCATION || 'us-central1',
  bucketName: process.env.GCS_BUCKET || 'hybrid-video-assets',
  pexelsApiKey: process.env.PEXELS_API_KEY,
  rendererJobName: process.env.RENDERER_JOB_NAME || 'video-renderer',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-pro',
  imagenModel: process.env.IMAGEN_MODEL || 'imagegeneration@006'
};

// Initialize clients
const storage = new Storage({ projectId: config.projectId });
const ttsClient = new textToSpeech.TextToSpeechClient();
let vertexAI = null;

/**
 * Initialize Vertex AI client
 */
function getVertexAI() {
  if (!vertexAI) {
    vertexAI = new VertexAI({
      project: config.projectId,
      location: config.location
    });
  }
  return vertexAI;
}

/**
 * Generate script/scenes using Gemini
 * @param {string} topic - Video topic
 * @param {number} targetDuration - Target video duration in seconds
 * @returns {Promise<Object>} Generated script with scenes
 */
async function generateScriptWithGemini(topic, targetDuration = 120) {
  const vertex = getVertexAI();
  const model = vertex.getGenerativeModel({ model: config.geminiModel });

  const prompt = `Create a detailed video script for an educational video about "${topic}".
Target duration: ${targetDuration} seconds.

Return a JSON object with the following structure:
{
  "title": "Video title",
  "description": "Brief description",
  "scenes": [
    {
      "id": "scene_1",
      "duration": 10,
      "narration": "Text to be spoken",
      "visualDescription": "Description of what should be shown",
      "visualType": "image" | "video",
      "searchQuery": "Search query for Pexels (if visualType is video)",
      "imagePrompt": "Detailed prompt for Imagen (if visualType is image)",
      "effects": {
        "kenBurns": {
          "startZoom": 1.0,
          "endZoom": 1.2,
          "direction": "in" | "out" | "left" | "right"
        }
      }
    }
  ]
}

Create 8-12 scenes that together form a cohesive educational narrative.
Alternate between image and video visual types for variety.
Make narrations clear and educational.
Ensure image prompts are detailed and suitable for AI generation.`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.candidates[0].content.parts[0].text;
  
  // Extract JSON from response
  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1] || jsonMatch[0]);
  }
  throw new Error('Failed to parse Gemini response as JSON');
}

/**
 * Generate image using Imagen via Vertex AI
 * @param {string} prompt - Image generation prompt
 * @param {string} jobId - Job identifier for storage path
 * @param {string} assetId - Asset identifier
 * @returns {Promise<string>} GCS path to generated image
 */
async function generateImageWithImagen(prompt, jobId, assetId) {
  const vertex = getVertexAI();
  
  // Use Imagen model endpoint
  const endpoint = `projects/${config.projectId}/locations/${config.location}/publishers/google/models/${config.imagenModel}`;
  
  const request = {
    instances: [{ prompt: prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: '16:9',
      safetyFilterLevel: 'block_some'
    }
  };

  // Call Imagen API
  const response = await axios.post(
    `https://${config.location}-aiplatform.googleapis.com/v1/${endpoint}:predict`,
    request,
    {
      headers: {
        'Authorization': `Bearer ${await getAccessToken()}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (response.data.predictions && response.data.predictions[0]) {
    const imageData = response.data.predictions[0].bytesBase64Encoded;
    const gcsPath = `jobs/${jobId}/assets/${assetId}.png`;
    
    // Upload to GCS
    await storage.bucket(config.bucketName).file(gcsPath).save(
      Buffer.from(imageData, 'base64'),
      { contentType: 'image/png' }
    );
    
    return `gs://${config.bucketName}/${gcsPath}`;
  }
  
  throw new Error('Failed to generate image with Imagen');
}

/**
 * Get access token for API calls
 */
async function getAccessToken() {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

/**
 * Generate speech audio using Cloud Text-to-Speech
 * @param {string} text - Text to synthesize
 * @param {string} jobId - Job identifier for storage path
 * @param {string} assetId - Asset identifier
 * @param {Object} voiceConfig - Voice configuration
 * @returns {Promise<Object>} GCS path and duration
 */
async function generateSpeechWithTTS(text, jobId, assetId, voiceConfig = {}) {
  const request = {
    input: { text: text },
    voice: {
      languageCode: voiceConfig.languageCode || 'en-US',
      name: voiceConfig.name || 'en-US-Neural2-D',
      ssmlGender: voiceConfig.ssmlGender || 'MALE'
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: voiceConfig.speakingRate || 1.0,
      pitch: voiceConfig.pitch || 0
    }
  };

  const [response] = await ttsClient.synthesizeSpeech(request);
  const gcsPath = `jobs/${jobId}/assets/${assetId}.mp3`;
  
  // Upload to GCS
  await storage.bucket(config.bucketName).file(gcsPath).save(
    response.audioContent,
    { contentType: 'audio/mpeg' }
  );

  // Estimate duration (rough calculation based on text length and speaking rate)
  const wordsPerMinute = 150 * (voiceConfig.speakingRate || 1.0);
  const wordCount = text.split(/\s+/).length;
  const estimatedDuration = (wordCount / wordsPerMinute) * 60;

  return {
    gcsPath: `gs://${config.bucketName}/${gcsPath}`,
    duration: estimatedDuration
  };
}

/**
 * Search for stock video from Pexels
 * @param {string} query - Search query
 * @param {number} minDuration - Minimum video duration in seconds
 * @returns {Promise<Object>} Video metadata and URL
 */
async function searchPexelsVideo(query, minDuration = 5) {
  if (!config.pexelsApiKey) {
    throw new Error('PEXELS_API_KEY environment variable is not set');
  }

  const response = await axios.get('https://api.pexels.com/videos/search', {
    headers: { 'Authorization': config.pexelsApiKey },
    params: {
      query: query,
      per_page: 10,
      orientation: 'landscape',
      size: 'medium'
    }
  });

  // Filter videos by duration and find best match
  const videos = response.data.videos.filter(v => v.duration >= minDuration);
  
  if (videos.length === 0) {
    // Try without duration filter
    if (response.data.videos.length > 0) {
      const video = response.data.videos[0];
      const hdFile = video.video_files.find(f => f.quality === 'hd') || video.video_files[0];
      return {
        id: video.id,
        url: hdFile.link,
        duration: video.duration,
        width: hdFile.width,
        height: hdFile.height
      };
    }
    throw new Error(`No Pexels videos found for query: ${query}`);
  }

  const video = videos[0];
  const hdFile = video.video_files.find(f => f.quality === 'hd') || video.video_files[0];
  
  return {
    id: video.id,
    url: hdFile.link,
    duration: video.duration,
    width: hdFile.width,
    height: hdFile.height
  };
}

/**
 * Download Pexels video to GCS
 * @param {string} url - Video URL
 * @param {string} jobId - Job identifier
 * @param {string} assetId - Asset identifier
 * @returns {Promise<string>} GCS path
 */
async function downloadPexelsVideoToGCS(url, jobId, assetId) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const gcsPath = `jobs/${jobId}/assets/${assetId}.mp4`;
  
  await storage.bucket(config.bucketName).file(gcsPath).save(
    Buffer.from(response.data),
    { contentType: 'video/mp4' }
  );
  
  return `gs://${config.bucketName}/${gcsPath}`;
}

/**
 * Build EDL from generated script and assets
 * @param {Object} script - Generated script
 * @param {Object} assets - Generated assets
 * @param {Object} options - Output options
 * @returns {Object} EDL JSON
 */
function buildEDL(script, assets, options = {}) {
  const edl = {
    version: '1.0.0',
    metadata: {
      title: script.title,
      description: script.description,
      author: 'Hybrid Video Orchestrator',
      createdAt: new Date().toISOString(),
      outputSettings: {
        width: options.width || 1920,
        height: options.height || 1080,
        fps: options.fps || 30,
        format: options.format || 'mp4',
        codec: options.codec || 'h264',
        bitrate: options.bitrate || '8M',
        audioCodec: 'aac',
        audioBitrate: '192K'
      }
    },
    assets: assets,
    timeline: {
      duration: 0,
      tracks: [
        { id: 'video-main', type: 'video', name: 'Main Video', clips: [] },
        { id: 'audio-narration', type: 'audio', name: 'Narration', clips: [] }
      ]
    },
    renderSettings: {
      useGpu: options.useGpu !== false,
      preset: options.preset || 'medium',
      crf: options.crf || 23
    }
  };

  let currentTime = 0;

  for (const scene of script.scenes) {
    const visualAssetId = `visual_${scene.id}`;
    const audioAssetId = `audio_${scene.id}`;
    
    const visualAsset = assets[visualAssetId];
    const audioAsset = assets[audioAssetId];
    
    if (!visualAsset || !audioAsset) continue;

    const clipDuration = audioAsset.duration || scene.duration;

    // Add video/image clip
    const videoClip = {
      id: `clip_${scene.id}`,
      assetId: visualAssetId,
      startTime: currentTime,
      duration: clipDuration,
      effects: []
    };

    // Add Ken Burns effect for images
    if (visualAsset.type === 'generated-image' || visualAsset.type === 'image') {
      const kb = scene.effects?.kenBurns || { startZoom: 1.0, endZoom: 1.15 };
      videoClip.effects.push({
        type: 'ken-burns',
        params: {
          startZoom: kb.startZoom,
          endZoom: kb.endZoom,
          startX: kb.startX || 0,
          startY: kb.startY || 0,
          endX: kb.endX || 0,
          endY: kb.endY || 0,
          easing: 'ease-in-out'
        }
      });
    }

    // Add fade transitions
    if (currentTime > 0) {
      videoClip.transitions = {
        in: { type: 'dissolve', duration: 0.5 }
      };
    }

    edl.timeline.tracks[0].clips.push(videoClip);

    // Add audio clip
    edl.timeline.tracks[1].clips.push({
      id: `audio_clip_${scene.id}`,
      assetId: audioAssetId,
      startTime: currentTime,
      duration: clipDuration
    });

    currentTime += clipDuration;
  }

  edl.timeline.duration = currentTime;
  
  return edl;
}

/**
 * Dispatch render job to Cloud Run Jobs
 * @param {string} jobId - Job identifier
 * @param {string} edlPath - GCS path to EDL JSON
 * @returns {Promise<Object>} Job execution info
 */
async function dispatchRenderJob(jobId, edlPath) {
  const { JobsClient } = require('@google-cloud/run').v2;
  const client = new JobsClient();

  const request = {
    name: `projects/${config.projectId}/locations/${config.location}/jobs/${config.rendererJobName}`,
    overrides: {
      containerOverrides: [{
        env: [
          { name: 'JOB_ID', value: jobId },
          { name: 'EDL_PATH', value: edlPath },
          { name: 'GCS_BUCKET', value: config.bucketName }
        ]
      }]
    }
  };

  const [execution] = await client.runJob(request);
  return {
    executionName: execution.name,
    status: 'dispatched'
  };
}

/**
 * Main orchestration function
 * @param {Object} request - Video generation request
 * @returns {Promise<Object>} Job information
 */
async function orchestrateVideoGeneration(request) {
  const jobId = request.jobId || uuidv4();
  const topic = request.topic;
  const targetDuration = request.targetDuration || 120;
  const options = request.options || {};

  console.log(`[${jobId}] Starting video orchestration for topic: ${topic}`);

  // Step 1: Generate script with Gemini
  console.log(`[${jobId}] Generating script with Gemini...`);
  const script = await generateScriptWithGemini(topic, targetDuration);
  console.log(`[${jobId}] Generated ${script.scenes.length} scenes`);

  // Step 2: Generate all assets in parallel
  const assets = {};
  const assetPromises = [];

  for (const scene of script.scenes) {
    const visualAssetId = `visual_${scene.id}`;
    const audioAssetId = `audio_${scene.id}`;

    // Generate visual asset
    if (scene.visualType === 'image' && scene.imagePrompt) {
      assetPromises.push(
        generateImageWithImagen(scene.imagePrompt, jobId, visualAssetId)
          .then(gcsPath => {
            assets[visualAssetId] = {
              type: 'generated-image',
              source: gcsPath,
              prompt: scene.imagePrompt
            };
          })
          .catch(err => {
            console.error(`[${jobId}] Failed to generate image for ${visualAssetId}:`, err.message);
            // Fallback to Pexels video
            return searchPexelsVideo(scene.searchQuery || scene.visualDescription, scene.duration)
              .then(video => downloadPexelsVideoToGCS(video.url, jobId, visualAssetId))
              .then(gcsPath => {
                assets[visualAssetId] = {
                  type: 'pexels-video',
                  source: gcsPath,
                  searchQuery: scene.searchQuery || scene.visualDescription
                };
              });
          })
      );
    } else if (scene.visualType === 'video' && scene.searchQuery) {
      assetPromises.push(
        searchPexelsVideo(scene.searchQuery, scene.duration)
          .then(video => downloadPexelsVideoToGCS(video.url, jobId, visualAssetId))
          .then(gcsPath => {
            assets[visualAssetId] = {
              type: 'pexels-video',
              source: gcsPath,
              searchQuery: scene.searchQuery
            };
          })
      );
    }

    // Generate audio narration
    if (scene.narration) {
      assetPromises.push(
        generateSpeechWithTTS(scene.narration, jobId, audioAssetId, options.voice)
          .then(result => {
            assets[audioAssetId] = {
              type: 'generated-audio',
              source: result.gcsPath,
              duration: result.duration
            };
          })
      );
    }
  }

  // Wait for all assets to be generated
  console.log(`[${jobId}] Generating ${assetPromises.length} assets...`);
  await Promise.all(assetPromises);
  console.log(`[${jobId}] All assets generated`);

  // Step 3: Build EDL
  console.log(`[${jobId}] Building EDL...`);
  const edl = buildEDL(script, assets, options);

  // Step 4: Save EDL to GCS
  const edlPath = `jobs/${jobId}/edl.json`;
  await storage.bucket(config.bucketName).file(edlPath).save(
    JSON.stringify(edl, null, 2),
    { contentType: 'application/json' }
  );
  const edlGcsPath = `gs://${config.bucketName}/${edlPath}`;
  console.log(`[${jobId}] EDL saved to ${edlGcsPath}`);

  // Step 5: Dispatch render job
  console.log(`[${jobId}] Dispatching render job...`);
  let renderExecution = null;
  try {
    renderExecution = await dispatchRenderJob(jobId, edlGcsPath);
    console.log(`[${jobId}] Render job dispatched: ${renderExecution.executionName}`);
  } catch (err) {
    console.warn(`[${jobId}] Could not dispatch render job (Cloud Run Jobs may not be configured):`, err.message);
  }

  return {
    jobId: jobId,
    status: 'processing',
    edlPath: edlGcsPath,
    script: script,
    assetCount: Object.keys(assets).length,
    estimatedDuration: edl.timeline.duration,
    renderExecution: renderExecution
  };
}

// Express app setup
const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: 'hybrid-video-orchestrator' });
});

// Generate video endpoint
app.post('/generate', async (req, res) => {
  try {
    const { topic, targetDuration, options } = req.body;
    
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const result = await orchestrateVideoGeneration({
      topic,
      targetDuration,
      options
    });

    res.status(202).json(result);
  } catch (error) {
    console.error('Error generating video:', error);
    res.status(500).json({ 
      error: 'Failed to generate video',
      message: error.message 
    });
  }
});

// Get job status endpoint
app.get('/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const edlPath = `jobs/${jobId}/edl.json`;
    const outputPath = `jobs/${jobId}/output/final.mp4`;

    // Check if output exists
    const [outputExists] = await storage.bucket(config.bucketName).file(outputPath).exists();
    
    if (outputExists) {
      const [metadata] = await storage.bucket(config.bucketName).file(outputPath).getMetadata();
      return res.json({
        jobId,
        status: 'completed',
        outputPath: `gs://${config.bucketName}/${outputPath}`,
        completedAt: metadata.updated
      });
    }

    // Check if EDL exists
    const [edlExists] = await storage.bucket(config.bucketName).file(edlPath).exists();
    
    if (edlExists) {
      return res.json({
        jobId,
        status: 'rendering',
        edlPath: `gs://${config.bucketName}/${edlPath}`
      });
    }

    res.status(404).json({ error: 'Job not found' });
  } catch (error) {
    console.error('Error getting job status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate from custom EDL endpoint
app.post('/render', async (req, res) => {
  try {
    const { edl } = req.body;
    
    if (!edl || !edl.timeline) {
      return res.status(400).json({ error: 'Valid EDL is required' });
    }

    const jobId = uuidv4();
    const edlPath = `jobs/${jobId}/edl.json`;
    
    // Save EDL to GCS
    await storage.bucket(config.bucketName).file(edlPath).save(
      JSON.stringify(edl, null, 2),
      { contentType: 'application/json' }
    );
    
    const edlGcsPath = `gs://${config.bucketName}/${edlPath}`;

    // Dispatch render job
    const renderExecution = await dispatchRenderJob(jobId, edlGcsPath);

    res.status(202).json({
      jobId,
      status: 'rendering',
      edlPath: edlGcsPath,
      renderExecution
    });
  } catch (error) {
    console.error('Error starting render:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(config.port, () => {
  console.log(`Hybrid Video Orchestrator Controller listening on port ${config.port}`);
  console.log(`Project: ${config.projectId}, Location: ${config.location}`);
  console.log(`Storage Bucket: ${config.bucketName}`);
});

module.exports = { app, orchestrateVideoGeneration, buildEDL };
