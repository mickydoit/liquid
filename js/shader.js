// The cymatic water fragment shader.
//
// ⚠ psi(), nodalAt() and waterAt() MIRROR js/cymafield.js exactly.
// The CPU copy drives the vector export; if the two drift, the exported
// outline stops matching what is on screen. Change them together.
//
// Two independent clocks. uTimeC moves the cymatic GEOMETRY (breathing, the
// fine-detail drift). uMatTime moves only LIGHT ON the water. Live Hold
// freezes the first and keeps the second, which is what lets a held design
// shimmer without its topology drifting.

export const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uM, uN, uKr, uMa, uMix, uAmp, uFine, uChaos, uPhase;
uniform float uTimeC, uRipAmt, uRipT, uMatTime, uGrow;
uniform float uAspect, uZoom, uGloss, uDispersion, uFlat, uTransparent;
uniform vec2 uPan;
uniform vec3 uGround, uInk, uDeep;

const float PI = 3.14159265359;

float psi(vec2 p) {
  vec2 uv = p * 0.5 + 0.5;
  float sq = cos(uM * PI * uv.x) * cos(uN * PI * uv.y)
           - cos(uN * PI * uv.x) * cos(uM * PI * uv.y);

  float r = length(p);
  float th = atan(p.y, p.x);
  // Periodic in theta: cos(uMa*th) is periodic only for integer uMa, and a
  // non-integer order tears along the atan branch cut. Blending the two
  // neighbouring integer orders keeps it smooth AND seamless.
  float m0 = floor(uMa), fm = uMa - m0;
  float ang = cos(m0 * th + uPhase) * (1.0 - fm) + cos((m0 + 1.0) * th + uPhase) * fm;
  float rad = cos(uKr * r - uMa * PI * 0.5 - PI * 0.25)
            / sqrt(1.0 + uKr * r * 0.6) * ang;

  float f = sq * (1.0 - uMix) + rad * uMix * 1.7;
  f += uFine * 0.30 * cos(uM * 2.7 * PI * uv.x + uTimeC * 0.21)
                    * cos(uN * 2.7 * PI * uv.y - uTimeC * 0.17);
  f += uChaos * 0.45 * (cos((uM + 1.7) * PI * uv.x) * cos((uN + 0.6) * PI * uv.y)
                      - cos((uN + 0.6) * PI * uv.x) * cos((uM + 1.7) * PI * uv.y));
  f += uRipAmt * sin(14.0 * r - uRipT * 9.0) * exp(-uRipT * 1.6) * exp(-r * 0.7);
  return f * (0.88 + 0.12 * sin(uTimeC * 0.9));
}

// Water is driven off the antinodes and collects along the NODAL lines, so
// thickness is high where |psi| is small. The band widens with amplitude:
// louder sound sweeps liquid out of a larger area and into the figure.
float nodalAt(vec2 p) {
  float f = abs(psi(p));
  float band = 0.05 + 0.34 * uAmp;
  float T = 1.0 - smoothstep(band * 0.30, band, f);
  return T * (1.0 - smoothstep(1.02, 1.30, length(p)));
}

// Emergence mask. The figure floods outward from the centre, so a design
// arrives as liquid spreading into the pattern rather than being switched on.
// At uGrow = 0 nothing is visible — that is the resting state now, instead of
// a scatter of unrelated droplets sitting over the figure.
float waterAt(vec2 p) {
  float reveal = 1.0 - smoothstep(uGrow * 1.55 - 0.30, uGrow * 1.55 + 0.04, length(p));
  return clamp(nodalAt(p) * reveal, 0.0, 1.0);
}

void main() {
  vec2 p = (vUv - 0.5 - uPan) * vec2(uAspect, 1.0) * 3.15 / uZoom;
  float T = waterAt(p);
  float px = 1.6 / (uZoom * 420.0);

  if (uFlat > 0.5) {
    // Exactly the silhouette the vector export emits, so what is on screen
    // and what lands in the SVG are the same shape.
    float m = smoothstep(0.45, 0.55, T);
    gl_FragColor = mix(vec4(mix(uGround, uInk, m), 1.0), vec4(uInk, m), uTransparent);
    return;
  }

  vec2 e = vec2(px, 0.0);
  vec2 grad = vec2(waterAt(p + e.xy) - waterAt(p - e.xy),
                   waterAt(p + e.yx) - waterAt(p - e.yx));

  // Internal surface motion, LIGHTING ONLY — never applied to thickness T, so
  // the silhouette, coverage and vector export stay bit-identical while the
  // surface moves. Three travelling waves rather than one static wobble: the
  // water body is nearly flat, so the eye needs highlights that actually
  // travel across it or a held design reads as motionless.
  float mt = uMatTime;
  float inWater = smoothstep(0.08, 0.55, T);
  float w1 = sin(p.x * 4.7 + p.y * 2.9 + mt * 0.85);
  float w2 = sin(p.x * -3.1 + p.y * 5.4 - mt * 0.63);
  float w3 = sin(length(p) * 7.5 - mt * 1.05);
  vec2 shim = vec2(w1 * 0.55 + w3 * 0.45, w2 * 0.55 - w3 * 0.45) * 0.22 * inWater;
  vec3 N = normalize(vec3(-(grad.x * 26.0 + shim.x), 1.0, -(grad.y * 26.0 + shim.y)));

  // A faint structured backdrop: refraction is invisible against a flat
  // colour — there has to be something behind the water for it to bend.
  vec2 ruv = vUv + N.xz * T * 0.055 * (1.0 + uDispersion * 0.4);
  float bandY = 0.5 + 0.5 * sin(ruv.y * 11.0 + ruv.x * 3.0);
  float vign = 1.0 - 0.35 * length(vUv - 0.5);
  vec3 back = uGround * (vign - 0.035 + 0.05 * bandY);
  vec3 backPlain = uGround * (1.0 - 0.35 * length(vUv - 0.5));

  float lap = waterAt(p + e.xy) + waterAt(p - e.xy)
            + waterAt(p + e.yx) + waterAt(p - e.yx) - 4.0 * T;
  float caustic = clamp(-lap * 9.0, 0.0, 1.0)
                * (0.82 + 0.18 * sin(mt * 1.25 + p.x * 4.0 + p.y * 3.1));

  vec3 body = mix(back, uDeep, clamp(T * 0.55, 0.0, 1.0));
  body += caustic * 0.28 * uGloss;
  // Travelling caustics: the clearest signal the liquid is alive while held.
  body += pow(max(0.0, w1 * w2), 3.0) * inWater * 0.13 * uGloss;

  // Contact darkening beneath thicker water.
  float shade = waterAt(p + vec2(px * 5.0, -px * 5.0));
  body *= 1.0 - 0.22 * clamp(shade - T, 0.0, 1.0) * 4.0;

  vec3 L = normalize(vec3(-0.45, 0.80, 0.40));
  vec3 V = vec3(0.0, 1.0, 0.0);
  float spec = pow(max(0.0, dot(N, normalize(L + V))), 34.0);
  float fres = pow(1.0 - max(0.0, dot(N, V)), 4.0);

  // Dispersion gated by thickness as well as curvature: a small droplet has a
  // huge gradient, and curvature alone rings every one of them in rainbow.
  float curv = clamp(length(grad) * 9.0, 0.0, 1.0) * smoothstep(0.15, 0.6, T);
  float a = atan(grad.y, grad.x) * 2.0;
  vec3 iri = vec3(sin(a), sin(a + 2.094), sin(a + 4.188)) * 0.5 + 0.5;

  vec3 col = body
           + vec3(1.0) * spec * 0.85 * uGloss
           + vec3(1.0) * fres * 0.16 * uGloss
           + (iri - 0.5) * curv * fres * uDispersion * 0.34;

  float cov = smoothstep(0.02, 0.14, T);
  col = mix(backPlain, col, cov);
  gl_FragColor = mix(vec4(col, 1.0), vec4(col, cov), uTransparent);
}`;
