// A handful of chicks hop out of a badge the moment it is earned: they
// leap up, tumble, land past the badge and fade. Nothing under reduced
// motion; the badge turning green carries the news on its own.
//
// Cheap on purpose: the chick is drawn once into a small sprite (two
// frames: eye open, eye shut) and stamped with drawImage, and the
// canvas covers only a box around the badge, not the viewport.

const TTL = 1.3;
const COUNT = 6;
const GRAVITY = 1400;
const BOX = { w: 480, h: 360 };
const SPRITE = 32;

// One chick drawn around the origin, facing +x, about 14px tall.
const drawChick = (ctx, blink) => {
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

let sprites = null;

const sprite = (dpr) => {
  if (sprites && sprites.dpr === dpr) return sprites;

  const make = (blink) => {
    const c = document.createElement("canvas");

    c.width = SPRITE * dpr;
    c.height = SPRITE * dpr;

    const ctx = c.getContext("2d");

    ctx.scale(dpr, dpr);
    ctx.translate(SPRITE / 2, SPRITE / 2);
    drawChick(ctx, blink);

    return c;
  };

  sprites = { dpr, open: make(false), shut: make(true) };

  return sprites;
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
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const left = Math.max(0, Math.round(from.x - BOX.w / 2));
  const top = Math.max(0, Math.round(from.y - BOX.h * 0.7));
  const w = Math.min(BOX.w, window.innerWidth - left);
  const h = Math.min(BOX.h, window.innerHeight - top);
  const canvas = document.createElement("canvas");

  canvas.className = "order-chicks";
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.left = `${left}px`;
  canvas.style.top = `${top}px`;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const { open, shut } = sprite(dpr);

  ctx.scale(dpr, dpr);

  const parts = [];

  for (let i = 0; i < COUNT; i += 1) {
    const dir = i % 2 ? 1 : -1;

    parts.push({
      x: from.x - left,
      y: from.y - top,
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
    ctx.clearRect(0, 0, w, h);

    for (const p of parts) {
      p.life += dt;
      if (p.life < p.delay) {
        alive += 1;
        continue;
      }
      if (p.life > TTL + p.delay) continue;
      if (p.y > h + SPRITE) continue;
      alive += 1;
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;

      const t = p.life - p.delay;
      const img = Math.floor(t * 6) % 7 === 3 ? shut : open;

      ctx.save();
      ctx.globalAlpha = Math.min(1, (TTL - t) / 0.35);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(p.scale * p.face, p.scale);
      ctx.drawImage(img, -SPRITE / 2, -SPRITE / 2, SPRITE, SPRITE);
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
