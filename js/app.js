/*
 * app.js — «چیدمان عکس روی کاغذ»
 * انتخاب اسکرین‌شات/عکس → چیدمان خودکار روی A4 (۴ عکس) یا A5 (۲ عکس)
 * → ویرایش دستی (جابه‌جایی، بزرگ/کوچک، چرخش، کراپ) → خروجی PDF چاپی و JPG
 */
(function () {
  'use strict';

  // ---------- پیکربندی ----------
  var PAPERS = {
    A4: { w: 210, h: 297 },
    A5: { w: 148, h: 210 }
  };
  var TEMPLATES = { A4: { cols: 2, rows: 2 }, A5: { cols: 1, rows: 2 } };
  var MIN_W_MM = 12;

  // ---------- وضعیت برنامه ----------
  var paper = 'A4';
  var marginMM = 8;
  var gapMM = 5;
  var dpi = 300;
  var currentPage = 0;
  var zoom = 1;
  var gridOn = false;
  var pages = [];    // [{ items:[item] }]
  var photos = [];   // [photo]
  var selectedIdx = -1; // ایندکس آیتم انتخاب‌شده در صفحه‌ی جاری (پس از رندر دوباره حفظ می‌شود)
  var uid = 0;
  var undoStack = [];
  var redoStack = [];

  // ---------- ابزار ----------
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function r1(v) { return Math.round(v * 100) / 100; }
  function dist(x1, y1, x2, y2) { var dx = x1 - x2, dy = y1 - y2; return Math.sqrt(dx * dx + dy * dy); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // پیشوند دلخواه کاربر + زیرخط + تاریخ شمسی  →  prefix_1405-06-29.pdf
  function baseFileName() {
    var pre = (localStorage.getItem('ppa_prefix') || '').trim();
    if (!pre) pre = 'چیدمان';
    return pre + '_' + Jalali.todayString();
  }

  function outputFileName(ext, pageIndex) {
    var multi = pages.filter(function (p) { return p.items.length; }).length > 1;
    return baseFileName() + (multi ? '-' + (pageIndex + 1) : '') + '.' + ext;
  }

  function updateNamePreview() {
    var el = $('namePreview');
    if (el) el.textContent = baseFileName() + '.pdf';
  }

  // اشتراک‌گذاری به‌صورت فایل (Web Share API سطح ۲)؛ در مرورگرهای بدون پشتیبانی، دانلود
  function shareBlob(blob, filename, title) {
    var file = null;
    try { file = new File([blob], filename, { type: blob.type }); } catch (e) { file = null; }
    if (file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: title || filename }).catch(function (err) {
        if (err && err.name !== 'AbortError') {
          downloadBlob(blob, filename);
          toast('اشتراک ناموفق بود؛ فایل دانلود شد');
        }
      });
    } else {
      downloadBlob(blob, filename);
      toast('این مرورگر اشتراک فایل ندارد؛ فایل دانلود شد و از آنجا قابل اشتراک است');
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 8000);
  }

  function isJpegBytes(u8) { return u8 && u8.length > 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF; }

  function loadBitmap(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).catch(function () { return loadViaImg(blob); });
    }
    return loadViaImg(blob);
  }

  function loadViaImg(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('bad image')); };
      img.src = url;
    });
  }

  // ---------- افزودن عکس ----------
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return f && f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) { toast('فقط فایل تصویری قابل انتخاب است'); return; }
    $('busy').hidden = false;

    var skipped = 0;
    Promise.all(files.map(function (file) {
      return file.arrayBuffer().then(function (buf) {
        var u8 = new Uint8Array(buf);
        var blob = new Blob([u8], { type: file.type });
        // ابعاد طبیعی (بدون اعمال EXIF) برای تشخیص چرخش خودکار
        return new Promise(function (res) {
          var probe = new Image();
          var purl = URL.createObjectURL(blob);
          probe.onload = function () {
            var natW = probe.naturalWidth;
            URL.revokeObjectURL(purl);
            res(natW);
          };
          probe.onerror = function () { URL.revokeObjectURL(purl); res(0); };
          probe.src = purl;
        }).then(function (natW) {
          return loadBitmap(blob).then(function (bmp) {
            var rawUsable = isJpegBytes(u8) && natW === bmp.width;
            return {
              id: 'p' + (++uid),
              name: file.name || 'image',
              blob: blob,
              bitmap: bmp,
              w: bmp.width,
              h: bmp.height,
              rawBytes: rawUsable ? u8 : null
            };
          });
        });
      }).catch(function (err) { skipped++; return null; });
    })).then(function (list) {
      $('busy').hidden = true;
      var added = list.filter(Boolean);
      if (skipped) toast(skipped + ' فایل خوانده نشد');
      if (!added.length) return;
      photos = photos.concat(added);
      currentPage = pages.length ? pages.length - 1 : 0;
      rebuildPages();
      $('emptyHint').hidden = true;
      toast(added.length + ' عکس اضافه شد — حالا می‌توانید جابه‌جا و بزرگ/کوچک کنید');
    });
  }

  // بایت JPEG هر عکس برای PDF (بایت اصلی یا تبدیل دوباره با جهت درست)
  function getJpegData(photo) {
    if (photo.jpegData) return Promise.resolve(photo.jpegData);
    if (photo.rawBytes) {
      photo.jpegData = photo.rawBytes;
      photo.jpegW = photo.w; photo.jpegH = photo.h;
      return Promise.resolve(photo.jpegData);
    }
    var c = document.createElement('canvas');
    c.width = photo.w; c.height = photo.h;
    var cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(photo.bitmap, 0, 0);
    return new Promise(function (res, rej) {
      c.toBlob(function (b) {
        if (!b) { rej(new Error('toBlob failed')); return; }
        b.arrayBuffer().then(function (ab) {
          photo.jpegData = new Uint8Array(ab);
          photo.jpegW = c.width; photo.jpegH = c.height;
          res(photo.jpegData);
        });
      }, 'image/jpeg', 0.93);
    });
  }

  // ---------- صفحه‌بندی و چیدمان ----------
  function capacity() { var t = TEMPLATES[paper]; return t.cols * t.rows; }
  function newPage() { return { items: [] }; }

  function rebuildPages() {
    var cap = capacity();
    pages = [];
    for (var i = 0; i < photos.length; i += cap) {
      pages.push({
        items: photos.slice(i, i + cap).map(function (ph, k, arr) { return makeItem(ph, k, arr.length); })
      });
    }
    if (!pages.length) pages.push(newPage());
    currentPage = clamp(currentPage, 0, pages.length - 1);
    commit();
  }

  function cellRect(index, total) {
    var t = TEMPLATES[paper], p = PAPERS[paper];
    var cw = (p.w - 2 * marginMM - (t.cols - 1) * gapMM) / t.cols;
    var ch = (p.h - 2 * marginMM - (t.rows - 1) * gapMM) / t.rows;
    var col = index % t.cols, row = Math.floor(index / t.cols);
    // اگر صفحه کامل پر نشده، گروه عکس‌ها عموداً وسط کاغذ قرار می‌گیرد
    var usedRows = Math.ceil((total || t.cols * t.rows) / t.cols);
    var dy = (t.rows - usedRows) * (ch + gapMM) / 2;
    return {
      x: marginMM + col * (cw + gapMM),
      y: marginMM + row * (ch + gapMM) + dy,
      w: cw, h: ch
    };
  }

  function makeItem(photo, index, total) {
    var c = cellRect(index, total);
    var s = Math.min(c.w / photo.w, c.h / photo.h);
    var w = photo.w * s, h = photo.h * s;
    return {
      photo: photo,
      x: c.x + (c.w - w) / 2,
      y: c.y + (c.h - h) / 2,
      w: w, h: h,
      rotation: 0,
      scale: 1
    };
  }

  function dropEmptyPages() {
    var kept = pages.filter(function (p) { return p.items.length > 0; });
    pages = kept.length ? kept : [newPage()];
    currentPage = clamp(currentPage, 0, pages.length - 1);
  }

  function collectPhotos() {
    var out = [];
    pages.forEach(function (p) { p.items.forEach(function (it) { out.push(it.photo); }); });
    return out;
  }

  // ---------- Undo / Redo ----------
  function snapshot() {
    return {
      paper: paper, marginMM: marginMM, gapMM: gapMM, currentPage: currentPage,
      pages: pages.map(function (p) {
        return {
          items: p.items.map(function (it) {
            return { photo: it.photo, x: it.x, y: it.y, w: it.w, h: it.h, rotation: it.rotation, scale: it.scale };
          })
        };
      })
    };
  }
  function restore(s) {
    paper = s.paper; marginMM = s.marginMM; gapMM = s.gapMM; currentPage = s.currentPage;
    pages = s.pages.map(function (p) {
      return { items: p.items.map(function (it) { return Object.assign({}, it); }) };
    });
    renderPage();
  }
  function commit() {
    undoStack.push(snapshot());
    if (undoStack.length > 40) undoStack.shift();
    redoStack.length = 0;
    renderPage();
  }
  function undo() {
    if (undoStack.length < 2) { toast('چیزی برای بازگشت نیست'); return; }
    redoStack.push(undoStack.pop());
    restore(undoStack[undoStack.length - 1]);
  }
  function redo() {
    if (!redoStack.length) { toast('چیزی برای جلو رفتن نیست'); return; }
    var s = redoStack.pop();
    undoStack.push(s);
    restore(s);
  }

  // ---------- رندر ----------
  // ۱ میلی‌متر CSS = ۹۶/۲۵.۴ پیکسل؛ پس ضریب نمایش = پیکسل موجود ÷ عرض کاغذ به پیکسل
  var CSS_PX_PER_MM = 96 / 25.4;

  function screenScale() {
    var host = $('pageScroll');
    var availPx = Math.max(120, host.clientWidth - 20);
    var pagePx = PAPERS[paper].w * CSS_PX_PER_MM;
    return Math.max(0.05, availPx / pagePx) * zoom;
  }

  function applyScale() {
    var p = PAPERS[paper];
    var s = screenScale();
    var wrap = $('pageWrap');
    wrap.style.width = Math.round(p.w * CSS_PX_PER_MM * s) + 'px';
    wrap.style.height = Math.round(p.h * CSS_PX_PER_MM * s) + 'px';
    $('page').style.transform = 'scale(' + s + ')';
  }

  function renderPage() {
    var p = PAPERS[paper];
    var pageEl = $('page');
    pageEl.style.width = p.w + 'mm';
    pageEl.style.height = p.h + 'mm';
    applyScale();
    pageEl.innerHTML = '';

    if (gridOn) {
      var t = TEMPLATES[paper];
      for (var i = 0; i < t.cols * t.rows; i++) {
        var c = cellRect(i);
        var d = document.createElement('div');
        d.className = 'cellhint';
        d.style.left = c.x + 'mm'; d.style.top = c.y + 'mm';
        d.style.width = c.w + 'mm'; d.style.height = c.h + 'mm';
        pageEl.appendChild(d);
      }
    }

    var pg = pages[currentPage] || (pages[currentPage] = newPage());
    pg.items.forEach(function (it, idx) { pageEl.appendChild(buildItemEl(it, idx)); });
    paintSelection();

    $('pageInfo').textContent = 'صفحه ' + (currentPage + 1) + '/' + pages.length +
      ' — ' + pg.items.length + ' از ' + capacity() + ' عکس';
    $('emptyHint').hidden = photos.length > 0;
    renderPagesStrip();
    renderOrderList();
    syncControls();
  }

  // نوار ترتیب عکس‌ها: با درگ لمسی یا ماوس، عکس‌ها جابه‌جا می‌شوند و دوباره خودکار چیده می‌شوند.
  function renderOrderList() {
    var panel = $('orderPanel');
    var list = $('orderList');
    if (!panel || !list) return;
    var entries = [];
    pages.forEach(function (pg, pageIndex) {
      pg.items.forEach(function (item, itemIndex) {
        entries.push({ item: item, pageIndex: pageIndex, itemIndex: itemIndex });
      });
    });
    panel.hidden = entries.length === 0;
    list.innerHTML = '';
    $('orderCount').textContent = entries.length ? '— ' + entries.length + ' عکس' : '';
    if (!entries.length) return;

    entries.forEach(function (entry, orderIndex) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'order-card' +
        (entry.pageIndex === currentPage && entry.itemIndex === selectedIdx ? ' current' : '');
      card.dataset.orderIndex = String(orderIndex);
      card.setAttribute('aria-label', 'عکس شماره ' + (orderIndex + 1) + ': ' + entry.item.photo.name);

      var img = document.createElement('img');
      img.alt = '';
      var objectUrl = URL.createObjectURL(entry.item.photo.blob);
      img.src = objectUrl;
      img.onload = function () { URL.revokeObjectURL(objectUrl); };
      card.appendChild(img);

      var no = document.createElement('span');
      no.className = 'order-no';
      no.textContent = String(orderIndex + 1);
      card.appendChild(no);
      var name = document.createElement('span');
      name.className = 'order-name';
      name.textContent = entry.item.photo.name || 'عکس';
      card.appendChild(name);

      wireOrderCard(card);
      list.appendChild(card);
    });
  }

  function reorderByOrderIndex(from, to) {
    if (from === to || from < 0 || to < 0) return;
    var flat = [];
    pages.forEach(function (pg) { pg.items.forEach(function (item) { flat.push(item); }); });
    if (from >= flat.length || to >= flat.length) return;
    var moved = flat.splice(from, 1)[0];
    flat.splice(to, 0, moved);
    photos = flat.map(function (item) { return item.photo; });
    var cap = capacity();
    currentPage = clamp(Math.floor(to / cap), 0, Math.max(0, Math.ceil(photos.length / cap) - 1));
    selectedIdx = to % cap;
    rebuildPages();
    toast('ترتیب عکس‌ها تغییر کرد و چیدمان دوباره انجام شد');
  }

  function wireOrderCard(card) {
    var drag = null;
    var pointerId = null;

    card.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      pointerId = ev.pointerId;
      drag = {
        from: parseInt(card.dataset.orderIndex, 10),
        to: parseInt(card.dataset.orderIndex, 10),
        x: ev.clientX, y: ev.clientY, moved: false
      };
      card.classList.add('dragging');
      try { card.setPointerCapture(pointerId); } catch (e) { }
    });

    card.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== pointerId) return;
      var moved = Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 5;
      if (!moved && !drag.moved) return;
      drag.moved = true;
      ev.preventDefault();
      var target = document.elementFromPoint(ev.clientX, ev.clientY);
      var over = target && target.closest ? target.closest('#orderList .order-card') : null;
      document.querySelectorAll('#orderList .order-card.drop-target').forEach(function (el) {
        el.classList.remove('drop-target');
      });
      if (over && over !== card) {
        drag.to = parseInt(over.dataset.orderIndex, 10);
        over.classList.add('drop-target');
      } else if (!over) {
        drag.to = drag.from;
      }
    });

    function finish(ev) {
      if (!drag || ev.pointerId !== pointerId) return;
      var d = drag;
      drag = null; pointerId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('#orderList .order-card.drop-target').forEach(function (el) {
        el.classList.remove('drop-target');
      });
      try { card.releasePointerCapture(ev.pointerId); } catch (e) { }
      if (d.moved) {
        ev.preventDefault();
        reorderByOrderIndex(d.from, d.to);
      }
    }
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);

    card.addEventListener('click', function () {
      // یک ضربه، همان عکس را روی صفحه انتخاب می‌کند؛ درگ فقط ترتیب را عوض می‌کند.
      if (drag) return;
      var orderIndex = parseInt(card.dataset.orderIndex, 10);
      var flat = [];
      pages.forEach(function (pg, pageIndex) {
        pg.items.forEach(function (item, itemIndex) {
          flat.push({ item: item, pageIndex: pageIndex, itemIndex: itemIndex });
        });
      });
      var entry = flat[orderIndex];
      if (!entry) return;
      currentPage = entry.pageIndex;
      selectedIdx = entry.itemIndex;
      renderPage();
    });
  }

  function buildItemEl(it, idx) {
    var wrap = document.createElement('div');
    wrap.className = 'item';
    wrap.dataset.idx = String(idx);
    applyItemStyle(wrap, it);
    wrap.style.zIndex = String(10 + idx);

    var clip = document.createElement('div');
    clip.className = 'clip';
    var img = document.createElement('img');
    img.src = URL.createObjectURL(it.photo.blob);
    img.draggable = false;
    img.alt = it.photo.name;
    img.style.transform = 'scale(' + (it.scale || 1) + ')';
    img.style.transformOrigin = 'center center';
    clip.appendChild(img);
    wrap.appendChild(clip);

    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(idx + 1);
    wrap.appendChild(badge);

    [['del', '✕', 'حذف عکس'], ['rot', '', 'چرخش'], ['crop', '⤢', 'بزرگ/کوچک کردن عکس داخل کادر']].forEach(function (h) {
      var b = document.createElement('div');
      b.className = 'ih ' + h[0];
      b.title = h[2];
      b.textContent = h[1];
      if (h[0] === 'rot') {
        b.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 5V1.5L6.5 6 12 10.5V7a5 5 0 1 1-5 5H4.5A7.5 7.5 0 1 0 12 5z"/></svg>';
      }
      wrap.appendChild(b);
    });

    ['nw', 'ne', 'sw', 'se'].forEach(function (c) {
      var hd = document.createElement('div');
      hd.className = 'rh ' + c;
      hd.dataset.corner = c;
      wrap.appendChild(hd);
    });

    wireItem(wrap, it);
    return wrap;
  }

  function applyItemStyle(el, it) {
    el.style.left = r1(it.x) + 'mm';
    el.style.top = r1(it.y) + 'mm';
    el.style.width = r1(it.w) + 'mm';
    el.style.height = r1(it.h) + 'mm';
    el.style.setProperty('--rot', (it.rotation || 0) + 'deg');
  }

  function renderPagesStrip() {
    var strip = $('pagesStrip');
    strip.innerHTML = '';
    pages.forEach(function (p, i) {
      var b = document.createElement('button');
      b.className = 'pageBtn' + (i === currentPage ? ' active' : '');
      b.innerHTML = '<span class="ph">' + (p.items.length || '−') + '</span><span class="pl">صفحه ' + (i + 1) + '</span>';
      b.addEventListener('click', function () { currentPage = i; renderPage(); });
      if (pages.length > 1) {
        var d = document.createElement('span');
        d.className = 'pdel'; d.textContent = '✕'; d.title = 'حذف صفحه';
        d.addEventListener('click', function (ev) {
          ev.stopPropagation();
          pages.splice(i, 1);
          photos = collectPhotos();
          dropEmptyPages();
          commit();
        });
        b.appendChild(d);
      }
      strip.appendChild(b);
    });
    var add = document.createElement('button');
    add.className = 'pageBtn add';
    add.innerHTML = '<span class="ph plus">+</span><span class="pl">صفحه جدید</span>';
    add.addEventListener('click', function () {
      pages.push(newPage());
      currentPage = pages.length - 1;
      commit();
    });
    strip.appendChild(add);
  }

  // اسکرین‌شات سامسونگ A53 = ۱۰۸۰×۲۴۰ پیکسل؛ اندازه‌ی چاپی‌اش روی کاغذ فعلی
  var A53 = { w: 1080, h: 2400 };
  function updateA53Info() {
    var t = TEMPLATES[paper], p = PAPERS[paper];
    var cw = (p.w - 2 * marginMM - (t.cols - 1) * gapMM) / t.cols;
    var ch = (p.h - 2 * marginMM - (t.rows - 1) * gapMM) / t.rows;
    var sc = Math.min(cw / A53.w, ch / A53.h);
    $('a53Info').textContent = '۱۰۸۰×۲۴۰ → چاپ حدود ' + Math.round(A53.w * sc) + '×' +
      Math.round(A53.h * sc) + ' میلی‌متر در هر خانه‌ی ' + paper;
  }

  function syncControls() {
    document.querySelectorAll('#paperSeg button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.paper === paper);
    });
    var t = TEMPLATES[paper];
    document.querySelectorAll('.tplbtn').forEach(function (b) {
      b.classList.toggle('active',
        parseInt(b.dataset.cols, 10) === t.cols && parseInt(b.dataset.rows, 10) === t.rows);
    });
    $('marginRange').value = marginMM;
    $('marginVal').textContent = marginMM + 'mm';
    $('gapRange').value = gapMM;
    $('gapVal').textContent = gapMM + 'mm';
    $('dpiSel').value = String(dpi);
    $('zoomVal').textContent = Math.round(zoom * 100) + '٪';
    updateA53Info();
    $('undoBtn').disabled = undoStack.length < 2;
    $('redoBtn').disabled = redoStack.length === 0;
  }

  // ---------- تعامل با عکس‌ها ----------
  function wireItem(el, item) {
    var st = null;

    el.addEventListener('pointerdown', function (ev) {
      var tgt = ev.target;
      if (tgt.classList.contains('del')) return; // کلیک حذف جداگانه
      ev.stopPropagation();
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      selectEl(el);

      st = { mode: 'move', sx: ev.clientX, sy: ev.clientY, x0: item.x, y0: item.y, moved: false };

      if (tgt.classList.contains('rh')) {
        st.mode = 'resize';
        // دستگیره‌ی دیده‌شده → گوشه‌ی واقعی (بدون چرخش) عکس
        st.corner = unrotateCorner(tgt.dataset.corner, item.rotation || 0);
        var c0 = centerScreen();
        st.d0 = Math.max(8, dist(ev.clientX, ev.clientY, c0.x, c0.y));
        st.w0 = item.w; st.h0 = item.h;
      } else if (tgt.classList.contains('rot')) {
        st.mode = 'rotate';
      } else if (tgt.classList.contains('crop')) {
        st.mode = 'crop';
        st.s0 = item.scale || 1;
        st.d0 = Math.max(8, distToCenter(ev));
      }
      try { el.setPointerCapture(ev.pointerId); } catch (e) { }
      ev.preventDefault();
    });

    el.addEventListener('pointermove', function (ev) {
      if (!st) return;
      if (!st.moved && Math.abs(ev.clientX - st.sx) + Math.abs(ev.clientY - st.sy) > 3) st.moved = true;
      if (!st.moved) return;          // فقط یک ضربه بوده، تغییری نده
      var s = screenScale();
      if (st.mode === 'move') {
        item.x = st.x0 + (ev.clientX - st.sx) / s;
        item.y = st.y0 + (ev.clientY - st.sy) / s;
      } else if (st.mode === 'resize') {
        var c = centerScreen();
        var d = Math.max(8, dist(ev.clientX, ev.clientY, c.x, c.y));
        var ratio = d / st.d0;
        var maxSide = Math.max(PAPERS[paper].w, PAPERS[paper].h) * 1.5;
        var nw = clamp(st.w0 * ratio, MIN_W_MM, maxSide);
        item.h = clamp(st.h0 * (nw / st.w0), MIN_W_MM * 0.2, maxSide);
        item.w = nw;
        keepCornerFixed(st.corner, st.w0, st.h0);
      } else if (st.mode === 'rotate') {
        var c2 = centerScreen();
        var ang = Math.atan2(ev.clientY - c2.y, ev.clientX - c2.x) * 180 / Math.PI + 90;
        ang = ((ang % 360) + 360) % 360;
        var snapped = Math.round(ang / 90) * 90;
        if (Math.abs(ang - snapped) < 12) ang = snapped % 360;
        setRotation(ang);
      } else if (st.mode === 'crop') {
        item.scale = clamp(st.s0 * (distToCenter(ev) / st.d0), 0.2, 5);
        el.querySelector('img').style.transform = 'scale(' + item.scale + ')';
      }
      applyItemStyle(el, item);
      ev.preventDefault();
    });

    function finish(ev) {
      if (!st) return;
      var changed = st.moved;
      st = null;
      try { el.releasePointerCapture(ev.pointerId); } catch (e) { }
      if (changed) commit(); else renderPage();
    }
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);

    function setRotation(deg) { rotateItemTo(item, deg); }

    function distToCenter(ev) {
      var c = centerScreen();
      return dist(ev.clientX, ev.clientY, c.x, c.y);
    }
    function centerScreen() {
      var rect = $('page').getBoundingClientRect();
      var s = screenScale();
      return { x: rect.left + (item.x + item.w / 2) * s, y: rect.top + (item.y + item.h / 2) * s };
    }
    function keepCornerFixed(corner, w0, h0) {
      var dx = item.w - w0, dy = item.h - h0;
      if (corner === 'sw') item.x -= dx;
      else if (corner === 'ne') item.y -= dy;
      else if (corner === 'nw') { item.x -= dx; item.y -= dy; }
    }

    el.querySelector('.del').addEventListener('click', function (ev) {
      ev.stopPropagation();
      removeItem(item);
    });
    el.addEventListener('dblclick', function (ev) {
      ev.stopPropagation();
      removeItem(item);
    });
  }

  function selectEl(el) {
    selectedIdx = parseInt(el.dataset.idx, 10);
    paintSelection();
  }

  function paintSelection() {
    document.querySelectorAll('#page .item').forEach(function (n) {
      n.classList.toggle('sel', parseInt(n.dataset.idx, 10) === selectedIdx);
    });
  }

  function selectedItem() {
    var p = pages[currentPage];
    return (p && p.items[selectedIdx]) || null;
  }

  // تبدیل گوشه‌ی ظاهری (روی صفحه) به گوشه‌ی واقعی عکس با توجه به چرخش
  function unrotateCorner(visCorner, rotDeg) {
    var order = ['nw', 'ne', 'se', 'sw'];        // چرخش ساعتگرد
    var i = order.indexOf(visCorner);
    var k = Math.round(rotDeg / 90);
    return order[(i - k + 400) % 4];
  }

  function removeItem(item) {
    var p = pages[currentPage];
    if (!p) return;
    var i = p.items.indexOf(item);
    if (i < 0) return;
    p.items.splice(i, 1);
    photos = collectPhotos();
    dropEmptyPages();
    selectedIdx = -1;
    commit();
    toast('عکس حذف شد');
  }

  function deleteSelected() {
    var it = selectedItem();
    if (!it) { toast('ابتدا یک عکس را انتخاب کنید'); return; }
    removeItem(it);
  }

  function duplicateSelected() {
    var src = selectedItem();
    if (!src) { toast('ابتدا یک عکس را انتخاب کنید'); return; }
    var p = pages[currentPage];
    if (p.items.length >= capacity()) {
      pages.push({ items: [] });
      currentPage = pages.length - 1;
    }
    var copy = Object.assign({}, src);
    copy.x = src.x + 4; copy.y = src.y + 4;
    pages[currentPage].items.push(copy);
    photos = collectPhotos();
    commit();
  }

  // چرخش: کل کادر (به‌همراه عکس) می‌چرخد؛ ابعاد کادر به عکس چسبیده و
  // هم‌نسبت با آن می‌ماند، پس هیچ کشیدگی‌ای پیش نمی‌آید.
  function rotateItemTo(it, deg) {
    deg = (((deg % 360) + 360) % 360);
    it.rotation = Math.round(deg * 10) / 10;
  }

  function rotateItemBy(it, delta) {
    rotateItemTo(it, (it.rotation || 0) + delta);
  }

  function rotateSelected(deg) {
    var it = selectedItem();
    if (!it) { toast('ابتدا یک عکس را انتخاب کنید'); return; }
    rotateItemBy(it, deg);
    commit();
  }

  function bringSelected(dir) {
    if (selectedIdx < 0) return;
    var idx = selectedIdx;
    var items = pages[currentPage].items;
    var j = idx + dir;
    if (j < 0 || j >= items.length) return;
    var tmp = items[idx]; items[idx] = items[j]; items[j] = tmp;
    commit();
  }

  // ---------- زوم و پن صفحه ----------
  function setupStageGestures() {
    var stage = $('pageScroll');
    var ptrs = new Map();
    var startDist = 0, startZoom = 1;
    stage.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest('.item')) return;
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (ptrs.size === 2) {
        var p = Array.from(ptrs.values());
        startDist = dist(p[0].x, p[0].y, p[1].x, p[1].y);
        startZoom = zoom;
      }
    });
    stage.addEventListener('pointermove', function (ev) {
      if (!ptrs.has(ev.pointerId)) return;
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (ptrs.size === 2) {
        var p = Array.from(ptrs.values());
        var d = dist(p[0].x, p[0].y, p[1].x, p[1].y);
        if (startDist > 0) setZoom(startZoom * (d / startDist));
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      stage.addEventListener(t, function (ev) { ptrs.delete(ev.pointerId); });
    });
    stage.addEventListener('pointerdown', function (ev) {
      if (!ev.target.closest('.item') && selectedIdx !== -1) {
        selectedIdx = -1;
        paintSelection();
      }
    });
  }

  function setZoom(z) {
    zoom = clamp(z, 0.4, 6);
    applyScale();
    $('zoomVal').textContent = Math.round(zoom * 100) + '٪';
  }

  // ---------- خروجی ----------
  function renderPageCanvas(pgIndex, targetDpi) {
    var p = PAPERS[paper];
    var ppm = targetDpi / 25.4;
    var c = document.createElement('canvas');
    c.width = Math.round(p.w * ppm);
    c.height = Math.round(p.h * ppm);
    var cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, c.width, c.height);
    (pages[pgIndex].items || []).forEach(function (it) { drawItemOn(cx, it, ppm); });
    return c;
  }

  function drawItemOn(cx, it, ppm) {
    var bmp = it.photo.bitmap;
    cx.save();
    cx.translate((it.x + it.w / 2) * ppm, (it.y + it.h / 2) * ppm);
    cx.rotate((it.rotation || 0) * Math.PI / 180);
    // برش مثل DOM: کادرِ چرخیده، عکس بزرگ‌شده (کراپ) را می‌بُرد
    cx.beginPath();
    cx.rect(-it.w / 2 * ppm, -it.h / 2 * ppm, it.w * ppm, it.h * ppm);
    cx.clip();
    var s2 = Math.min(it.w / bmp.width, it.h / bmp.height) * (it.scale || 1);
    var w = bmp.width * s2, h = bmp.height * s2;
    cx.drawImage(bmp, -w / 2, -h / 2, w, h);
    cx.restore();
  }

  // باکس محیطی کادر چرخیده (برای رسترکردن چرخش‌های دلخواه)
  function rotatedBound(it) {
    var rad = ((it.rotation || 0) % 360) * Math.PI / 180;
    var c = Math.abs(Math.cos(rad)), sn = Math.abs(Math.sin(rad));
    return { w: it.w * c + it.h * sn, h: it.w * sn + it.h * c };
  }

  function rasterizeItemJpeg(it) {
    var bound = rotatedBound(it);
    var ppm = Math.min(150 / 25.4, 3500000 / Math.max(1, bound.w * bound.h)); // سقف ~۳.۵ مگاپیکسل
    var c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(bound.w * ppm));
    c.height = Math.max(8, Math.round(bound.h * ppm));
    var cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, c.width, c.height);
    cx.save();
    cx.translate(c.width / 2, c.height / 2);
    cx.rotate((it.rotation || 0) * Math.PI / 180);
    cx.beginPath();
    cx.rect(-it.w / 2 * ppm, -it.h / 2 * ppm, it.w * ppm, it.h * ppm);
    cx.clip();
    var bmp = it.photo.bitmap;
    var s2 = Math.min(it.w / bmp.width, it.h / bmp.height) * (it.scale || 1);
    cx.drawImage(bmp, -bmp.width * s2 / 2, -bmp.height * s2 / 2, bmp.width * s2, bmp.height * s2);
    cx.restore();
    return new Promise(function (res, rej) {
      c.toBlob(function (b) {
        if (!b) { rej(new Error('toBlob failed')); return; }
        b.arrayBuffer().then(function (ab) {
          res({ jpeg: new Uint8Array(ab), widthPx: c.width, heightPx: c.height, boundW: bound.w, boundH: bound.h });
        });
      }, 'image/jpeg', 0.92);
    });
  }

  function buildPdfBlob() {
    var pg = pages[currentPage];
    if (!pg || !pg.items.length) { toast('ابتدا عکس اضافه کنید'); return Promise.resolve(null); }

    var tasks = pg.items.map(function (it) {
      var rot = (((it.rotation || 0) % 360) + 360) % 360;
      var scaled = Math.abs((it.scale || 1) - 1) > 0.001;

      // الف) بدون چرخش و بدون کراپ: بایت اصلی عکس، بدون افت کیفیت
      if (rot === 0 && !scaled) {
        return getJpegData(it.photo).then(function (jpeg) {
          return {
            imageKey: it.photo.id,
            jpeg: jpeg,
            widthPx: it.photo.jpegW || it.photo.w,
            heightPx: it.photo.jpegH || it.photo.h,
            xMM: it.x, yMM: it.y, wMM: it.w, hMM: it.h, rotation: 0
          };
        });
      }

      // ب) چرخش ۹۰/۱۸۰/۲۷۰ و بدون کراپ: بایت اصلی + ماتریس چرخش در PDF
      var cardinal = rot % 90 === 0;
      if (cardinal && rot !== 0 && !scaled) {
        return getJpegData(it.photo).then(function (jpeg) {
          return {
            imageKey: it.photo.id + ':' + rot,
            jpeg: jpeg,
            widthPx: it.photo.jpegW || it.photo.w,
            heightPx: it.photo.jpegH || it.photo.h,
            xMM: it.x, yMM: it.y, wMM: it.w, hMM: it.h, rotation: rot
          };
        });
      }

      // ج) کراپ یا چرخش دلخواه: تصویر دقیقاً مثل نمای صفحه رستر می‌شود.
      //    چون خودِ رستر چرخیده است، دیگر چرخشی در PDF اعمال نمی‌کنیم (وگرنه دوبار می‌چرخد).
      return rasterizeItemJpeg(it).then(function (r) {
        var cx0 = it.x + it.w / 2, cy0 = it.y + it.h / 2;
        return {
          imageKey: it.photo.id + ':r' + rot,
          jpeg: r.jpeg, widthPx: r.widthPx, heightPx: r.heightPx,
          xMM: cx0 - r.boundW / 2, yMM: cy0 - r.boundH / 2,
          wMM: r.boundW, hMM: r.boundH, rotation: 0
        };
      });
    });

    return Promise.all(tasks).then(function (items) {
      var p = PAPERS[paper];
      var bytes = PDFWriter.build([{ widthMM: p.w, heightMM: p.h, items: items }]);
      return new Blob([bytes], { type: 'application/pdf' });
    });
  }

  function withBusy(btnId, fn) {
    var btn = $(btnId);
    btn.disabled = true;
    var t = btn.textContent;
    btn.textContent = 'در حال ساخت…';
    fn().finally(function () {
      btn.disabled = false;
      btn.textContent = t;
    });
  }

  function exportPDF() {
    withBusy('pdfBtn', function () {
      return buildPdfBlob().then(function (b) {
        if (!b) return null;
        downloadBlob(b, outputFileName('pdf', currentPage));
        toast('PDF ساخته شد (' + Math.round(b.size / 1024) + ' کیلوبایت)');
        return b;
      }).catch(function (e) {
        console.error(e);
        toast('خطا در ساخت PDF: ' + (e && e.message ? e.message : e));
        return null;
      });
    });
  }

  function sharePDF() {
    withBusy('sharePdfBtn', function () {
      return buildPdfBlob().then(function (b) {
        if (b) shareBlob(b, outputFileName('pdf', currentPage), 'چیدمان عکس');
        return b;
      });
    });
  }

  function buildJpegBlob(pgIndex) {
    return new Promise(function (res, rej) {
      var pg = pages[pgIndex];
      if (!pg || !pg.items.length) { res(null); return; }
      renderPageCanvas(pgIndex, dpi).toBlob(function (b) {
        if (!b) rej(new Error('toBlob failed')); else res(b);
      }, 'image/jpeg', 0.93);
    });
  }

  function exportJPG() {
    buildJpegBlob(currentPage).then(function (b) {
      if (!b) { toast('ابتدا عکس اضافه کنید'); return; }
      downloadBlob(b, outputFileName('jpg', currentPage));
      toast('JPG ذخیره شد');
    }).catch(function (e) { toast('ساخت عکس ناموفق بود: ' + e.message); });
  }

  function shareJPG() {
    withBusy('shareJpgBtn', function () {
      return buildJpegBlob(currentPage).then(function (b) {
        if (b) shareBlob(b, outputFileName('jpg', currentPage), 'چیدمان عکس');
        return b;
        }).catch(function (e) { toast('ساخت عکس ناموفق بود: ' + e.message); return null; });
    });
  }

  function exportAllPages() {
    var idxs = [];
    pages.forEach(function (p, i) { if (p.items.length) idxs.push(i); });
    if (!idxs.length) { toast('صفحه‌ها خالی است'); return; }
    var cur = currentPage;
    idxs.forEach(function (i, k) {
      setTimeout(function () {
        buildJpegBlob(i).then(function (b) {
          if (b) downloadBlob(b, outputFileName('jpg', i));
          if (k === idxs.length - 1) { currentPage = cur; renderPage(); }
        });
      }, k * 900);
    });
    toast('دانلود ' + idxs.length + ' عکس شروع شد');
  }

  // ---------- اتصال رویدادها ----------
  function bind() {
    $('pickBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      addFiles(e.target.files);
      e.target.value = '';
    });

    ['dragover', 'dragenter'].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); });
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    document.querySelectorAll('#paperSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (paper === b.dataset.paper) return;
        paper = b.dataset.paper;
        photos = collectPhotos();
        currentPage = 0;
        rebuildPages();
        toast('کاغذ ' + paper + ' — ' + capacity() + ' عکس در هر صفحه');
      });
    });

    document.querySelectorAll('.tplbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        setTemplate(parseInt(b.dataset.cols, 10), parseInt(b.dataset.rows, 10));
      });
    });

    $('arrangeBtn').addEventListener('click', function () {
      photos = collectPhotos();
      currentPage = 0;
      rebuildPages();
      toast('چیدمان خودکار انجام شد');
    });
    $('resetBtn').addEventListener('click', function () {
      var p = pages[currentPage];
      p.items = p.items.map(function (it, i) { return makeItem(it.photo, i, p.items.length); });
      commit();
      toast('چیدمان این صفحه بازنشانی شد');
    });
    $('gridBtn').addEventListener('click', function () {
      gridOn = !gridOn;
      $('gridBtn').classList.toggle('active', gridOn);
      renderPage();
    });
    $('clearBtn').addEventListener('click', function () {
      if (!photos.length) return;
      if (!window.confirm('همه‌ی عکس‌ها پاک شوند؟')) return;
      photos = [];
      pages = [newPage()];
      currentPage = 0;
      commit();
    });

    $('marginRange').addEventListener('input', function (e) {
      marginMM = parseInt(e.target.value, 10);
      $('marginVal').textContent = marginMM + 'mm';
      if (gridOn) renderPage();
    });
    $('marginRange').addEventListener('change', function () { commit(); });
    $('gapRange').addEventListener('input', function (e) {
      gapMM = parseInt(e.target.value, 10);
      $('gapVal').textContent = gapMM + 'mm';
      if (gridOn) renderPage();
    });
    $('gapRange').addEventListener('change', function () { commit(); });
    $('dpiSel').addEventListener('change', function (e) { dpi = parseInt(e.target.value, 10); });

    $('prevPage').addEventListener('click', function () {
      if (currentPage > 0) { currentPage--; renderPage(); }
    });
    $('nextPage').addEventListener('click', function () {
      if (currentPage < pages.length - 1) { currentPage++; renderPage(); }
    });
    $('addPage').addEventListener('click', function () {
      pages.push(newPage());
      currentPage = pages.length - 1;
      commit();
    });

    $('pdfBtn').addEventListener('click', exportPDF);
    $('jpgBtn').addEventListener('click', exportJPG);
    $('jpgAllBtn').addEventListener('click', exportAllPages);
    $('sharePdfBtn').addEventListener('click', sharePDF);
    $('shareJpgBtn').addEventListener('click', shareJPG);

    var pre = $('prefixInput');
    pre.value = localStorage.getItem('ppa_prefix') || '';
    pre.addEventListener('input', function () {
      localStorage.setItem('ppa_prefix', pre.value);
      updateNamePreview();
    });
    updateNamePreview();

    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('zoomOut').addEventListener('click', function () { setZoom(zoom / 1.25); });
    $('zoomIn').addEventListener('click', function () { setZoom(zoom * 1.25); });
    $('zoomFit').addEventListener('click', function () { setZoom(1); });

    $('selDup').addEventListener('click', duplicateSelected);
    $('selRotL').addEventListener('click', function () { rotateSelected(-90); });
    $('selRotR').addEventListener('click', function () { rotateSelected(90); });
    $('selBack').addEventListener('click', function () { bringSelected(-1); });
    $('selFront').addEventListener('click', function () { bringSelected(1); });
    $('selDel').addEventListener('click', deleteSelected);

    window.addEventListener('resize', function () { renderPage(); });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      var btn = $('installBtn');
      btn.hidden = false;
      btn.onclick = function () { e.prompt(); btn.hidden = true; };
    });
    window.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdx >= 0 &&
          document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        deleteSelected();
      }
    });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    }
  }

  function setTemplate(cols, rows) {
    if (TEMPLATES[paper].cols === cols && TEMPLATES[paper].rows === rows) return;
    TEMPLATES[paper] = { cols: cols, rows: rows };
    photos = collectPhotos();
    currentPage = 0;
    rebuildPages();
    toast('قالب ' + cols + '×' + rows + ' روی ' + paper);
  }

  function init() {
    bind();
    setupStageGestures();
    pages = [newPage()];
    renderPage();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
