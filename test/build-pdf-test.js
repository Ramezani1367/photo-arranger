/* تست: ساخت PDF با همان ماژولی که در مرورگر استفاده می‌شود (js/pdf-writer.js) */
const fs = require('fs');
const path = require('path');
const PDFWriter = require('../js/pdf-writer.js');

function bytes(f) { return new Uint8Array(fs.readFileSync(path.join(__dirname, f))); }

// باکس محیطیِ تصویرِ چرخیده — دقیقاً همان کاری که اپلیکیشن هنگام چرخش انجام می‌دهد
function rotatedBox(wMM, hMM, rot) {
  const a = rot * Math.PI / 180;
  return {
    w: Math.abs(wMM * Math.cos(a)) + Math.abs(hMM * Math.sin(a)),
    h: Math.abs(wMM * Math.sin(a)) + Math.abs(hMM * Math.cos(a))
  };
}

// چیدمان A4 با حاشیه ۸mm و فاصله ۵mm، قالب ۲×۲
const margin = 8, gap = 5;
const W = 210, H = 297;
const cw = (W - 2 * margin - gap) / 2;
const ch = (H - 2 * margin - gap) / 2;
const cells = [
  { x: margin, y: margin },
  { x: margin + cw + gap, y: margin },
  { x: margin, y: margin + ch + gap },
  { x: margin + cw + gap, y: margin + ch + gap }
];

// مدل اپ: کادر همیشه هم‌نسبت با خود تصویر است؛ چرخش روی کل کادر اعمال می‌شود
function itemFrom(imgW, imgH, jpeg, key, cell, rot) {
  const s = Math.min(cw / imgW, ch / imgH);
  const w = imgW * s, h = imgH * s;
  return {
    imageKey: key, jpeg, widthPx: imgW, heightPx: imgH,
    xMM: cell.x + (cw - w) / 2,
    yMM: cell.y + (ch - h) / 2,
    wMM: w, hMM: h, rotation: rot
  };
}

const items = [
  itemFrom(400, 800, bytes('red.jpg'), 'k1', cells[0], 0),    // عمودی، بدون چرخش
  itemFrom(400, 800, bytes('red.jpg'), 'k2', cells[1], 90),   // عمودی چرخیده ۹۰° ساعتگرد
  itemFrom(600, 300, bytes('green.jpg'), 'k3', cells[2], 0),  // رسترِ چرخیده‌ی ۳۳° (مثل خروجی اپ)
  itemFrom(400, 800, bytes('red.jpg'), 'k4', cells[3], 180)   // ۱۸۰ درجه
];

// صفحه دوم: A5 با ۲ عکس
const A5W = 148, A5H = 210;
const a5cw = A5W - 2 * margin;
const a5ch = (A5H - 2 * margin - gap) / 2;
function a5Item(imgW, imgH, jpeg, key, row) {
  const s = Math.min(a5cw / imgW, a5ch / imgH);
  const w = imgW * s, h = imgH * s;
  return {
    imageKey: key, jpeg, widthPx: imgW, heightPx: imgH,
    xMM: margin + (a5cw - w) / 2,
    yMM: margin + row * (a5ch + gap) + (a5ch - h) / 2,
    wMM: w, hMM: h, rotation: 0
  };
}
const a5items = [
  a5Item(400, 800, bytes('red.jpg'), 'k5', 0),
  a5Item(800, 400, bytes('blue.jpg'), 'k6', 1)
];

const pdf = PDFWriter.build([
  { widthMM: W, heightMM: H, items },
  { widthMM: A5W, heightMM: A5H, items: a5items }
]);

const out = path.join(__dirname, 'sample.pdf');
fs.writeFileSync(out, Buffer.from(pdf));

const expected = {
  pages: [
    { wMM: W, hMM: H, boxes: items.map((it) => [it.xMM, it.yMM, it.wMM, it.hMM, it.rotation]) },
    { wMM: A5W, hMM: A5H, boxes: a5items.map((it) => [it.xMM, it.yMM, it.wMM, it.hMM, it.rotation]) }
  ]
};
fs.writeFileSync(path.join(__dirname, 'expected.json'), JSON.stringify(expected, null, 2));
console.log('PDF bytes:', pdf.length, '->', out);
