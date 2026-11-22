import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

// the finishing pass over a whole frame, so the place, props and models sit in the same picture
// as the umas: dark lines where something stands in front of something far behind it (the umas'
// own outlines are on top already), bloom on the brightest bits only (toon skin sits close to
// white: a lower threshold blows faces out), a grade and a vignette.
// only on solid backgrounds: glow and lines would smear a transparent one's edges.

const FINISH = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null },
    cNear: { value: 0.1 }, cFar: { value: 100 }, res: { value: new THREE.Vector2(1, 1) },
    lines: { value: 0.8 }, lineDist: { value: 40 },
    sat: { value: 1.12 }, contrast: { value: 1.06 }, warm: { value: 0.3 }, vignette: { value: 0.35 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth;
    uniform float cNear, cFar, lines, lineDist, sat, contrast, warm, vignette;
    uniform vec2 res;
    varying vec2 vUv;
    float lin(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return 2.0 * cNear * cFar / (cFar + cNear - z * (cFar - cNear));
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      if (lines > 0.0) {
        // the line goes on the near side of an edge: a neighbour much further back than this pixel
        float d = lin(vUv);
        vec2 px = max(1.0, res.y / 900.0) / res;
        float e = 0.0;
        e = max(e, lin(vUv + vec2(px.x, 0.0)) - d);
        e = max(e, lin(vUv - vec2(px.x, 0.0)) - d);
        e = max(e, lin(vUv + vec2(0.0, px.y)) - d);
        e = max(e, lin(vUv - vec2(0.0, px.y)) - d);
        e = max(e, 0.7 * (lin(vUv + px) - d));
        e = max(e, 0.7 * (lin(vUv - px) - d));
        e = max(e, 0.7 * (lin(vUv + vec2(px.x, -px.y)) - d));
        e = max(e, 0.7 * (lin(vUv + vec2(-px.x, px.y)) - d));
        float edge = smoothstep(0.03, 0.09, e / d);
        // far away the crowd and fences would turn to scribbles
        float fade = 1.0 - smoothstep(lineDist * 0.5, lineDist, d);
        col = mix(col, col * vec3(0.22, 0.2, 0.24), edge * fade * lines);
      }
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, sat);
      col = (col - 0.5) * contrast + 0.5;
      col *= vec3(1.0 + warm * 0.05, 1.0 + warm * 0.01, 1.0 - warm * 0.05);
      vec2 q = (vUv - 0.5) * vec2(res.x / res.y, 1.0);
      col *= 1.0 - vignette * smoothstep(0.3, 0.95, length(q));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

/** The finishing pass reads the depth the scene was drawn with. */
class FinishPass extends ShaderPass {
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

export const settings = { on: true, lines: 0.8, lineDist: 40, bloom: 0.2, sat: 1.12, contrast: 1.06, warm: 0.3, vignette: 0.35 };

function target(w, h) {
  // depth and stencil (the eyes show through the bangs by stencil) in one texture we can read
  const depth = new THREE.DepthTexture(w, h, THREE.UnsignedInt248Type);
  depth.format = THREE.DepthStencilFormat;
  return new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, stencilBuffer: true, depthTexture: depth });
}

/** A post chain for scene + camera at w x h (pixels). */
export function makeChain(renderer, scene, camera, w, h, toScreen) {
  const composer = new EffectComposer(renderer, target(w, h));
  composer.renderToScreen = toScreen;
  const render = new RenderPass(scene, camera);
  const finish = new FinishPass(FINISH);
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), settings.bloom, 0.35, 0.96);
  const out = new OutputPass();
  composer.addPass(render);
  composer.addPass(finish);
  composer.addPass(bloom);
  composer.addPass(out);
  const copy = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms), vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
  }));
  return {
    composer, w, h,
    setSize(nw, nh) { this.w = nw; this.h = nh; composer.setSize(nw, nh); bloom.setSize(nw, nh); },
    render() {
      const u = finish.uniforms;
      u.cNear.value = camera.near; u.cFar.value = camera.far;
      u.res.value.set(this.w * composer._pixelRatio, this.h * composer._pixelRatio);
      u.lines.value = settings.lines; u.lineDist.value = settings.lineDist;
      u.sat.value = settings.sat; u.contrast.value = settings.contrast; u.warm.value = settings.warm; u.vignette.value = settings.vignette;
      bloom.strength = settings.bloom;
      bloom.enabled = settings.bloom > 0;
      composer.render();
    },
    /** The last render copied into rt (8-bit, for reading back). */
    copyTo(rt) {
      copy.material.uniforms.tDiffuse.value = composer.readBuffer.texture;
      renderer.setRenderTarget(rt);
      copy.render(renderer);
    },
    dispose() { copy.dispose(); copy.material.dispose(); composer.dispose(); composer.renderTarget1.depthTexture?.dispose(); composer.renderTarget2.depthTexture?.dispose(); bloom.dispose(); },
  };
}
