# Photo Arranger — چیدمان عکس روی کاغذ (A4 / A5)

An offline-first, privacy-first PWA for arranging phone screenshots and photos onto printable **A4 (4 photos)** and **A5 (2 photos)** pages, with full manual fine-tuning, and export to **print-ready PDF** (true millimeter geometry) or **JPG**.

Everything runs inside the browser: **no server, no uploads, no frameworks, no external libraries, no build step.** UI language is Persian (RTL).

[📄 راهنمای فارسی (README.fa.md)](./README.fa.md)

![A4 layout](docs/screenshot-a4.png)
![A5 layout](docs/screenshot-a5.png)

## Features

- **Auto-arrange**: A4 → 2×2 (4 photos), A5 → 1×2 (2 photos). Templates 1×1, 2×1, 2×2, 2×3.
- **Manual editing per photo**: drag within the paper boundary, corner resize, rotate, crop-to-fill inside its frame (green handle), bring to front/back, duplicate, delete.
- **Bulk zoom tool**: the top HTML tools menu applies a percentage zoom (100–200%) to every photo inside its frame without breaking the page layout.
- **Adjustable page margin & gap**, multiple pages, Undo/Redo, page thumbnails strip.
- **Export**: print-ready PDF (real mm dimensions, JPEG streams embedded via `DCTDecode`) and JPG at 150/300 dpi (single page or all pages).
- **File naming**: `{prefix}_{Jalali date}` — e.g. `report_1404-06-30.pdf`. Jalali (Persian/Solar Hijri) calendar conversion is built in; the prefix is saved in `localStorage`.
- **Share as file** (Web Share API Level 2): share buttons send the PDF/JPG straight to the OS share sheet; automatic download fallback where unsupported.
- **Galaxy A53 reference**: shows the exact printed size of a 1080×2400 screenshot on the current paper.
- **Installable PWA** with service worker (works fully offline after first load), light minimal UI.

## Run

No build step — serve the folder statically:

```bash
cd photo-arranger
python3 -m http.server 8000
# open http://localhost:8000
```

## Tests

```bash
# 1) PDF writer unit test — builds a PDF with node, validates geometry with pypdf
cd test && node build-pdf-test.js && python3 verify_pdf.py && cd ..

# 2) Full end-to-end suite in a real browser (34 checks)
pip install playwright pypdf && python3 -m playwright install chromium
python3 test/browser_e2e.py
```

The e2e suite covers: auto-arrange (A4/A5), drag-to-reorder, correctly scaled and paper-bounded dragging, bulk percentage zoom, rotate/resize/drag/in-frame zoom visuals, export naming, JPG format & dimensions (2480×3508 @300dpi), partial-page centering, PDF structure, Web Share (mocked) + download fallback, and zero console errors.

## Architecture (~1,800 lines of vanilla JS/CSS/HTML)

| Path | Purpose |
|---|---|
| `index.html` | Persian RTL UI, all controls |
| `styles.css` | Light minimal theme; item/handle/clip styling |
| `js/app.js` | State, layout engine, touch editing, canvas rendering, exports, share |
| `js/pdf-writer.js` | Hand-written PDF generator (no libraries; `DCTDecode` for JPEGs) |
| `js/jalali.js` | Gregorian → Jalali date conversion |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA install & offline caching |
| `test/` | Unit + Playwright e2e tests and fixtures |
| `.github/workflows/main.yml` | GitHub Actions CI: syntax, PDF, geometry and browser tests |
| `.github/workflows/android.yml` | Manual/tag-triggered Capacitor debug APK build and artifact upload |

**Two-stage pipeline:** editing happens in the DOM (CSS transforms on `.item` inside a `.clip` layer); export re-draws the identical transforms onto a Canvas (`renderPageCanvas` → `drawItemOn`), so what you see is exactly what prints. The PDF writer receives the JPEG bytes directly (no re-encoding) and writes true-mm page/image boxes.

**Key functions in `js/app.js`:** `cellRect` (grid geometry + partial-page centering), `makeItem`/`wireItem` (item DOM + gestures), `screenPxPerMM`/`clampItemToPage` (accurate bounded dragging), `renderOrderList`/`wireOrderCard`/`reorderByOrderIndex` (mouse/touch ordering), `applyAllZoom` (bulk in-frame zoom), `renderPage`/`renderPageCanvas` (view & export), `buildPdfBlob`/`buildJpegBlob` (exports), `outputFileName` (prefix + Jalali naming), `shareBlob`/`downloadBlob` (share choke points).

## Converting to a mobile app (recommended: Capacitor)

This is a standard static web app, so wrapping it with [Capacitor](https://capacitorjs.com/) is straightforward:

```bash
# Stage the static app into Capacitor's web directory
rm -rf www && mkdir -p www
cp index.html styles.css manifest.webmanifest sw.js www/
cp -r js icons www/

npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
npx cap sync
npx cap open android             # then Build → APK / AAB in Android Studio
# or without the IDE:  cd android && ./gradlew assembleDebug
```

A ready-made `capacitor.config.json` (appId `com.example.photoarranger`, `webDir: "www"`) is included — change the appId before publishing. The automated Android workflow performs the staging step for you.

**Integration checklist (important):**

1. **File sharing is the one thing to re-wire.** Android System WebView does *not* implement `navigator.share({ files })`, and blob `<a download>` is limited there too. The app already funnels every export through exactly two functions in `js/app.js` — `shareBlob()` and `downloadBlob()` — so the fix is to bridge them to `@capacitor/share` + `@capacitor/filesystem` (write blob → temp file → share URI). Everything else keeps working untouched.
2. **File picking works as-is**: `<input type="file" accept="image/*" multiple>` is supported by the Capacitor WebView on Android and iOS.
3. **Service worker is irrelevant** under Capacitor (the app is loaded from local files); `app.js` already guards registration and the PWA install button (`#installBtn`) can be hidden.
4. **Icons**: generate adaptive launcher icons from `icons/icon-512.png` with `npx @capacitor/assets generate`.
5. **Orientation**: manifest locks portrait; mirror that in `AndroidManifest.xml` (`android:screenOrientation="portrait"`) / `Info.plist`.
6. Canvas, `createImageBitmap`, JPEG re-encoding, localStorage and all touch gestures work unchanged in the WebView.

## Automated Android APK from GitHub Actions

The repository includes `.github/workflows/android.yml`. To build an installable debug APK without Android Studio:

1. Open the repository's **Actions** tab.
2. Select **Build Android APK**.
3. Click **Run workflow** on the `main` branch.
4. When the job finishes, open the run and download the `photo-arranger-debug-apk` artifact.
5. Extract the ZIP and install `app-debug.apk` on an Android phone.

The workflow uses Capacitor 7 and produces an **unsigned debug APK** for testing. A signed release APK/AAB for Google Play requires an Android keystore and a separate signing configuration.

## Browser APIs used

`File` / `FileReader`, `createImageBitmap`, Canvas 2D, Web Share API L2 (with fallback), `localStorage`, Service Worker, Web App Manifest. No other permissions, no network calls at runtime.

## License

MIT — see [LICENSE](./LICENSE).
