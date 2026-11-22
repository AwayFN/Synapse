import * as THREE from 'three';

/**
 * Neurone néon : un seul quad par neurone, toujours face à la caméra, dessiné par des fonctions de distance.
 *   - un noyau lumineux (contour de néon + cœur blanc brûlant) ;
 *   - des branches (dendrites) effilées : une de plus par lien, jusqu'à 10 — une pensée reliée est ramifiée ;
 *   - néon éteint = terminé ; néon qui grésille + anneau rose-rouge = en retard ; battement = en cours ;
 *   - quand une impulsion arrive ou part, des points de lumière filent le long des branches.
 * Tous les neurones ont la même forme : seule la couleur dit la nature (pensée, action, moment, référence).
 */
export function makeNodeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 600 },
      uMinPx: { value: 1.6 },
      uFog: { value: new THREE.Vector2(420, 1500) },
      /** 1 = animations normales ; plus bas si l'on préfère moins de mouvement */
      uMotion: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec3 iColor;
      attribute float iSize;
      attribute float iBranches; // nombre de branches ; -1 = neurone qui disparaît (onde seule)
      attribute vec4 iState;     // éclat, terminé, central, retard
      attribute vec4 iFx;        // sélection, survol, onde, en cours
      attribute float iFire;     // activation (impulsion reçue ou envoyée)
      attribute float iPhase;
      uniform float uScale;
      uniform float uMinPx;
      uniform vec2 uFog;
      varying vec2 vUv;
      varying float vPx;
      varying vec3 vColor;
      varying vec4 vState;
      varying vec4 vFx;
      varying float vBranches;
      varying float vFire;
      varying float vPhase;
      varying float vFade;
      void main() {
        vec4 mvc = modelViewMatrix * vec4(iPos, 1.0);
        float dist = max(-mvc.z, 0.001);
        float px = iSize * uScale / dist;
        // un neurone lointain garde une empreinte minimale, sans devenir plus lumineux pour autant
        float k = max(1.0, uMinPx / max(px, 1e-4));
        float energy = 1.0 / (k * k);
        // les branches vont jusqu'à 3,4 rayons du noyau
        float ext = max(3.8, iFx.z > 0.0 ? 1.4 + iFx.z * 3.8 : 0.0);
        float R = iSize * k;
        vec2 corner = position.xy * 2.0;
        vec4 mv = mvc;
        mv.xy += corner * R * ext;
        gl_Position = projectionMatrix * mv;
        vUv = corner * ext;
        vPx = px * k;
        vColor = iColor;
        vState = vec4(iState.x * max(energy, 0.1), iState.yzw);
        vFx = iFx;
        vBranches = iBranches;
        vFire = iFire;
        vPhase = iPhase;
        float nearFade = smoothstep(0.6, 4.0, dist);
        float farFade = 1.0 - smoothstep(uFog.x, uFog.y, dist);
        float depthDim = mix(1.0, 0.55, smoothstep(70.0, uFog.x, dist));
        vFade = nearFade * farFade * depthDim;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uMotion;
      varying vec2 vUv;
      varying float vPx;
      varying vec3 vColor;
      varying vec4 vState;
      varying vec4 vFx;
      varying float vBranches;
      varying float vFire;
      varying float vPhase;
      varying float vFade;

      float h1(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
      float seg(vec2 p, vec2 a, vec2 b, out float h) {
        vec2 pa = p - a;
        vec2 ba = b - a;
        h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
        return length(pa - ba * h);
      }

      void main() {
        vec2 p = vUv;
        float r = length(p);
        float aa = 1.25 / max(vPx, 0.6);
        float bright = vState.x;
        float done = vState.y;
        float hub = vState.z;
        float alert = vState.w;
        float sel = vFx.x;
        float hov = vFx.y;
        float ripple = vFx.z;
        float doing = vFx.w;
        float fire = clamp(vFire, 0.0, 2.0);
        vec3 c = vColor;
        vec3 col = vec3(0.0);

        if (vBranches > -0.5) {
          float on = 1.0 - done;
          // néon éteint : la couleur se ternit
          float lum = dot(c, vec3(0.299, 0.587, 0.114));
          vec3 cd = mix(c, vec3(lum) * 0.8, done * 0.7);
          // battement de cœur (en cours, maintenant)
          float ph = uTime * 4.2 * max(uMotion, 0.35) + vPhase * 6.2831853;
          float beat = doing * (pow(0.5 + 0.5 * sin(ph), 16.0) + 0.55 * pow(0.5 + 0.5 * sin(ph - 0.85), 16.0));

          // ── noyau : boule de néon, contour lumineux, cœur blanc brûlant
          float dS = r - 1.0;
          float inside = 1.0 - smoothstep(-aa, aa, dS);
          float rim = exp(-pow(dS / (0.09 + aa), 2.0));
          float body = inside * (0.16 + 0.5 * (1.0 - r * r));
          float core = exp(-r * r * 8.0);
          float halo = exp(-max(dS, 0.0) * 2.0) * (1.0 - inside) * 0.2;
          col += cd * (body * (0.25 + 0.75 * on) + rim * (0.42 + 0.58 * on) + halo * (0.15 + 0.85 * on) * (1.0 + beat * 1.4));
          col += mix(c, vec3(1.0), 0.62) * core * (1.35 + beat * 1.4 + fire * 0.5) * on;

          // ── branches : une de plus par lien, effilées, un peu courbes, avec une fourche
          float detail = smoothstep(4.0, 16.0, vPx);
          if (detail > 0.001 && r > 0.7 && r < 3.7) {
            float nb = vBranches;
            float reach = 1.0 - 0.45 * done;
            float acc = 0.0;
            float sig = 0.0;
            for (int k = 0; k < 10; k++) {
              float fk = float(k);
              if (fk >= nb) break;
              float s = vPhase * 91.0 + fk * 7.13;
              float ang = vPhase * 6.2831853 + fk * 6.2831853 / nb + (h1(s) - 0.5) * (2.6 / nb);
              float len = (1.95 + 1.25 * h1(s + 1.7)) * reach;
              vec2 dir = vec2(cos(ang), sin(ang));
              vec2 nrm = vec2(-dir.y, dir.x);
              float bend = (h1(s + 3.3) - 0.5) * 0.8 + 0.07 * sin(uTime * 0.8 * uMotion + fk * 1.9 + vPhase * 6.0);
              vec2 a = dir * 0.82;
              vec2 m = dir * (0.82 + (len - 0.82) * 0.5) + nrm * bend * 0.5;
              vec2 b = dir * len + nrm * bend;
              float t1;
              float d1 = seg(p, a, m, t1);
              float t2;
              float d2 = seg(p, m, b, t2);
              float d = d1 < d2 ? d1 : d2;
              float u = d1 < d2 ? t1 * 0.5 : 0.5 + t2 * 0.5;
              float w = mix(0.15, 0.03, u) * (1.0 + 0.4 * hub);
              float line = exp(-pow(d / (w + aa * 0.7), 2.0));
              float glow = exp(-d / (w * 3.0 + aa)) * 0.18;
              acc += (line + glow) * (1.0 - 0.6 * u);
              // fourche, aux deux tiers
              float side = h1(s + 5.1) > 0.5 ? 1.0 : -1.0;
              vec2 fa = mix(m, b, 0.3);
              vec2 fdir = normalize(b - m);
              float fan = 0.62 * side;
              vec2 fd = vec2(fdir.x * cos(fan) - fdir.y * sin(fan), fdir.x * sin(fan) + fdir.y * cos(fan));
              float tf;
              float df = seg(p, fa, fa + fd * len * 0.32, tf);
              float wf = mix(0.06, 0.02, tf) * (1.0 + 0.4 * hub);
              acc += (exp(-pow(df / (wf + aa * 0.7), 2.0)) + exp(-df / (wf * 3.0 + aa)) * 0.12) * 0.55 * (1.0 - 0.5 * tf);
              // signal : un point de lumière file vers le bout de la branche
              float run = fract(uTime * 0.75 * max(uMotion, 0.35) + h1(s + 9.0));
              sig += exp(-pow((u - run) * 9.0, 2.0)) * line;
            }
            col += cd * acc * detail * (0.62 + 0.38 * on) * (1.0 - done * 0.7);
            col += mix(c, vec3(1.0), 0.5) * sig * detail * (fire * 0.9 + beat * 0.6 + 0.1) * on;
          }
          col *= bright;

          // ── en retard : le néon grésille, avec un anneau rose-rouge
          if (alert > 0.01) {
            float tq = floor(uTime * 11.0 + vPhase * 37.0);
            float off = step(0.84, h1(tq + vPhase * 13.0)) * step(0.5, uMotion);
            col *= 1.0 - alert * off * 0.75;
            float ar = exp(-pow((r - 1.32) / (0.07 + aa), 2.0));
            col += vec3(1.0, 0.3, 0.48) * ar * alert * (1.0 - off * 0.8) * max(bright, 0.55) * 1.2;
          }

          // ── sélection : anneau blanc en quatre arcs ; survol : anneau discret
          float ringR = 1.5 + 0.05 * sin(uTime * 1.6);
          float ring = 1.0 - smoothstep(aa * 0.6, aa * 1.5 + 0.02, abs(r - ringR));
          float arcs = smoothstep(0.06, 0.1, fract(atan(p.y, p.x) / 6.2832 * 4.0 + uTime * 0.04));
          col += vec3(0.93, 0.96, 1.0) * ring * (sel * arcs * 0.95 + hov * 0.4);
        }

        // onde : naissance, accomplissement, disparition
        if (ripple > 0.0) {
          float rad = 1.0 + ripple * 3.6;
          float w = 0.04 + aa * 1.5;
          float ring2 = (1.0 - smoothstep(0.0, w, abs(r - rad))) * pow(1.0 - ripple, 1.6);
          col += mix(c, vec3(1.0), 0.45) * ring2 * 0.8;
        }

        col *= vFade;
        if (col.r + col.g + col.b < 0.003) discard;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Connexion (axone) : tube de néon courbe dessiné à l'écran. Épaisseur et luminosité = force du lien,
 * éclat temporaire = fraîcheur. Quand une impulsion le parcourt, l'axone s'allume autour d'elle.
 * Pointillés = connexion possible suggérée par Synapse.
 */
export function makeLinkMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1280, 720) },
      uFog: { value: new THREE.Vector2(420, 1500) },
      /** < 1 quand le réseau est dense : les connexions ne saturent jamais en blanc */
      uGain: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aT;
      attribute float aSide;
      attribute vec3 iA;
      attribute vec3 iC;
      attribute vec3 iB;
      attribute vec3 iColA;
      attribute vec3 iColB;
      attribute vec4 iP;     // force, éclat, fraîcheur, suggestion
      attribute vec4 iF;     // départ de l'onde, sens, intensité, vitesse
      attribute vec2 iTrim;
      uniform vec2 uRes;
      uniform vec2 uFog;
      varying float vT;
      varying float vSide;
      varying vec3 vCol;
      varying vec4 vP;
      varying vec4 vF;
      varying float vFade;
      varying float vLen;
      vec3 bez(float t) {
        float it = 1.0 - t;
        return it * it * iA + 2.0 * it * t * iC + t * t * iB;
      }
      void main() {
        float t = mix(iTrim.x, iTrim.y, aT);
        mat4 pmv = projectionMatrix * modelViewMatrix;
        vec4 c = pmv * vec4(bez(t), 1.0);
        vec4 cn = pmv * vec4(bez(clamp(t + 0.003, 0.0, 1.0)), 1.0);
        vec4 cp = pmv * vec4(bez(clamp(t - 0.003, 0.0, 1.0)), 1.0);
        vec2 sn = cn.xy / max(cn.w, 0.01);
        vec2 sp = cp.xy / max(cp.w, 0.01);
        vec2 dir = (sn - sp) * uRes;
        float l = length(dir);
        dir = l > 1e-6 ? dir / l : vec2(1.0, 0.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        float w = mix(0.9, 2.6, iP.x) * (0.8 + 0.3 * min(iP.y, 1.6)) + iP.z * 1.1;
        c.xy += nrm * aSide * (w / uRes) * c.w;
        gl_Position = c.w < 0.05 ? vec4(0.0, 0.0, 2.0, 1.0) : c;
        vT = t;
        vSide = aSide;
        vCol = mix(iColA, iColB, t);
        vP = iP;
        vF = iF;
        float dist = max(c.w, 0.0);
        vFade = smoothstep(0.5, 3.0, dist) * (1.0 - smoothstep(uFog.x, uFog.y, dist)) * mix(1.0, 0.55, smoothstep(70.0, uFog.x, dist));
        vLen = length(iB - iA);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uGain;
      varying float vT;
      varying float vSide;
      varying vec3 vCol;
      varying vec4 vP;
      varying vec4 vF;
      varying float vFade;
      varying float vLen;
      void main() {
        float x = 1.0 - abs(vSide);
        float core = smoothstep(0.0, 0.85, x);
        // tube de néon : un filament plus clair au centre
        float filament = pow(x, 5.0);
        float strength = vP.x;
        float bright = vP.y;
        float fresh = vP.z;
        float a = (0.07 + 0.34 * strength) * bright * (1.0 + fresh * 1.6) * (0.78 + 0.22 * abs(vT * 2.0 - 1.0)) * mix(uGain, 1.0, clamp(bright - 1.0, 0.0, 1.0));
        vec3 col = mix(vCol, vec3(1.0), filament * 0.3);
        if (vP.w > 0.5) {
          float dashes = max(5.0, vLen / 2.4);
          float f = fract(vT * dashes - uTime * 0.35);
          a = (0.12 + 0.12 * strength) * bright * smoothstep(0.3, 0.45, f) * (1.0 - smoothstep(0.75, 0.9, f));
        }
        // impulsion en cours : l'axone s'allume autour d'elle (même vitesse que le point de lumière)
        float age = uTime - vF.x;
        float speed = max(vF.w, 0.2);
        if (vF.z > 0.0 && age > 0.0 && age * speed < 1.6) {
          float u = vF.y > 0.0 ? vT : 1.0 - vT;
          float head = age * speed;
          float g = exp(-pow((u - head) * 7.5, 2.0));
          float trail = smoothstep(head - 0.45, head, u) * step(u, head) * 0.4;
          float wv = (g + trail) * vF.z * (1.0 - smoothstep(1.15, 1.6, age * speed));
          a += wv * 0.95;
          col = mix(col, vec3(1.0), clamp(g * 0.4, 0.0, 1.0));
        }
        vec3 outc = col * a * core * vFade;
        if (outc.r + outc.g + outc.b < 0.002) discard;
        gl_FragColor = vec4(outc, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // le ruban est construit à l'écran : selon le sens du lien, ses triangles regardent d'un côté ou de l'autre
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Impulsion : point de lumière additif, cœur blanc brûlant, halo de la couleur du neurone */
export function makePulseMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uScale: { value: 600 },
      uMaxPx: { value: 60 },
      uFar: { value: new THREE.Vector2(420, 1400) },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aInt;
      uniform float uScale;
      uniform float uMaxPx;
      uniform vec2 uFar;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mv.z, 0.001);
        float size = aSize * uScale / dist;
        float px = clamp(size, 2.0, uMaxPx);
        // un point agrandi jusqu'à sa taille minimale garde la même énergie lumineuse
        float energy = max(min((size * size) / (px * px), 1.0), 0.12);
        float nearFade = smoothstep(0.4, 3.5, dist);
        float farFade = 1.0 - smoothstep(uFar.x, uFar.y, dist);
        vColor = aColor * aInt * energy * nearFade * farFade;
        gl_PointSize = px;
        gl_Position = aInt > 0.0 ? projectionMatrix * mv : vec4(0.0, 0.0, 2.0, 1.0);
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
        vec3 col = vColor * glow + vec3(lum) * hot * 1.4;
        if (col.r + col.g + col.b < 0.002) discard;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

/** Particule lumineuse (fond étoilé) — additive, taille atténuée */
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
        float tw = 0.8 + 0.2 * sin(uTime * (0.5 + aPhase * 1.6) + aPhase * 41.0);
        float size = aSize * uScale / dist;
        float px = clamp(size, 1.2, uMaxPx);
        float energy = max(min((size * size) / (px * px), 1.0), 0.06);
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
        gl_FragColor = vec4(vColor * soft * soft, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}
