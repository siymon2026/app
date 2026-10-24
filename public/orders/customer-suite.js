/* SIYMON Customer Suite:
   - Customer SIYMON Wallet, Top-Up, Ledger History & Loyalty Points Card (Sections 11, 12)
   - Structured Complaint Routing & Supervisor Escalation (Section 16)
   - Phone OTP Verification / Password Recovery & Logout All Devices (Section 3)
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
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function injectOtpRecoveryLink() {
    var authBox = document.getElementById("authBox");
    if (!authBox || document.getElementById("custOtpRecoverCard")) return;
    var box = document.createElement("div");
    box.id = "custOtpRecoverCard";
    box.style.marginTop = "12px";
    box.style.paddingTop = "10px";
    box.style.borderTop = "1px solid rgba(128,128,128,0.2)";
    box.innerHTML =
      '<button class="btn ghost small" id="toggleOtpRecoverBtn" type="button">🔑 استرجاع الحساب / التحقق عبر رمز الهاتف (OTP)</button>' +
      '<div id="otpRecoverForm" hidden style="margin-top:10px;display:grid;gap:8px">' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <input id="otpRecPhone" type="tel" placeholder="رقم الهاتف (06/07...)" style="flex:1;min-width:150px" />' +
      '    <button class="btn small" id="otpReqBtn" type="button">إرسال رمز التحقق</button>' +
      '  </div>' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <input id="otpChallengeId" type="hidden" />' +
      '    <input id="otpCodeInp" type="text" placeholder="رمز التحقق (6 أرقام)" style="max-width:150px" />' +
      '    <input id="otpNewPass" type="password" placeholder="كلمة المرور الجديدة" style="flex:1;min-width:150px" />' +
      '    <button class="btn good small" id="otpVerifyResetBtn" type="button">تأكيد وتغيير كلمة السر</button>' +
      '  </div>' +
      '  <div id="otpRecHint" class="hint"></div>' +
      '</div>';
    authBox.appendChild(box);

    document.getElementById("toggleOtpRecoverBtn").addEventListener("click", function () {
      var f = document.getElementById("otpRecoverForm");
      f.hidden = !f.hidden;
    });

    document.getElementById("otpReqBtn").addEventListener("click", function () {
      var phone = document.getElementById("otpRecPhone").value.trim();
      var hint = document.getElementById("otpRecHint");
      if (!phone) { hint.textContent = "يرجى إدخال رقم الهاتف"; return; }
      custApi("/api/auth/otp/request", {
        method: "POST",
        body: JSON.stringify({ phone: phone, purpose: "recover" }),
      }).then(function (r) {
        if (r.ok && r.body.challengeId) {
          document.getElementById("otpChallengeId").value = r.body.challengeId;
          hint.textContent = "✅ تم إرسال رمز التحقق بنجاح.";
        } else {
          hint.textContent = "⚠️ " + (r.body.error || "تعذر إرسال الرمز");
        }
      });
    });

    document.getElementById("otpVerifyResetBtn").addEventListener("click", function () {
      var phone = document.getElementById("otpRecPhone").value.trim();
      var cid = document.getElementById("otpChallengeId").value.trim();
      var code = document.getElementById("otpCodeInp").value.trim();
      var newPassword = document.getElementById("otpNewPass").value;
      var hint = document.getElementById("otpRecHint");
      if (!cid || !code || !newPassword) {
        hint.textContent = "يرجى إدخال رمز التحقق وكلمة المرور الجديدة";
        return;
      }
      custApi("/api/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: cid, code: code, phone: phone }),
      }).then(function (v) {
        if (!v.ok || !v.body.verificationToken) {
          hint.textContent = "⚠️ " + (v.body.error || "رمز التحقق غير صحيح");
          return;
        }
        return custApi("/api/auth/recover-password", {
          method: "POST",
          body: JSON.stringify({
            verificationToken: v.body.verificationToken,
            newPassword: newPassword,
            userType: "customer",
          }),
        }).then(function (rec) {
          if (rec.ok) {
            hint.textContent = "✅ تم استرجاع الحساب وتغيير كلمة المرور وإلغاء الجلسات القديمة.";
          } else {
            hint.textContent = "⚠️ " + (rec.body.error || "تعذر تغيير كلمة المرور");
          }
        });
      });
    });
  }

  function injectCustomerSuite() {
    injectOtpRecoveryLink();
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
      '  <div><b style="color:#5DD62C">محفظة SIYMON ونقاط الولاء</b> <span id="cwBalance" style="margin-inline-start:8px;font-weight:800">0 MAD</span> | <span id="cwPoints">0 نقطة</span></div>' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <button class="btn small" id="cwTopupBtn" type="button">＋ شحن المحفظة</button>' +
      '    <button class="btn small" id="cwRedeemBtn" type="button">تحويل النقاط للمحفظة</button>' +
      '    <button class="btn small" id="cwLedgerBtn" type="button">سجل المحفظة</button>' +
      '    <button class="btn small" id="cwComplaintToggleBtn" type="button">الشكاوى والدعم</button>' +
      '    <button class="btn ghost small" id="cwLogoutAllBtn" type="button">خروج من كل الأجهزة</button>' +
      '  </div>' +
      '</div>' +
      '<div id="cwLedgerBox" hidden style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1);font-size:12px"></div>' +
      '<div id="cwComplaintBox" hidden style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1)">' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '    <input id="cmpOrderId" placeholder="رقم الطلب (Order ID)" style="max-width:160px" />' +
      '    <select id="cmpTarget" style="max-width:140px"><option value="store">المتجر</option><option value="driver">السائق</option><option value="platform">المنصة</option></select>' +
      '    <input id="cmpDesc" placeholder="تفاصيل الشكوى..." style="flex:1;min-width:180px" />' +
      '    <button class="btn good small" id="cmpSendBtn" type="button">إرسال الشكوى</button>' +
      '  </div>' +
      '  <div id="cmpHint" class="hint" style="margin-top:4px"></div>' +
      '  <div id="cmpListBox" style="margin-top:8px;font-size:12px"></div>' +
      '</div>';

    profileBox.parentNode.insertBefore(card, profileBox.nextSibling);

    function refreshWallet() {
      custApi("/api/customer/wallet").then(function (r) {
        if (!r.ok) return;
        document.getElementById("cwBalance").textContent = Number(r.body.balance || 0).toFixed(2) + " MAD";
        document.getElementById("cwPoints").textContent = ((r.body.loyalty && r.body.loyalty.points) || 0) + " نقطة";
        var lBox = document.getElementById("cwLedgerBox");
        var txs = r.body.transactions || [];
        lBox.innerHTML = txs.length
          ? txs.slice(0, 10).map(function (t) {
              var sign = Number(t.amount || 0) >= 0 ? "+" : "";
              return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)"><span>' + esc(t.type) + " — " + esc(t.reason || "") + '</span><b>' + sign + Number(t.amount || 0).toFixed(2) + " MAD</b></div>";
            }).join("")
          : '<div class="muted">لا توجد حركات مالية بعد.</div>';
      });
    }

    function refreshComplaints() {
      custApi("/api/customer/complaints").then(function (r) {
        if (!r.ok) return;
        var box = document.getElementById("cmpListBox");
        var list = r.body.complaints || [];
        if (!list.length) {
          box.innerHTML = '<div class="muted">لا توجد شكاوى مسجلة.</div>';
          return;
        }
        box.innerHTML = list.map(function (c) {
          var canEsc = c.status !== "escalated_to_supervisor" && c.status !== "resolved";
          return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.08)">' +
            '<span><b>#' + esc(c.id) + '</b> (' + esc(c.targetType) + ') — ' + esc(c.description) + ' <span class="badge">' + esc(c.status) + '</span></span>' +
            (canEsc ? '<button class="btn small" data-esc-id="' + esc(c.id) + '" type="button">تصعيد للمشرف</button>' : '') +
            '</div>';
        }).join("");
        box.querySelectorAll("[data-esc-id]").forEach(function (b) {
          b.addEventListener("click", function () {
            var cid = b.getAttribute("data-esc-id");
            var reason = prompt("سبب التصعيد للمشرف:", "لم يتم حل المشكلة");
            if (!reason) return;
            custApi("/api/customer/complaints/" + encodeURIComponent(cid) + "/escalate", {
              method: "POST",
              body: JSON.stringify({ reason: reason }),
            }).then(function (res) {
              if (res.ok) refreshComplaints();
            });
          });
        });
      });
    }

    refreshWallet();

    document.getElementById("cwTopupBtn").addEventListener("click", function () {
      var amt = prompt("أدخل مبلغ الشحن بالدرهم (MAD):", "50");
      if (!amt || Number(amt) <= 0) return;
      custApi("/api/customer/wallet/topup", {
        method: "POST",
        body: JSON.stringify({ amount: Number(amt), reference: "topup_" + Date.now() }),
      }).then(function (r) {
        if (r.ok) {
          alert("✅ تم إرسال طلب شحن المحفظة للمراجعة والتأكيد.");
          refreshWallet();
        } else {
          alert("⚠️ " + (r.body.error || "تعذر إرسال طلب الشحن"));
        }
      });
    });

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

    document.getElementById("cwLedgerBtn").addEventListener("click", function () {
      var b = document.getElementById("cwLedgerBox");
      b.hidden = !b.hidden;
      if (!b.hidden) refreshWallet();
    });

    document.getElementById("cwComplaintToggleBtn").addEventListener("click", function () {
      var b = document.getElementById("cwComplaintBox");
      b.hidden = !b.hidden;
      if (!b.hidden) refreshComplaints();
    });

    document.getElementById("cwLogoutAllBtn").addEventListener("click", function () {
      if (!confirm("هل تريد تسجيل الخروج من جميع الأجهزة؟")) return;
      custApi("/api/customer/logout-all", { method: "POST" }).then(function () {
        localStorage.removeItem("siymon_customer_token_v1");
        window.location.reload();
      });
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
        if (r.ok) refreshComplaints();
      });
    });
  }

  setInterval(function () {
    injectCustomerSuite();
  }, 1500);
})();
