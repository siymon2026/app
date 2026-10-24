(function () {
  var TOKEN_KEY = "siymon_customer_token_v1";
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; }
  }
  function authHeaders() {
    var t = getToken();
    var h = { "Content-Type": "application/json" };
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }
  var form = document.getElementById("supportComplaintForm");
  var statusEl = document.getElementById("scStatus");
  var listEl = document.getElementById("scList");
  var refreshBtn = document.getElementById("scRefreshBtn");

  async function loadComplaints() {
    if (!listEl) return;
    if (!getToken()) {
      listEl.innerHTML = '<p style="font-size:13px">يرجى تسجيل الدخول في الصفحة الرئيسية لعرض شكاويك أو تقديم شكوى مرتبطة بحسابك.</p>';
      return;
    }
    try {
      var res = await fetch("/api/customer/complaints", { headers: authHeaders() });
      var data = await res.json();
      if (!res.ok || !Array.isArray(data.complaints)) {
        listEl.innerHTML = '<p style="font-size:13px">تعذر تحميل الشكاوى حالياً.</p>';
        return;
      }
      if (!data.complaints.length) {
        listEl.innerHTML = '<p style="font-size:13px">لا توجد شكاوى مسجلة حتى الآن.</p>';
        return;
      }
      listEl.innerHTML = "";
      data.complaints.forEach(function (c) {
        var row = document.createElement("div");
        row.className = "complaint-item";
        var info = document.createElement("div");
        var topLine = document.createElement("div");
        var strongEl = document.createElement("strong");
        strongEl.textContent = "#" + (c.id || "");
        topLine.appendChild(strongEl);
        if (c.orderId) {
          topLine.appendChild(document.createTextNode(" · طلب #" + c.orderId + " "));
        }
        var stBadge = document.createElement("span");
        stBadge.className = "badge";
        stBadge.textContent = c.status || "open";
        topLine.appendChild(stBadge);
        if (c.assignedLevel) {
          var lvlBadge = document.createElement("span");
          lvlBadge.className = "badge";
          lvlBadge.style.marginRight = "4px";
          lvlBadge.textContent = "الجهة: " + c.assignedLevel;
          topLine.appendChild(lvlBadge);
        }
        var msgLine = document.createElement("div");
        msgLine.style.cssText = "font-size:13px;color:var(--muted);margin-top:4px";
        msgLine.textContent = c.message || c.subject || "";
        info.appendChild(topLine);
        info.appendChild(msgLine);
        row.appendChild(info);

        if (c.assignedLevel !== "supervisor" && c.status !== "resolved") {
          var escBtn = document.createElement("button");
          escBtn.type = "button";
          escBtn.className = "btn secondary";
          escBtn.style.cssText = "padding:6px 10px;font-size:12px";
          escBtn.textContent = "⬆️ تصعيد للمشرف";
          escBtn.addEventListener("click", async function () {
            escBtn.disabled = true;
            try {
              await fetch("/api/customer/complaints/" + encodeURIComponent(c.id) + "/escalate", {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ reason: "Customer escalated from support portal" })
              });
              loadComplaints();
            } catch (_) {
              escBtn.disabled = false;
            }
          });
          row.appendChild(escBtn);
        }
        listEl.appendChild(row);
      });
    } catch (_) {
      listEl.innerHTML = '<p style="font-size:13px">تعذر الاتصال بالخادم.</p>';
    }
  }

  if (form) {
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (!getToken()) {
        statusEl.style.color = "#ff6b6b";
        statusEl.textContent = "يرجى تسجيل الدخول أولاً من الصفحة الرئيسية لتقديم شكوى.";
        return;
      }
      statusEl.style.color = "#5DD62C";
      statusEl.textContent = "جارٍ الإرسال...";
      try {
        var payload = {
          orderId: document.getElementById("scOrderId").value.trim() || null,
          targetType: document.getElementById("scTarget").value,
          category: document.getElementById("scCategory").value,
          message: document.getElementById("scMessage").value.trim()
        };
        var res = await fetch("/api/customer/complaints", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (!res.ok) {
          statusEl.style.color = "#ff6b6b";
          statusEl.textContent = data.error || "تعذر إرسال الشكوى.";
          return;
        }
        statusEl.style.color = "#5DD62C";
        statusEl.textContent = "تم استلام شكواك بنجاح ✅ رقم المتابعة: " + (data.complaint && data.complaint.id ? data.complaint.id : "");
        document.getElementById("scMessage").value = "";
        loadComplaints();
      } catch (_) {
        statusEl.style.color = "#ff6b6b";
        statusEl.textContent = "تعذر الاتصال بالخادم.";
      }
    });
  }

  if (refreshBtn) refreshBtn.addEventListener("click", loadComplaints);
  loadComplaints();
})();
