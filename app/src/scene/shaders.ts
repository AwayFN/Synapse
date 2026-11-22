import * as THREE from 'three';

/** Glowing particle (points) — additive, size attenuated, white-hot center */
export function makePointMaterial(gain = 1, maxPx = 90, farStart = 420, farEnd = 1300) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 600 },
      uGain: { value: gain },
      uMaxPx: { value: maxPx },
      uFar: { value: new THREE.Vector2(farStart, farEnd) },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aInt;
      attribute float aPhase;
      uniform float uTime;
      uniform float uScale;
      uniform float uGain;
      uniform float uMaxPx;
      uniform vec2 uFar;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mv.z, 0.001);
        float tw = 0.74 + 0.26 * sin(uTime * (0.7 + aPhase * 2.4) + aPhase * 41.0);
        float size = aSize * uScale / dist;
        float px = clamp(size, 1.4, uMaxPx);
        // conserve energy when a point is clamped up to the minimum size
        float energy = min((size * size) / (px * px), 1.0);
        energy = max(energy, 0.06);
        float nearFade = smoothstep(0.4, 3.5, dist);
        float farFade = 1.0 - smoothstep(uFar.x, uFar.y, dist);
        vColor = aColor * aInt * tw * uGain * energy * nearFade * farFade;
        gl_PointSize = px;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c) * 2.0;
        if (d > 1.0) discard;
        float soft = 1.0 - d;
        float glow = soft * soft;
        float hot = pow(soft, 7.0);
        float lum = dot(vColor, vec3(0.3333));
        vec3 col = vColor * glow + vec3(lum) * hot * 1.3;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

/** Fine additive lines sharing the particle attributes (aColor * aInt) */
export function makeLineMaterial(gain = 0.2) {
  return new THREE.ShaderMaterial({
    uniforms: { uGain: { value: gain } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aInt;
      uniform float uGain;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mv.z, 0.001);
        float farFade = 1.0 - smoothstep(320.0, 900.0, dist);
        float nearFade = smoothstep(0.3, 2.5, dist);
        vColor = aColor * aInt * uGain * farFade * nearFade;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() { gl_FragColor = vec4(vColor, 1.0); }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

/** Nucleus: glassy rim-lit sphere, instanced, HDR color for bloom */
export function makeCoreMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vCol;
      void main() {
        vec4 wp = instanceMatrix * vec4(position, 1.0);
        vec4 mv = modelViewMatrix * wp;
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz);
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(1.0);
        #endif
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vCol;
      void main() {
        float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float rim = pow(1.0 - ndv, 2.2);
        float lum = dot(vCol, vec3(0.3333));
        vec3 col = vCol * (0.28 + 1.9 * rim) + vec3(lum) * pow(ndv, 5.0) * 0.85;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}
