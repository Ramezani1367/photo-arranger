/*
 * pdf-writer.js — ساخت فایل PDF چاپی از تصاویر JPEG بدون هیچ کتابخانه‌ی خارجی
 * (چون اپ باید آفلاین و بدون CDN کار کند)
 *
 * ورودی هر صفحه:
 *   { widthMM, heightMM, items: [ { xMM, yMM, wMM, hMM, rotation, imageKey, jpeg: Uint8Array } ] }
 *   x/y = گوشه‌ی بالا-چپ کادر تصویر، نسبت به گوشه‌ی بالا-چپ کاغذ (میلی‌متر)
 *   rotation = چرخش ساعتگرد بر حسب درجه (۰/۹۰/۱۸۰/۲۷۰ مستقیماً با ماتریس PDF، بقیه با تصویر raster)
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PDFWriter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MM_TO_PT = 72 / 25.4; // هر میلی‌متر = ۲.۸۳۴۶۴۵۶۷ پوینت

  function mmToPt(mm) { return mm * MM_TO_PT; }

  // عدد با حداکثر ۴ رقم اعشار، بدون صفر اضافه
  function n(v) {
    var r = Math.round(v * 10000) / 10000;
    if (Object.is(r, -0)) r = 0;
    return String(r);
  }

  function imageObject(w, h, cs, bpc, bytes) {
    var dict = '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
      ' /ColorSpace /' + cs + ' /BitsPerComponent ' + bpc +
      ' /Filter /DCTDecode /Length ' + bytes.length + ' >>';
    return { head: dict, stream: bytes };
  }

  function streamObject(text) {
    var enc = new TextEncoder();
    var body = enc.encode(text);
    var dict = '<< /Length ' + body.length + ' >>';
    return { head: dict, stream: body };
  }

  // ماتریس تبدیل تصویر برای حالت چرخیده (۰/۹۰/۱۸۰/۲۷۰ درجه ساعتگرد)
  // خروجی: [a b c d e f] + ابعاد خود تصویر (w0,h0) که در PDF استفاده می‌شود
  function rotationMatrix(rotDeg, boxWpt, boxHpt) {
    var k = ((Math.round(rotDeg / 90) % 4) + 4) % 4;
    var swap = (k === 1 || k === 3);
    var w0 = swap ? boxHpt : boxWpt;
    var h0 = swap ? boxWpt : boxHpt;
    var m;
    // تصویر در واحدِ [0,1]² رسم می‌شود؛ محور y آن در PDF رو به بالاست.
    // این ماتریس‌ها با محاسبه‌ی عددی گوشه‌ها تأیید شده‌اند (test/verify_pdf.py).
    if (k === 0) m = [w0, 0, 0, h0, 0, 0];             // بدون چرخش
    else if (k === 1) m = [0, -w0, h0, 0, 0, w0];      // ۹۰ درجه ساعتگرد
    else if (k === 2) m = [-w0, 0, 0, -h0, w0, h0];    // ۱۸۰ درجه
    else m = [0, w0, -h0, 0, h0, 0];                   // ۲۷۰ درجه ساعتگرد
    return { m: m, w0: w0, h0: h0 };
  }

  function contentForPage(widthMM, heightMM, items, imageRefs) {
    var W = mmToPt(widthMM), H = mmToPt(heightMM);
    var out = [];
    // پس‌زمینه‌ی سفید کاغذ
    out.push('1 1 1 rg 0 0 ' + n(W) + ' ' + n(H) + ' re f');
    items.forEach(function (it) {
      var x = mmToPt(it.xMM);
      var yTop = mmToPt(it.yMM);
      var w = mmToPt(it.wMM);
      var h = mmToPt(it.hMM);
      var y = H - yTop - h; // تبدیل مبدأ بالا-چپ به پایین-چپ PDF
      var name = imageRefs[it.imageKey];
      if (!name) return;

      var rot = it.rotation || 0;
      if (rot === 0) {
        // کلیپ تا کادر عکس: اگر تصویر بزرگ‌تر از کادر باشد (کراپ/cover) بریده می‌شود
        out.push('q ' + n(x) + ' ' + n(y) + ' ' + n(w) + ' ' + n(h) + ' re W n');
        out.push(n(w) + ' 0 0 ' + n(h) + ' ' + n(x) + ' ' + n(y) + ' cm /' + name + ' Do Q');
        return;
      }

      var isCardinal = Math.abs(((rot % 90) + 90) % 90) < 0.01;
      out.push('q');
      // محدود کردن به کادر تصویر
      out.push(n(x) + ' ' + n(y) + ' ' + n(w) + ' ' + n(h) + ' re W n');
      if (isCardinal) {
        var r = rotationMatrix(rot, w, h);
        var m = r.m;
        out.push('1 0 0 1 ' + n(x) + ' ' + n(y) + ' cm');
        out.push(n(m[0]) + ' ' + n(m[1]) + ' ' + n(m[2]) + ' ' + n(m[3]) + ' ' + n(m[4]) + ' ' + n(m[5]) + ' cm');
        out.push('/' + name + ' Do');
      } else {
        // چرخش دلخواه: کادر تصویر = باکس محیطیِ تصویرِ چرخیده
        var cx = w / 2, cy = h / 2;
        var a = -rot * Math.PI / 180; // PDF پادساعتگرد است، زاویه‌ی ما ساعتگرد
        var cos = Math.cos(a), sin = Math.sin(a);
        var iw = w, ih = h;
        var corners = [
          [-iw / 2, -ih / 2], [iw / 2, -ih / 2], [iw / 2, ih / 2], [-iw / 2, ih / 2]
        ].map(function (p) {
          return [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos];
        });
        var maxX = Math.max.apply(null, corners.map(function (p) { return p[0]; }));
        var maxY = Math.max.apply(null, corners.map(function (p) { return p[1]; }));
        out.push('1 0 0 1 ' + n(x + cx - maxX) + ' ' + n(y + cy - maxY) + ' cm');
        out.push(n(cos) + ' ' + n(sin) + ' ' + n(-sin) + ' ' + n(cos) + ' ' + n(maxX) + ' ' + n(maxY) + ' cm');
        out.push('/' + name + ' Do');
      }
      out.push('Q');
    });
    return out.join('\n');
  }

  function buildPdf(pages) {
    var objs = [];
    function add(o) { objs.push(o); return objs.length; } // شماره‌ی آبجکت = ایندکس+۱

    // شماره‌ها از قبل رزرو می‌شوند: ۱=Catalog ۲=Pages ۳=Resources
    var catalogNum = add(null), pagesNum = add(null), resourcesNum = add(null);

    var imageEntries = [];
    var pageChildren = [];

    pages.forEach(function (page) {
      var refs = {};
      (page.items || []).forEach(function (it) {
        if (refs[it.imageKey]) return;
        var num = add(imageObject(it.widthPx, it.heightPx, it.colorSpace || 'DeviceRGB', 8, it.jpeg));
        refs[it.imageKey] = 'Im' + num;
        imageEntries.push(num);
      });

      var text = contentForPage(page.widthMM, page.heightMM, page.items || [], refs);
      var contentNum = add(streamObject(text));
      var pageNum = add({
        head: '<< /Type /Page /Parent ' + pagesNum + ' 0 R /MediaBox [0 0 ' +
          n(mmToPt(page.widthMM)) + ' ' + n(mmToPt(page.heightMM)) + '] /Resources ' + resourcesNum +
          ' 0 R /Contents ' + contentNum + ' 0 R >>'
      });
      pageChildren.push(pageNum);
    });

    var xobj = imageEntries.map(function (num) { return '/Im' + num + ' ' + num + ' 0 R'; }).join(' ');
    objs[resourcesNum - 1] = { head: '<< /XObject << ' + xobj + ' >> >>' };
    objs[pagesNum - 1] = {
      head: '<< /Type /Pages /Count ' + pageChildren.length + ' /Kids [' +
        pageChildren.map(function (p) { return p + ' 0 R'; }).join(' ') + '] >>'
    };
    objs[catalogNum - 1] = { head: '<< /Type /Catalog /Pages ' + pagesNum + ' 0 R >>' };

    // ---- مونتاژ بایت‌ها ----
    var enc = new TextEncoder();
    var chunks = [];
    var length = 0;
    function pushText(s) { var b = enc.encode(s); chunks.push(b); length += b.length; }
    function pushBytes(b) { chunks.push(b); length += b.length; }

    pushText('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    var offsets = [];
    for (var i = 0; i < objs.length; i++) {
      offsets.push(length);
      var obj = objs[i];
      pushText((i + 1) + ' 0 obj\n' + obj.head + '\n');
      if (obj.stream) {
        pushText('stream\n');
        pushBytes(obj.stream);
        pushText('\nendstream\n');
      }
      pushText('endobj\n');
    }

    var xrefOffset = length;
    var xref = 'xref\n0 ' + (objs.length + 1) + '\n';
    xref += '0000000000 65535 f \r\n';
    for (var k = 0; k < offsets.length; k++) {
      xref += String(offsets[k]).padStart(10, '0') + ' 00000 n \r\n';
    }
    xref += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogNum + ' 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
    pushText(xref);

    var out = new Uint8Array(length);
    var pos = 0;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], pos); pos += chunks[c].length; }
    return out;
  }

  return {
    build: buildPdf,
    MM_TO_PT: MM_TO_PT,
    _internals: { mmToPt: mmToPt, rotationMatrix: rotationMatrix, contentForPage: contentForPage, n: n }
  };
});
