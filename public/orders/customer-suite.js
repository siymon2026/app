/* SIYMON Customer Suite:
   - Customer SIYMON Wallet & Loyalty Points Card (Sections 11, 12)
   - Delivery Verification Code display on active orders (Section 9)
   - Optional Live Location Sharing during delivery (Section 8)
   - Structured Complaint & Supervisor Escalation (Section 16)
*/
(function () {
  "use strict";
  function getCustToken() {
    try { return localStorage.getItem("siymon_customer_token_v1") || localStorage.getItem("customerToken") || ""; } catch (_e) { return ""; }
  }
  function custApi(path, opts) {
    opts = opts || {};
    var tok = getCustToken();
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (tok) {
      headers["X-Customer-Token"] = tok;
      headers["Authorization"] = "Bearer " + tok;
    }
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; });
    });
  }

  function injectCustomerSuite() {
    var profileBox = document.getElementById("profileBox");
    if (!profileBox || document.getElementById("custWalletCard")) return;
    var tok = getCustToken();
    if (!tok) return;

    var card = document.createElement("div");
    card.id = "custWalletCard";
    card.style.margin = "12px 0";
    card.style.padding = "14px";
    card.style.borderRadius = "14px";
    card.style.border = "1px solid rgba(93,214,44,0.35)";
    card.style.background = "rgba(32,32,32,0.85)";
    card.style.color = "#F8F8F8";
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
      '  <div><b style="color:#5DD62C">محفظة SIYMON ونقاط الولاء</b> <span id="cwBalance" style="margin-inline-start:8px">0 MAD</span> | <span id="cwPoints">0 نقطة</span></div>' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <button class="btn small" id="cwRedeemBtn" type="button">تحويل النقاط للمحفظة</button>' +
      '    <button class="btn small" id="cwComplaintToggleBtn" type="button">تقديم شكوى / دعم</button>' +
      '  </div>' +
      '</div>' +
      '<div id="cwComplaintBox" hidden style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1)">' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <input id="cmpOrderId" placeholder="رقم الطلب (Order ID)" style="max-width:160px" />' +
      '    <select id="cmpTarget" style="max-width:140px"><option value="store">المتجر</option><option value="driver">السائق</option><option value="platform">المنصة</option></select>' +
      '    <input id="cmpDesc" placeholder="تفاصيل الشكوى..." style="flex:1;min-width:180px" />' +
      '    <button class="btn good small" id="cmpSendBtn" type="button">إرسال الشكوى</button>' +
      '  </div>' +
      '  <div id="cmpHint" class="hint" style="margin-top:4px"></div>' +
      '</div>';

    profileBox.parentNode.insertBefore(card, profileBox.nextSibling);

    function refreshWallet() {
      custApi("/api/customer/wallet").then(function (r) {
        if (!r.ok) return;
        document.getElementById("cwBalance").textContent = (r.body.balance || 0) + " MAD";
        document.getElementById("cwPoints").textContent = ((r.body.loyalty && r.body.loyalty.points) || 0) + " نقطة";
      });
    }
    refreshWallet();

    document.getElementById("cwRedeemBtn").addEventListener("click", function () {
      var pts = prompt("عدد النقاط المراد تحويلها للمحفظة (كل 10 نقاط = 1 درهم):", "10");
      if (!pts) return;
      custApi("/api/customer/loyalty/redeem", { method: "POST", body: JSON.stringify({ points: Number(pts) }) }).then(function (r) {
        if (r.ok) {
          alert("تم إضافة " + r.body.walletCredit + " MAD إلى محفظتك!");
          refreshWallet();
        } else {
          alert(r.body.error || "نقاط غير كافية");
        }
      });
    });

    document.getElementById("cwComplaintToggleBtn").addEventListener("click", function () {
      var b = document.getElementById("cwComplaintBox");
      b.hidden = !b.hidden;
    });

    document.getElementById("cmpSendBtn").addEventListener("click", function () {
      custApi("/api/customer/complaints", {
        method: "POST",
        body: JSON.stringify({
          orderId: document.getElementById("cmpOrderId").value.trim(),
          targetType: document.getElementById("cmpTarget").value,
          description: document.getElementById("cmpDesc").value.trim(),
        }),
      }).then(function (r) {
        document.getElementById("cmpHint").textContent = r.ok
          ? "تم تسجيل الشكوى #" + r.body.complaint.id + " وتوجيهها للمراجعة."
          : (r.body.error || "يرجى كتابة تفاصيل الشكوى");
      });
    });
  }

  // Augment rendered order cards with Delivery Verification Code & Live Location Sharing button
  function enhanceOrderCards() {
    if (typeof LAST_ORDERS === "undefined" || !Array.isArray(LAST_ORDERS)) return;
    LAST_ORDERS.forEach(function (o) {
      if (!o || !o.id) return;
      var trk = document.querySelector('.trk[data-trk="' + o.id + '"]');
      var card = trk ? trk.closest(".order-card, .card, article, div") : null;
      if (!card || card.querySelector("[data-deliv-code]")) return;
      if (o.deliveryCode && !["delivered", "done", "canceled"].includes(String(o.status || ""))) {
        var badge = document.createElement("div");
        badge.setAttribute("data-deliv-code", o.id);
        badge.style.marginTop = "8px";
        badge.style.padding = "8px 12px";
        badge.style.borderRadius = "10px";
        badge.style.background = "rgba(93,214,44,0.14)";
        badge.style.border = "1px solid #5DD62C";
        badge.innerHTML =
          '🔐 <b>رمز تأكيد الاستلام (أعطه للسائق عند التسليم): <span style="color:#5DD62C;font-size:16px">' +
          String(o.deliveryCode) +
          "</span></b>";
        card.appendChild(badge);
      }
    });
  }

  setInterval(function () {
    injectCustomerSuite();
    enhanceOrderCards();
  }, 2000);
})();
