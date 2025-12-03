/**
 * Tests for EDL Builder and Ken Burns effect generation
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { generateKenBurnsFilter } = require('../src/entrypoint.js');
const { buildEDL } = require('../src/controller.js');

describe('Ken Burns Effect Generation', () => {
  test('generates valid zoompan filter with linear easing', () => {
    const params = {
      startZoom: 1.0,
      endZoom: 1.2,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
      easing: 'linear'
    };
    const outputSettings = { width: 1920, height: 1080, fps: 30 };
    
    const filter = generateKenBurnsFilter(params, 10, outputSettings);
    
    assert.ok(filter.includes('zoompan'), 'Should include zoompan filter');
    assert.ok(filter.includes('1920x1080'), 'Should include output resolution');
    assert.ok(filter.includes('fps=30'), 'Should include fps setting');
  });

  test('generates valid zoompan filter with ease-in-out', () => {
    const params = {
      startZoom: 1.0,
      endZoom: 1.5,
      easing: 'ease-in-out'
    };
    const outputSettings = { width: 1920, height: 1080, fps: 30 };
    
    const filter = generateKenBurnsFilter(params, 5, outputSettings);
    
    assert.ok(filter.includes('zoompan'), 'Should include zoompan filter');
    assert.ok(filter.includes('cos'), 'Should include cosine for ease-in-out');
  });

  test('scales image for zoom headroom', () => {
    const params = {
      startZoom: 1.0,
      endZoom: 2.0
    };
    const outputSettings = { width: 1920, height: 1080, fps: 30 };
    
    const filter = generateKenBurnsFilter(params, 5, outputSettings);
    
    assert.ok(filter.includes('scale='), 'Should include scale filter');
    // The scale should be at least 2x the output for 2x zoom
    const scaleMatch = filter.match(/scale=(\d+):(\d+)/);
    assert.ok(scaleMatch, 'Should have scale dimensions');
    const scaleWidth = parseInt(scaleMatch[1]);
    assert.ok(scaleWidth >= 1920 * 2, 'Scale width should accommodate zoom');
  });
});

describe('EDL Builder', () => {
  test('builds valid EDL from script and assets', () => {
    const script = {
      title: 'Test Video',
      description: 'A test video',
      scenes: [
        {
          id: 'scene_1',
          duration: 10,
          narration: 'Welcome to the test',
          visualType: 'image',
          effects: { kenBurns: { startZoom: 1.0, endZoom: 1.2 } }
        },
        {
          id: 'scene_2',
          duration: 15,
          narration: 'This is scene two',
          visualType: 'video'
        }
      ]
    };

    const assets = {
      visual_scene_1: {
        type: 'generated-image',
        source: 'gs://bucket/image.png'
      },
      audio_scene_1: {
        type: 'generated-audio',
        source: 'gs://bucket/audio1.mp3',
        duration: 10
      },
      visual_scene_2: {
        type: 'pexels-video',
        source: 'gs://bucket/video.mp4'
      },
      audio_scene_2: {
        type: 'generated-audio',
        source: 'gs://bucket/audio2.mp3',
        duration: 15
      }
    };

    const edl = buildEDL(script, assets, { width: 1920, height: 1080 });

    assert.strictEqual(edl.version, '1.0.0', 'Should have correct version');
    assert.strictEqual(edl.metadata.title, 'Test Video', 'Should have correct title');
    assert.strictEqual(edl.metadata.outputSettings.width, 1920, 'Should have correct width');
    assert.strictEqual(edl.metadata.outputSettings.height, 1080, 'Should have correct height');
    assert.strictEqual(edl.timeline.tracks.length, 2, 'Should have 2 tracks');
    assert.strictEqual(edl.timeline.tracks[0].clips.length, 2, 'Should have 2 video clips');
    assert.strictEqual(edl.timeline.tracks[1].clips.length, 2, 'Should have 2 audio clips');
    assert.strictEqual(edl.timeline.duration, 25, 'Should have correct duration');
  });

  test('applies Ken Burns effect to image clips', () => {
    const script = {
      title: 'Ken Burns Test',
      description: 'Test Ken Burns effect',
      scenes: [
        {
          id: 'scene_1',
          duration: 10,
          narration: 'Test',
          visualType: 'image',
          effects: { kenBurns: { startZoom: 1.0, endZoom: 1.3 } }
        }
      ]
    };

    const assets = {
      visual_scene_1: {
        type: 'generated-image',
        source: 'gs://bucket/image.png'
      },
      audio_scene_1: {
        type: 'generated-audio',
        source: 'gs://bucket/audio.mp3',
        duration: 10
      }
    };

    const edl = buildEDL(script, assets);

    const videoClip = edl.timeline.tracks[0].clips[0];
    assert.ok(videoClip.effects, 'Should have effects');
    assert.ok(videoClip.effects.length > 0, 'Should have at least one effect');
    assert.strictEqual(videoClip.effects[0].type, 'ken-burns', 'Should have ken-burns effect');
    assert.strictEqual(videoClip.effects[0].params.startZoom, 1.0, 'Should have correct start zoom');
    assert.strictEqual(videoClip.effects[0].params.endZoom, 1.3, 'Should have correct end zoom');
  });

  test('adds transitions for non-first clips', () => {
    const script = {
      title: 'Transition Test',
      description: 'Test transitions',
      scenes: [
        { id: 'scene_1', duration: 5, narration: 'First', visualType: 'image' },
        { id: 'scene_2', duration: 5, narration: 'Second', visualType: 'image' }
      ]
    };

    const assets = {
      visual_scene_1: { type: 'generated-image', source: 'gs://bucket/1.png' },
      audio_scene_1: { type: 'generated-audio', source: 'gs://bucket/1.mp3', duration: 5 },
      visual_scene_2: { type: 'generated-image', source: 'gs://bucket/2.png' },
      audio_scene_2: { type: 'generated-audio', source: 'gs://bucket/2.mp3', duration: 5 }
    };

    const edl = buildEDL(script, assets);

    const firstClip = edl.timeline.tracks[0].clips[0];
    const secondClip = edl.timeline.tracks[0].clips[1];

    assert.ok(!firstClip.transitions, 'First clip should not have in transition');
    assert.ok(secondClip.transitions, 'Second clip should have transitions');
    assert.ok(secondClip.transitions.in, 'Second clip should have in transition');
    assert.strictEqual(secondClip.transitions.in.type, 'dissolve', 'Should use dissolve transition');
  });
});

describe('EDL Schema Validation', () => {
  test('schema file exists and is valid JSON', async () => {
    const fs = require('fs');
    const path = require('path');
    
    const schemaPath = path.join(__dirname, '../schema/edl-schema.json');
    assert.ok(fs.existsSync(schemaPath), 'Schema file should exist');
    
    const content = fs.readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(content);
    
    assert.ok(schema.$schema, 'Should have $schema property');
    assert.ok(schema.properties, 'Should have properties');
    assert.ok(schema.properties.version, 'Should have version property');
    assert.ok(schema.properties.metadata, 'Should have metadata property');
    assert.ok(schema.properties.timeline, 'Should have timeline property');
  });
});
