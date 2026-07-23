// $1 Unistroke Recognizer (Wobbrock, Wilson, Li 2007) - bản rút gọn.
// Nhận một nét vẽ (mảng điểm {x,y}) và so khớp với các rune mẫu,
// trả về loại rune khớp nhất + điểm similarity (0..1).

const NUM_POINTS = 64;
const SQUARE_SIZE = 250;
const ANGLE_RANGE = deg2rad(45);
const ANGLE_PRECISION = deg2rad(2);
const PHI = 0.5 * (-1 + Math.sqrt(5));
const HALF_DIAGONAL = 0.5 * Math.sqrt(SQUARE_SIZE * SQUARE_SIZE * 2);

function deg2rad(d) {
  return (d * Math.PI) / 180;
}

function dist(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += dist(points[i - 1], points[i]);
  return d;
}

function resample(points, n) {
  const interval = pathLength(points) / (n - 1);
  if (!interval) return Array.from({ length: n }, () => ({ ...points[0] }));
  let D = 0;
  const pts = points.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (D + d >= interval) {
      const t = (interval - D) / d;
      const q = {
        x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
        y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
      };
      out.push(q);
      pts.splice(i, 0, q);
      D = 0;
    } else {
      D += d;
    }
  }
  while (out.length < n) out.push({ ...points[points.length - 1] });
  return out.slice(0, n);
}

function centroid(points) {
  let x = 0;
  let y = 0;
  points.forEach((p) => {
    x += p.x;
    y += p.y;
  });
  return { x: x / points.length, y: y / points.length };
}

function rotateBy(points, angle) {
  const c = centroid(points);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return { x: dx * cos - dy * sin + c.x, y: dx * sin + dy * cos + c.y };
  });
}

function indicativeAngle(points) {
  const c = centroid(points);
  return Math.atan2(c.y - points[0].y, c.x - points[0].x);
}

function boundingBox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach((p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  });
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function scaleToSquare(points, size) {
  const b = boundingBox(points);
  return points.map((p) => ({
    x: b.width === 0 ? p.x : (p.x - b.x) * (size / b.width),
    y: b.height === 0 ? p.y : (p.y - b.y) * (size / b.height),
  }));
}

function translateToOrigin(points) {
  const c = centroid(points);
  return points.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}

function pathDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += dist(a[i], b[i]);
  return d / a.length;
}

function distanceAtAngle(points, template, angle) {
  return pathDistance(rotateBy(points, angle), template);
}

function distanceAtBestAngle(points, template, aIn, bIn, threshold) {
  let a = aIn;
  let b = bIn;
  let x1 = PHI * a + (1 - PHI) * b;
  let f1 = distanceAtAngle(points, template, x1);
  let x2 = (1 - PHI) * a + PHI * b;
  let f2 = distanceAtAngle(points, template, x2);
  while (Math.abs(b - a) > threshold) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = PHI * a + (1 - PHI) * b;
      f1 = distanceAtAngle(points, template, x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = (1 - PHI) * a + PHI * b;
      f2 = distanceAtAngle(points, template, x2);
    }
  }
  return Math.min(f1, f2);
}

// Chuẩn hoá 1 nét vẽ thô về dạng có thể so sánh (dùng chung cho rune mẫu và nét người chơi vẽ).
export function normalizeStroke(rawPoints) {
  let pts = resample(rawPoints, NUM_POINTS);
  const angle = indicativeAngle(pts);
  pts = rotateBy(pts, -angle);
  pts = scaleToSquare(pts, SQUARE_SIZE);
  pts = translateToOrigin(pts);
  return pts;
}

export function buildTemplate(type, rawPoints) {
  return { type, points: normalizeStroke(rawPoints) };
}

// Trả về { type, similarity } - similarity trong khoảng 0..1, không all-or-nothing.
export function recognize(rawPoints, templates) {
  if (!rawPoints || rawPoints.length < 2) return { type: null, similarity: 0 };
  const points = normalizeStroke(rawPoints);
  let best = null;
  let bestDistance = Infinity;
  templates.forEach((t) => {
    const d = distanceAtBestAngle(points, t.points, -ANGLE_RANGE, ANGLE_RANGE, ANGLE_PRECISION);
    if (d < bestDistance) {
      bestDistance = d;
      best = t;
    }
  });
  const similarity = Math.max(0, 1 - bestDistance / HALF_DIAGONAL);
  return { type: best.type, similarity };
}

// ---- Rune mẫu (MVP: 3 rune cố định) ----
// Toạ độ trong không gian logic 0-300, khớp với LOGICAL_CANVAS trong app.js.
function circlePoints(cx, cy, r, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

export const RUNE_TEMPLATES = [
  buildTemplate('attack', [
    { x: 150, y: 20 },
    { x: 280, y: 260 },
    { x: 20, y: 260 },
    { x: 150, y: 20 },
  ]), // tam giác = Tấn công
  buildTemplate('defense', [
    { x: 40, y: 40 },
    { x: 260, y: 40 },
    { x: 260, y: 260 },
    { x: 40, y: 260 },
    { x: 40, y: 40 },
  ]), // vuông = Phòng thủ
  buildTemplate('utility', circlePoints(150, 150, 120, 32)), // tròn = Đa dụng
];

export const RUNE_LABELS = {
  attack: 'Tấn công (Tam giác)',
  defense: 'Phòng thủ (Vuông)',
  utility: 'Đa dụng (Tròn)',
};
