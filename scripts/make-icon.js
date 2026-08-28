// 生成应用图标(纯 Node,无第三方依赖):build/icon.png(256) build/tray.png(32) build/icon.ico(256)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, pixelFn) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 圆角矩形 SDF
function roundedRectSDF(x, y, w, h, r, px, py) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function makeIcon(size) {
  return encodePNG(size, size, (x, y) => {
    const d = roundedRectSDF(0, 0, size, size, size * 0.18, x + 0.5, y + 0.5);
    if (d > 0) return [0, 0, 0, 0];
    const t = y / size;
    // 垂直渐变蓝 #3b82f6 -> #2563eb
    const r = Math.round(59 + (37 - 59) * t);
    const g = Math.round(130 + (99 - 130) * t);
    const b = Math.round(246 + (235 - 246) * t);
    // 白色对勾
    const th = size * 0.085;
    const s1 = segDist(x + 0.5, y + 0.5, size * 0.26, size * 0.55, size * 0.44, size * 0.73);
    const s2 = segDist(x + 0.5, y + 0.5, size * 0.44, size * 0.73, size * 0.76, size * 0.32);
    if (Math.min(s1, s2) <= th) return [255, 255, 255, 255];
    return [r, g, b, 255];
  });
}

const png256 = makeIcon(256);
fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(path.join(outDir, 'tray.png'), makeIcon(32));

// ICO(内嵌 256 PNG,Windows Vista+ 支持)
const icondir = Buffer.alloc(6);
icondir.writeUInt16LE(0, 0); // reserved
icondir.writeUInt16LE(1, 2); // type: icon
icondir.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = 0; // width 256
entry[1] = 0; // height 256
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bit count
entry.writeUInt32LE(png256.length, 8); // bytes in res
entry.writeUInt32LE(22, 12); // offset
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([icondir, entry, png256]));

console.log('icons generated: build/icon.png, build/tray.png, build/icon.ico');
