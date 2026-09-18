// A handful of chicks hop out of a badge the moment it is earned. Each
// is a little yellow body and head with a beak and an eye; they leap
// up, tumble, land past the badge and fade. Nothing under reduced
// motion; the badge turning green carries the news on its own.

const TTL = 1.3;
const COUNT = 6;
const GRAVITY = 1400;

// One chick drawn around the origin, facing +x, about 14px tall.
const chick = (ctx, blink) => {
  ctx.fillStyle = "#ffd94a";
  ctx.beginPath();
  ctx.ellipse(0, 3, 6.5, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffe27a";
  ctx.beginPath();
  ctx.arc(4, -4, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f2953c";
  ctx.beginPath();
  ctx.moveTo(8, -4.5);
  ctx.lineTo(12, -3.5);
  ctx.lineTo(8, -2.5);
  ctx.fill();
  ctx.fillStyle = "#1d1c1b";
  ctx.beginPath();
  if (blink) {
    ctx.rect(4.5, -5.5, 2, 0.8);
  } else {
    ctx.arc(5.5, -5, 1, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.fillStyle = "#f2c23a";
  ctx.beginPath();
  ctx.ellipse(-2, 3.5, 3, 2, -0.4, 0, Math.PI * 2);
  ctx.fill();
};

// `origin` is an element (the badge) or a { x, y } in viewport pixels.
export const celebrate = (origin) => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const from = origin instanceof Element
    ? (() => {
      const r = origin.getBoundingClientRect();

      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
    : origin;
  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.className = "order-chicks";
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");

  ctx.scale(dpr, dpr);

  const parts = [];

  for (let i = 0; i < COUNT; i += 1) {
    const dir = i % 2 ? 1 : -1;

    parts.push({
      x: from.x,
      y: from.y,
      vx: dir * (60 + Math.random() * 140),
      vy: -(380 + Math.random() * 220),
      rot: 0,
      spin: dir * (2 + Math.random() * 6),
      face: dir,
      scale: 0.8 + Math.random() * 0.4,
      delay: i * 0.04,
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
      if (p.life < p.delay) {
        alive += 1;
        continue;
      }
      if (p.life > TTL + p.delay) continue;
      alive += 1;
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;

      const t = p.life - p.delay;

      ctx.save();
      ctx.globalAlpha = Math.min(1, (TTL - t) / 0.35);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(p.scale * p.face, p.scale);
      chick(ctx, Math.floor(t * 6) % 7 === 3);
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
