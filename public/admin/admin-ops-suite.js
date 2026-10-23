/* SIYMON Supervisor Operations Suite:
   - Unified Exception Center (Section 14)
   - Accounting, Reports (CSV/Excel/PDF), Manual Settlements, Refunds, Wallet, Promotions & Service Zones (Sections 10, 11, 12, 17, 18)
   - Rating Comment Moderation, Granular Supervisors, Verified Backups & System Health Monitoring (Sections 4, 16, 21, 22)
*/
(function () {
  "use strict";
  var TOKEN_KEY = "siymon_admin_token_v2";
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_e) { return ""; }
  }
  function api(url, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json", "X-Admin-Token": getToken() }, opts.headers || {});
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { ok: r.ok, status: r.status, body: body };
      });
    });
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function injectUI() {
    var navScroll = document.getElementById("sbScroll");
    if (navScroll && !document.getElementById("sbExceptionsBtn")) {
      var group = document.createElement("div");
      group.className = "sb-group";
      group.innerHTML =
        '<div class="sb-sep" role="separator"></div>' +
        '<div class="sb-label">العمليات والرقابة / Operations</div>' +
        '<button class="sb-item" id="sbExceptionsBtn" type="button" data-tip="مركز الاستثناءات">' +
        '  <span class="sb-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg></span>' +
        '  <span class="sb-text">مركز الاستثناءات</span>' +
        '  <span class="sb-badge" id="sbExcBadge" hidden>0</span>' +
        '</button>' +
        '<button class="sb-item" id="sbFinanceBtn" type="button" data-tip="المالية والتقارير والمناطق">' +
        '  <span class="sb-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/></svg></span>' +
        '  <span class="sb-text">المالية والتقارير</span>' +
        '</button>' +
        '<button class="sb-item" id="sbHealthBtn" type="button" data-tip="صحة النظام والرقابة">' +
        '  <span class="sb-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>' +
        '  <span class="sb-text">صحة النظام والرقابة</span>' +
        '</button>';
      navScroll.appendChild(group);
    }

    if (!document.getElementById("opsSuiteModal")) {
      var modal = document.createElement("div");
      modal.className = "modal";
      modal.id = "opsSuiteModal";
      modal.innerHTML =
        '<div class="modal-card" style="max-width:1180px;width:96%;max-height:90vh;overflow-y:auto">' +
        '  <div class="row" style="justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid rgba(93,214,44,0.25);padding-bottom:10px">' +
        '    <h3 id="opsSuiteTitle" style="margin:0;color:#5DD62C">SIYMON Operations & Governance</h3>' +
        '    <button class="btn ghost" id="closeOpsSuiteBtn" type="button">✕</button>' +
        '  </div>' +
        '  <div id="opsSuiteContent" style="margin-top:14px"></div>' +
        '</div>';
      document.body.appendChild(modal);
      document.getElementById("closeOpsSuiteBtn").addEventListener("click", function () {
        modal.classList.remove("show");
      });
    }

    var excBtn = document.getElementById("sbExceptionsBtn");
    if (excBtn) excBtn.addEventListener("click", openExceptionsCenter);
    var finBtn = document.getElementById("sbFinanceBtn");
    if (finBtn) finBtn.addEventListener("click", openFinanceAndZonesHub);
    var hltBtn = document.getElementById("sbHealthBtn");
    if (hltBtn) hltBtn.addEventListener("click", openHealthAndModerationHub);
  }

  /* ---------------- 1. Unified Exception Center ---------------- */
  function openExceptionsCenter() {
    var modal = document.getElementById("opsSuiteModal");
    var title = document.getElementById("opsSuiteTitle");
    var box = document.getElementById("opsSuiteContent");
    title.textContent = "مركز إدارة الاستثناءات والمشاكل / Unified Exception Center";
    modal.classList.add("show");
    box.innerHTML = '<div class="muted">جاري تحميل الحالات...</div>';

    api("/api/admin/exceptions").then(function (r) {
      if (!r.ok) {
        box.innerHTML = '<div class="hint">' + esc(r.body.error || "Unauthorized") + "</div>";
        return;
      }
      var cases = r.body.cases || [];
      var openCnt = cases.filter(function (c) { return c.status !== "resolved"; }).length;
      var badge = document.getElementById("sbExcBadge");
      if (badge) { badge.hidden = !openCnt; badge.textContent = String(openCnt); }

      var html =
        '<div class="panel-like" style="margin-bottom:14px">' +
        '  <h4 style="margin:0 0 8px">تجاوز رمز التحقق (استثناء المشرف) / Verification Code Override</h4>' +
        '  <div class="row" style="gap:8px;flex-wrap:wrap">' +
        '    <input id="ovrOrderId" placeholder="رقم الطلب (Order ID)" style="max-width:180px" />' +
        '    <select id="ovrStage" style="max-width:160px"><option value="pickup">استلام من المتجر (Pickup)</option><option value="delivery">تسليم للعميل (Delivery)</option></select>' +
        '    <input id="ovrReason" placeholder="سبب التجاوز الإجباري (Reason)" style="flex:1;min-width:220px" />' +
        '    <button class="btn good" id="ovrSubmitBtn" type="button">تأكيد التجاوز الموثق</button>' +
        '  </div>' +
        '  <div id="ovrMsg" class="hint" style="margin-top:6px"></div>' +
        '</div>' +
        '<div style="display:grid;gap:10px">';

      if (!cases.length) {
        html += '<div class="panel-like muted">لا توجد استثناءات مفتوحة حالياً.</div>';
      } else {
        cases.forEach(function (c) {
          var isRes = c.status === "resolved";
          html +=
            '<div class="panel-like" style="border-inline-start:4px solid ' + (isRes ? "#337418" : "#f59e0b") + '">' +
            '  <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap">' +
            '    <div><b>[' + esc(c.category) + "] " + esc(c.title) + '</b> <span class="badge">' + esc(c.status) + "</span></div>" +
            '    <div class="muted" style="font-size:12px">' + esc(c.createdAt) + " | #" + esc(c.id) + "</div>" +
            "  </div>" +
            '  <div style="margin:6px 0">' + esc(c.description) + (c.orderId ? " (Order: <b>" + esc(c.orderId) + "</b>)" : "") + "</div>" +
            (isRes
              ? '<div class="muted" style="font-size:12px">تم الحل: ' + esc(c.resolution && c.resolution.decision) + " — " + esc(c.resolution && c.resolution.notes) + "</div>"
              : '<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">' +
                '  <select data-exc-dec="' + esc(c.id) + '" style="max-width:190px">' +
                '    <option value="resolved">تمت المعالجة (Resolved)</option>' +
                '    <option value="reassigned">إعادة تعيين سائق (Reassign)</option>' +
                '    <option value="redelivery_scheduled">جدولة إعادة توصيل (Redelivery)</option>' +
                '    <option value="dismissed">إغلاق (Dismiss)</option>' +
                "  </select>" +
                '  <input data-exc-note="' + esc(c.id) + '" placeholder="ملاحظات الحل..." style="flex:1;min-width:200px" />' +
                '  <button class="btn good small" data-exc-btn="' + esc(c.id) + '" type="button">حفظ القرار</button>' +
                "</div>") +
            "</div>";
        });
      }
      html += "</div>";
      box.innerHTML = html;

      var ovrBtn = document.getElementById("ovrSubmitBtn");
      if (ovrBtn) {
        ovrBtn.addEventListener("click", function () {
          var oid = document.getElementById("ovrOrderId").value.trim();
          var stg = document.getElementById("ovrStage").value;
          var rsn = document.getElementById("ovrReason").value.trim();
          api("/api/admin/orders/" + encodeURIComponent(oid) + "/override-verification", {
            method: "POST",
            body: JSON.stringify({ stage: stg, reason: rsn }),
          }).then(function (res) {
            document.getElementById("ovrMsg").textContent = res.ok
              ? "تم توثيق التجاوز بنجاح."
              : (res.body.error || "فشل التجاوز");
          });
        });
      }

      box.querySelectorAll("[data-exc-btn]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-exc-btn");
          var dec = box.querySelector('[data-exc-dec="' + id + '"]').value;
          var notes = box.querySelector('[data-exc-note="' + id + '"]').value.trim();
          api("/api/admin/exceptions/" + encodeURIComponent(id) + "/resolve", {
            method: "POST",
            body: JSON.stringify({ decision: dec, notes: notes }),
          }).then(function (res) {
            if (res.ok) openExceptionsCenter();
            else alert(res.body.error || "Error");
          });
        });
      });
    });
  }

  /* ---------------- 2. Finance, Reports, Settlements, Zones Hub ---------------- */
  function openFinanceAndZonesHub() {
    var modal = document.getElementById("opsSuiteModal");
    var title = document.getElementById("opsSuiteTitle");
    var box = document.getElementById("opsSuiteContent");
    title.textContent = "المالية، التقارير، المحافظ، العروض ومناطق الخدمة / Finance, Reports & Zones";
    modal.classList.add("show");
    box.innerHTML = '<div class="muted">جاري تحميل البيانات المالية...</div>';

    Promise.all([
      api("/api/admin/reports?period=daily"),
      api("/api/admin/promotions"),
      api("/api/admin/service-zones"),
    ]).then(function (results) {
      var repRes = results[0];
      var prmRes = results[1];
      var znRes = results[2];
      var s = (repRes.body && repRes.body.report && repRes.body.report.summary) || {};
      var zones = (znRes.body && znRes.body.zones) || [];
      var coupons = (prmRes.body && prmRes.body.coupons) || [];
      var tok = encodeURIComponent(getToken());

      box.innerHTML =
        '<div class="grid2" style="gap:12px;margin-bottom:14px">' +
        '  <div class="panel-like">' +
        '    <h4 style="margin:0 0 8px;color:#5DD62C">ملخص المبيعات والعمولات / Financial Summary</h4>' +
        '    <div>إجمالي الطلبات المسلّمة: <b>' + esc(s.deliveredOrders || 0) + "</b> / " + esc(s.totalOrders || 0) + "</div>" +
        '    <div>إجمالي المبيعات (Gross Sales): <b>' + esc(s.grossSales || 0) + " MAD</b></div>" +
        '    <div>عمولات المنصة (Commissions): <b>' + esc(s.totalPlatformCommissions || 0) + " MAD</b></div>" +
        '    <div>صافي مستحقات المتاجر: <b>' + esc(s.totalNetMerchantPayable || 0) + " MAD</b></div>" +
        '    <div>أرباح السائقين: <b>' + esc(s.totalDriverEarnings || 0) + " MAD</b></div>" +
        '    <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
        '      <button class="btn small good" id="expCsvBtn" type="button">تصدير CSV</button>' +
        '      <button class="btn small good" id="expXlsBtn" type="button">تصدير Excel (.xls)</button>' +
        '      <button class="btn small good" id="expPdfBtn" type="button">تصدير PDF</button>' +
        "    </div>" +
        "  </div>" +
        '  <div class="panel-like">' +
        '    <h4 style="margin:0 0 8px;color:#5DD62C">التسويات اليدوية والاسترداد والمحفظة / Settlements & Refunds</h4>' +
        '    <div class="row" style="gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
        '      <select id="stlType" style="max-width:110px"><option value="store">متجر</option><option value="driver">سائق</option></select>' +
        '      <input id="stlTargetId" placeholder="معرف المتجر/السائق (ID)" style="flex:1" />' +
        '      <input id="stlRef" placeholder="مرجع الدفع" style="max-width:130px" />' +
        '      <button class="btn small good" id="stlCreateBtn" type="button">تسجيل تسوية</button>' +
        "    </div>" +
        '    <div class="row" style="gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
        '      <input id="rfdOrderId" placeholder="رقم الطلب للاسترداد" style="flex:1" />' +
        '      <input id="rfdAmount" type="number" step="0.01" placeholder="المبلغ (اختياري)" style="max-width:120px" />' +
        '      <input id="rfdReason" placeholder="السبب" style="flex:1" />' +
        '      <button class="btn small" id="rfdBtn" type="button">استرداد للمحفظة</button>' +
        "    </div>" +
        '    <div class="row" style="gap:6px;flex-wrap:wrap">' +
        '      <input id="wltCustId" placeholder="معرف العميل (Customer ID)" style="flex:1" />' +
        '      <input id="wltAmount" type="number" step="0.01" placeholder="المبلغ MAD" style="max-width:110px" />' +
        '      <input id="wltReason" placeholder="سبب التعديل" style="flex:1" />' +
        '      <button class="btn small" id="wltCreditBtn" type="button">شحن محفظة</button>' +
        "    </div>" +
        '    <div id="finActionMsg" class="hint" style="margin-top:6px"></div>' +
        "  </div>" +
        "</div>" +
        '<div class="grid2" style="gap:12px">' +
        '  <div class="panel-like">' +
        '    <h4 style="margin:0 0 8px">الكوبونات والعروض الترويجية / Promotions</h4>' +
        '    <div class="row" style="gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
        '      <input id="prmCode" placeholder="الكود (مثال: BERRECHID20)" style="max-width:150px" />' +
        '      <select id="prmType" style="max-width:130px"><option value="percent">نسبة %</option><option value="fixed">مبلغ ثابت</option><option value="free_delivery">توصيل مجاني</option></select>' +
        '      <input id="prmVal" type="number" placeholder="القيمة" style="max-width:90px" />' +
        '      <select id="prmBearer" style="max-width:130px"><option value="platform">تتحمله المنصة</option><option value="store">يتحمله المتجر</option><option value="split">مشترك</option></select>' +
        '      <button class="btn small good" id="prmAddBtn" type="button">إضافة</button>' +
        "    </div>" +
        '    <div style="font-size:13px">' +
        (coupons.length
          ? coupons.map(function (c) {
              return "<div>• <b>" + esc(c.code) + "</b> (" + esc(c.discountType) + ": " + esc(c.value) + ") — Bearer: " + esc(c.costBearer) + " — Used: " + esc(c.usedCount || 0) + "</div>";
            }).join("")
          : '<span class="muted">لا توجد كوبونات حالياً</span>') +
        "    </div>" +
        "  </div>" +
        '  <div class="panel-like">' +
        '    <h4 style="margin:0 0 8px">مناطق الخدمة وتسعير المسافة (برشيد) / Service Zones & Road Pricing</h4>' +
        zones.map(function (z) {
          return (
            '<div style="border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:8px;margin-bottom:8px">' +
            "  <div><b>" + esc((z.name && (z.name.ar || z.name.en)) || z.id) + "</b> (" + esc(z.city) + ") — نصف القطر: " + esc(z.radiusKm) + " كم | أقصى مسافة طريق: " + esc(z.maxRoadDistanceKm) + " كم</div>" +
            '  <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">' +
            '    <label style="font-size:12px">سعر الكم (MAD/km): <input id="znPriceKm_' + esc(z.id) + '" type="number" step="0.5" value="' + esc(z.pricing && z.pricing.pricePerKm) + '" style="width:70px" /></label>' +
            '    <label style="font-size:12px">أساسي السائق: <input id="znDrvBase_' + esc(z.id) + '" type="number" step="0.5" value="' + esc(z.driverEarnings && z.driverEarnings.basePay) + '" style="width:70px" /></label>' +
            '    <label style="font-size:12px">سائق/كم: <input id="znDrvKm_' + esc(z.id) + '" type="number" step="0.5" value="' + esc(z.driverEarnings && z.driverEarnings.distanceRatePerKm) + '" style="width:70px" /></label>' +
            '    <button class="btn small good" data-zn-save="' + esc(z.id) + '" type="button">حفظ التسعير</button>' +
            "  </div>" +
            "</div>"
          );
        }).join("") +
        "  </div>" +
        "</div>";

      function downloadExport(fmt) {
        fetch("/api/admin/reports/export?format=" + fmt, { headers: { "X-Admin-Token": getToken() } })
          .then(function (r) { return r.blob(); })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = u;
            a.download = "siymon-report." + (fmt === "xlsx" ? "xls" : fmt);
            a.click();
          });
      }
      document.getElementById("expCsvBtn").addEventListener("click", function () { downloadExport("csv"); });
      document.getElementById("expXlsBtn").addEventListener("click", function () { downloadExport("xlsx"); });
      document.getElementById("expPdfBtn").addEventListener("click", function () { downloadExport("pdf"); });

      document.getElementById("stlCreateBtn").addEventListener("click", function () {
        api("/api/admin/settlements", {
          method: "POST",
          body: JSON.stringify({
            targetType: document.getElementById("stlType").value,
            targetId: document.getElementById("stlTargetId").value.trim(),
            reference: document.getElementById("stlRef").value.trim(),
          }),
        }).then(function (r) {
          document.getElementById("finActionMsg").textContent = r.ok
            ? "تم تسجيل التسوية #" + r.body.settlement.id + " بمبلغ صافي " + r.body.settlement.netPayout + " MAD"
            : (r.body.error || "فشل التسوية");
        });
      });

      document.getElementById("rfdBtn").addEventListener("click", function () {
        var oid = document.getElementById("rfdOrderId").value.trim();
        var amt = document.getElementById("rfdAmount").value;
        var rsn = document.getElementById("rfdReason").value.trim();
        api("/api/admin/orders/" + encodeURIComponent(oid) + "/refund", {
          method: "POST",
          body: JSON.stringify({
            amount: amt ? Number(amt) : null,
            destination: "wallet",
            reason: rsn,
          }),
        }).then(function (r) {
          document.getElementById("finActionMsg").textContent = r.ok
            ? "تم استرداد " + r.body.refund.amount + " MAD إلى محفظة العميل"
            : (r.body.error || "فشل الاسترداد");
        });
      });

      document.getElementById("wltCreditBtn").addEventListener("click", function () {
        var cid = document.getElementById("wltCustId").value.trim();
        var amt = Number(document.getElementById("wltAmount").value);
        var rsn = document.getElementById("wltReason").value.trim();
        api("/api/admin/wallets/" + encodeURIComponent(cid) + "/adjust", {
          method: "POST",
          body: JSON.stringify({ direction: "credit", amount: amt, reason: rsn }),
        }).then(function (r) {
          document.getElementById("finActionMsg").textContent = r.ok
            ? "الرصيد الجديد للعميل: " + r.body.balance + " MAD"
            : (r.body.error || "فشل التعديل");
        });
      });

      document.getElementById("prmAddBtn").addEventListener("click", function () {
        api("/api/admin/promotions", {
          method: "POST",
          body: JSON.stringify({
            code: document.getElementById("prmCode").value.trim(),
            discountType: document.getElementById("prmType").value,
            value: Number(document.getElementById("prmVal").value || 10),
            costBearer: document.getElementById("prmBearer").value,
          }),
        }).then(function (r) {
          if (r.ok) openFinanceAndZonesHub();
          else alert(r.body.error || "Error");
        });
      });

      box.querySelectorAll("[data-zn-save]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var zid = btn.getAttribute("data-zn-save");
          var pKm = Number(document.getElementById("znPriceKm_" + zid).value);
          var dBase = Number(document.getElementById("znDrvBase_" + zid).value);
          var dKm = Number(document.getElementById("znDrvKm_" + zid).value);
          api("/api/admin/service-zones/" + encodeURIComponent(zid), {
            method: "PUT",
            body: JSON.stringify({
              pricing: { pricePerKm: pKm, baseFee: 0 },
              driverEarnings: { basePay: dBase, distanceRatePerKm: dKm },
            }),
          }).then(function (r) {
            document.getElementById("finActionMsg").textContent = r.ok ? "تم تحديث تسعير المنطقة بنجاح." : "فشل التحديث";
          });
        });
      });
    });
  }

  /* ---------------- 3. System Health, Backups & Moderation Hub ---------------- */
  function openHealthAndModerationHub() {
    var modal = document.getElementById("opsSuiteModal");
    var title = document.getElementById("opsSuiteTitle");
    var box = document.getElementById("opsSuiteContent");
    title.textContent = "صحة النظام، النسخ الاحتياطي، مراجعة التعليقات وصلاحيات المشرفين";
    modal.classList.add("show");
    box.innerHTML = '<div class="muted">جاري فحص حالة النظام...</div>';

    Promise.all([
      api("/api/admin/system-health"),
      api("/api/admin/ratings/moderation"),
      api("/api/admin/supervisors"),
    ]).then(function (results) {
      var h = (results[0] && results[0].body) || {};
      var mod = (results[1] && results[1].body && results[1].body.pending) || [];
      var sups = (results[2] && results[2].body && results[2].body.supervisors) || [];

      box.innerHTML =
        '<div class="grid2" style="gap:12px;margin-bottom:14px">' +
        '  <div class="panel-like">' +
        '    <h4 style="margin:0 0 8px;color:#5DD62C">فحص صحة النظام الحقيقي / Live System Health</h4>' +
        '    <div>وقت التشغيل (Uptime): <b>' + esc(h.uptimeSec || 0) + "s</b> | الذاكرة: <b>" + esc(h.memoryMb || 0) + " MB</b></div>" +
        '    <div>التخزين: <b>' + esc(h.storage && h.storage.status) + "</b> | عدد النسخ الاحتياطية: <b>" + esc(h.storage && h.storage.backupCount) + "</b></div>" +
        '    <div>محرك التوزيع الذكي (H3): <b>' + esc(h.services && h.services.h3Dispatch && h.services.h3Dispatch.engine) + "</b> (سائقون متصلون: " + esc(h.services && h.services.h3Dispatch && h.services.h3Dispatch.onlineDrivers) + ")</div>" +
        '    <div>خدمة التوجيه الطرقي (Routing): <b>' + esc(h.services && h.services.roadRouting && h.services.roadRouting.provider) + "</b></div>" +
        '    <div>سلامة سجل التدقيق (Audit Chain): <b>' + (h.integrity && h.integrity.auditChain && h.integrity.auditChain.ok ? "✅ سليم (Verified)" : "⚠️ غير متحقق") + "</b></div>" +
        '    <div class="row" style="gap:8px;margin-top:10px">' +
        '      <button class="btn small good" id="createBackupBtn" type="button">إنشاء نسخة احتياطية موثقة (SHA-256)</button>' +
        '      <span id="backupStatusMsg" class="hint"></span>' +
        "    </div>" +
        "  </div>" +
        '  <div class="panel-like">' +
        '    <h4 style="margin:0 0 8px;color:#5DD62C">مراجعة تعليقات التقييم قبل النشر / Comment Moderation</h4>' +
        (mod.length
          ? mod.map(function (m) {
              return (
                '<div style="border-bottom:1px solid rgba(255,255,255,0.08);padding:6px 0">' +
                "  <div><b>★" + esc(m.stars) + "</b> (" + esc(m.targetType) + ") — " + esc(m.comment) + "</div>" +
                '  <div class="row" style="gap:6px;margin-top:4px">' +
                '    <button class="btn small good" data-mod-ord="' + esc(m.orderId) + '" data-mod-type="' + esc(m.targetType) + '" data-mod-st="approved" type="button">موافقة ونشر</button>' +
                '    <button class="btn small" data-mod-ord="' + esc(m.orderId) + '" data-mod-type="' + esc(m.targetType) + '" data-mod-st="rejected" type="button">رفض التعليق</button>' +
                "  </div>" +
                "</div>"
              );
            }).join("")
          : '<div class="muted">لا توجد تعليقات معلقة للمراجعة.</div>') +
        "  </div>" +
        "</div>" +
        '<div class="panel-like">' +
        '  <h4 style="margin:0 0 8px">إدارة أدوار المشرفين / Granular Supervisor Roles</h4>' +
        '  <div class="row" style="gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
        '    <input id="supName" placeholder="الاسم" style="max-width:150px" />' +
        '    <input id="supEmail" placeholder="البريد الإلكتروني" style="max-width:190px" />' +
        '    <input id="supPhone" placeholder="الهاتف" style="max-width:140px" />' +
        '    <select id="supRole" style="max-width:180px">' +
        '      <option value="order_supervisor">مشرف طلبات (order_supervisor)</option>' +
        '      <option value="driver_supervisor">مشرف سائقين (driver_supervisor)</option>' +
        '      <option value="accountant">محاسب (accountant)</option>' +
        '      <option value="support_agent">دعم فني (support_agent)</option>' +
        '      <option value="system_admin">مدير نظام (system_admin)</option>' +
        "    </select>" +
        '    <input id="supPass" type="password" placeholder="كلمة المرور" style="max-width:150px" />' +
        '    <button class="btn small good" id="supAddBtn" type="button">إضافة مشرف</button>' +
        "  </div>" +
        '  <div style="font-size:13px">' +
        sups.map(function (s) {
          return "<div>• <b>" + esc(s.email) + "</b> (" + esc(s.subRole) + ") — " + (s.isActive ? "نشط" : "معطل") + "</div>";
        }).join("") +
        "  </div>" +
        "</div>";

      var bkpBtn = document.getElementById("createBackupBtn");
      if (bkpBtn) {
        bkpBtn.addEventListener("click", function () {
          api("/api/admin/backups", { method: "POST", body: JSON.stringify({ label: "admin_ui_backup" }) }).then(function (r) {
            document.getElementById("backupStatusMsg").textContent = r.ok
              ? "تم الحفظ والتحقق: " + r.body.backup.id
              : (r.body.error || "فشل النسخ");
          });
        });
      }

      box.querySelectorAll("[data-mod-ord]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var oid = btn.getAttribute("data-mod-ord");
          var tt = btn.getAttribute("data-mod-type");
          var st = btn.getAttribute("data-mod-st");
          api("/api/admin/ratings/" + encodeURIComponent(oid) + "/moderate", {
            method: "POST",
            body: JSON.stringify({ targetType: tt, status: st }),
          }).then(function () { openHealthAndModerationHub(); });
        });
      });

      var supAdd = document.getElementById("supAddBtn");
      if (supAdd) {
        supAdd.addEventListener("click", function () {
          api("/api/admin/supervisors", {
            method: "POST",
            body: JSON.stringify({
              name: document.getElementById("supName").value.trim(),
              email: document.getElementById("supEmail").value.trim(),
              phone: document.getElementById("supPhone").value.trim(),
              subRole: document.getElementById("supRole").value,
              password: document.getElementById("supPass").value,
            }),
          }).then(function (r) {
            if (r.ok) openHealthAndModerationHub();
            else alert(r.body.error || "Error");
          });
        });
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectUI);
  } else {
    injectUI();
  }
})();
