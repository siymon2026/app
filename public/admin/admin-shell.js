/* global orders, orderTabOf, money */
/* SIYMON admin shell: header breadcrumbs, global search (Ctrl/Cmd+K), notifications dropdown,
   profile dropdown, collapsible sidebar groups and the Orders overview KPIs/chart.
   It only reads what admin.js / admin-nav.js already render and navigates through window.adminNav,
   so all existing auth checks, data loading and handlers stay in charge. Text is set with textContent. */
(function () {
  "use strict";
  var doc = document, html = doc.documentElement, body = doc.body;
  var $ = function (id) { return doc.getElementById(id); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var GROUPS_KEY = "siymon_admin_sb_groups_v1";

  var T = {
    ar: { search: "ابحث عن صفحة أو طلب أو زبون…", pages: "الصفحات", quick: "بحث سريع", none: "لا توجد نتائج", inOrders: "البحث في الطلبات عن", inCustomers: "البحث في الزبائن عن",
      inDrivers: "البحث في السائقين عن", inStores: "البحث في المتاجر عن", notifications: "الإشعارات", noNotif: "لا توجد تنبيهات جديدة", newOrders: "طلبات جديدة بانتظار القبول",
      activity: "نشاط جديد", settings: "الإعدادات", language: "اللغة", theme: "المظهر", bt: "طابعة البلوتوث", admin: "مشرف", home: "siymon", collapse: "طي القائمة", expand: "توسيع القائمة",
      kToday: "طلبات اليوم", kPending: "بانتظار القبول", kProgress: "قيد المعالجة", kRevenue: "إيراد اليوم (المكتملة)", kCanceled: "ملغاة اليوم", chart: "الطلبات خلال آخر 7 أيام",
      chartSub: "عدد الطلبات يومياً من البيانات الحالية", vsYesterday: "أمس", total7: "إجمالي 7 أيام", openNew: "عرض الطلبات الجديدة" },
    fr: { search: "Rechercher une page, commande, client…", pages: "Pages", quick: "Recherche rapide", none: "Aucun résultat", inOrders: "Chercher dans les commandes :", inCustomers: "Chercher dans les clients :",
      inDrivers: "Chercher dans les livreurs :", inStores: "Chercher dans les boutiques :", notifications: "Notifications", noNotif: "Aucune nouvelle alerte", newOrders: "nouvelles commandes à valider",
      activity: "Nouvelle activité", settings: "Paramètres", language: "Langue", theme: "Thème", bt: "Imprimante Bluetooth", admin: "Administrateur", home: "siymon", collapse: "Réduire le menu", expand: "Agrandir le menu",
      kToday: "Commandes du jour", kPending: "En attente", kProgress: "En cours", kRevenue: "Revenu du jour (terminées)", kCanceled: "Annulées aujourd'hui", chart: "Commandes des 7 derniers jours",
      chartSub: "Nombre de commandes par jour (données actuelles)", vsYesterday: "hier", total7: "Total 7 jours", openNew: "Voir les nouvelles commandes" },
    en: { search: "Search pages, orders, customers…", pages: "Pages", quick: "Quick search", none: "No results", inOrders: "Search orders for", inCustomers: "Search customers for",
      inDrivers: "Search drivers for", inStores: "Search stores for", notifications: "Notifications", noNotif: "No new alerts", newOrders: "new orders awaiting approval",
      activity: "New activity", settings: "Settings", language: "Language", theme: "Theme", bt: "Bluetooth printer", admin: "Administrator", home: "siymon", collapse: "Collapse menu", expand: "Expand menu",
      kToday: "Orders today", kPending: "Awaiting approval", kProgress: "In progress", kRevenue: "Revenue today (completed)", kCanceled: "Canceled today", chart: "Orders in the last 7 days",
      chartSub: "Daily order count from current data", vsYesterday: "yesterday", total7: "7-day total", openNew: "View new orders" }
  };
  var L = function () { return T[(html.lang || "ar").slice(0, 2)] || T.en; };
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function svg(paths) {
    var s = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = paths; // static, trusted markup only
    return s;
  }
  var IC = {
    page: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'
  };
  var go = function (key) { if (window.adminNav && typeof window.adminNav.go === "function") window.adminNav.go(key); };
  var isMobile = function () { return window.matchMedia("(max-width: 860px)").matches; };
  var itemLabel = function (it) { var t = it.querySelector(".sb-text"); return (t ? t.textContent : it.textContent || "").trim(); };
  var groupLabel = function (it) { var g = it.closest(".sb-group"); var s = g && g.querySelector(".sb-group-btn span"); return s ? s.textContent.trim() : ""; };

  /* ---------------- popovers ---------------- */
  var open = null;
  function closePop(focusBack) {
    if (!open) return;
    open.pop.hidden = true; open.btn.setAttribute("aria-expanded", "false");
    if (focusBack) open.btn.focus();
    open = null;
  }
  function togglePop(btn, pop, fill) {
    if (open && open.pop === pop) return closePop();
    closePop(); closeSearch();
    if (fill) fill();
    pop.hidden = false; btn.setAttribute("aria-expanded", "true"); open = { btn: btn, pop: pop };
    var f = pop.querySelector("button,a"); if (f) f.focus();
  }
  doc.addEventListener("click", function (e) {
    if (open && !open.pop.contains(e.target) && !open.btn.contains(e.target)) closePop();
    var sw = $("hdSearchWrap"); if (sw && !sw.contains(e.target)) hideSearchPop();
  });
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && open) { e.stopPropagation(); closePop(true); }
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") { e.preventDefault(); var i = $("hdSearch"); if (i) { i.focus(); i.select(); } }
  });

  /* ---------------- sidebar groups ---------------- */
  function groupsPref() { try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) || {}; } catch (e) { return {}; } }
  function setGroup(g, collapsed, persist) {
    g.classList.toggle("is-collapsed", !!collapsed);
    var b = g.querySelector(".sb-group-btn"); if (b) b.setAttribute("aria-expanded", String(!collapsed));
    if (persist) { var p = groupsPref(); p[g.getAttribute("data-group")] = !!collapsed; try { localStorage.setItem(GROUPS_KEY, JSON.stringify(p)); } catch (e) { /* private mode */ } }
  }
  function bindGroups() {
    var p = groupsPref();
    $$(".sb-group").forEach(function (g) {
      setGroup(g, p[g.getAttribute("data-group")] === true, false);
      var b = g.querySelector(".sb-group-btn");
      if (b) b.addEventListener("click", function () { setGroup(g, !g.classList.contains("is-collapsed"), true); });
    });
  }
  function revealActive() {
    var a = doc.querySelector(".sb-item.active"); var g = a && a.closest(".sb-group.is-collapsed");
    if (g) setGroup(g, false, false);
  }

  /* ---------------- breadcrumbs ---------------- */
  function renderCrumbs() {
    var box = $("hdCrumbs"); if (!box) return;
    var active = doc.querySelector(".sb-item.active") || $("sbHome");
    var sub = doc.querySelector(".sb-subitem.active");
    box.textContent = "";
    var root = el("button", "hd-crumb", L().home); root.type = "button";
    root.addEventListener("click", function () { go("home"); });
    box.appendChild(root);
    var parts = [];
    var gl = active ? groupLabel(active) : ""; if (gl) parts.push(gl);
    if (active) parts.push(itemLabel(active));
    if (sub) parts.push(itemLabel(sub));
    parts.forEach(function (p, i) {
      box.appendChild(el("span", "hd-crumb-sep", "/")).setAttribute("aria-hidden", "true");
      var last = i === parts.length - 1;
      var c = el("span", "hd-crumb" + (last ? " current" : i === 0 && gl ? " grp" : ""), p);
      if (last) c.setAttribute("aria-current", "page");
      box.appendChild(c);
    });
    if (active) doc.title = itemLabel(active) + " • siymon Admin";
  }

  /* ---------------- global search ---------------- */
  var sItems = [], sIdx = -1;
  function hideSearchPop() { var p = $("hdSearchPop"); if (p) p.hidden = true; var i = $("hdSearch"); if (i) i.setAttribute("aria-expanded", "false"); }
  function closeSearch() { hideSearchPop(); }
  function whenShown(id, fn) {
    var tries = 0; (function wait() { var m = $(id); if (m && m.classList.contains("show")) return fn(); if (++tries < 40) setTimeout(wait, 100); })();
  }
  function setInput(id, v) { var i = $(id); if (!i) return false; i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); return true; }
  function searchActions(q) {
    var s = L(), out = [];
    out.push([IC.receipt, s.inOrders + " «" + q + "»", function () {
      go("home");
      setTimeout(function () { var all = doc.querySelector('#ordersTabs [data-tab="all"]'); if (all) all.click(); setInput("searchInput", q); var si = $("searchInput"); if (si) si.scrollIntoView({ block: "center" }); }, 80);
    }]);
    out.push([IC.search, s.inCustomers + " «" + q + "»", function () { go("customers"); whenShown("customersModal", function () { setInput("custSearch", q); }); }]);
    out.push([IC.search, s.inDrivers + " «" + q + "»", function () { go("drivers"); whenShown("driversModal", function () { var all = $("driversTabAll"); if (all) all.click(); setInput("drvSearch", q); }); }]);
    out.push([IC.search, s.inStores + " «" + q + "»", function () { go("stores"); whenShown("storesModal", function () { setTimeout(function () { setInput("spSearch", q); }, 150); }); }]);
    return out;
  }
  function renderSearch(q) {
    var pop = $("hdSearchPop"); if (!pop) return;
    q = String(q || "").trim(); var ql = q.toLowerCase();
    pop.textContent = ""; sItems = [];
    var nav = $$(".sb-item[data-key], .sb-subitem[data-key]").filter(function (it) {
      var lab = itemLabel(it); if (!lab) return false;
      return !ql || lab.toLowerCase().indexOf(ql) >= 0 || groupLabel(it.classList.contains("sb-subitem") ? (it.closest(".sb-sub") || it) : it).toLowerCase().indexOf(ql) >= 0;
    }).slice(0, 9);
    function add(iconPaths, title, sub, fn) {
      var b = el("button", "hd-pop-item"); b.type = "button"; b.setAttribute("role", "option");
      var ic = el("span", "hd-pop-ic"); ic.appendChild(iconPaths instanceof Node ? iconPaths : svg(iconPaths)); b.appendChild(ic);
      var tx = el("span", "hd-pop-txt"); tx.appendChild(el("b", null, title)); if (sub) tx.appendChild(el("small", null, sub)); b.appendChild(tx);
      b.addEventListener("click", function () { hideSearchPop(); var i = $("hdSearch"); if (i) { i.value = ""; i.blur(); } fn(); if (isMobile()) body.classList.remove("sb-open"); });
      pop.appendChild(b); sItems.push(b);
    }
    if (nav.length) {
      pop.appendChild(el("div", "hd-pop-label", L().pages));
      nav.forEach(function (it) {
        var ico = it.querySelector("svg.sb-ico:not(.sb-chev)");
        var parent = it.classList.contains("sb-subitem") ? it.closest(".sb-sub") && it.closest(".sb-sub").previousElementSibling : null;
        add(ico ? ico.cloneNode(true) : IC.page, itemLabel(it), parent ? itemLabel(parent) : groupLabel(it), function () {
          if (it.tagName === "A" || it.id === "sbStoreEnter") it.click(); else go(it.getAttribute("data-key"));
        });
      });
    }
    if (q) {
      pop.appendChild(el("div", "hd-pop-label", L().quick));
      searchActions(q).forEach(function (a) { add(a[0], a[1], "", a[2]); });
    }
    if (!sItems.length) { var e = el("div", "hd-pop-empty"); e.appendChild(svg(IC.search)); e.appendChild(el("span", null, L().none)); pop.appendChild(e); }
    pop.hidden = false; $("hdSearch").setAttribute("aria-expanded", "true");
    sIdx = q && sItems.length ? 0 : -1; paintIdx();
  }
  function paintIdx() { sItems.forEach(function (b, i) { b.classList.toggle("is-focused", i === sIdx); }); }
  function bindSearch() {
    var i = $("hdSearch"); if (!i) return;
    i.addEventListener("focus", function () { closePop(); renderSearch(i.value); });
    i.addEventListener("input", function () { renderSearch(i.value); });
    i.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" && sItems.length) { e.preventDefault(); sIdx = (sIdx + 1) % sItems.length; paintIdx(); sItems[sIdx].scrollIntoView({ block: "nearest" }); }
      else if (e.key === "ArrowUp" && sItems.length) { e.preventDefault(); sIdx = (sIdx - 1 + sItems.length) % sItems.length; paintIdx(); sItems[sIdx].scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Enter") { e.preventDefault(); var b = sItems[sIdx >= 0 ? sIdx : 0]; if (b) b.click(); }
      else if (e.key === "Escape") { e.stopPropagation(); i.value = ""; hideSearchPop(); i.blur(); }
    });
  }

  /* ---------------- notifications (aggregated from live sidebar counters) ---------------- */
  var COUNT_RE = /\(\s*(\d+)\s*\)\s*$/;
  function notifEntries() {
    var out = [];
    var nc = parseInt(($("newCount") && $("newCount").textContent) || "0", 10) || 0;
    if (nc > 0) out.push({ n: nc, title: nc + " " + L().newOrders, icon: IC.receipt, run: function () { go("home"); setTimeout(function () { var b = doc.querySelector('#ordersTabs [data-tab="new"]'); if (b) b.click(); }, 80); } });
    $$(".sb-item[data-key]").forEach(function (it) {
      var key = it.getAttribute("data-key"); if (key === "home") return;
      var badge = it.querySelector(".sb-badge"), n = badge && !badge.hidden ? parseInt(badge.textContent, 10) || 0 : 0;
      if (!n && it.hasAttribute("data-text")) { var src = $(it.getAttribute("data-text")); var m = src && (src.textContent || "").match(COUNT_RE); if (m) n = parseInt(m[1], 10) || 0; }
      var dot = it.classList.contains("notify");
      if (!n && !dot) return;
      var ico = it.querySelector("svg.sb-ico:not(.sb-chev)");
      out.push({ n: n, title: n ? itemLabel(it) + " (" + n + ")" : itemLabel(it), sub: n ? "" : L().activity, icon: ico ? ico.cloneNode(true) : IC.page, run: function () { go(key); } });
    });
    return out;
  }
  function renderNotif() {
    var pop = $("hdNotifPop"); if (!pop) return;
    pop.textContent = "";
    var head = el("div", "hd-pop-head"); head.appendChild(el("b", null, L().notifications)); pop.appendChild(head);
    var list = notifEntries();
    if (!list.length) { var e = el("div", "hd-pop-empty ok"); e.appendChild(svg(IC.check)); e.appendChild(el("span", null, L().noNotif)); pop.appendChild(e); return; }
    list.forEach(function (x) {
      var b = el("button", "hd-pop-item"); b.type = "button"; b.setAttribute("role", "menuitem");
      var ic = el("span", "hd-pop-ic"); ic.appendChild(x.icon instanceof Node ? x.icon : svg(x.icon)); b.appendChild(ic);
      var tx = el("span", "hd-pop-txt"); tx.appendChild(el("b", null, x.title)); if (x.sub) tx.appendChild(el("small", null, x.sub)); b.appendChild(tx);
      var ch = svg(IC.chev); ch.setAttribute("class", "hd-pop-chev"); b.appendChild(ch);
      b.addEventListener("click", function () { closePop(); x.run(); });
      pop.appendChild(b);
    });
  }
  var nTimer = null;
  function updateNotifCount() {
    clearTimeout(nTimer);
    nTimer = setTimeout(function () {
      var list = notifEntries(), total = list.reduce(function (a, x) { return a + (x.n || 1); }, 0);
      var c = $("hdNotifCount"); if (c) { c.hidden = !total; c.textContent = total > 99 ? "99+" : String(total); }
      var b = $("hdNotifBtn"); if (b) b.setAttribute("aria-label", L().notifications + (total ? " (" + total + ")" : ""));
      if (open && open.pop.id === "hdNotifPop") renderNotif();
    }, 120);
  }

  /* ---------------- profile ---------------- */
  function syncProfile() {
    var name = ($("sbUserName") && $("sbUserName").textContent.trim()) || "—";
    var mail = ($("sbUserMail") && $("sbUserMail").textContent.trim()) || "";
    var av = ($("sbAvatar") && $("sbAvatar").textContent.trim()) || "A";
    [["hdUserName", name], ["hdUserName2", name], ["hdUserMail", mail], ["hdAvatar", av], ["hdAvatar2", av], ["hdUserRole", L().admin]].forEach(function (p) { var n = $(p[0]); if (n && n.textContent !== p[1]) n.textContent = p[1]; });
    var pb = $("hdProfileBtn"); if (pb) pb.setAttribute("aria-label", name + (mail ? " — " + mail : ""));
  }
  function applyLabels() {
    var s = L();
    var i = $("hdSearch"); if (i) { i.placeholder = s.search; i.setAttribute("aria-label", s.search); }
    $$("[data-hd-t]").forEach(function (n) { var k = n.getAttribute("data-hd-t"); if (s[k]) n.textContent = s[k]; });
    var c = $("hdCollapse"); if (c) c.setAttribute("aria-label", body.classList.contains("sb-collapsed") ? s.expand : s.collapse);
    syncProfile(); renderCrumbs(); updateNotifCount(); paintKpis();
  }

  /* ---------------- Orders overview: KPI cards + 7-day chart (computed from the loaded orders) ---------------- */
  function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function fmtMoney(v) { try { return typeof money === "function" ? money(v) : Number(v || 0).toFixed(2) + " MAD"; } catch (e) { return String(v); } }
  function tabOf(o) { try { return typeof orderTabOf === "function" ? orderTabOf(o) : "processing"; } catch (e) { return "processing"; } }
  function kpiCard(icon, label, value, foot, tone, onClick) {
    var c = el(onClick ? "button" : "div", "adm-kpi" + (tone ? " " + tone : ""));
    if (onClick) { c.type = "button"; c.addEventListener("click", onClick); }
    var b = el("div", "adm-kpi-body"); b.appendChild(el("span", "adm-kpi-label", label)); b.appendChild(el("b", "adm-kpi-value", value));
    if (foot) b.appendChild(el("span", "adm-kpi-foot", foot));
    var ic = el("span", "adm-kpi-ic"); ic.appendChild(svg(icon));
    c.appendChild(b); c.appendChild(ic);
    return c;
  }
  function paintKpis() {
    var box = $("adminKpis"); if (!box) return;
    var list = []; try { list = Array.isArray(orders) ? orders : []; } catch (e) { list = []; }
    var s = L(), now = new Date(), today = dayKey(now), y = new Date(now); y.setDate(now.getDate() - 1);
    var yKey = dayKey(y);
    var todays = [], yest = 0, pending = 0, progress = 0, revenue = 0, canceled = 0;
    var days = []; for (var i = 6; i >= 0; i--) { var d = new Date(now); d.setDate(now.getDate() - i); days.push({ k: dayKey(d), d: d, n: 0 }); }
    var idx = {}; days.forEach(function (x, j) { idx[x.k] = j; });
    list.forEach(function (o) {
      var t = new Date(o && o.createdAt); if (isNaN(t)) return;
      var k = dayKey(t), tab = tabOf(o);
      if (k === today) { todays.push(o); if (tab === "done") revenue += Number(o.total) || 0; if (tab === "canceled") canceled++; }
      if (k === yKey) yest++;
      if (tab === "new") pending++;
      if (tab === "processing") progress++;
      if (idx[k] != null) days[idx[k]].n++;
    });
    box.textContent = "";
    var cards = el("div", "adm-kpi-grid");
    cards.appendChild(kpiCard(IC.receipt, s.kToday, String(todays.length), s.vsYesterday + ": " + yest));
    cards.appendChild(kpiCard(IC.clock, s.kPending, String(pending), pending ? s.openNew : "", pending ? "hot" : "", pending ? function () { var b = doc.querySelector('#ordersTabs [data-tab="new"]'); if (b) b.click(); } : null));
    cards.appendChild(kpiCard(IC.loader, s.kProgress, String(progress), "", "", function () { var b = doc.querySelector('#ordersTabs [data-tab="processing"]'); if (b) b.click(); }));
    cards.appendChild(kpiCard(IC.cash, s.kRevenue, fmtMoney(revenue), canceled ? s.kCanceled + ": " + canceled : "", "money"));
    box.appendChild(cards);
    var chart = el("section", "adm-chart");
    var head = el("div", "adm-chart-head"), ht = el("div");
    ht.appendChild(el("h3", null, s.chart)); ht.appendChild(el("p", null, s.chartSub)); head.appendChild(ht);
    var tot = days.reduce(function (a, x) { return a + x.n; }, 0);
    var tt = el("div", "adm-chart-total"); tt.appendChild(el("small", null, s.total7)); tt.appendChild(el("b", null, String(tot))); head.appendChild(tt);
    chart.appendChild(head);
    var max = Math.max(1, Math.max.apply(null, days.map(function (x) { return x.n; })));
    var bars = el("div", "adm-bars"); bars.setAttribute("role", "list");
    var loc = (html.lang || "ar").slice(0, 2) === "ar" ? "ar-MA" : (html.lang || "en");
    days.forEach(function (x, j) {
      var col = el("div", "adm-bar" + (j === days.length - 1 ? " today" : "")); col.setAttribute("role", "listitem");
      var lab = x.d.toLocaleDateString(loc, { weekday: "short" });
      col.setAttribute("aria-label", lab + ": " + x.n);
      col.appendChild(el("span", "adm-bar-v", String(x.n)));
      var tr = el("span", "adm-bar-track"), fill = el("i", "adm-bar-fill");
      fill.style.height = (x.n ? Math.max(6, Math.round(x.n / max * 100)) : 0) + "%";
      tr.appendChild(fill); col.appendChild(tr); col.appendChild(el("span", "adm-bar-l", lab));
      bars.appendChild(col);
    });
    chart.appendChild(bars);
    box.appendChild(chart);
  }
  function hookRender() {
    if (typeof window.render !== "function" || window.render.__shell) return;
    var orig = window.render;
    var wrapped = function () { var r = orig.apply(this, arguments); try { paintKpis(); updateNotifCount(); } catch (e) { /* never break the orders table */ } return r; };
    wrapped.__shell = true; window.render = wrapped;
  }

  /* ---------------- header buttons ---------------- */
  function bindHeader() {
    var c = $("hdCollapse");
    if (c) c.addEventListener("click", function () { var t = $("sbToggle"); if (t) t.click(); applyLabels(); });
    var nb = $("hdNotifBtn"), np = $("hdNotifPop");
    if (nb && np) nb.addEventListener("click", function () { togglePop(nb, np, renderNotif); });
    var pb = $("hdProfileBtn"), pp = $("hdProfilePop");
    if (pb && pp) pb.addEventListener("click", function () { togglePop(pb, pp, syncProfile); });
    $$("[data-hd-go]").forEach(function (b) { b.addEventListener("click", function () { closePop(); go(b.getAttribute("data-hd-go")); }); });
    $$("[data-hd-click]").forEach(function (b) { b.addEventListener("click", function () { var t = $(b.getAttribute("data-hd-click")); if (t) t.click(); if (b.getAttribute("data-hd-click") !== "themeToggle") closePop(); }); });
    var lo = $("logoutBtn"); if (lo) lo.addEventListener("click", function () { closePop(); });
    var br = $("hdBrand"); if (br) br.addEventListener("click", function (e) { e.preventDefault(); go("home"); });
  }

  /* ---------------- init ---------------- */
  bindGroups(); bindHeader(); bindSearch(); hookRender();
  var mo = new MutationObserver(function () { renderCrumbs(); revealActive(); updateNotifCount(); syncProfile(); });
  var side = $("sideNav");
  if (side) mo.observe(side, { subtree: true, attributes: true, attributeFilter: ["class", "hidden"], childList: true, characterData: true });
  var nc = $("newCount"); if (nc) mo.observe(nc, { childList: true, characterData: true, subtree: true });
  new MutationObserver(applyLabels).observe(html, { attributes: true, attributeFilter: ["lang"] });
  new MutationObserver(function () { var c = $("hdCollapse"); if (c) { var v = body.classList.contains("sb-collapsed"); c.setAttribute("aria-pressed", String(v)); c.setAttribute("aria-label", v ? L().expand : L().collapse); } })
    .observe(body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("hashchange", function () { setTimeout(renderCrumbs, 0); });
  applyLabels(); revealActive();
  setInterval(paintKpis, 60000); // keeps "today" correct across midnight even without new data
})();
