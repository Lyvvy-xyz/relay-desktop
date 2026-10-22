// The frog: pixel art drawn from simple shapes every frame on a small canvas that CSS scales up,
// which lets his belly move with each breath. mood.meal() is null or { at, count, folder, from: {x,
// y} } for just-dropped files; mood.carrying() is null or { count, folder, at: {x, y} } while files
// are dragged over (canvas pixels).

const W = 40;
const H = 40;
const FRAME_MILLISECONDS = 125; // 8 fps
const COLORS = {
  outline: "#10241e", skin: "#6fbf7f", shade: "#4b9a63", light: "#a9e39a", belly: "#d4efb8",
  white: "#f4faf7", mouth: "#3a1f22", tongue: "#f18768", sweat: "#8fd3ff", bubble: "#cdeeff",
  huff: "rgba(190, 214, 206, 0.75)", zzz: "#a1b1aa", alert: "#f18768", ground: "rgba(0, 0, 0, 0.28)",
  hat: "#5b4bb7", hatBand: "#e2b65c", star: "#ffe27a", folder: "#e2b65c", folderTab: "#c9993f",
};

// Breathing and eye openness per mood (0 open, 1 shut).
const MOODS = {
  idle: { period: 3.0, swell: 2, lid: 0.5 },
  working: { period: 1.4, swell: 2, lid: 0.25, hop: 1.4 },
  attention: { period: 1.8, swell: 1, lid: 0, hop: 1.0 },
  excited: { period: 0.8, swell: 1, lid: 0 },
  sleepy: { period: 4.4, swell: 3, lid: 1 },
  eating: { period: 0.9, swell: 1, lid: 0 },
};

// Dropped files fly into his mouth, then he closes it and swallows.
const MEAL_SECONDS = 1.9;
const SWALLOW_AT = 1.0;
const FLIGHT_SECONDS = 0.6;
const MOST_FILES_SHOWN = 3;
// File icon. k outline, w paper, l text.
const FILE_ICON = [
  "kkkkk..",
  "kwwwkk.",
  "kwwwkwk",
  "kwwwkkk",
  "kllllwk",
  "kwwwwwk",
  "kllllwk",
  "kwwwwwk",
  "kkkkkkk",
];

// Folder icon. k outline, t tab, y folder.
const FOLDER_ICON = [
  ".kkkk....",
  "kttttk...",
  "kkkkkkkkk",
  "kyyyyyyyk",
  "kyyyyyyyk",
  "kyyyyyyyk",
  "kyyyyyyyk",
  "kkkkkkkkk",
];
const ICON_FILLS = { k: "outline", w: "white", l: "zzz", t: "folderTab", y: "folder" };

const Z_GLYPH = [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]];

// Wizard hat. k outline, p purple, b band, y star.
const WIZARD_HAT = [
  ".........kk.....",
  "........kpk.....",
  ".......kppk.....",
  "......kpppk.....",
  "......kpyppk....",
  ".....kpppppk....",
  ".....kppppppk...",
  "....kpppyppppk..",
  "....kbbbbbbbbk..",
  ".kkpppppppppppkk",
  "kppppppppppppppk",
  ".kkkkkkkkkkkkkk.",
];

export function startFrog(canvas, mood) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const px = (x, y, color) => {
    if (x >= 0 && y >= 0 && x < W && y < H) {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  };
  const timers = { blinkUntil: 0, nextBlink: 2, yawnUntil: 0, nextYawn: 8, nextGlance: 0 };
  let lookX = 0;
  let lookTarget = 0;
  // Draws an icon at (left, top). skip(y) hides rows that have been swallowed.
  const drawIcon = (icon, left, top, skip = () => false) => {
    icon.forEach((row, y) => [...row].forEach((cell, x) => {
      if (ICON_FILLS[cell] && !skip(top + y)) px(left + x, top + y, COLORS[ICON_FILLS[cell]]);
    }));
  };

  function frame() {
    const t = performance.now() / 1000;
    const state = MOODS[mood.state()] ? mood.state() : "idle";
    const style = MOODS[state];
    ctx.clearRect(0, 0, W, H);

    // Breathing: a cosine rounded to whole pixels.
    const phase = (t % style.period) / style.period;
    const breath = (1 - Math.cos(phase * Math.PI * 2)) / 2;
    const swell = Math.round(breath * style.swell);

    // Blinks, the odd yawn, and now and then a glance at the mouse.
    if (t > timers.nextBlink) {
      timers.blinkUntil = t + 0.3;
      timers.nextBlink = t + 3 + Math.random() * 4;
    }
    if (state === "idle" && t > timers.nextYawn) {
      timers.yawnUntil = t + 2;
      timers.nextYawn = t + 12 + Math.random() * 12;
    }
    const carrying = mood.carrying();
    if (carrying) {
      // Watch the files.
      lookTarget = Math.max(-1, Math.min(1, Math.round((carrying.at.x - W / 2) / 6)));
    } else if (t > timers.nextGlance) {
      lookTarget = Math.max(-1, Math.min(1, Math.round(mood.look.x / 70)));
      timers.nextGlance = t + (state === "idle" ? 1.8 : 0.5);
    }
    lookX += Math.sign(lookTarget - lookX);
    const yawning = state === "idle" && t < timers.yawnUntil;
    const meal = mood.meal();
    const sinceMeal = meal ? t - meal.at : Infinity;
    const gulping = sinceMeal < SWALLOW_AT;
    const chewing = sinceMeal >= SWALLOW_AT && sinceMeal < MEAL_SECONDS;
    // Eyes closed while swallowing.
    const lid = chewing || yawning || t < timers.blinkUntil ? 1 : style.lid;

    let hop = 0;
    if (style.hop) {
      const hopPhase = (t % style.hop) / style.hop;
      hop = hopPhase < 0.12 ? -2 : hopPhase < 0.24 ? -1 : 0;
    }

    // Body: an ellipse that widens and flattens on each breath, plus two eye bumps.
    const ground = 36;
    const cheeks = chewing && sinceMeal < SWALLOW_AT + 0.4 ? 2 : 0;
    const rx = 15 + swell + cheeks;
    const ry = 10 - (swell >= 2 ? 1 : 0);
    const cx = W / 2 - 0.5;
    const cy = ground - ry + hop;
    const bumps = [cx - 7, cx + 7].map((x) => ({ x, y: cy - 7 }));
    const inBody = (x, y) => {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) return true;
      return bumps.some((bump) => (x - bump.x) ** 2 + (y - bump.y) ** 2 <= 21);
    };
    const inBelly = (x, y) => ((x - cx) / (rx * 0.68)) ** 2 + ((y - cy - 5) / (ry * 0.48)) ** 2 <= 1;

    for (let x = cx - rx - 1; x <= cx + rx + 1; x += 1) {
      px(x, ground + 1, COLORS.ground);
    }
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (inBody(x, y)) {
          const color = inBelly(x, y) ? COLORS.belly : y >= cy + ry - 2 ? COLORS.shade : COLORS.skin;
          px(x, y, color);
        } else if (inBody(x + 1, y) || inBody(x - 1, y) || inBody(x, y + 1) || inBody(x, y - 1)) {
          px(x, y, COLORS.outline);
        }
      }
    }
    for (const bump of bumps) px(bump.x - 2, bump.y - 3, COLORS.light);
    // Hands.
    for (const side of [-1, 1]) {
      for (const offset of [5, 6, 7]) {
        px(cx + side * offset, ground - 1 + hop, COLORS.shade);
        px(cx + side * offset, ground + hop, COLORS.outline);
      }
    }

    // Eyes: whites, pupils and lids.
    for (const bump of bumps) {
      const ex = bump.x;
      const ey = bump.y;
      for (let y = ey - 3; y <= ey + 3; y += 1) {
        for (let x = ex - 3; x <= ex + 3; x += 1) {
          if ((x - ex) ** 2 + (y - ey) ** 2 <= 9.5) px(x, y, COLORS.white);
        }
      }
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) px(ex - 1 + lookX + dx, ey + dy, COLORS.outline);
      if (lid >= 1) {
        for (let y = ey - 3; y <= ey + 3; y += 1) {
          for (let x = ex - 3; x <= ex + 3; x += 1) {
            if ((x - ex) ** 2 + (y - ey) ** 2 <= 9.5) px(x, y, COLORS.skin);
          }
        }
        for (let x = ex - 2; x <= ex + 2; x += 1) px(x, ey + 1, COLORS.outline);
      } else if (lid > 0) {
        const rows = Math.round(lid * 6);
        for (let y = ey - 3; y < ey - 3 + rows; y += 1) {
          for (let x = ex - 3; x <= ex + 3; x += 1) {
            if ((x - ex) ** 2 + (y - ey) ** 2 <= 9.5) px(x, y, COLORS.skin);
          }
        }
        for (let x = ex - 3; x <= ex + 3; x += 1) {
          if ((x - ex) ** 2 + (ey - 3 + rows - ey) ** 2 <= 9.5) px(x, ey - 3 + rows, COLORS.outline);
        }
      }
    }

    // Nostrils and mouth: a half smile, or open for a yawn or food.
    px(cx - 2, cy - 3, COLORS.outline);
    px(cx + 2, cy - 3, COLORS.outline);
    const open = gulping ? 4 : yawning ? 3 : state === "excited" ? 3 : state === "attention" ? 1 : 0;
    if (open) {
      for (let y = cy; y <= cy + open; y += 1) {
        for (let x = cx - 6; x <= cx + 6; x += 1) {
          const inside = ((x - cx) / 6.5) ** 2 + ((y - cy - open / 2) / (open / 2 + 0.6)) ** 2 <= 1;
          if (inside) px(x, y, y === cy + open && Math.abs(x - cx) <= 2 && state === "excited" ? COLORS.tongue : COLORS.mouth);
        }
      }
    } else {
      for (let x = cx - 8; x <= cx + 7; x += 1) px(x, cy, COLORS.outline);
      px(cx + 8, cy - 1, COLORS.outline);
    }

    // Dropped files arc from the drop point into his mouth. Rows past his lip aren't drawn, so they
    // look swallowed.
    if (gulping) {
      const icon = meal.folder ? FOLDER_ICON : FILE_ICON;
      for (let index = 0; index < Math.min(meal.count, MOST_FILES_SHOWN); index += 1) {
        const progress = Math.min(1, Math.max(0, (sinceMeal - index * 0.15) / FLIGHT_SECONDS));
        if (progress >= 1) continue;
        const eased = progress * progress;
        const startX = meal.from.x + index * 2 - 3;
        const startY = meal.from.y - index * 2 - 3;
        const left = startX + (cx - 2 - startX) * eased;
        const top = startY + (cy - 1 - startY) * eased - Math.sin(progress * Math.PI) * 5;
        drawIcon(icon, left, top, (row) => progress > 0.6 && row > cy + 1);
      }
    }

    // Files being dragged hang under the cursor and bob slightly.
    if (carrying && !gulping) {
      const icon = carrying.folder ? FOLDER_ICON : FILE_ICON;
      const bob = Math.round(Math.sin(t * 9) * 0.6);
      const shown = Math.min(carrying.count, MOST_FILES_SHOWN);
      // First file on the cursor, the rest fanned out up and to the right.
      const left = Math.max(0, Math.min(W - icon[0].length - (shown - 1) * 4, carrying.at.x - 3));
      const top = Math.max((shown - 1) * 3 + 1, Math.min(H - icon.length, carrying.at.y - 4));
      for (let index = shown - 1; index >= 0; index -= 1) {
        drawIcon(icon, left + index * 4, top - index * 3 + bob);
      }
    }

    // Wizard hat, with the odd sparkle.
    if (mood.hat()) {
      const left = cx - 8;
      const top = cy - 7 - 4 - WIZARD_HAT.length + 1;
      const fills = { k: COLORS.outline, p: COLORS.hat, b: COLORS.hatBand, y: COLORS.star };
      WIZARD_HAT.forEach((row, y) => [...row].forEach((cell, x) => {
        if (fills[cell]) px(left + x, top + y, fills[cell]);
      }));
      if (Math.random() < 0.35) {
        px(left + 9 + Math.round(Math.random() * 6 - 3), top - 1 + Math.round(Math.random() * 3 - 2), COLORS.star);
      }
    }

    // Per-mood extras.
    if ((state === "idle" || state === "working") && phase > 0.55 && phase < 0.85) {
      const drift = Math.floor((phase - 0.55) * 10);
      px(cx - 4 - drift, cy - 4 - drift, COLORS.huff);
      px(cx - 5 - drift, cy - 3 - drift, COLORS.huff);
    }
    if (state === "working") {
      const drop = Math.floor((t * 5) % 5);
      px(cx + rx - 3, cy - 6 + drop, COLORS.sweat);
      px(cx + rx - 3, cy - 5 + drop, COLORS.sweat);
    }
    if (state === "attention") {
      const ax = cx + rx - 1;
      const ay = cy - ry - 5;
      for (const dy of [0, 1, 2]) px(ax, ay + dy, COLORS.alert);
      px(ax, ay + 4, COLORS.alert);
    }
    if (state === "sleepy") {
      // A snot bubble that grows with each breath, then pops.
      const size = Math.floor(((t % 4) / 4) * 3);
      for (let y = -size; y <= size; y += 1) {
        for (let x = -size; x <= size; x += 1) {
          if (size && x * x + y * y <= size * size + 0.5) px(cx + 3 + size + x, cy - 3 + y, COLORS.bubble);
        }
      }
      for (const [index, delay] of [[0, 0], [1, 1.3]]) {
        const rise = ((t + delay) % 2.6) / 2.6;
        const zx = cx + 8 + index * 4 + Math.round(rise * 3);
        const zy = cy - ry - 2 - Math.round(rise * 6) - index * 3;
        if (rise < 0.85) for (const [dx, dy] of Z_GLYPH) px(zx + dx, zy + dy, COLORS.zzz);
      }
    }
  }

  frame();
  setInterval(frame, FRAME_MILLISECONDS);
  // Redraw now, between frames, so dragged files keep up with the cursor.
  return { redraw: frame };
}
