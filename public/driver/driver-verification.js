/* SIYMON Driver Verification, Issue Reporting & Financial Reports Suite (Sections 9, 15, 17):
   - Pickup Code verification (verify before confirming collection from business)
   - Delivery Code verification (verify customer's code before confirming delivery)
   - Report delivery failure / cannot complete order (triggers safe reassignment or supervisor exception)
   - Driver Financial & Earnings Reports with CSV / Excel / PDF Export
*/
(function () {
  "use strict";
  function getDriverToken() {
    try {
      return (
        localStorage.getItem("SIYMON_DRIVER_TOKEN") ||
        localStorage.getItem("siymon_driver_token_v1") ||
        localStorage.getItem("driverToken") ||
        ""
      );
    } catch (_e) {
      return "";
    }
  }
  function drvApi(path, opts) {
    opts = opts || {};
    var tok = getDriverToken();
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (tok) {
      headers["X-Driver-Token"] = tok;
      headers["Authorization"] = "Bearer " + tok;
    }
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    });
  }

  function injectVerificationBars() {
    var activeList = document.getElementById("mineList");
    if (!activeList) return;
    var cards = activeList.querySelectorAll(".o-card[data-oid]");
    cards.forEach(function (card) {
      var oid = card.getAttribute("data-oid");
      if (!oid || card.querySelector(".drv-verify-bar")) return;
      var bar = document.createElement("div");
      bar.className = "drv-verify-bar";
      bar.style.marginTop = "10px";
      bar.style.padding = "10px";
      bar.style.borderRadius = "10px";
      bar.style.background = "rgba(93,214,44,0.08)";
      bar.style.border = "1px solid rgba(93,214,44,0.35)";
      bar.innerHTML =
        '<div style="font-size:12px;font-weight:700;margin-bottom:6px;color:#5DD62C">التحقق من الاستلام والتسليم (Pickup & Delivery Codes)</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
        '  <input class="input" data-vcode-for="' + oid + '" placeholder="أدخل كود 4 أرقام" style="max-width:130px;padding:6px 8px" maxlength="6" />' +
        '  <button type="button" class="btn small" data-vpickup="' + oid + '">تأكيد كود المتجر</button>' +
        '  <button type="button" class="btn small primary" data-vdeliv="' + oid + '">تأكيد كود الزبون</button>' +
        '  <button type="button" class="btn small danger" data-vissue="' + oid + '">إبلاغ عن مشكلة / تعذر التسليم</button>' +
        '</div>' +
        '<div class="muted" data-vmsg="' + oid + '" style="font-size:12px;margin-top:4px"></div>';
      card.appendChild(bar);

      var codeInp = bar.querySelector('[data-vcode-for="' + oid + '"]');
      var msgEl = bar.querySelector('[data-vmsg="' + oid + '"]');

      bar.querySelector('[data-vpickup="' + oid + '"]').addEventListener("click", function () {
        var code = (codeInp.value || "").trim();
        if (!code) { msgEl.textContent = "أدخل كود الاستلام من المتجر أولاً"; return; }
        drvApi("/api/driver/orders/" + encodeURIComponent(oid) + "/verify-pickup", {
          method: "POST",
          body: JSON.stringify({ code: code }),
        }).then(function (r) {
          msgEl.textContent = r.ok ? "✅ تم التحقق من استلام الطلب من المتجر بنجاح!" : ("❌ " + (r.body.error || "كود غير صحيح"));
        });
      });

      bar.querySelector('[data-vdeliv="' + oid + '"]').addEventListener("click", function () {
        var code = (codeInp.value || "").trim();
        if (!code) { msgEl.textContent = "أدخل كود التسليم من الزبون أولاً"; return; }
        drvApi("/api/driver/orders/" + encodeURIComponent(oid) + "/verify-delivery", {
          method: "POST",
          body: JSON.stringify({ code: code }),
        }).then(function (r) {
          msgEl.textContent = r.ok ? "✅ تم التحقق من كود التسليم وإتمام التوصيل!" : ("❌ " + (r.body.error || "كود غير صحيح"));
        });
      });

      bar.querySelector('[data-vissue="' + oid + '"]').addEventListener("click", function () {
        var reason = prompt("سبب المشكلة / تعذر التسليم (مثلاً: عطل بالدراجة، الزبون لا يرد):", "");
        if (!reason) return;
        var issueType = confirm("هل المشكلة تعطل يمنعك من متابعة الطلب قبل الاستلام؟ (موافق = طلب إعادة تعيين سائق، إلغاء = فشل تسليم عند الزبون)")
          ? "cannot_complete"
          : "failed_delivery";
        drvApi("/api/driver/orders/" + encodeURIComponent(oid) + "/report-issue", {
          method: "POST",
          body: JSON.stringify({ issueType: issueType, reason: reason }),
        }).then(function (r) {
          msgEl.textContent = r.ok
            ? (r.body.reassigned ? "تم سحب الطلب وإعادة توجيهه لسائق آخر." : "تم إبلاغ المشرف بالاستثناء.")
            : ("❌ " + (r.body.error || "خطأ"));
        });
      });
    });
  }

  function injectDriverReportCard() {
    var walletPage = document.getElementById("pageWallet");
    if (!walletPage || document.getElementById("drvFinReportCard")) return;
    var tok = getDriverToken();
    if (!tok) return;

    var card = document.createElement("div");
    card.id = "drvFinReportCard";
    card.className = "card";
    card.style.marginTop = "14px";
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
      '  <b>📊 التقرير المالي وأرباح التوصيل</b>' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <button type="button" class="btn small" id="drvRepLoadBtn">تحديث التقرير</button>' +
      '    <button type="button" class="btn small" id="drvRepCsvBtn">CSV</button>' +
      '    <button type="button" class="btn small" id="drvRepXlsxBtn">Excel</button>' +
      '    <button type="button" class="btn small" id="drvRepPdfBtn">PDF</button>' +
      '  </div>' +
      '</div>' +
      '<div id="drvRepSummary" class="muted" style="margin-top:8px;font-size:13px"></div>';
    walletPage.appendChild(card);

    function loadReport() {
      drvApi("/api/driver/reports").then(function (r) {
        if (!r.ok || !r.body.summary) return;
        var s = r.body.summary;
        document.getElementById("drvRepSummary").innerHTML =
          "الطلبات المكتملة: <b>" + s.completedOrders + "</b> | إجمالي أرباح السائق: <b style='color:#5DD62C'>" + s.totalDriverEarnings + " MAD</b> | رسوم التوصيل: <b>" + s.totalDeliveryFees + " MAD</b>";
      });
    }
    document.getElementById("drvRepLoadBtn").addEventListener("click", loadReport);
    ["csv", "xlsx", "pdf"].forEach(function (fmt) {
      var btnId = fmt === "csv" ? "drvRepCsvBtn" : fmt === "xlsx" ? "drvRepXlsxBtn" : "drvRepPdfBtn";
      document.getElementById(btnId).addEventListener("click", function () {
        fetch("/api/driver/reports?format=" + fmt, {
          headers: { Authorization: "Bearer " + getDriverToken() },
        })
          .then(function (r) { return r.blob(); })
          .then(function (blob) {
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "siymon-driver-report." + fmt;
            a.click();
          });
      });
    });
    loadReport();
  }

  setInterval(function () {
    injectVerificationBars();
    injectDriverReportCard();
  }, 1500);
})();
