// three.js stage renderer.
//
// The canvas is always rendered at the project's real pixel dimensions (so a
// recording is pixel-exact) and CSS-scaled to fit the viewport. Every glyph is
// its own mesh with its own material, which is what the effects animate.
//
// Any number of clips can be live at the same moment; each one runs its own
// effect over its own span, and the track index decides what sits in front.

import * as THREE from 'three';
import { layoutText, glyphGeometry, glyphOutline, pruneGeometryCache, orderFonts } from './typography.js';
import { applyEffect, resolveParams, clipStage, stageAt, stageU, clipLive, clipStyle } from './effects.js';
import { cameraAt, FOV, defaultCameraPosition, cameraKeyEntries } from './camera.js';
import { VIDEO_CHANNEL_KINDS } from './video/engine.js';
import { ParticleField, MAX_COLLIDERS } from './particles.js';
import { clamp } from './util.js';
import { backdropAt, clipColorAt, clipFont, clipWorldPosition } from './state.js';

const OVERLAY_FRAG = `
uniform float uVignette, uGrain, uTime;
varying vec2 vUv;
float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 d = vUv - 0.5;
  float v = smoothstep(0.40, 0.98, length(d) * 1.30) * uVignette;      // darken toward the edges
  float n = (rnd(vUv * 900.0 + floor(uTime * 24.0)) - 0.5) * uGrain;   // film grain, stable per frame
  float ga = abs(n);
  float a = clamp(v + ga, 0.0, 1.0);
  vec3 grainCol = n > 0.0 ? vec3(1.0) : vec3(0.0);
  vec3 col = (vec3(0.0) * v + grainCol * ga) / max(a, 1e-4);
  gl_FragColor = vec4(col, a);
}`;

const OVERLAY_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const BACKDROP_FRAG = `
uniform int uBackdropMode;
uniform vec3 uBackdropColorA, uBackdropColorB, uBackdropColorC, uBackdropColorD;
uniform float uBackdropAngle, uBackdropRadius;
uniform float uBackdropAspect;
uniform vec2 uBackdropCenter;
varying vec2 vUv;

void main() {
  // Work in top-left-oriented frame coordinates. Three's plane UVs run from
  // bottom to top, while the editor's gradient controls read like a canvas.
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  vec3 color;
  if (uBackdropMode == 1) {
    vec2 dir = vec2(cos(uBackdropAngle), sin(uBackdropAngle));
    float extent = max(0.0001, 0.5 * (abs(dir.x) + abs(dir.y)));
    float amount = 0.5 + dot(p - vec2(0.5), dir) / (2.0 * extent);
    color = mix(uBackdropColorA, uBackdropColorB, clamp(amount, 0.0, 1.0));
  } else if (uBackdropMode == 2) {
    vec2 delta = p - uBackdropCenter;
    delta.x *= uBackdropAspect;
    float amount = length(delta) / max(0.0001, uBackdropRadius);
    color = mix(uBackdropColorA, uBackdropColorB, clamp(amount, 0.0, 1.0));
  } else if (uBackdropMode == 3) {
    vec3 top = mix(uBackdropColorA, uBackdropColorB, p.x);
    vec3 bottom = mix(uBackdropColorC, uBackdropColorD, p.x);
    color = mix(top, bottom, p.y);
  } else {
    color = uBackdropColorA;
  }
  gl_FragColor = vec4(color, 1.0);
}`;

const BACKDROP_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// The mask is evaluated in framebuffer pixels rather than video UV space. A
// cover-fitted source can extend beyond the frame, but the mask should still
// describe the same rectangle or circle in the final composition.
const BACKDROP_MASK_GLSL = `
uniform int uBackdropMaskShape;
uniform vec4 uBackdropMaskRect;
uniform float uBackdropMaskBlur;
uniform vec2 uBackdropMaskResolution;

float backdropMaskDistance() {
  vec2 center = vec2(
    uBackdropMaskRect.x * uBackdropMaskResolution.x,
    (1.0 - uBackdropMaskRect.y) * uBackdropMaskResolution.y
  );
  vec2 delta = gl_FragCoord.xy - center;
  vec2 halfSize = 0.5 * vec2(
    uBackdropMaskRect.z * uBackdropMaskResolution.x,
    uBackdropMaskRect.w * uBackdropMaskResolution.y
  );

  if (uBackdropMaskShape == 2) {
    return length(delta) - min(halfSize.x, halfSize.y);
  }

  vec2 q = abs(delta) - halfSize;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
}

float backdropMaskAlpha() {
  if (uBackdropMaskShape == 0) return 1.0;
  float edgeDistance = backdropMaskDistance();
  float blur = max(0.0, uBackdropMaskBlur);
  if (blur < 0.5) return edgeDistance <= 0.0 ? 1.0 : 0.0;
  return 1.0 - smoothstep(-blur, blur, edgeDistance);
}
`;

function makeBackdropMaterial(texture) {
  const maskUniforms = {
    uBackdropMaskShape: { value: 0 },
    uBackdropMaskRect: { value: new THREE.Vector4(0.5, 0.5, 0.72, 0.72) },
    uBackdropMaskBlur: { value: 0 },
    uBackdropMaskResolution: { value: new THREE.Vector2(1, 1) }
  };
  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, opacity: 1,
    depthTest: false, depthWrite: false, toneMapped: false
  });
  material.userData.maskUniforms = maskUniforms;
  material.customProgramCacheKey = () => 'backdrop-mask-v1';
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, maskUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BACKDROP_MASK_GLSL}`)
      .replace('#include <opaque_fragment>',
        'diffuseColor.a *= backdropMaskAlpha();\n#include <opaque_fragment>');
  };
  return { material, maskUniforms };
}

function backdropClipList(lane) {
  if (Array.isArray(lane)) return lane;
  if (Array.isArray(lane?.clips)) return lane.clips;
  // Accept the original one-object-per-channel shape during migration.
  return lane?.name || lane?.duration ? [lane] : [];
}

function backdropTransitionOpacity(clip, local, duration) {
  let opacity = 1;
  const inDuration = clamp(Number(clip.inDuration) || 0, 0, duration);
  const outDuration = clamp(Number(clip.outDuration) || 0, 0, duration);
  if (clip.inEffect === 'fade' && inDuration > 0) {
    opacity *= clamp(local / inDuration, 0, 1);
  }
  // A looping source has no natural out point; its lane remains live until
  // the composition ends, so only non-looping clips receive an exit fade.
  if (clip.outEffect === 'fade' && outDuration > 0 && clip.loop !== true) {
    opacity *= clamp((duration - local) / outDuration, 0, 1);
  }
  return opacity;
}

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x08090c, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 40000);
    this.scene.add(this.camera);

    // Backdrop planes live on the output camera, so a video always fills the
    // rendered frame even while the authored camera pans, rolls, or changes
    // depth. They are closer than the clear colour and farther than text.
    this.backdropGroup = new THREE.Group();
    this.camera.add(this.backdropGroup);
    this.backdropColorMat = new THREE.ShaderMaterial({
      uniforms: {
        uBackdropMode: { value: 0 },
        uBackdropColorA: { value: new THREE.Color('#08090c') },
        uBackdropColorB: { value: new THREE.Color('#08090c') },
        uBackdropColorC: { value: new THREE.Color('#08090c') },
        uBackdropColorD: { value: new THREE.Color('#08090c') },
        uBackdropAngle: { value: 0 },
        uBackdropRadius: { value: 0.75 },
        uBackdropAspect: { value: 1 },
        uBackdropCenter: { value: new THREE.Vector2(0.5, 0.5) }
      },
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      depthTest: false, depthWrite: false, toneMapped: false
    });
    this.backdropColorPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backdropColorMat);
    this.backdropColorPlane.frustumCulled = false;
    this.backdropColorPlane.renderOrder = -1000;
    this.backdropGroup.add(this.backdropColorPlane);
    this.backdropMeshes = new Map();
    this.backdropRenderSize = new THREE.Vector2(1, 1);
    // Scratch vectors for the stage/world conversions the move control asks for.
    this._probe = new THREE.Vector3();
    this._origin = new THREE.Vector3();

    // The output camera is also an object in the editor scene. A second camera
    // looks at that scene from an oblique angle so the authored text planes,
    // camera frustum and their Z separation can be inspected together.
    this.editorCamera = new THREE.PerspectiveCamera(48, 1, 1, 100000);
    this.editorOrbit = {
      target: new THREE.Vector3(), yaw: 0.72, pitch: 0.48, distance: 2600
    };
    this.editorPointer = null;
    this.editorWorldSpan = 1080;
    this.mode = 'output';
    this.onPick = null;
    this.onPickCamera = null;
    this.onViewChange = null;

    this.editorHelpers = new THREE.Group();
    this.scene.add(this.editorHelpers);

    this.editorGrid = new THREE.GridHelper(2000, 20, 0x30405a, 0x182332);
    this.editorGrid.rotation.x = Math.PI / 2;
    this.editorGrid.material.transparent = true;
    this.editorGrid.material.opacity = 0.7;
    this.editorHelpers.add(this.editorGrid);

    this.editorAxes = new THREE.AxesHelper(500);
    this.editorHelpers.add(this.editorAxes);

    const frameMat = new THREE.LineBasicMaterial({ color: 0x6f87a8, transparent: true, opacity: 0.75, depthTest: false });
    this.editorFrame = new THREE.LineLoop(new THREE.BufferGeometry(), frameMat);
    this.editorHelpers.add(this.editorFrame);

    const frustumMat = new THREE.LineBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.95, depthTest: false });
    this.editorFrustum = new THREE.LineSegments(new THREE.BufferGeometry(), frustumMat);
    this.editorScreen = new THREE.LineLoop(new THREE.BufferGeometry(), frustumMat);
    this.editorHelpers.add(this.editorFrustum, this.editorScreen);

    const cameraMat = new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.9, depthTest: false });
    this.editorCameraBody = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cameraMat);
    this.editorHelpers.add(this.editorCameraBody);

    this.editorCameraPath = new THREE.Line(new THREE.BufferGeometry(), frustumMat);
    this.editorHelpers.add(this.editorCameraPath);
    this.editorCameraMarkers = new THREE.Group();
    this.editorHelpers.add(this.editorCameraMarkers);
    this.editorMarkerGeo = new THREE.SphereGeometry(1, 12, 8);
    this.editorMarkerMat = new THREE.MeshBasicMaterial({ color: 0x9b86d8, depthTest: false });
    this.editorMarkerSelectedMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    this.editorMarkerMeshes = new Map();

    this.editorSelection = new THREE.Box3Helper(new THREE.Box3(), new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false
    }));
    this.editorHelpers.add(this.editorSelection);

    // A small picture-in-picture of the actual output camera. It is rendered
    // in a separate screen-space scene, so it stays fixed over the 3D editor
    // while the authored scene can be orbited underneath it.
    this.previewTarget = new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false
    });
    this.previewTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.editorPreviewScene = new THREE.Scene();
    this.editorPreviewCamera = new THREE.OrthographicCamera(0, 1080, 1080, 0, 0.1, 100);
    this.editorPreviewCamera.position.z = 10;
    this.editorPreviewGroup = new THREE.Group();
    this.editorPreviewScene.add(this.editorPreviewGroup);
    this.editorPreviewPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this.previewTarget.texture, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false, toneMapped: false
    }));
    this.editorPreviewPlane.renderOrder = 1000;
    this.editorPreviewGroup.add(this.editorPreviewPlane);
    this.editorPreviewBorder = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: 0xc4b5fd, transparent: true, opacity: 0.95, depthTest: false
    }));
    this.editorPreviewBorder.renderOrder = 1001;
    this.editorPreviewGroup.add(this.editorPreviewBorder);
    this.editorPreviewLabel = this._makePreviewLabel();
    this.editorPreviewLabel.renderOrder = 1002;
    this.editorPreviewGroup.add(this.editorPreviewLabel);

    this._bindEditorControls();

    this.key = new THREE.DirectionalLight(0xffffff, 2.1);
    this.key.position.set(0.4, 0.8, 1);
    this.rim = new THREE.DirectionalLight(0x88bbff, 1.1);
    this.rim.position.set(-0.7, -0.3, 0.6);
    this.scene.add(this.key, this.rim, new THREE.AmbientLight(0xffffff, 0.85));

    this.overlayMat = new THREE.ShaderMaterial({
      uniforms: { uVignette: { value: 0.45 }, uGrain: { value: 0.06 }, uTime: { value: 0 } },
      vertexShader: OVERLAY_VERT, fragmentShader: OVERLAY_FRAG,
      transparent: true, depthTest: false, depthWrite: false
    });
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.overlayMat);
    this.overlay.position.z = -10;
    this.overlay.renderOrder = 999;
    this.overlay.frustumCulled = false;
    this.camera.add(this.overlay);

    // Particles live in the same world space as the glyphs, so the camera gives
    // them parallax and the outline colliders need no extra transform. Each
    // emitter gets its own field: that is what lets them differ in shape,
    // colour and blending without a per-particle material.
    this.particleFields = new Map();      // emitter.id → ParticleField
    this.colliderPoints = new Float32Array(MAX_COLLIDERS * 2);
    this.colliderVec = new THREE.Vector3();

    this.groups = new Map();      // clip.id → { key, group, glyphs, layout }
    this.W = 1080; this.H = 1080;
    this.setDesign(1080, 1080);
  }

  _makePreviewLabel() {
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256; labelCanvas.height = 48;
    const ctx = labelCanvas.getContext('2d');
    ctx.fillStyle = 'rgba(10, 12, 18, 0.92)';
    ctx.fillRect(0, 0, labelCanvas.width, labelCanvas.height);
    ctx.fillStyle = '#ddd6fe';
    ctx.font = '700 19px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('OUTPUT PREVIEW', 16, labelCanvas.height / 2);
    const texture = new THREE.CanvasTexture(labelCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false,
      toneMapped: false
    }));
    return sprite;
  }

  setDesign(w, h) {
    if (this.W === w && this.H === h && this._sized) return;
    const oldSpan = this.editorWorldSpan;
    const span = Math.max(w, h);
    this.W = w; this.H = h; this._sized = true;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.baseZ = defaultCameraPosition(w, h).z;
    this.camera.position.set(0, 0, this.baseZ);
    this.camera.updateProjectionMatrix();

    const oh = 2 * Math.tan((FOV / 2) * Math.PI / 180) * 10;
    this.overlay.scale.set(oh * this.camera.aspect, oh, 1);
    this.editorCamera.aspect = w / h;
    this.editorCamera.far = Math.max(100000, span * 20);
    this.editorCamera.updateProjectionMatrix();
    this.editorPreviewCamera.right = w;
    this.editorPreviewCamera.top = h;
    this.editorPreviewCamera.updateProjectionMatrix();
    if (this._sized && oldSpan > 0 && oldSpan !== span) this.editorOrbit.distance *= span / oldSpan;
    this.editorWorldSpan = span;
    const gridScale = span / 2000;
    this.editorGrid.scale.setScalar(gridScale);
    this.editorAxes.scale.setScalar(span / 1080);
    this._setLinePoints(this.editorFrame, [
      new THREE.Vector3(-w / 2, -h / 2, 0), new THREE.Vector3(w / 2, -h / 2, 0),
      new THREE.Vector3(w / 2, h / 2, 0), new THREE.Vector3(-w / 2, h / 2, 0)
    ]);
    const previewW = clamp(Math.min(w, h) * 0.34, 220, 420);
    const previewH = previewW * h / w;
    const previewGap = clamp(Math.min(w, h) * 0.035, 24, 56);
    this.editorPreviewGroup.position.set(
      w - previewGap - previewW / 2,
      h - previewGap - previewH / 2,
      0
    );
    this.editorPreviewPlane.scale.set(previewW, previewH, 1);
    this._setLinePoints(this.editorPreviewBorder, [
      new THREE.Vector3(-previewW / 2, -previewH / 2, 1),
      new THREE.Vector3(previewW / 2, -previewH / 2, 1),
      new THREE.Vector3(previewW / 2, previewH / 2, 1),
      new THREE.Vector3(-previewW / 2, previewH / 2, 1)
    ]);
    this.editorPreviewLabel.position.set(-previewW / 2 + 61, previewH / 2 + 17, 2);
    this.editorPreviewLabel.scale.set(122, 23, 1);
    const previewPxScale = 640 / Math.max(w, h);
    const previewPxW = Math.max(1, Math.round(w * previewPxScale));
    const previewPxH = Math.max(1, Math.round(h * previewPxScale));
    this.previewTarget.setSize(previewPxW, previewPxH);
    this._updateEditorCamera();
    this.invalidate();
  }

  setBackground(hex) { this.renderer.setClearColor(new THREE.Color(hex), 1); }

  _updateBackdropColor(project, time, frameDistance, frameW, frameH) {
    const value = backdropAt(project, time);
    const mode = value.mode === 'linear' ? 1 : value.mode === 'radial' ? 2 : value.mode === 'four-point' ? 3 : 0;
    const uniforms = this.backdropColorMat.uniforms;
    uniforms.uBackdropMode.value = mode;
    uniforms.uBackdropColorA.value.set(value.colors[0]);
    uniforms.uBackdropColorB.value.set(value.colors[1]);
    uniforms.uBackdropColorC.value.set(value.colors[2]);
    uniforms.uBackdropColorD.value.set(value.colors[3]);
    uniforms.uBackdropAngle.value = (Number(value.angle) || 0) * Math.PI / 180;
    uniforms.uBackdropRadius.value = Number(value.radius) || 0.75;
    uniforms.uBackdropAspect.value = Math.max(0.0001, Number(frameW) / Math.max(0.0001, Number(frameH)));
    uniforms.uBackdropCenter.value.set(
      Number.isFinite(Number(value.center?.x)) ? Number(value.center.x) : 0.5,
      Number.isFinite(Number(value.center?.y)) ? Number(value.center.y) : 0.5
    );

    this.backdropColorPlane.position.set(0, 0, -frameDistance - 1);
    this.backdropColorPlane.scale.set(frameW, frameH, 1);
    this.backdropColorPlane.visible = true;
  }

  _disposeBackdrop(id) {
    const rec = this.backdropMeshes.get(id);
    if (!rec) return;
    this.backdropGroup.remove(rec.plane);
    rec.plane.geometry.dispose();
    rec.plane.material.map?.dispose();
    rec.plane.material.dispose();
    this.backdropMeshes.delete(id);
  }

  _setBackdropResolution(width, height) {
    for (const rec of this.backdropMeshes.values()) {
      rec.maskUniforms?.uBackdropMaskResolution.value.set(width, height);
    }
  }

  _setBackdropMask(rec, settings, width, height) {
    const mask = settings.mask ?? {};
    const shape = mask.shape === 'rectangle' ? 1 : mask.shape === 'circle' ? 2 : 0;
    const x = clamp(Number.isFinite(Number(mask.x)) ? Number(mask.x) : 0.5, 0, 1);
    const y = clamp(Number.isFinite(Number(mask.y)) ? Number(mask.y) : 0.5, 0, 1);
    const w = clamp(Number.isFinite(Number(mask.width)) ? Number(mask.width) : 0.72, 0.02, 2);
    const h = clamp(Number.isFinite(Number(mask.height)) ? Number(mask.height) : 0.72, 0.02, 2);
    const blur = clamp(Number.isFinite(Number(mask.blur)) ? Number(mask.blur) : 0, 0, 1000);
    const uniforms = rec.maskUniforms;
    uniforms.uBackdropMaskShape.value = shape;
    uniforms.uBackdropMaskRect.value.set(x, y, w, h);
    uniforms.uBackdropMaskBlur.value = blur;
    uniforms.uBackdropMaskResolution.value.set(width, height);
  }

  /** Update camera-facing planes for every visual clip in the backdrop lanes. */
  _updateBackdrops(project, videos, time, resolution = null) {
    // The camera is at positive Z in the normal framing. Keep the plane a
    // little behind the authored scene (world Z < 0), then size it for its
    // actual camera-space distance; a fixed local -10 would otherwise land in
    // front of the text because the output camera sits around Z 1483.
    const frameDistance = Math.max(20, Math.abs(this.camera.position.z) + 100);
    const frameH = 2 * Math.tan((FOV / 2) * Math.PI / 180) * frameDistance;
    const frameW = frameH * (project.width / project.height);
    this._updateBackdropColor(project, time, frameDistance, frameW, frameH);
    const frameAspect = project.width / project.height;
    const renderSize = resolution ?? this.renderer.getDrawingBufferSize(this.backdropRenderSize);
    this._setBackdropResolution(renderSize.x, renderSize.y);
    const active = new Set();

    for (let index = 0; index < VIDEO_CHANNEL_KINDS.length; index++) {
      const meta = VIDEO_CHANNEL_KINDS[index];
      const lane = videos?.channels?.[meta.kind] ?? videos?.[meta.kind] ?? null;
      const clips = backdropClipList(lane);
      for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
        const settings = clips[clipIndex];
        const clipId = settings?.id ?? `${meta.kind}:${clipIndex}`;
        const runtime = videos?.runtime?.get?.(clipId) ?? videos?.get?.(clipId) ??
          (clipIndex === 0 ? (videos?.runtime?.get?.(meta.kind) ?? videos?.get?.(meta.kind)) : null);
        const source = runtime?.video ?? settings?.video ?? null;
        if (!settings || !source || settings.ready === false || settings.visible === false ||
            Number(settings.opacity) <= 0) continue;

        const sourceDuration = Number.isFinite(source.duration) && source.duration > 0
          ? source.duration : Number(settings.duration) || 0;
        if (!sourceDuration) continue;
        const local = time - (Number(settings.start) || 0);
        const looping = settings.loop === true;
        const activeNow = local >= 0 && (looping || local < sourceDuration);
        if (!activeNow) continue;
        const transition = backdropTransitionOpacity(settings, local, sourceDuration);
        const opacity = clamp(Number(settings.opacity) || 0, 0, 1) * transition;
        if (opacity <= 0.001) continue;

        active.add(clipId);
        let rec = this.backdropMeshes.get(clipId);
        if (rec?.video !== source) {
          this._disposeBackdrop(clipId);
          const texture = new THREE.VideoTexture(source);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          const { material, maskUniforms } = makeBackdropMaterial(texture);
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
          plane.frustumCulled = false;
          this.backdropGroup.add(plane);
          rec = { video: source, plane, maskUniforms };
          this.backdropMeshes.set(clipId, rec);
        }

        const sourceW = source.videoWidth || project.width;
        const sourceH = source.videoHeight || project.height;
        const sourceAspect = sourceW / Math.max(1, sourceH);
        let w = frameW, h = frameH;
        if (settings.fit === 'cover') {
          if (sourceAspect >= frameAspect) w = frameH * sourceAspect;
          else h = frameW / sourceAspect;
        } else if (settings.fit === 'contain') {
          if (sourceAspect >= frameAspect) h = frameW / sourceAspect;
          else w = frameH * sourceAspect;
        }
        // Channel order is V1 back → V3 front; later clips in one channel
        // sit above earlier clips, which also makes fades cross-dissolve.
        rec.plane.position.set(0, 0, -frameDistance - index * 0.02 - clipIndex * 0.0001);
        rec.plane.scale.set(w, h, 1);
        rec.plane.renderOrder = index * 100 + clipIndex;
        rec.plane.material.opacity = opacity;
        this._setBackdropMask(rec, settings, renderSize.x, renderSize.y);
        rec.plane.visible = true;
      }
    }

    for (const [id, rec] of this.backdropMeshes) {
      if (!active.has(id)) this._disposeBackdrop(id);
    }
  }

  /** Force every clip group to be rebuilt on the next frame. */
  invalidate() { for (const g of this.groups.values()) g.key = ''; }

  /**
   * The laid-out text block of one clip in world units, ignoring whatever the
   * effect is doing to the glyphs this frame — it describes where the layer is
   * placed, not where its letters happen to have flown.
   */
  clipBounds(id) {
    const rec = this.groups.get(id);
    return rec ? { width: rec.layout.width, height: rec.layout.height } : null;
  }

  /**
   * Where a world point lands on the stage, in canvas CSS pixels.
   * Null once the point is behind the output camera.
   */
  stagePoint(x, y, z) {
    const v = this._probe.set(x, y, z).project(this.camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z > 1) return null;
    const w = this.canvas.clientWidth || this.W;
    const h = this.canvas.clientHeight || this.H;
    return { x: (v.x * 0.5 + 0.5) * w, y: (0.5 - v.y * 0.5) * h };
  }

  /** The world point on the plane z = depth that a stage pixel points at. */
  stageToWorld(px, py, depth = 0) {
    const w = Math.max(1, this.canvas.clientWidth || this.W);
    const h = Math.max(1, this.canvas.clientHeight || this.H);
    const dir = this._probe.set((px / w) * 2 - 1, -(py / h) * 2 + 1, 0.5).unproject(this.camera);
    const origin = this.camera.getWorldPosition(this._origin);
    dir.sub(origin);
    if (Math.abs(dir.z) < 1e-6) return null;         // looking along the plane
    const k = (depth - origin.z) / dir.z;
    if (!(k > 0)) return null;                       // the plane is behind the camera
    return { x: origin.x + dir.x * k, y: origin.y + dir.y * k };
  }

  _setLinePoints(line, points) {
    const attr = line.geometry.getAttribute('position');
    if (!attr || attr.count !== points.length) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry();
      line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(points.length * 3), 3));
      line.frustumCulled = false;
    }
    const out = line.geometry.getAttribute('position');
    points.forEach((p, i) => out.setXYZ(i, p.x, p.y, p.z));
    out.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  _updateEditorCamera() {
    const o = this.editorOrbit;
    const cp = Math.cos(o.pitch);
    this.editorCamera.position.set(
      o.target.x + o.distance * cp * Math.sin(o.yaw),
      o.target.y + o.distance * Math.sin(o.pitch),
      o.target.z + o.distance * cp * Math.cos(o.yaw)
    );
    this.editorCamera.lookAt(o.target);
  }

  _editorPointerPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _panEditor(dx, dy) {
    const scale = this.editorOrbit.distance * Math.tan((this.editorCamera.fov / 2) * Math.PI / 180) * 2 /
      Math.max(1, this.canvas.clientHeight || this.H);
    const right = new THREE.Vector3().setFromMatrixColumn(this.editorCamera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.editorCamera.matrixWorld, 1);
    this.editorOrbit.target.addScaledVector(right, -dx * scale);
    this.editorOrbit.target.addScaledVector(up, dy * scale);
  }

  _bindEditorControls() {
    this.canvas.addEventListener('pointerdown', e => {
      if (this.mode !== 'space' || e.button > 2) return;
      const p = this._editorPointerPos(e);
      this.editorPointer = {
        x: p.x, y: p.y, startX: p.x, startY: p.y,
        button: e.button, moved: false, pan: e.shiftKey || e.button !== 0
      };
      this.canvas.style.cursor = 'grabbing';
      this.canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    this.canvas.addEventListener('pointermove', e => {
      const d = this.editorPointer;
      if (this.mode !== 'space' || !d) return;
      const p = this._editorPointerPos(e);
      const dx = p.x - d.x, dy = p.y - d.y;
      if (Math.abs(p.x - d.startX) + Math.abs(p.y - d.startY) > 4) d.moved = true;
      d.x = p.x; d.y = p.y;
      if (d.pan || e.shiftKey) {
        this._panEditor(dx, dy);
      } else {
        this.editorOrbit.yaw -= dx * 0.008;
        this.editorOrbit.pitch = clamp(this.editorOrbit.pitch - dy * 0.006, -1.35, 1.35);
      }
      this._updateEditorCamera();
      this.onViewChange?.();
    });

    window.addEventListener('pointerup', e => {
      const d = this.editorPointer;
      if (!d) return;
      this.editorPointer = null;
      this.canvas.style.cursor = this.mode === 'space' ? 'grab' : 'default';
      if (this.mode !== 'space' || d.moved || d.button !== 0) return;
      const p = this._editorPointerPos(e);
      this._pickEditor(p.x, p.y);
    });

    this.canvas.addEventListener('wheel', e => {
      if (this.mode !== 'space') return;
      e.preventDefault();
      const min = Math.max(120, this.editorWorldSpan * 0.12);
      const max = Math.max(5000, this.editorWorldSpan * 30);
      this.editorOrbit.distance = clamp(
        this.editorOrbit.distance * Math.exp(e.deltaY * 0.001), min, max
      );
      this._updateEditorCamera();
      this.onViewChange?.();
    }, { passive: false });
  }

  _pickEditor(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const nx = (x / Math.max(1, r.width)) * 2 - 1;
    const ny = -(y / Math.max(1, r.height)) * 2 + 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera({ x: nx, y: ny }, this.editorCamera);
    const roots = [...this.groups.values()].filter(rec => rec.group.visible).map(rec => rec.group);
    roots.push(this.editorCameraMarkers);
    const hit = ray.intersectObjects(roots, true).find(x =>
      x.object.userData.clipId || x.object.userData.cameraKeyId
    );
    if (hit?.object.userData.clipId) this.onPick?.(hit.object.userData.clipId);
    else if (hit?.object.userData.cameraKeyId) {
      this.onPickCamera?.(hit.object.userData.cameraKeyId, hit.object.userData.cameraAxis ?? null);
    }
  }

  _updateEditorCameraScene(cam, project, selection) {
    const p = cam.position;
    // Draw the frustum at a fixed depth so its size stays constant as the
    // camera dollies forward or back, instead of collapsing onto the z=0 plane.
    const dist = defaultCameraPosition(project.width, project.height).z;
    const screenZ = p.z - dist;
    const halfH = dist * Math.tan((FOV / 2) * Math.PI / 180);
    const halfW = halfH * (project.width / project.height);
    const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
    const corner = (x, y) => new THREE.Vector3(
      p.x + x * cr - y * sr, p.y + x * sr + y * cr, screenZ
    );
    const corners = [corner(-halfW, -halfH), corner(halfW, -halfH),
      corner(halfW, halfH), corner(-halfW, halfH)];
    const frustumPoints = [];
    for (const c of corners) { frustumPoints.push(p, c); }
    frustumPoints.push(corners[0], corners[1], corners[1], corners[2],
      corners[2], corners[3], corners[3], corners[0]);
    this._setLinePoints(this.editorFrustum, frustumPoints);
    this._setLinePoints(this.editorScreen, corners);

    const bodySize = clamp(Math.min(project.width, project.height) * 0.055, 28, 96);
    this.editorCameraBody.position.copy(p);
    this.editorCameraBody.rotation.set(0, 0, cam.roll);
    this.editorCameraBody.scale.set(bodySize * 0.82, bodySize * 0.58, bodySize);

    const keys = cameraKeyEntries(project.camera, project.width, project.height);
    const points = keys.map(k => new THREE.Vector3(k.position.x, k.position.y, k.position.z));
    this.editorCameraPath.visible = points.length > 1;
    if (points.length > 1) this._setLinePoints(this.editorCameraPath, points);

    const activeMarkers = new Set();
    const markerSize = clamp(this.editorWorldSpan * 0.014, 10, 30);
    for (const key of keys) {
      activeMarkers.add(key.id);
      let marker = this.editorMarkerMeshes.get(key.id);
      if (!marker) {
        marker = new THREE.Mesh(this.editorMarkerGeo, this.editorMarkerMat);
        marker.userData.cameraKeyId = key.id;
        marker.userData.cameraAxis = key.axis;
        this.editorCameraMarkers.add(marker);
        this.editorMarkerMeshes.set(key.id, marker);
      }
      marker.position.set(key.position.x, key.position.y, key.position.z);
      marker.scale.setScalar(markerSize);
      marker.material = selection?.type === 'camkey' && selection.id === key.id &&
                        (selection.axis ?? null) === (key.axis ?? null)
        ? this.editorMarkerSelectedMat : this.editorMarkerMat;
    }
    for (const [id, marker] of this.editorMarkerMeshes) {
      marker.visible = activeMarkers.has(id);
      if (!marker.visible) { this.editorCameraMarkers.remove(marker); this.editorMarkerMeshes.delete(id); }
    }
  }

  _renderOutputPreview({ time, project, beats, draw }) {
    const helpersVisible = this.editorHelpers.visible;
    const overlayVisible = this.overlay.visible;
    const selectionVisible = this.editorSelection.visible;

    // The preview is the same scene/camera as Output mode. Temporarily hide
    // editor-only geometry so the texture contains only the final composite.
    this.editorHelpers.visible = false;
    this.overlay.visible = true;
    this.editorSelection.visible = false;
    for (const clip of draw) {
      const rec = this.groups.get(clip.id);
      if (!rec) continue;
      const pos = clipWorldPosition(clip) ?? clip.position ?? { x: 0, y: 0, z: 0 };
      rec.group.position.set(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0);
      rec.group.renderOrder = 10 - clip.track;
      const active = clipLive(clip, time, project);
      rec.group.visible = active;
      this._applyClip(rec, clip, project, time, beats, active, 1);
    }

    const previousTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.previewTarget);
    this._setBackdropResolution(this.previewTarget.width, this.previewTarget.height);
    // Point sprites are sized in the target's pixels, not the stage's.
    for (const field of this.particleFields.values()) field.setProjection(FOV, this.previewTarget.height);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(previousTarget);
    for (const field of this.particleFields.values()) field.setProjection(this.editorCamera.fov, this.H);
    const mainSize = this.renderer.getDrawingBufferSize(this.backdropRenderSize);
    this._setBackdropResolution(mainSize.x, mainSize.y);

    // Put the editor scene back exactly as it was before the offscreen pass.
    this.editorHelpers.visible = helpersVisible;
    this.overlay.visible = overlayVisible;
    this.editorSelection.visible = selectionVisible;
    for (const clip of draw) {
      const rec = this.groups.get(clip.id);
      if (!rec) continue;
      const pos = clipWorldPosition(clip) ?? clip.position ?? { x: 0, y: 0, z: 0 };
      rec.group.position.set(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0);
      rec.group.renderOrder = 10 - clip.track;
      const active = clipLive(clip, time, project);
      rec.group.visible = true;
      this._applyClip(rec, clip, project, time, beats, active, active ? 1 : 0.2);
    }
  }

  dispose() {
    for (const id of [...this.groups.keys()]) this._destroy(id);
    for (const id of [...this.backdropMeshes.keys()]) this._disposeBackdrop(id);
    for (const id of [...this.particleFields.keys()]) this._destroyField(id);
    this.backdropColorPlane.geometry.dispose();
    this.backdropColorMat.dispose();
    this.previewTarget.dispose();
    this.renderer.dispose();
  }

  _destroy(id) {
    const rec = this.groups.get(id);
    if (!rec) return;
    for (const gl of rec.glyphs) gl.mesh.material.dispose();
    this.scene.remove(rec.group);
    this.groups.delete(id);
  }

  _clipKey(clip, project, fonts) {
    const s = clipStyle(clip, project);
    return [fonts.map(f => f.__id).join(','), clip.text, s.size, s.lineHeight,
            s.tracking, s.align, s.color, project.depth,
            project.width, project.height].join('|');
  }

  _group(clip, project, fonts) {
    const key = this._clipKey(clip, project, fonts);
    const cur = this.groups.get(clip.id);
    if (cur && cur.key === key) return cur;
    if (cur) this._destroy(clip.id);

    const style = clipStyle(clip, project);
    const group = new THREE.Group();
    group.userData.clipId = clip.id;
    const glyphs = [];
    const sizePx = Math.max(4, style.size * Math.min(project.width, project.height));
    const depth = project.depth || 0;
    const layout = layoutText(fonts, clip.text, sizePx, {
      lineHeight: style.lineHeight, tracking: style.tracking, align: style.align
    });

    for (const item of layout.items) {
      if (item.blank) continue;
      const geo = glyphGeometry(item.font, item.glyph, sizePx, depth);
      if (!geo.geometry) continue;
      const material = depth > 0
        ? new THREE.MeshStandardMaterial({ color: style.color, roughness: 0.42, metalness: 0.08, transparent: true })
        // depthFunc LessDepth rejects coplanar re-draws, so overlapping strokes
        // inside one glyph never double-blend while the glyph fades.
        : new THREE.MeshBasicMaterial({
            color: style.color, transparent: true, side: THREE.DoubleSide,
            depthWrite: true, depthFunc: THREE.LessDepth
          });
      const mesh = new THREE.Mesh(geo.geometry, material);
      mesh.userData.clipId = clip.id;
      mesh.frustumCulled = false;
      const base = { x: item.x + geo.center.x, y: item.y + geo.center.y };
      mesh.position.set(base.x, base.y, 0);
      group.add(mesh);
      glyphs.push({
        mesh, material, base, index: glyphs.length, char: item.char,
        outline: glyphOutline(item.font, item.glyph, sizePx, geo.center)
      });
    }

    this.scene.add(group);
    const rec = { key, group, glyphs, layout, sizePx };
    this.groups.set(clip.id, rec);
    pruneGeometryCache();
    return rec;
  }

  /**
   * Outline samples of every glyph currently on screen, in world space and with
   * this frame's effect transforms already applied. That is what the particles
   * collide with, cling to or shed from.
   * @returns {{points: Float32Array, count: number}|null}
   */
  _collectOutlines(activeClips) {
    const buf = this.colliderPoints;
    const max = buf.length >> 1;
    const v = this.colliderVec;
    let n = 0;
    for (const clip of activeClips) {
      const rec = this.groups.get(clip.id);
      if (!rec || !rec.group.visible) continue;
      rec.group.updateMatrixWorld(true);
      for (const gl of rec.glyphs) {
        const pts = gl.outline;
        if (!gl.mesh.visible || !pts?.length) continue;
        const m = gl.mesh.matrixWorld;
        for (let k = 0; k < pts.length && n < max; k += 2) {
          v.set(pts[k], pts[k + 1], 0).applyMatrix4(m);
          buf[n * 2] = v.x;
          buf[n * 2 + 1] = v.y;
          n++;
        }
        if (n >= max) break;
      }
      if (n >= max) break;
    }
    return n ? { points: buf, count: n } : null;
  }

  _destroyField(id) {
    const field = this.particleFields.get(id);
    if (!field) return;
    this.scene.remove(field.points);
    field.dispose();
    this.particleFields.delete(id);
  }

  _field(id) {
    let field = this.particleFields.get(id);
    if (!field) {
      field = new ParticleField();
      this.scene.add(field.points);
      this.particleFields.set(id, field);
    }
    return field;
  }

  /** Run every emitter for this frame, sharing one pass over the glyph outlines. */
  _updateParticles(project, time, beats, active, fovDeg) {
    const emitters = project.particles?.emitters ?? [];

    const live = new Set(emitters.map(e => e.id));
    for (const id of [...this.particleFields.keys()]) if (!live.has(id)) this._destroyField(id);
    if (!emitters.length) return;

    const readsText = emitters.some(e =>
      e.on && (e.textMode !== 'none' || e.origin === 'outline'));
    const colliders = readsText ? this._collectOutlines(active) : null;

    for (const settings of emitters) {
      // A muted emitter keeps no buffers: its field is released until it is
      // switched back on.
      if (!settings.on) { this._destroyField(settings.id); continue; }
      const field = this._field(settings.id);
      field.setProjection(fovDeg, this.H);
      field.update({ time, project, settings, colliders, beats });
    }
  }

  _applyClip(rec, clip, project, time, beats, animate = true, opacityScale = 1) {
    const react = clamp(clip.beatReact ?? 0, 0, 1);
    let sinceBeat = 999, beatIndex = -1;
    if (beats?.length) {
      for (let i = beats.length - 1; i >= 0; i--) {
        if (beats[i] <= time) { sinceBeat = time - beats[i]; beatIndex = i; break; }
      }
    }
    const pulse = animate && beats?.length ? Math.exp(-sinceBeat * 9) * react : 0;
    const dur = Math.max(1e-4, clip.end - clip.start);
    // One stage is live at a time: it hands its own effect the slice of that
    // effect's arc the stage stands for, stretched over the stage's length.
    const at = stageAt(clip, time);
    const stage = clipStage(clip, at.key);
    const u = animate ? stageU(stage.effect, at.key, at.local) : 0.5;
    const p = resolveParams(stage.effect, stage.params);
    const n = rec.glyphs.length;
    const c = {
      i: 0, n, u, t: animate ? time - clip.start : dur * 0.5, time, pulse, react,
      sinceBeat, beatIndex, p, W: project.width, H: project.height, size: rec.sizePx,
      stage: at.key, clip
    };
    const color = clipColorAt(clip, project, time);

    for (let i = 0; i < n; i++) {
      const gl = rec.glyphs[i];
      const g = {
        x: gl.base.x, y: gl.base.y, z: 0,
        rx: 0, ry: 0, rz: 0,
        sx: 1, sy: 1, sz: 1,
        opacity: 1
      };
      c.i = i;
      if (animate) applyEffect(stage.effect, g, c);

      gl.material.color.set(color);
      gl.mesh.position.set(g.x, g.y, g.z);
      gl.mesh.rotation.set(g.rx, g.ry, g.rz);
      gl.mesh.scale.set(g.sx || 1e-4, g.sy || 1e-4, g.sz || 1e-4);
      const o = clamp(g.opacity * opacityScale, 0, 1);
      gl.material.opacity = o;
      gl.mesh.visible = o > 0.002;
    }
  }

  /**
   * @param {object} ctx { time, project, clips, fonts, videos, beats, mode, selection }
   * The camera track reframes everything at once in output mode. Space mode
   * keeps the same animated glyph transforms but looks at them with an editor
   * camera, leaving the authored camera and every text layer visible together.
   * @returns {{ live: number, glyphs: number }|null}
   */
  render({ time, project, clips, fonts, videos, beats, mode = 'output', selection = null }) {
    this.mode = mode === 'space' ? 'space' : 'output';
    this.setDesign(project.width, project.height);
    this.setBackground(project.bg);
    this.overlayMat.uniforms.uVignette.value = project.vignette;
    this.overlayMat.uniforms.uGrain.value = project.grain;
    this.overlayMat.uniforms.uTime.value = time;

    const lit = (project.depth || 0) > 0;
    this.key.visible = this.rim.visible = lit;

    const cam = cameraAt(project.camera, time, { width: project.width, height: project.height });
    this.camera.position.set(cam.position.x, cam.position.y, cam.position.z);
    this.camera.rotation.set(0, 0, cam.roll);
    const far = Math.max(40000, Math.abs(cam.position.z) * 4, project.width * 20, project.height * 20);
    if (this.camera.far !== far) { this.camera.far = far; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld(true);
    this._updateBackdrops(project, videos, time);

    const inSpace = this.mode === 'space';
    this.canvas.style.cursor = inSpace ? 'grab' : 'default';
    this.overlay.visible = !inSpace;
    this.editorHelpers.visible = inSpace;
    this.editorPreviewGroup.visible = inSpace;
    this.editorSelection.visible = false;
    if (inSpace) {
      this._updateEditorCamera();
      this._updateEditorCameraScene(cam, project, selection);
    }

    // `fonts` is slot-aligned so a layer can name the face it leads with; the
    // filtered copy only answers "is there any typeface at all yet".
    const slots = fonts ?? [];
    const stack = slots.filter(Boolean);

    // Drop groups for clips that no longer exist.
    const live = new Set(clips.map(c => c.id));
    for (const id of [...this.groups.keys()]) if (!live.has(id)) this._destroy(id);
    for (const rec of this.groups.values()) rec.group.visible = false;

    // Higher track index renders further back, so track 0 sits in front.
    const active = clips
      .filter(c => clipLive(c, time, project))
      .sort((a, b) => b.track - a.track);
    const draw = inSpace
      ? [...clips].sort((a, b) => b.track - a.track || a.start - b.start)
      : active;
    const hasAnyFont = stack.length > 0 || draw.some(clip => !!clipFont(clip));

    let glyphCount = 0;
    for (const clip of draw) {
      const style = clipStyle(clip, project);
      const stageStack = orderFonts(slots, style.font);
      const layerFont = clipFont(clip);
      if (!stageStack.length && !layerFont) continue;
      const fontsForClip = layerFont
        ? [layerFont, ...stageStack.filter(font => font !== layerFont)]
        : stageStack;
      const rec = this._group(clip, project, fontsForClip);
      rec.group.visible = true;
      const pos = clipWorldPosition(clip) ?? clip.position ?? { x: 0, y: 0, z: 0 };
      rec.group.position.set(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0);
      rec.group.renderOrder = 10 - clip.track;
      const isActive = clipLive(clip, time, project);
      this._applyClip(rec, clip, project, time, beats, isActive, inSpace && !isActive ? 0.2 : 1);
      if (isActive) glyphCount += rec.glyphs.length;
    }

    this._updateParticles(project, time, beats, active, inSpace ? this.editorCamera.fov : FOV);

    if (inSpace) this._renderOutputPreview({ time, project, beats, draw: hasAnyFont ? draw : [] });

    if (inSpace && selection?.type === 'clip') {
      const rec = this.groups.get(selection.id);
      if (rec?.group.visible && rec.glyphs.length) {
        this.editorSelection.box.setFromObject(rec.group);
        this.editorSelection.visible = !this.editorSelection.box.isEmpty();
        this.editorSelection.updateMatrixWorld(true);
      }
    }

    this.renderer.render(this.scene, inSpace ? this.editorCamera : this.camera);
    if (inSpace) {
      const autoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.render(this.editorPreviewScene, this.editorPreviewCamera);
      this.renderer.autoClear = autoClear;
    }
    return { live: active.length, glyphs: glyphCount };
  }
}
