/*
 * jalali.js — تبدیل میلادی→شمسی (الگوریتم استاندارد جلالی)
 * برای نام‌گذاری خروجی‌ها: prefix_1405-06-29.pdf
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Jalali = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function div(a, b) { return ~~(a / b); }
  function mod(a, b) { return a - ~~(a / b) * b; }

  function gregorianToJalali(gy, gm, gd) {
    var gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var jy = (gy <= 1600) ? 0 : 979;
    gy -= (gy <= 1600) ? 621 : 1600;
    var gy2 = (gm > 2) ? (gy + 1) : gy;
    var days = (365 * gy) + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400)
      - 80 + gd + gdm[gm - 1];
    jy += 33 * div(days, 12053);
    days = mod(days, 12053);
    jy += 4 * div(days, 1461);
    days = mod(days, 1461);
    if (days > 365) {
      jy += div(days - 1, 365);
      days = mod(days - 1, 365);
    }
    var jm = (days < 186) ? 1 + div(days, 31) : 7 + div(days - 186, 30);
    var jd = 1 + ((days < 186) ? mod(days, 31) : mod(days - 186, 30));
    return [jy, jm, jd];
  }

  function pad(v) { return (v < 10 ? '0' : '') + v; }

  function todayString() {
    var d = new Date();
    var j = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return j[0] + '-' + pad(j[1]) + '-' + pad(j[2]);
  }

  return { gregorianToJalali: gregorianToJalali, todayString: todayString };
});
