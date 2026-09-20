// Sensor look: FLIR/thermal post-process on the whole scene, display only.
// Monochrome green-on-dark with a brightness ramp, vignette and a rolling
// scanline. Toggled from the HUD SENSOR button; the demo works with the
// effect off, this is the bonus view.

import { PostProcessStage, type Viewer } from 'cesium';

// GLSL 300 style fragment shader, sampling the linear-scene colorTexture.
// Palette: near-black for cold pixels, dim green for mid, pale green-white
// for hot. A sine band scrolls upward with uTime; the vignette is a distance
// falloff from the frame center.
const FRAGMENT_SHADER = `
uniform sampler2D colorTexture;
uniform float uTime;

varying vec2 v_textureCoordinates;

const float SCAN_SPACING = 220.0;
const float SCAN_SPEED = 24.0;

// 0..1 brightness ramp onto the FLIR palette: dark -> dim green -> near white.
vec3 flirPalette(float l) {
  vec3 dark = vec3(0.020, 0.055, 0.035);
  vec3 mid = vec3(0.180, 0.480, 0.300);
  vec3 hot = vec3(0.800, 1.000, 0.860);
  vec3 c = mix(dark, mid, smoothstep(0.0, 0.55, l));
  return mix(c, hot, smoothstep(0.55, 1.0, l));
}

void main() {
  vec4 scene = texture(colorTexture, v_textureCoordinates);

  float l = dot(scene.rgb, vec3(0.299, 0.587, 0.114));
  vec3 c = flirPalette(clamp(l, 0.0, 1.0));

  // Rolling scanline: one bright band drifting upward through the frame.
  float y = v_textureCoordinates.y;
  float scan = 1.0 - abs(fract((y + uTime / SCAN_SPEED) * SCAN_SPACING) - 0.5) * 2.0;
  c *= 1.0 - 0.06 * scan;

  // Vignette: darken toward the frame edges like a sensor tube.
  vec2 d = v_textureCoordinates - vec2(0.5);
  c *= 1.0 - dot(d, d) * 0.55;

  gl_FragColor = vec4(c, scene.a);
}
`;

let stage: PostProcessStage | null = null;

/** Enable or disable the sensor-look post effect on the given viewer. */
export function setSensorLook(viewer: Viewer, on: boolean): void {
  const stages = viewer.scene.postProcessStages;
  if (on) {
    if (!stage) {
      stage = new PostProcessStage({
        fragmentShader: FRAGMENT_SHADER,
        uniforms: { uTime: 0 },
      });
      stages.add(stage);
      startClock(viewer);
    }
    stage.enabled = true;
  } else {
    if (stage) stage.enabled = false;
  }
}

// The clock only advances while the stage is enabled, so an off sensor costs
// nothing per frame. One listener for the module lifetime; the demo never
// tears the viewer down.
function startClock(viewer: Viewer): void {
  const advance = () => {
    if (stage?.enabled) {
      stage.uniforms.uTime = performance.now() / 1000;
    }
  };
  viewer.scene.postRender.addEventListener(advance);
}
