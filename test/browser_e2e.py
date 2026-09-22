"""تست سرتاسری در مرورگر واقعی: بارگذاری اپ، مرتب‌سازی، ویرایش و خروجی PDF و JPG."""
import io, json, os, sys
from playwright.sync_api import sync_playwright
from PIL import Image
import re as _re
from pypdf import PdfReader

BASE = "http://127.0.0.1:8000/"
HERE = os.path.dirname(os.path.abspath(__file__))
MM = 72 / 25.4

fails = []
def check(cond, msg):
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails.append(msg)

def make_screenshot(path, w, h, color, label):
    img = Image.new("RGB", (w, h), color)
    d = ImageDraw = None
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, int(h * 0.06)], fill=(0, 0, 0))          # نوار وضعیت
    d.rectangle([int(w*.06), int(h*.10), int(w*.94), int(h*.22)], fill=(255, 255, 255))
    d.ellipse([int(w*.35), int(h*.45), int(w*.65), int(h*.60)], fill=(255, 255, 255))
    img.save(path, quality=90)

make_screenshot(os.path.join(HERE, "shot1.png"), 1080, 2400, (220, 38, 38), "1")
make_screenshot(os.path.join(HERE, "shot2.png"), 1080, 2400, (37, 99, 235), "2")
make_screenshot(os.path.join(HERE, "shot3.png"), 1080, 2400, (16, 185, 129), "3")
make_screenshot(os.path.join(HERE, "shot4.png"), 1080, 2400, (124, 58, 237), "4")

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 420, "height": 900},
                              accept_downloads=True, device_scale_factor=2)
    page = ctx.new_page()

    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE, wait_until="networkidle")
    check(page.title().startswith("چیدمان عکس"), f"عنوان صفحه: {page.title()}")

    # افزودن ۴ اسکرین‌شات از طریق ورودی فایل (مثل انتخاب از گالری)
    page.set_input_files("#fileInput", [os.path.join(HERE, f"shot{i}.png") for i in range(1, 5)])
    page.wait_for_selector(".item", timeout=15000)
    page.wait_for_timeout(1200)

    n_items = page.locator("#page .item").count()
    check(n_items == 4, f"۴ عکس روی صفحه A4 چیده شد (تعداد = {n_items})")
    check("4 از 4" in page.locator("#pageInfo").inner_text(),
          f"شمارنده صفحه: {page.locator('#pageInfo').inner_text()}")

    # مرتب‌سازی عکس‌ها با درگ لمسی/ماوس در نوار ترتیب؛ عکس اول به انتها می‌رود.
    order_cards = page.locator("#orderList .order-card")
    check(order_cards.count() == 4, f"نوار ترتیب ۴ عکس دارد ({order_cards.count()})")
    first_before = order_cards.nth(0).get_attribute("aria-label")
    second_before = order_cards.nth(1).get_attribute("aria-label")
    last_before = order_cards.nth(3).get_attribute("aria-label")
    order_cards.nth(0).scroll_into_view_if_needed()
    first_box = order_cards.nth(0).bounding_box()
    last_box = order_cards.nth(3).bounding_box()
    page.mouse.move(first_box["x"] + first_box["width"] / 2, first_box["y"] + first_box["height"] / 2)
    page.mouse.down()
    page.mouse.move(last_box["x"] + last_box["width"] / 2, last_box["y"] + last_box["height"] / 2, steps=8)
    page.mouse.up()
    page.wait_for_timeout(350)
    order_cards = page.locator("#orderList .order-card")
    first_after = order_cards.nth(0).get_attribute("aria-label")
    last_after = order_cards.nth(3).get_attribute("aria-label")
    print("   ترتیب بعد از درگ:", first_before, "+", second_before, "→", first_after, "؛", last_before, "→", last_after)
    check(first_after.endswith("shot2.png") and first_after != first_before and last_after.endswith("shot1.png"),
          "ترتیب عکس‌ها با درگ جابه‌جا شد و چیدمان دوباره انجام شد")

    # نوار ترتیب برای درگ اسکرول شده بود؛ صفحه را دوباره برای تست ویرایش به عکس اول برگردان.
    page.locator("#page .item").nth(0).scroll_into_view_if_needed()
    page.wait_for_timeout(150)

    def box_mm(i):
        return page.evaluate("""(i) => {
            const el = document.querySelectorAll('#page .item')[i];
            const mm = (v) => parseFloat(v);
            return {x: mm(el.style.left), y: mm(el.style.top), w: mm(el.style.width), h: mm(el.style.height),
                    rot: el.style.getPropertyValue('--rot')};
        }""", i)

    b0 = box_mm(0)
    print("   آیتم ۱ قبل از چرخش:", {k: round(v, 2) if isinstance(v, float) else v for k, v in b0.items()})
    check(abs(b0["w"] / b0["h"] - 1080 / 2400) < 0.01,
          f"نسبت ابعاد حفظ شده ({b0['w']:.2f}×{b0['h']:.2f}mm ≈ ۱۰۸۰×۲۳۴۰)")

    # انتخاب عکس (کلیک روی بدنه، دور از دستگیره‌ها) و چرخش ۹۰ درجه با نوار ابزار
    bb0 = page.locator("#page .item").nth(0).bounding_box()
    page.mouse.click(bb0["x"] + bb0["width"] * 0.5, bb0["y"] + bb0["height"] * 0.35)
    page.wait_for_timeout(150)
    check(page.locator("#page .item.sel").count() == 1, "عکس با کلیک انتخاب و هایلایت شد")
    page.locator("#selRotR").click()
    page.wait_for_timeout(300)
    b0r = box_mm(0)
    rect0 = page.locator("#page .item").nth(0).bounding_box()
    print("   آیتم ۱ بعد از چرخش ۹۰°:", {k: (round(v, 2) if isinstance(v, float) else v) for k, v in b0r.items()},
          "| روی صفحه:", round(rect0["width"]), "×", round(rect0["height"]))
    check("90" in b0r["rot"], f"زاویه ذخیره‌شده: {b0r['rot']}")
    check(rect0["width"] > rect0["height"],
          f"نمای ظاهری پس از چرخش افقی شد ({rect0['width']:.0f}×{rect0['height']:.0f}px)")
    check(abs(b0r["w"] - b0["w"]) < 0.05 and abs(b0r["h"] - b0["h"]) < 0.05,
          "کادر به عکس چسبیده ماند (بدون کشیدگی)")

    # بزرگ‌کردن عکس با دستگیره (شبیه‌سازی لمس) — اول انتخاب تا دستگیره‌ها ظاهر شوند
    el = page.locator("#page .item").nth(1)
    el.scroll_into_view_if_needed()
    page.wait_for_timeout(150)
    bb1 = el.bounding_box()
    page.mouse.click(bb1["x"] + bb1["width"] / 2, bb1["y"] + bb1["height"] / 2)
    page.wait_for_timeout(200)
    page.wait_for_timeout(150)
    bb = el.bounding_box()
    page.mouse.move(bb["x"] + bb["width"] - 4, bb["y"] + bb["height"] - 4)
    page.mouse.down()
    page.mouse.move(bb["x"] + bb["width"] + 45, bb["y"] + bb["height"] + 45, steps=8)
    page.mouse.up()
    page.wait_for_timeout(250)
    b1 = box_mm(1)
    print("   آیتم ۲ بعد از دستگیره:", {k: (round(v,2) if isinstance(v,float) else v) for k,v in b1.items()}, "| handle at", round(bb["x"]+bb["width"]-4,1), round(bb["y"]+bb["height"]-4,1))
    check(b1["w"] > b0["w"] * 1.05, f"بزرگ‌کردن با دستگیره کار کرد ({b0['w']:.2f} → {b1['w']:.2f}mm)")

    # بزرگ/کوچک کردن عکس داخل کادر (دستگیره‌ی سبز پایین-وسط) — کادر ثابت می‌ماند
    box_before = page.locator("#page .item").nth(1).bounding_box()
    ch_ = page.locator("#page .item .ih.crop").nth(1).bounding_box()
    ccx, ccy = ch_["x"] + ch_["width"] / 2, ch_["y"] + ch_["height"] / 2
    page.mouse.move(ccx, ccy); page.mouse.down(); page.mouse.move(ccx + 60, ccy + 60, steps=8); page.mouse.up()
    page.wait_for_timeout(250)
    sc = page.evaluate("() => getComputedStyle(document.querySelectorAll('#page .item')[1].querySelector('img')).transform")
    box_after = page.locator("#page .item").nth(1).bounding_box()
    import math as _m
    scale_val = float(sc.replace("matrix(", "").split(",")[0]) if sc.startswith("matrix") else 1
    check(scale_val > 1.1 and abs(box_after["width"] - box_before["width"]) < 1,
          f"عکس داخل کادر بزرگ شد (ضریب {scale_val:.2f}) و کادر ثابت ماند")
    ch_ = page.locator("#page .item .ih.crop").nth(1).bounding_box()
    ccx, ccy = ch_["x"] + ch_["width"] / 2, ch_["y"] + ch_["height"] / 2
    page.mouse.move(ccx, ccy); page.mouse.down(); page.mouse.move(ccx - 110, ccy - 110, steps=10); page.mouse.up()
    page.wait_for_timeout(250)
    sc2 = page.evaluate("() => getComputedStyle(document.querySelectorAll('#page .item')[1].querySelector('img')).transform")
    scale_val2 = float(sc2.replace("matrix(", "").split(",")[0]) if sc2.startswith("matrix") else 1
    check(scale_val2 < 0.95, f"عکس داخل کادر کوچک شد (ضریب {scale_val2:.2f})")

    # جابه‌جایی با درگ
    before = box_mm(2)
    el2 = page.locator("#page .item").nth(2)
    el2.scroll_into_view_if_needed()
    page.wait_for_timeout(150)
    bb2 = el2.bounding_box()
    page.mouse.move(bb2["x"] + bb2["width"] / 2, bb2["y"] + bb2["height"] / 2)
    page.mouse.down()
    page.mouse.move(bb2["x"] + bb2["width"] / 2 + 30, bb2["y"] + bb2["height"] / 2 + 12, steps=6)
    page.mouse.up()
    page.wait_for_timeout(250)
    after = box_mm(2)
    print("   آیتم ۳ درگ:", {k: (round(v,2) if isinstance(v,float) else v) for k,v in after.items()}, "| box", {k: round(v,1) for k,v in bb2.items()})
    check(abs(after["x"] - before["x"]) > 1 or abs(after["y"] - before["y"]) > 1,
          f"جابه‌جایی کار کرد ({before['x']:.2f},{before['y']:.2f} → {after['x']:.2f},{after['y']:.2f})")

    # پیشوند دلخواه + تاریخ شمسی در نام خروجی
    import re as _re
    page.fill("#prefixInput", "azmoon")
    page.wait_for_timeout(200)
    prev = page.locator("#namePreview").inner_text()
    check(_re.fullmatch(r"azmoon_14\d{2}-\d{2}-\d{2}\.pdf", prev) is not None,
          f"پیش‌نمایش نام خروجی با پیشوند و تاریخ شمسی: {prev}")
    a53txt = page.locator("#a53Info").inner_text()
    check("۱۰۸۰" in a53txt and "میلی‌متر" in a53txt, f"اطلاعات ابعاد A53: {a53txt}")

    # خروجی PDF
    with page.expect_download(timeout=30000) as dl:
        page.locator("#pdfBtn").click()
    pdf_path = os.path.join(HERE, "app-export.pdf")
    dl.value.save_as(pdf_path)
    fname = dl.value.suggested_filename
    print("   PDF دانلود شد:", fname, os.path.getsize(pdf_path), "بایت")
    check(_re.fullmatch(r"azmoon_14\d{2}-\d{2}-\d{2}\.pdf", fname) is not None,
          f"نام فایل PDF = پیشوند_تاریخ‌شمسی ({fname})")

    # خروجی JPG
    with page.expect_download(timeout=30000) as dl2:
        page.locator("#jpgBtn").click()
    png_path = os.path.join(HERE, "app-export.jpg")
    dl2.value.save_as(png_path)
    fname2 = dl2.value.suggested_filename
    print("   JPG دانلود شد:", fname2, os.path.getsize(png_path), "بایت")
    check(_re.fullmatch(r"azmoon_14\d{2}-\d{2}-\d{2}\.jpg", fname2) is not None,
          f"نام فایل JPG هم همان الگو ({fname2})")

    # اشتراک‌گذاری به‌صورت فایل: شاخه‌ی Web Share (موک برای تست)
    page.evaluate('() => { window.__shared = null; navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = d.files.map(f => f.name); }; }')
    page.locator("#sharePdfBtn").click()
    page.wait_for_timeout(1500)
    shared = page.evaluate("window.__shared")
    check(shared is not None and len(shared) == 1 and _re.fullmatch(r"azmoon_14\d{2}-\d{2}-\d{2}\.pdf", shared[0]) is not None,
          f"اشتراک‌گذاری فایل PDF با نام درست انجام شد: {shared}")

    # سوئیچ به A5 با ۲ عکس
    page.locator('#paperSeg button[data-paper="A5"]').click()
    page.wait_for_timeout(500)
    check(page.locator("#pageInfo").inner_text().count("از 2") > 0,
          f"در A5 ظرفیت ۲ عکس شد: {page.locator('#pageInfo').inner_text()}")

    browser.close()

check(not errors, f"بدون خطای کنسول ({errors[:3]})")

# مرورگر بدون Web Share: دانلود به‌عنوان جایگزین با پیشوند پیش‌فرض + تاریخ شمسی
with sync_playwright() as pw2:
    b2 = pw2.chromium.launch()
    ctx2 = b2.new_context(viewport={"width": 420, "height": 900}, accept_downloads=True)
    p2 = ctx2.new_page()
    p2.add_init_script("try { Object.defineProperty(navigator, 'share', { value: undefined }); } catch (e) {}")
    p2.goto(BASE, wait_until="networkidle")
    p2.set_input_files("#fileInput", [os.path.join(HERE, "shot1.png")])
    p2.wait_for_selector(".item"); p2.wait_for_timeout(700)
    # وسط‌چین بودن عکس تکی روی A5 (چیدمان دوتایی)
    p2.locator('#paperSeg button[data-paper="A5"]').click()
    p2.wait_for_timeout(400)
    y_mm = p2.evaluate("() => parseFloat(document.querySelector('#page .item').style.top)")
    h_mm = p2.evaluate("() => parseFloat(document.querySelector('#page .item').style.height)")
    check(abs(y_mm - (210 - h_mm) / 2) < 0.6,
          f"عکس تکی در چیدمان دوتایی A5 عموداً وسط کاغذ است (y={y_mm}mm)")

    with p2.expect_download(timeout=30000) as dl3:
        p2.locator("#shareJpgBtn").click()
    fn3 = dl3.value.suggested_filename
    print("   fallback share → download:", fn3)
    check(_re.fullmatch(r".*_14\d{2}-\d{2}-\d{2}\.jpg", fn3) is not None,
          f"بدون Web Share فایل دانلود شد با نام شمسی: {fn3}")
    b2.close()

# ---- اعتبارسنجی فایل‌های خروجی ----
img = Image.open(png_path)
check(img.format == "JPEG", f"فرمت فایل خروجی عکس = {img.format}")
exp_px = (round(210 * 300 / 25.4), round(297 * 300 / 25.4))
check(img.size == exp_px, f"ابعاد JPG = {img.size} (انتظار {exp_px} = A4 در ۳۰۰dpi)")
# بررسی اینکه صفحه سفید نیست و عکس‌ها واقعاً کشیده شده‌اند
thumb = img.convert("L").resize((40, 56))
px = list(thumb.getdata())
check(min(px) < 200, f"JPG محتوای واقعی دارد (تیره‌ترین پیکسل = {min(px)})")

r = PdfReader(pdf_path)
check(len(r.pages) == 1, f"PDF یک صفحه دارد ({len(r.pages)})")
mb = r.pages[0].mediabox
check(abs(float(mb.width) - 210 * MM) < 0.5 and abs(float(mb.height) - 297 * MM) < 0.5,
      f"اندازه کاغذ PDF = {float(mb.width)/MM:.1f}×{float(mb.height)/MM:.1f}mm (A4)")
ops = [op.decode() for _, op in r.pages[0].get_contents().operations]
check(ops.count("Do") == 4, f"۴ تصویر در PDF رسم شده (تعداد Do = {ops.count('Do')})")
check(len(r.pages[0].images) >= 4, "تصاویر به‌صورت XObject جاسازی شده‌اند")

print()
print("نتیجه:", "همه‌ی بررسی‌ها موفق ✅" if not fails else f"{len(fails)} مورد ناموفق ❌")
sys.exit(0 if not fails else 1)
