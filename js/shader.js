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
uniform float uSimple, uRim, uDepth, uRefract, uSwell;
uniform float uMass;        // 0 = water on the nodes, 1 = on the antinodes
uniform vec4 uMeta[14];     // xy = centre, zw = ellipse radii
uniform vec2 uMetaRC[14];   // x = rotation, y = cluster id
uniform int uMetaN;
uniform float uMetaK;       // fillet radius for necks within a cluster
uniform float uMetaBlend;   // 0 = concave fillet waist, 1 = broad flowing union
uniform float uMetaScale;   // Scale/crop, a true zoom of the finished artwork
uniform float uMode;        // 0 = Detailed Cymatic, 1 = Metaball Cymatic
uniform float uView;        // 0 = water, 1 = filled flat, 2 = outline only
uniform float uLineW;       // outline stroke width, in world units
uniform sampler2D uBackTex; // optional backdrop the water refracts
uniform float uHasBack;
uniform float uPxWorld;       // one pixel, in world units
uniform float uAspect, uZoom, uGloss, uDispersion, uTransparent;
uniform vec2 uPan;
uniform vec3 uGround, uInk, uDeep;

const float PI = 3.14159265359;

float psi(vec2 p) {
  vec2 uv = p * 0.5 + 0.5;

  // Complexity in a Chladni figure IS its mode numbers — a high-order plate
  // has many small cells — so simplifying means LOWERING the orders, not
  // blurring or hiding anything. Floors keep a recognisable figure at the
  // simple end rather than collapsing it to a blob.
  // Reaches much further down than before, but the floors are what keep a
  // blobby metaball character at the extreme instead of collapsing to a disc:
  // a couple of lobes still beat against each other.
  float det = 1.0 - 0.86 * uSimple;
  float m_ = max(0.55, uM * det);
  float n_ = max(0.45, uN * det);
  float kr_ = max(1.3, uKr * det);
  float ma_ = max(0.7, uMa * det);

  float sq = cos(m_ * PI * uv.x) * cos(n_ * PI * uv.y)
           - cos(n_ * PI * uv.x) * cos(m_ * PI * uv.y);

  float r = length(p);
  float th = atan(p.y, p.x);
  // Periodic in theta: cos(uMa*th) is periodic only for integer uMa, and a
  // non-integer order tears along the atan branch cut. Blending the two
  // neighbouring integer orders keeps it smooth AND seamless.
  float m0 = floor(ma_), fm = ma_ - m0;
  float ang = cos(m0 * th + uPhase) * (1.0 - fm) + cos((m0 + 1.0) * th + uPhase) * fm;
  float rad = cos(kr_ * r - ma_ * PI * 0.5 - PI * 0.25)
            / sqrt(1.0 + kr_ * r * 0.6) * ang;

  float f = sq * (1.0 - uMix) + rad * uMix * 1.7;
  // Fine detail and layering are complexity too, so they fade with the same
  // control — otherwise "simple" would still carry busy overlays.
  f += uFine * 0.30 * det * cos(m_ * 2.7 * PI * uv.x + uTimeC * 0.21)
                          * cos(n_ * 2.7 * PI * uv.y - uTimeC * 0.17);
  f += uChaos * 0.45 * det * (cos((m_ + 1.7) * PI * uv.x) * cos((n_ + 0.6) * PI * uv.y)
                            - cos((n_ + 0.6) * PI * uv.x) * cos((m_ + 1.7) * PI * uv.y));
  f += uRipAmt * sin(14.0 * r - uRipT * 9.0) * exp(-uRipT * 1.6) * exp(-r * 0.7);
  return f * (0.88 + 0.12 * sin(uTimeC * 0.9));
}

// Water is driven off the antinodes and collects along the NODAL lines, so
// thickness is high where |psi| is small. The band widens with amplitude:
// louder sound sweeps liquid out of a larger area and into the figure.

// ── Metaball Cymatic ───────────────────────────────────────────────────
//
// ⚠ MIRRORS js/metafield.js. Change them together.
//
// Circular FILLET union, not a polynomial smooth-min: a fillet cuts a concave
// tangent arc in the corner where two surfaces meet, which is the hourglass
// waist this look is built on. smin bulges convexly there and reads as soap
// bubbles.
float unionRoundf(float d1, float d2, float kf) {
  if (kf <= 0.0) return min(d1, d2);
  vec2 u = max(vec2(kf - d1, kf - d2), 0.0);
  return max(kf, min(d1, d2)) - length(u);
}

// Approximate ellipse SDF. Exact for circles and close enough for the modest
// ratios the generator allows; the exact form needs an iterative root solve.
float sdEllipsef(vec2 p, vec2 r, float rot) {
  float ca = cos(-rot), sa = sin(-rot);
  vec2 q = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  float k1 = length(q / r);
  float k2 = length(q / (r * r));
  if (k2 == 0.0) return -min(r.x, r.y);
  return (k1 - 1.0) * (k1 / k2);
}

// Fillet union WITHIN a cluster, plain min ACROSS clusters. That split is what
// makes connection a decision rather than an accident of overlap: forms in one
// cluster grow a neck, forms in different clusters never touch however close
// the composition packs them.
// Polynomial smooth minimum — the convex, flowing union.
float sminf(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Fillet at low Merge for a narrow hourglass waist, smin at high Merge for a
// broad flowing join. Fillet alone exaggerates the pinch into peanuts; smin
// alone dissolves the lobes into one oval.
float clusterUnionf(float d1, float d2) {
  float f = unionRoundf(d1, d2, uMetaK);
  float sm = sminf(d1, d2, uMetaK * mix(1.5, 3.2, uMetaBlend));
  return mix(f, sm, uMetaBlend);
}

float metaDistf(vec2 q) {
  // Scale/crop is a TRUE zoom: evaluate at p/S and scale the result by S, so
  // positions, radii and necks all enlarge together.
  vec2 p = q / uMetaScale;
  float best = 1e9;
  for (int c = 0; c < 8; c++) {
    float dc = 1e9;
    for (int i = 0; i < 14; i++) {
      if (i >= uMetaN) break;
      if (int(uMetaRC[i].y) != c) continue;
      float d = sdEllipsef(p - uMeta[i].xy, uMeta[i].zw, uMetaRC[i].x);
      dc = (dc > 1e8) ? d : clusterUnionf(dc, d);
    }
    best = min(best, dc);
  }
  return best * uMetaScale;
}

float nodalAt(vec2 p) {
  float f = abs(psi(p));

  // Variable line weight: a low-order standing wave from the SAME modal
  // family, so thick and thin passages belong to the form rather than
  // reading as an effect over it. Not the true field gradient — exact, but
  // two extra psi evaluations inside a function already called ~8x per pixel
  // triples the trig budget for a difference the eye does not read.
  float detS = 1.0 - 0.86 * uSimple;
  float mS = max(0.55, uM * detS), nS = max(0.45, uN * detS);
  vec2 uvS = p * 0.5 + 0.5;
  // Low frequencies relative to the figure: a few broad passages that swell
  // and pinch, rather than many small wobbles along every ribbon.
  float sw = 0.5 + 0.5 * cos(mS * 0.32 * PI * uvS.x + uPhase * 0.7)
                       * cos(nS * 0.27 * PI * uvS.y - uPhase * 0.5);
  float weight = 1.0 + uSwell * (0.15 + 2.6 * sw - 1.0);
  // The band is a threshold on the FIELD, not a width in space: gentler
  // gradients at low modal orders spread it over more area. Scaling by the
  // same detail factor keeps ribbon width roughly fixed as cells grow —
  // without it, simplifying fills the disc into a solid mass.
  float band = (0.05 + 0.34 * uAmp) * detS * weight;

  // WHICH SIDE of the field holds the water. On the NODES the wet set is a
  // nodal line network — always a web of closed loops, because that is what a
  // nodal set IS, so simplifying can never turn it into a few solid lobes. On
  // the ANTINODES it is the field's peaks: a handful of fat rounded masses
  // joined by necks, which is the metaball topology.
  float line = 1.0 - smoothstep(band * 0.30, band, f);
  float thr = (0.62 - 0.42 * uAmp) / max(0.3, weight);
  float soft = 0.10 * (1.0 + uSimple);
  float lobe = smoothstep(thr - soft, thr + soft, f);
  float T = mix(line, lobe, uMass);
  // Soft plate boundary — the dish edge, not a hard crop. A Chladni figure
  // lives on a physical plate and must end at its rim.
  return T * (1.0 - smoothstep(1.02, 1.30, length(p)));
}

// Emergence mask. The figure floods outward from the centre, so a design
// arrives as liquid spreading into the pattern rather than being switched on.
// At uGrow = 0 nothing is visible — that is the resting state now, instead of
// a scatter of unrelated droplets sitting over the figure.
float waterAt(vec2 p) {
  // Two generators, routed — not blended. Metaball Cymatic is exempt from the
  // emergence mask: that mask is a fixed radius in WORLD units while how much
  // world is on screen depends on zoom, and a composition whose language is
  // forms running off the frame cannot be bounded by a circle.
  if (uMode > 0.5) {
    return clamp(1.0 - smoothstep(-uPxWorld, uPxWorld, metaDistf(p)), 0.0, 1.0);
  }
  float reveal = 1.0 - smoothstep(uGrow * 1.55 - 0.30, uGrow * 1.55 + 0.04, length(p));
  return clamp(nodalAt(p) * reveal, 0.0, 1.0);
}

void main() {
  vec2 p = (vUv - 0.5 - uPan) * vec2(uAspect, 1.0) * 3.15 / uZoom;
  float T = waterAt(p);
  float px = 1.6 / (uZoom * 420.0);

  vec2 e = vec2(px, 0.0);
  vec2 grad = vec2(waterAt(p + e.xy) - waterAt(p - e.xy),
                   waterAt(p + e.yx) - waterAt(p - e.yx));

  if (uView > 0.5 && uView < 1.5) {
    // Filled silhouette — exactly what the flat vector export emits.
    // ⚠ Centred on WATER_EDGE (0.08) in js/cymafield.js, the same value the
    // coverage ramp below uses and the exporter contours. All three must
    // agree or the export is a different weight from the screen.
    float m = smoothstep(0.05, 0.11, T);
    gl_FragColor = mix(vec4(mix(uGround, uInk, m), 1.0), vec4(uInk, m), uTransparent);
    return;
  }

  if (uView >= 1.5) {
    // CENTRELINE, not the water's edge.
    //
    // Stroking the boundary of a ribbon draws BOTH its sides, so every curve
    // came out as a doubled line with a parallel twin. The reference is a
    // single continuous curve — which is the nodal line itself, the ribbon's
    // spine. So stroke psi = 0 directly, and for the blob form stroke its
    // outline, since a filled mass has no spine to trace.
    vec2 ep = vec2(px, 0.0);
    float f0 = psi(p);
    vec2 gp = vec2(psi(p + ep.xy) - psi(p - ep.xy),
                   psi(p + ep.yx) - psi(p - ep.yx)) / (2.0 * px);
    // Divide by the gradient to turn a field difference into a real distance,
    // or the stroke fattens wherever the field happens to be shallow.
    float dCentre = abs(f0) / max(length(gp), 1e-4);

    float gmag = max(length(grad) / (2.0 * px), 1e-4);
    float dEdge = abs(T - 0.08) / gmag;

    // Detailed Cymatic traces the CENTRELINE — outlining a nodal ribbon's
    // boundary draws both sides of every line and every curve arrives doubled.
    // A metaball has no spine, so it keeps its boundary.
    float d = mix(dCentre, dEdge, uMode);

    // Gate by water PRESENCE as a multiplier, not by dividing the distance:
    // the division let isolated points where the field grazes zero outside
    // the figure sneak through as speckle dots across the plate.
    float wet = mix(smoothstep(0.04, 0.12, T), 1.0, uMode);
    float line = (1.0 - smoothstep(uLineW * 0.5, uLineW, d)) * wet;
    gl_FragColor = mix(vec4(mix(uGround, uInk, line), 1.0), vec4(uInk, line), uTransparent);
    return;
  }

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

  // Refraction is its own control now: how hard the ground bends through
  // the water, independent of how much that bending splits into colour.
  vec2 ruv = vUv + N.xz * T * 0.055 * uRefract * (1.0 + uDispersion * 0.4);
  float vign = 1.0 - 0.35 * length(vUv - 0.5);

  // With a backdrop loaded, the water refracts THAT — which is what makes it
  // bend type sitting behind it, the way the reference does. Sampled per
  // channel at slightly different offsets so the displacement itself splits
  // into colour at steep angles, rather than colour being painted on.
  vec3 back, backPlain;
  if (uHasBack > 0.5) {
    float sp = uDispersion * 0.004 * T;
    back = vec3(texture2D(uBackTex, ruv + N.xz * sp).r,
                texture2D(uBackTex, ruv).g,
                texture2D(uBackTex, ruv - N.xz * sp).b);
    backPlain = texture2D(uBackTex, vUv).rgb;
  } else {
    float bandY = 0.5 + 0.5 * sin(ruv.y * 11.0 + ruv.x * 3.0);
    back = uGround * (vign - 0.035 + 0.05 * bandY);
    backPlain = uGround * (1.0 - 0.35 * length(vUv - 0.5));
  }

  float lap = waterAt(p + e.xy) + waterAt(p - e.xy)
            + waterAt(p + e.yx) + waterAt(p - e.yx) - 4.0 * T;
  float caustic = clamp(-lap * 9.0, 0.0, 1.0)
                * (0.82 + 0.18 * sin(mt * 1.25 + p.x * 4.0 + p.y * 3.1));

  // Depth: how heavily the water takes on its own colour with thickness.
  // High values give the near-black interiors of the reference, where the
  // shape reads almost entirely from its rim.
  vec3 body = mix(back, uDeep, clamp(T * 0.55 * uDepth, 0.0, 1.0));
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

  // Rim: the bright meniscus tracing the edge. In the reference this is what
  // carries the whole silhouette, so it gets its own control rather than
  // riding on Gloss.
  float rim = pow(clamp(length(grad) * 7.0, 0.0, 1.0), 0.65);

  vec3 col = body
           + vec3(1.0) * spec * 0.85 * uGloss
           + vec3(1.0) * fres * 0.16 * uGloss
           + vec3(1.0) * rim * fres * uRim * 0.9
           + (iri - 0.5) * curv * fres * uDispersion * 0.34;

  float cov = smoothstep(0.02, 0.14, T);   // ramp centred on WATER_EDGE
  col = mix(backPlain, col, cov);
  gl_FragColor = mix(vec4(col, 1.0), vec4(col, cov), uTransparent);
}`;
