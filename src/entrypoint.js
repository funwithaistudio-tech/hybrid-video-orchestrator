/**
 * Hybrid Video Orchestrator - Renderer Entrypoint
 * 
 * Cloud Run Jobs entrypoint for FFmpeg video assembly.
 * Processes EDL (Edit Decision List) JSON and renders final video with:
 * - Ken Burns effects for images
 * - Transitions between clips
 * - Audio mixing
 * - GPU acceleration (when available)
 */

'use strict';

const { Storage } = require('@google-cloud/storage');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');

const execAsync = promisify(exec);
const mkdirAsync = promisify(fs.mkdir);
const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);
const readdirAsync = promisify(fs.readdir);

// Configuration from environment variables
const config = {
  jobId: process.env.JOB_ID,
  edlPath: process.env.EDL_PATH,
  bucketName: process.env.GCS_BUCKET || 'hybrid-video-assets',
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.PROJECT_ID,
  workDir: process.env.WORK_DIR || '/tmp/render',
  useGpu: process.env.USE_GPU === 'true',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe'
};

// Initialize GCS client
const storage = new Storage({ projectId: config.projectId });

/**
 * Download file from GCS to local filesystem
 * @param {string} gcsPath - GCS path (gs://bucket/path)
 * @param {string} localPath - Local file path
 */
async function downloadFromGCS(gcsPath, localPath) {
  const match = gcsPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid GCS path: ${gcsPath}`);
  }
  
  const [, bucketName, filePath] = match;
  await storage.bucket(bucketName).file(filePath).download({ destination: localPath });
  console.log(`Downloaded: ${gcsPath} -> ${localPath}`);
}

/**
 * Upload file to GCS
 * @param {string} localPath - Local file path
 * @param {string} gcsPath - GCS path (gs://bucket/path)
 */
async function uploadToGCS(localPath, gcsPath) {
  const match = gcsPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid GCS path: ${gcsPath}`);
  }
  
  const [, bucketName, filePath] = match;
  await storage.bucket(bucketName).file(filePath).upload(localPath);
  console.log(`Uploaded: ${localPath} -> ${gcsPath}`);
}

/**
 * Get media duration using ffprobe
 * @param {string} filePath - Path to media file
 * @returns {Promise<number>} Duration in seconds
 */
async function getMediaDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `${config.ffprobePath} -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`
    );
    return parseFloat(stdout.trim()) || 0;
  } catch (err) {
    console.warn(`Could not get duration for ${filePath}:`, err.message);
    return 0;
  }
}

/**
 * Generate Ken Burns effect filter for an image
 * @param {Object} params - Effect parameters
 * @param {number} duration - Clip duration
 * @param {Object} outputSettings - Output video settings
 * @returns {string} FFmpeg filter string
 */
function generateKenBurnsFilter(params, duration, outputSettings) {
  const {
    startZoom = 1.0,
    endZoom = 1.2,
    startX = 0,
    startY = 0,
    endX = 0,
    endY = 0,
    easing = 'linear'
  } = params;

  const fps = outputSettings.fps || 30;
  const width = outputSettings.width || 1920;
  const height = outputSettings.height || 1080;
  const totalFrames = Math.ceil(duration * fps);

  // Calculate zoom progression based on easing
  let zoomExpr;
  const zoomDiff = endZoom - startZoom;
  
  if (easing === 'ease-in-out') {
    // Smooth ease-in-out using sine
    zoomExpr = `${startZoom}+${zoomDiff}*(1-cos(PI*t/${duration}))/2`;
  } else if (easing === 'ease-in') {
    zoomExpr = `${startZoom}+${zoomDiff}*pow(t/${duration},2)`;
  } else if (easing === 'ease-out') {
    zoomExpr = `${startZoom}+${zoomDiff}*(1-pow(1-t/${duration},2))`;
  } else {
    // Linear
    zoomExpr = `${startZoom}+${zoomDiff}*t/${duration}`;
  }

  // Calculate pan positions
  const panXDiff = (endX - startX) * width / 2;
  const panYDiff = (endY - startY) * height / 2;
  
  let panXExpr, panYExpr;
  if (easing === 'ease-in-out') {
    panXExpr = `${startX * width / 2}+${panXDiff}*(1-cos(PI*t/${duration}))/2`;
    panYExpr = `${startY * height / 2}+${panYDiff}*(1-cos(PI*t/${duration}))/2`;
  } else {
    panXExpr = `${startX * width / 2}+${panXDiff}*t/${duration}`;
    panYExpr = `${startY * height / 2}+${panYDiff}*t/${duration}`;
  }

  // Build zoompan filter
  // Scale image to ensure we have enough resolution for zooming
  const maxZoom = Math.max(startZoom, endZoom);
  const scaleWidth = Math.ceil(width * maxZoom * 1.5);
  const scaleHeight = Math.ceil(height * maxZoom * 1.5);

  return `scale=${scaleWidth}:${scaleHeight},zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)+(${panXExpr})':y='ih/2-(ih/zoom/2)+(${panYExpr})':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
}

/**
 * Render a single clip to a temporary video file
 * @param {Object} clip - Clip definition from EDL
 * @param {Object} asset - Asset definition from EDL
 * @param {string} assetPath - Local path to asset file
 * @param {string} outputPath - Output video path
 * @param {Object} outputSettings - Output settings
 * @returns {Promise<void>}
 */
async function renderClip(clip, asset, assetPath, outputPath, outputSettings) {
  const duration = clip.duration;
  
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(assetPath);
    
    // Handle different asset types
    if (asset.type === 'generated-image' || asset.type === 'image') {
      // For images, we need to create video with duration
      cmd = cmd.loop(1).inputOptions(['-t', duration.toString()]);
      
      // Apply Ken Burns effect if present
      const kenBurnsEffect = clip.effects?.find(e => e.type === 'ken-burns');
      if (kenBurnsEffect) {
        const filter = generateKenBurnsFilter(kenBurnsEffect.params, duration, outputSettings);
        cmd = cmd.complexFilter([filter]);
      } else {
        // Simple scale and pad to output resolution
        cmd = cmd.complexFilter([
          `scale=${outputSettings.width}:${outputSettings.height}:force_original_aspect_ratio=decrease,` +
          `pad=${outputSettings.width}:${outputSettings.height}:(ow-iw)/2:(oh-ih)/2,` +
          `fps=${outputSettings.fps}`
        ]);
      }
    } else if (asset.type === 'pexels-video' || asset.type === 'video') {
      // For videos, trim and scale
      cmd = cmd
        .inputOptions(['-ss', (clip.inPoint || 0).toString()])
        .inputOptions(['-t', duration.toString()])
        .complexFilter([
          `scale=${outputSettings.width}:${outputSettings.height}:force_original_aspect_ratio=decrease,` +
          `pad=${outputSettings.width}:${outputSettings.height}:(ow-iw)/2:(oh-ih)/2,` +
          `fps=${outputSettings.fps}`
        ]);
    }

    // Apply transitions
    const videoFilters = [];
    
    if (clip.transitions?.in?.type === 'fade' || clip.transitions?.in?.type === 'dissolve') {
      const fadeDuration = clip.transitions.in.duration || 0.5;
      videoFilters.push(`fade=t=in:st=0:d=${fadeDuration}`);
    }
    
    if (clip.transitions?.out?.type === 'fade' || clip.transitions?.out?.type === 'dissolve') {
      const fadeDuration = clip.transitions.out.duration || 0.5;
      const fadeStart = duration - fadeDuration;
      videoFilters.push(`fade=t=out:st=${fadeStart}:d=${fadeDuration}`);
    }

    // Output settings
    cmd = cmd
      .outputOptions([
        '-c:v', outputSettings.codec === 'h265' ? 'libx265' : 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-an', // No audio for clip rendering
        '-y'
      ])
      .output(outputPath)
      .on('start', (cmdline) => {
        console.log(`Rendering clip: ${clip.id}`);
        console.log(`Command: ${cmdline}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`  Progress: ${progress.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => {
        console.log(`  Completed: ${clip.id}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`  Error rendering ${clip.id}:`, err.message);
        reject(err);
      });

    cmd.run();
  });
}

/**
 * Concatenate clips with transitions
 * @param {string[]} clipPaths - Paths to clip video files
 * @param {string} outputPath - Output path
 * @param {Object} outputSettings - Output settings
 * @returns {Promise<void>}
 */
async function concatenateClips(clipPaths, outputPath, outputSettings) {
  // Create concat file
  const concatFile = path.join(config.workDir, 'concat.txt');
  const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
  await writeFileAsync(concatFile, concatContent);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c:v', outputSettings.codec === 'h265' ? 'libx265' : 'libx264',
        '-preset', outputSettings.preset || 'medium',
        '-crf', (outputSettings.crf || 23).toString(),
        '-pix_fmt', 'yuv420p',
        '-an',
        '-y'
      ])
      .output(outputPath)
      .on('start', (cmdline) => {
        console.log('Concatenating clips...');
        console.log(`Command: ${cmdline}`);
      })
      .on('end', () => {
        console.log('Clips concatenated successfully');
        resolve();
      })
      .on('error', (err) => {
        console.error('Error concatenating clips:', err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Mix audio tracks
 * @param {Object[]} audioClips - Audio clip definitions
 * @param {Object} assets - Asset definitions
 * @param {string} outputPath - Output audio path
 * @param {number} totalDuration - Total timeline duration
 * @returns {Promise<void>}
 */
async function mixAudioTracks(audioClips, assets, outputPath, totalDuration) {
  if (audioClips.length === 0) {
    console.log('No audio clips to mix');
    return null;
  }

  // Build complex audio filter for mixing with delays
  const inputs = [];
  const filterParts = [];
  
  for (let i = 0; i < audioClips.length; i++) {
    const clip = audioClips[i];
    const asset = assets[clip.assetId];
    if (!asset) continue;

    const localPath = path.join(config.workDir, 'assets', `${clip.assetId}.mp3`);
    inputs.push(localPath);
    
    // Add delay based on clip start time
    const delayMs = Math.round(clip.startTime * 1000);
    filterParts.push(`[${i}]adelay=${delayMs}|${delayMs}[a${i}]`);
  }

  if (inputs.length === 0) {
    return null;
  }

  // Create amerge filter
  const mergeInputs = inputs.map((_, i) => `[a${i}]`).join('');
  filterParts.push(`${mergeInputs}amix=inputs=${inputs.length}:duration=longest[aout]`);

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();
    
    inputs.forEach(input => {
      cmd = cmd.input(input);
    });

    cmd
      .complexFilter(filterParts.join(';'), 'aout')
      .outputOptions([
        '-c:a', 'aac',
        '-b:a', '192k',
        '-y'
      ])
      .output(outputPath)
      .on('start', (cmdline) => {
        console.log('Mixing audio...');
        console.log(`Command: ${cmdline}`);
      })
      .on('end', () => {
        console.log('Audio mixed successfully');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('Error mixing audio:', err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Combine video and audio into final output
 * @param {string} videoPath - Path to video file
 * @param {string} audioPath - Path to audio file
 * @param {string} outputPath - Final output path
 * @param {Object} outputSettings - Output settings
 * @returns {Promise<void>}
 */
async function combineVideoAndAudio(videoPath, audioPath, outputPath, outputSettings) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg()
      .input(videoPath);

    if (audioPath) {
      cmd = cmd.input(audioPath);
    }

    cmd
      .outputOptions([
        '-c:v', 'copy',
        '-c:a', audioPath ? 'aac' : 'copy',
        '-b:a', outputSettings.audioBitrate || '192K',
        '-shortest',
        '-y'
      ])
      .output(outputPath)
      .on('start', (cmdline) => {
        console.log('Combining video and audio...');
        console.log(`Command: ${cmdline}`);
      })
      .on('end', () => {
        console.log('Final video created successfully');
        resolve();
      })
      .on('error', (err) => {
        console.error('Error combining video and audio:', err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Main render function
 * @param {Object} edl - Edit Decision List
 * @returns {Promise<string>} Path to rendered video
 */
async function render(edl) {
  const outputSettings = edl.metadata.outputSettings;
  const renderSettings = edl.renderSettings || {};
  
  // Create work directories
  const assetsDir = path.join(config.workDir, 'assets');
  const clipsDir = path.join(config.workDir, 'clips');
  const outputDir = path.join(config.workDir, 'output');
  
  await mkdirAsync(assetsDir, { recursive: true });
  await mkdirAsync(clipsDir, { recursive: true });
  await mkdirAsync(outputDir, { recursive: true });

  // Download all assets
  console.log('Downloading assets...');
  const assets = edl.assets || {};
  
  for (const [assetId, asset] of Object.entries(assets)) {
    if (asset.source && asset.source.startsWith('gs://')) {
      const ext = path.extname(asset.source) || 
        (asset.type.includes('image') ? '.png' : 
         asset.type.includes('audio') ? '.mp3' : '.mp4');
      const localPath = path.join(assetsDir, `${assetId}${ext}`);
      await downloadFromGCS(asset.source, localPath);
      asset._localPath = localPath;
    }
  }

  // Get video and audio tracks
  const videoTrack = edl.timeline.tracks.find(t => t.type === 'video');
  const audioTrack = edl.timeline.tracks.find(t => t.type === 'audio');

  // Render each video clip
  console.log('Rendering video clips...');
  const clipPaths = [];
  
  if (videoTrack) {
    for (let i = 0; i < videoTrack.clips.length; i++) {
      const clip = videoTrack.clips[i];
      const asset = assets[clip.assetId];
      
      if (!asset || !asset._localPath) {
        console.warn(`Skipping clip ${clip.id}: Asset not found`);
        continue;
      }

      const clipPath = path.join(clipsDir, `clip_${i.toString().padStart(4, '0')}.mp4`);
      await renderClip(clip, asset, asset._localPath, clipPath, outputSettings);
      clipPaths.push(clipPath);
    }
  }

  if (clipPaths.length === 0) {
    throw new Error('No clips were rendered');
  }

  // Concatenate clips
  const concatenatedPath = path.join(outputDir, 'video_only.mp4');
  await concatenateClips(clipPaths, concatenatedPath, outputSettings);

  // Mix audio
  let audioPath = null;
  if (audioTrack && audioTrack.clips.length > 0) {
    // Ensure audio assets have local paths
    for (const clip of audioTrack.clips) {
      const asset = assets[clip.assetId];
      if (asset && asset.source && !asset._localPath) {
        const ext = '.mp3';
        const localPath = path.join(assetsDir, `${clip.assetId}${ext}`);
        if (asset.source.startsWith('gs://')) {
          await downloadFromGCS(asset.source, localPath);
          asset._localPath = localPath;
        }
      }
    }
    
    audioPath = path.join(outputDir, 'audio_mixed.aac');
    try {
      await mixAudioTracks(audioTrack.clips, assets, audioPath, edl.timeline.duration);
    } catch (err) {
      console.warn('Audio mixing failed, continuing without audio:', err.message);
      audioPath = null;
    }
  }

  // Combine video and audio
  const finalPath = path.join(outputDir, 'final.mp4');
  await combineVideoAndAudio(concatenatedPath, audioPath, finalPath, outputSettings);

  return finalPath;
}

/**
 * Main entrypoint
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Hybrid Video Orchestrator - Renderer');
  console.log('='.repeat(60));
  console.log(`Job ID: ${config.jobId}`);
  console.log(`EDL Path: ${config.edlPath}`);
  console.log(`Work Directory: ${config.workDir}`);
  console.log(`GPU Enabled: ${config.useGpu}`);
  console.log('='.repeat(60));

  if (!config.edlPath) {
    console.error('EDL_PATH environment variable is required');
    process.exit(1);
  }

  try {
    // Create work directory
    await mkdirAsync(config.workDir, { recursive: true });

    // Download and parse EDL
    const edlLocalPath = path.join(config.workDir, 'edl.json');
    await downloadFromGCS(config.edlPath, edlLocalPath);
    
    const edlContent = fs.readFileSync(edlLocalPath, 'utf8');
    const edl = JSON.parse(edlContent);
    
    console.log(`Project: ${edl.metadata.title}`);
    console.log(`Duration: ${edl.timeline.duration}s`);
    console.log(`Output: ${edl.metadata.outputSettings.width}x${edl.metadata.outputSettings.height} @ ${edl.metadata.outputSettings.fps}fps`);

    // Render video
    const finalVideoPath = await render(edl);
    console.log(`Rendered video: ${finalVideoPath}`);

    // Upload final video to GCS
    const outputGcsPath = `gs://${config.bucketName}/jobs/${config.jobId}/output/final.mp4`;
    await uploadToGCS(finalVideoPath, outputGcsPath);
    
    console.log('='.repeat(60));
    console.log('Render completed successfully!');
    console.log(`Output: ${outputGcsPath}`);
    console.log('='.repeat(60));

    process.exit(0);
  } catch (error) {
    console.error('Render failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { render, generateKenBurnsFilter };
