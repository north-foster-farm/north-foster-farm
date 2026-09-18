// A few feathers drift out from the pointer, once, when an order first
// qualifies for local delivery. Quiet by design: a dozen small shapes,
// a short rise, then a slow, swaying fall. Nothing under reduced
// motion; the badge carries the news on its own.

const COLORS = ["#fffdf7", "#f3ead8", "#cfe3d3", "#e7d3b3"];
const TTL = 1.5;
const COUNT = 12;

// One feather: a leaf-shaped vane with a short quill, drawn around the
// origin along the +x axis, about 14px long.
const feather = (ctx, color) => {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-7, 0);
  ctx.bezierCurveTo(-4, -4, 3, -4.5, 7, 0);
  ctx.bezierCurveTo(3, 4.5, -4, 4, -7, 0);
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-7, 0);
  ctx.lineTo(6, 0);
  ctx.stroke();
};

// `origin` is a { x, y } in viewport pixels, the pointer as a rule.
export const celebrate = (origin) => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.className = "order-feathers";
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");

  ctx.scale(dpr, dpr);

  const parts = [];

  for (let i = 0; i < COUNT; i += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const speed = 90 + Math.random() * 110;

    parts.push({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 4,
      sway: 1.5 + Math.random() * 2,
      phase: Math.random() * Math.PI * 2,
      scale: 0.7 + Math.random() * 0.5,
      color: COLORS[i % COLORS.length],
      life: 0,
    });
  }

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    let alive = 0;

    last = now;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (const p of parts) {
      p.life += dt;
      if (p.life > TTL) continue;
      alive += 1;

      // Light gravity and heavy drag: a brief lift, then a slow drift
      // down with a sideways sway, the way a feather falls.
      p.vy += 140 * dt;
      p.vx *= 0.96;
      p.vy = Math.min(p.vy, 55);
      p.x += (p.vx + Math.sin(p.life * p.sway + p.phase) * 28) * dt;
      p.y += p.vy * dt;
      p.rot += (p.spin + Math.cos(p.life * p.sway + p.phase) * 1.2) * dt;

      ctx.save();
      ctx.globalAlpha = 0.9 * Math.min(1, (TTL - p.life) / 0.5);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(p.scale, p.scale);
      feather(ctx, p.color);
      ctx.restore();
    }

    if (alive) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  };

  requestAnimationFrame(frame);
};
