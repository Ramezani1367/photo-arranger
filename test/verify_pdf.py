"""اعتبارسنجی PDF تولیدشده: ساختار، ابعاد کاغذ، جای تصاویر و چرخش‌ها."""
import json, math, sys
from pypdf import PdfReader

MM = 72 / 25.4
reader = PdfReader("sample.pdf")
expected = json.load(open("expected.json"))

ok = True
def check(cond, msg):
    global ok
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        ok = False

def mul(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    # CTM' = m x CTM  →  e' = e1*a2 + f1*c2 + e2 ، f' = e1*b2 + f1*d2 + f2
    return (a1*a2 + b1*c2, a1*b2 + b1*d2,
            c1*a2 + d1*c2, c1*b2 + d1*d2,
            e1*a2 + f1*c2 + e2, e1*b2 + f1*d2 + f2)

IDENT = (1, 0, 0, 1, 0, 0)

def analyze(page):
    """پیمایش دستورات صفحه و محاسبه‌ی چهارگوش هر تصویر در فضای صفحه."""
    stack, ctm, out = [], list(IDENT), []
    for operands, op in page.get_contents().operations:
        op = op.decode()
        if op == "cm":
            # p' = p x m x CTM  →  با تعریف mul(m1,m2) = m2 x m1 ، فراخوانی باید mul(m, CTM) باشد
            ctm = mul(tuple(float(v) for v in operands), ctm)
        elif op == "q":
            stack.append(list(ctm))
        elif op == "Q":
            if stack:
                ctm = stack.pop()
        elif op == "Do":
            a, b, c, d, e, f = ctm
            pts = [(a*x + c*y + e, b*x + d*y + f) for x, y in ((0, 0), (1, 0), (1, 1), (0, 1))]
            out.append({"name": str(operands[0]), "pts": pts, "ctm": ctm})
    return out

def bbox(pts):
    """x_min، y_min (پایین)، عرض و ارتفاع — همه در فضای PDF (مبدأ پایین-چپ)."""
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)

check(not reader.is_encrypted, "فایل رمزنگاری نشده است")
check(len(reader.pages) == len(expected["pages"]), f"تعداد صفحه‌ها = {len(reader.pages)}")

total_images = 0
for i, page in enumerate(reader.pages):
    exp = expected["pages"][i]
    mb = page.mediabox
    check(abs(float(mb.width) - exp["wMM"] * MM) < 0.5,
          f"صفحه {i+1}: عرض کاغذ {float(mb.width)/MM:.1f}mm (انتظار {exp['wMM']}mm)")
    check(abs(float(mb.height) - exp["hMM"] * MM) < 0.5,
          f"صفحه {i+1}: ارتفاع کاغذ {float(mb.height)/MM:.1f}mm (انتظار {exp['hMM']}mm)")

    drawn = analyze(page)
    total_images += len(drawn)
    check(len(drawn) == len(exp["boxes"]),
          f"صفحه {i+1}: تعداد تصویر کشیده‌شده = {len(drawn)} (انتظار {len(exp['boxes'])})")

    H_pt = float(mb.height)
    for k, (item, e) in enumerate(zip(drawn, exp["boxes"])):
        ex, ey, ew, eh, rot = e
        bx, by, bw, bh = bbox(item["pts"])
        # بالای کادر در فضای PDF = by + bh؛ تبدیل به مبدأ بالا-چپ
        got_x, got_y = bx / MM, (H_pt - (by + bh)) / MM
        got_w, got_h = bw / MM, bh / MM
        check(abs(got_x - ex) < 0.05 and abs(got_y - ey) < 0.05,
              f"صفحه {i+1} تصویر {k+1}: جای ({got_x:.2f},{got_y:.2f})mm == انتظار ({ex:.2f},{ey:.2f})mm")
        check(abs(got_w - ew) < 0.05 and abs(got_h - eh) < 0.05,
              f"صفحه {i+1} تصویر {k+1}: کادر {got_w:.2f}×{got_h:.2f}mm == انتظار {ew:.2f}×{eh:.2f}mm")

        a, b, c, d, e_, f_ = item["ctm"]
        # گوشه‌های تصویر در فضای صفحه (پوینت، مبدأ پایین-چپ)
        P = {(x, y): (a*x + c*y + e_, b*x + d*y + f_) for x in (0, 1) for y in (0, 1)}
        bx0, by0 = bx, by
        tol_pt = 0.6
        def near(pt, tx, ty):
            return abs(pt[0] - tx) < tol_pt and abs(pt[1] - ty) < tol_pt

        if rot == 0:
            # بدون چرخش: گوشه‌ها سرِ جای خودشان
            good = (near(P[(0, 0)], bx0, by0) and near(P[(1, 1)], bx0 + bw, by0 + bh)
                    and abs(math.hypot(a, b) / MM - ew) < 0.05)
            check(good, f"صفحه {i+1} تصویر {k+1}: بدون چرخش، گوشه‌ها منطبق بر کادر")
        elif rot in (90, 180, 270):
            # چرخش ساعتگرد حول مرکز: گوشه‌ی (x,y) تصویر باید به گوشه‌ی چرخیده‌ی کادر برود
            # ۹۰° ساعتگرد: پایین-چپ تصویر → بالا-چپ کادر
            # ۱۸۰°       : پایین-چپ تصویر → بالا-راست کادر
            # ۲۷۰°       : پایین-چپ تصویر → پایین-راست کادر
            target = {90: (bx0, by0 + bh), 180: (bx0 + bw, by0 + bh), 270: (bx0 + bw, by0)}[rot]
            good = near(P[(0, 0)], target[0], target[1])
            # و گوشه‌ی پایین-راست تصویر باید ۹۰ درجه در همان جهت بچرخد
            nxt = {90: (bx0, by0), 180: (bx0, by0 + bh), 270: (bx0 + bw, by0 + bh)}[rot]
            good = good and near(P[(1, 0)], nxt[0], nxt[1])
            check(good, f"صفحه {i+1} تصویر {k+1}: چرخش {rot}° ساعتگرد درست اعمال شده")
        else:
            good = (abs(math.hypot(a, b) / MM - ew) < 0.05 and abs(b) < 1e-6
                    and near(P[(0, 0)], bx0, by0))
            check(good, f"صفحه {i+1} تصویر {k+1}: رسترِ چرخیده بدون چرخش اضافی در PDF "
                        f"(عرض ماتریس {math.hypot(a,b)/MM:.2f}mm == کادر {ew:.2f}mm)")

# هر تصویر باید یک XObject واقعی با داده‌ی JPEG باشد
imgs = reader.pages[0].images
check(len(imgs) >= 4, f"تعداد XObject تصویر در منابع = {len(imgs)}")
jpeg_ok = all(im.image.format == "JPEG" for im in imgs)
check(jpeg_ok, "همه‌ی تصاویر با فیلتر DCTDecode (JPEG) جاسازی شده‌اند")
check(total_images == sum(len(p["boxes"]) for p in expected["pages"]),
      f"مجموع تصاویر در کل فایل = {total_images}")

print()
print("نتیجه:", "همه‌ی بررسی‌ها موفق ✅" if ok else "خطا وجود دارد ❌")
sys.exit(0 if ok else 1)
