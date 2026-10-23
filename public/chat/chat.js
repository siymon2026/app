/* siymon — standalone chat page (/chat/).
     /chat/                → conversation with support
     /chat/?order=<id>     → conversation with the driver of that order
   It opens directly on the conversation — it never passes through the orders
   page. Same API as before; the server keeps ONE support conversation per
   customer, so opening this page never creates a new conversation. */
(function () {
  "use strict";

  const SP = window.SP;
  const el = (id) => document.getElementById(id);

  const qs = new URLSearchParams(location.search);
  const ORDER_ID = String(qs.get("order") || "").trim().slice(0, 80);
  const MODE = ORDER_ID ? "driver" : "support";
  const ENDPOINT =
    MODE === "driver"
      ? `/api/customer/orders/${encodeURIComponent(ORDER_ID)}/chat`
      : "/api/customer/support";
  const POLL_MS = MODE === "driver" ? 3500 : 4000;

  const T = {
    ar: {
      back: "الرجوع",
      supportTitle: "الدعم",
      supportSub: "نرد عليك في أقرب وقت",
      driverTitle: () => "دردشة السائق",
      driverSub: (id) => `الطلب #${id}`,
      type: "اكتب رسالة...",
      send: "إرسال",
      emoji: "إيموجي",
      today: "اليوم",
      yesterday: "أمس",
      empty: "لا توجد رسائل بعد",
      hint: "ابدأ المحادثة بإرسال رسالة",
      noDriver: "لم يتم تعيين سائق لهذا الطلب بعد",
      noDriverHint: "ستظهر الدردشة هنا بمجرد تعيين السائق.",
      closedMsg: "انتهت هذه المحادثة بعد إغلاق الطلب.",
      notFound: "هذا الطلب غير متاح",
      notFoundHint: "تأكد من أنه من طلباتك.",
      loadError: "تعذّر تحميل المحادثة",
      retry: "إعادة المحاولة",
    },
    fr: {
      back: "Retour",
      supportTitle: "Support",
      supportSub: "Nous répondons rapidement",
      driverTitle: () => "Chat chauffeur",
      driverSub: (id) => `Commande #${id}`,
      type: "Écrire un message...",
      send: "Envoyer",
      emoji: "Emoji",
      today: "Aujourd’hui",
      yesterday: "Hier",
      empty: "Aucun message pour le moment",
      hint: "Lancez la conversation",
      noDriver: "Aucun chauffeur n’est encore assigné à cette commande",
      noDriverHint: "Le chat apparaîtra ici dès l’assignation.",
      closedMsg: "Cette conversation est fermée (commande terminée).",
      notFound: "Cette commande n’est pas disponible",
      notFoundHint: "Vérifiez qu’elle fait partie de vos commandes.",
      loadError: "Impossible de charger la conversation",
      retry: "Réessayer",
    },
    en: {
      back: "Back",
      supportTitle: "Support",
      supportSub: "We reply as soon as possible",
      driverTitle: () => "Driver Chat",
      driverSub: (id) => `Order #${id}`,
      type: "Type a message...",
      send: "Send",
      emoji: "Emoji",
      today: "Today",
      yesterday: "Yesterday",
      empty: "No messages yet",
      hint: "Say hello to start the chat",
      noDriver: "No driver has been assigned to this order yet",
      noDriverHint: "The chat will appear here once a driver is assigned.",
      closedMsg: "This conversation is closed (order finished).",
      notFound: "This order isn’t available",
      notFoundHint: "Make sure it is one of your orders.",
      loadError: "Couldn’t load the conversation",
      retry: "Try again",
    },
  };
  const t = () => SP.pick(T);

  const CC_EMOJI = ["😀","😂","😊","😍","🙏","👍","👌","🙌","🎉","❤️","🔥","😉","😅","🤝","😢","😮","😎","🤔","👋","✅","⚠️","⏳","🍔","🍕","🛵","📦","📍","⭐","💯","🙂","😇","😴"];

  /* ---------------- rendering (same look as the admin chat) ---------------- */
  const lang = () => SP.lang;
  const ccLocale = () =>
    lang() === "ar" ? "ar-u-nu-latn" : lang() === "fr" ? "fr-FR" : "en-US";
  function ccTime(ts) {
    const d = ts ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(ccLocale(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: lang() === "en",
    });
  }
  const ccDayKey = (d) => d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  function ccDayLabel(d) {
    const now = new Date();
    const y = new Date();
    y.setDate(now.getDate() - 1);
    if (ccDayKey(d) === ccDayKey(now)) return t().today;
    if (ccDayKey(d) === ccDayKey(y)) return t().yesterday;
    return d.toLocaleDateString(ccLocale(), {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  function ccNode(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function ccState(icon, title, hint) {
    const w = ccNode("div", "cc-state");
    w.appendChild(ccNode("div", "cc-state-ico", icon));
    w.appendChild(ccNode("b", "", title));
    if (hint) w.appendChild(ccNode("span", "", hint));
    return w;
  }
  function showLoading() {
    const box = el("chatBox");
    box.dataset.sig = "";
    const sk = ccNode("div", "cc-skel");
    for (let i = 0; i < 4; i++)
      sk.appendChild(ccNode("span", "cc-skel-b" + (i % 2 ? " me" : "")));
    box.replaceChildren(sk);
  }
  function showState(icon, title, hint, withRetry) {
    const box = el("chatBox");
    box.dataset.sig = "";
    const st = ccState(icon, title, hint);
    if (withRetry) {
      const b = ccNode("button", "cc-retry", t().retry);
      b.type = "button";
      b.addEventListener("click", () => {
        showLoading();
        load();
      });
      st.appendChild(b);
    }
    box.replaceChildren(st);
  }
  function renderMessages(messages) {
    const box = el("chatBox");
    const list = Array.isArray(messages) ? messages : [];
    const last = list[list.length - 1];
    const sig =
      list.length +
      "|" +
      (last ? last.id || last.createdAt || last.text : "") +
      "|" +
      lang();
    if (box.dataset.sig === sig) return; /* polling: nothing new, keep scroll */
    const firstPaint = !box.dataset.sig;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.dataset.sig = sig;

    const frag = document.createDocumentFragment();
    if (!list.length) {
      frag.appendChild(
        ccState(MODE === "driver" ? "🛵" : "💬", t().empty, t().hint),
      );
    }
    let day = "";
    for (const m of list) {
      const d = m.createdAt ? new Date(m.createdAt) : null;
      if (d && !isNaN(d.getTime()) && ccDayKey(d) !== day) {
        day = ccDayKey(d);
        frag.appendChild(ccNode("div", "cc-day", ccDayLabel(d)));
      }
      const me = String(m.from || "") === "customer";
      const row = ccNode("div", "chat-msg" + (me ? " me" : ""));
      const bubble = ccNode("div", "chat-bubble");
      bubble.appendChild(ccNode("span", "cc-text", m.text || ""));
      bubble.appendChild(ccNode("time", "cc-time", ccTime(m.createdAt)));
      row.appendChild(bubble);
      frag.appendChild(row);
    }
    box.replaceChildren(frag);
    if (firstPaint || nearBottom) box.scrollTop = box.scrollHeight;
  }

  /* ---------------- text / labels ---------------- */
  function applyText() {
    const s = t();
    const title = MODE === "driver" ? s.driverTitle(ORDER_ID) : s.supportTitle;
    el("chatTitle").textContent = title;
    el("chatSub").textContent = MODE === "driver" ? s.driverSub(ORDER_ID) : s.supportSub;
    el("chatAvatar").textContent = MODE === "driver" ? "🛵" : "🎧";
    document.title = "siymon | " + title;
    el("goHome").setAttribute("aria-label", s.back);
    el("goHome").setAttribute("title", s.back);
    el("chatInput").placeholder = s.type;
    el("chatSendBtn").setAttribute("aria-label", s.send);
    el("chatSendBtn").setAttribute("title", s.send);
    const eb = document.querySelector(".cc-emoji-btn");
    if (eb) eb.setAttribute("aria-label", s.emoji);
  }

  function setComposerEnabled(on) {
    el("chatInput").disabled = !on;
    el("chatSendBtn").disabled = !on;
  }

  /* ---------------- data ---------------- */
  let firstLoadDone = false;
  let loadingNow = false;
  async function load() {
    if (loadingNow) return;
    loadingNow = true;
    try {
      const res = await SP.api(ENDPOINT);
      firstLoadDone = true;
      el("chatHint").textContent = "";
      if (MODE === "driver" && !res.driverId) {
        setComposerEnabled(false);
        showState("🛵", t().noDriver, t().noDriverHint, false);
        return;
      }
      setComposerEnabled(!res.closed);
      renderMessages(res.messages || []);
      if (res.closed) {
        el("chatHint").textContent = t().closedMsg || "";
        stopPoll();
      }
    } catch (e) {
      if (e && e.status === 401) {
        SP.clearSession();
        SP.toLogin();
        return;
      }
      if (e && (e.status === 404 || e.status === 403)) {
        stopPoll();
        setComposerEnabled(false);
        showState("📦", t().notFound, t().notFoundHint, false);
        return;
      }
      if (!firstLoadDone) {
        showState("⚠️", t().loadError, String(e?.message || ""), true);
      }
      /* later (background) failures: keep what is on screen */
    } finally {
      loadingNow = false;
    }
  }

  let sending = false;
  async function send() {
    const input = el("chatInput");
    const btn = el("chatSendBtn");
    const text = String(input.value || "").trim();
    if (!text || sending) return;
    sending = true;
    btn.disabled = true;
    el("chatHint").textContent = "";
    input.value = "";
    const pop = document.querySelector(".cc-emoji");
    if (pop) pop.hidden = true;
    try {
      await SP.api(ENDPOINT, { method: "POST", body: JSON.stringify({ text }) });
      await load();
      el("chatBox").scrollTop = el("chatBox").scrollHeight;
    } catch (e) {
      if (e && e.status === 401) {
        SP.clearSession();
        SP.toLogin();
        return;
      }
      if (String(e?.message) === "chat_closed") { load(); return; }
      input.value = text; /* don't lose what was typed */
      el("chatHint").textContent = "❌ " + String(e?.message || e);
    } finally {
      sending = false;
      if (!input.disabled) btn.disabled = false;
      input.focus();
    }
  }

  /* ---------------- polling (only while the page is visible) ---------------- */
  let pollId = null;
  function startPoll() {
    stopPoll();
    pollId = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
  }
  function stopPoll() {
    if (pollId) clearInterval(pollId);
    pollId = null;
  }

  /* ---------------- emoji + events ---------------- */
  function initEmoji() {
    const pop = document.querySelector(".cc-emoji");
    const btn = document.querySelector(".cc-emoji-btn");
    const input = el("chatInput");
    if (!pop || !btn) return;
    CC_EMOJI.forEach((em) => {
      const b = ccNode("button", "", em);
      b.type = "button";
      b.addEventListener("click", () => {
        const s = input.selectionStart ?? input.value.length;
        const e2 = input.selectionEnd ?? s;
        input.value = input.value.slice(0, s) + em + input.value.slice(e2);
        input.focus();
        input.setSelectionRange(s + em.length, s + em.length);
      });
      pop.appendChild(b);
    });
    btn.addEventListener("click", () => {
      pop.hidden = !pop.hidden;
      btn.setAttribute("aria-expanded", String(!pop.hidden));
    });
    document.addEventListener("click", (e) => {
      if (!pop.hidden && !e.target.closest(".cc-emoji, .cc-emoji-btn"))
        pop.hidden = true;
    });
  }

  /* keep the keyboard / focus on the input while tapping send or emoji, otherwise the
     layout shifts (bottom bar returns) before the tap completes and the tap is lost */
  ["chatSendBtn"].forEach((id) =>
    el(id).addEventListener("pointerdown", (e) => e.preventDefault()),
  );
  document
    .querySelector(".cc-emoji-btn")
    ?.addEventListener("pointerdown", (e) => e.preventDefault());
  document
    .querySelector(".cc-emoji")
    ?.addEventListener("pointerdown", (e) => e.preventDefault());
  el("chatSendBtn").addEventListener("click", () => send());
  el("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  el("chatInput").addEventListener("focus", () => {
    setTimeout(() => {
      el("chatBox").scrollTop = el("chatBox").scrollHeight;
    }, 300);
  });
  el("chatInput").maxLength = 1200; /* server limit */

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) load();
  });
  window.addEventListener("pagehide", stopPoll);
  window.addEventListener("siymon:revive", () => {
    load();
    startPoll();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  /* ---------------- init ---------------- */
  (function init() {
    if (!SP.getToken()) {
      SP.toLogin(); /* signs in, then returns right here (same ?order=) */
      return;
    }
    applyText();
    initEmoji();
    showLoading();
    load();
    startPoll();
  })();
})();
