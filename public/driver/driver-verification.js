/* SIYMON Driver Verification & Issue Reporting Suite (Sections 7, 9, 14) */
(function () {
  "use strict";
  function injectDriverVerificationPanel() {
    var activeBox = document.getElementById("activeList");
    if (!activeBox || document.getElementById("drvVerifyBar")) return;
    var wrap = document.createElement("div");
    wrap.id = "drvVerifyBar";
    wrap.className = "card";
    wrap.style.marginBottom = "12px";
    wrap.style.border = "1px solid rgba(93,214,44,0.35)";
    wrap.innerHTML =
      '<div style="font-weight:700;color:#5DD62C;margin-bottom:8px">التحقق من الاستلام والتسليم / Pickup & Delivery Verification</div>' +
      '<div style="display:grid;gap:8px">' +
      '  <input id="drvVerOrderId" placeholder="رقم الطلب النشط (Order ID)" />' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <input id="drvPickupCode" placeholder="رمز الاستلام من المتجر (4 أرقام)" inputmode="numeric" maxlength="6" style="flex:1" />' +
      '    <button class="btn primary sm" id="drvVerifyPickupBtn" type="button">تأكيد الاستلام</button>' +
      '  </div>' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <input id="drvDeliveryCode" placeholder="رمز التسليم من العميل (4 أرقام)" inputmode="numeric" maxlength="6" style="flex:1" />' +
      '    <button class="btn primary sm" id="drvVerifyDeliveryBtn" type="button">تأكيد التسليم</button>' +
      '  </div>' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <input id="drvIssueReason" placeholder="سبب تعذر التسليم (في حال وجود مشكلة)" style="flex:1" />' +
      '    <button class="btn ghost sm" id="drvReportIssueBtn" type="button">إبلاغ عن مشكلة</button>' +
      '  </div>' +
      '  <div id="drvVerifyMsg" class="hint"></div>' +
      '</div>';
    activeBox.parentNode.insertBefore(wrap, activeBox);

    function callDriverApi(path, body) {
      var tok = "";
      try { tok = localStorage.getItem("siymon_driver_token_v1") || localStorage.getItem("driverToken") || ""; } catch (_e) {}
      return fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Driver-Token": tok, Authorization: tok ? "Bearer " + tok : "" },
        body: JSON.stringify(body),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; });
      });
    }

    document.getElementById("drvVerifyPickupBtn").addEventListener("click", function () {
      var oid = document.getElementById("drvVerOrderId").value.trim();
      var code = document.getElementById("drvPickupCode").value.trim();
      if (!oid || !code) return;
      callDriverApi("/api/driver/orders/" + encodeURIComponent(oid) + "/verify-pickup", { code: code }).then(function (r) {
        document.getElementById("drvVerifyMsg").textContent = r.ok ? "✅ تم التحقق من استلام الطلب بنجاح" : (r.body.error || "رمز غير صحيح");
      });
    });

    document.getElementById("drvVerifyDeliveryBtn").addEventListener("click", function () {
      var oid = document.getElementById("drvVerOrderId").value.trim();
      var code = document.getElementById("drvDeliveryCode").value.trim();
      if (!oid || !code) return;
      callDriverApi("/api/driver/orders/" + encodeURIComponent(oid) + "/verify-delivery", { code: code }).then(function (r) {
        document.getElementById("drvVerifyMsg").textContent = r.ok ? "✅ تم التحقق من تسليم الطلب للعميل بنجاح" : (r.body.error || "رمز غير صحيح");
      });
    });

    document.getElementById("drvReportIssueBtn").addEventListener("click", function () {
      var oid = document.getElementById("drvVerOrderId").value.trim();
      var reason = document.getElementById("drvIssueReason").value.trim();
      if (!oid || !reason) return;
      callDriverApi("/api/driver/orders/" + encodeURIComponent(oid) + "/report-issue", { issueType: "cannot_complete", reason: reason }).then(function (r) {
        document.getElementById("drvVerifyMsg").textContent = r.ok ? "تم تسجيل البلاغ وإبلاغ المشرف" : (r.body.error || "خطأ");
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectDriverVerificationPanel);
  } else {
    injectDriverVerificationPanel();
  }
})();
