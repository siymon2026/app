/* global api, lang, toast, adminRestaurants, openRestEdit, refreshMenuData */
/* Stores management page (admin). Everything shown comes from GET /api/admin/stores/directory:
 * filtering, KPIs and pagination are computed on the server from real stores/orders; this file only renders.
 * Add -> POST /api/admin/restaurants, Edit -> the existing store editor (openRestEdit),
 * View -> GET /api/admin/stores/:id/overview. All text is inserted with textContent (no HTML injection). */
(function () {
  "use strict";
  var doc = document;
  var $ = function (id) { return doc.getElementById(id); };
  var curLang = function () { return (doc.documentElement.lang || (typeof lang !== "undefined" ? lang : "ar") || "ar").slice(0, 2); };
  var L = function (ar, en, fr) { var l = curLang(); return l === "ar" ? ar : l === "fr" ? (fr || en) : en; };
  var PREF_KEY = "siymon_admin_stores_prefs_v1";
  var ICONS = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L8 14.2 3 9.3l6.9-1z"/>',
    store: '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M9 22v-6h6v6M2 7h20"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>'
  };
  function icon(name, cls) {
    var s = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "sp-ico" + (cls ? " " + cls : ""));
    s.innerHTML = ICONS[name]; // static, trusted markup only
    return s;
  }
  function h(tag, props) {
    var e = doc.createElement(tag), k, kids = Array.prototype.slice.call(arguments, 2);
    for (k in (props || {})) {
      var v = props[k]; if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    kids.forEach(function (kid) { (Array.isArray(kid) ? kid : [kid]).forEach(function (c) { if (c == null || c === false) return; e.appendChild(c instanceof Node ? c : doc.createTextNode(String(c))); }); });
    return e;
  }
  var nm = function (o, fb) { return o && typeof o === "object" ? o[curLang()] || o.ar || o.en || o.fr || fb || "" : String(o || fb || ""); };
  var money = function (n) { return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }) + " MAD"; };
  var num = function (n) { return Number(n || 0).toLocaleString("en-US"); };
  function say(m) { try { toast(m); } catch (e) { /* toast is optional */ } }

  /* ---------- state ---------- */
  var prefs = (function () { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } })();
  var S = { q: "", channel: "", status: "", perf: "", type: "", page: 1, pageSize: [6, 12, 24, "all"].indexOf(prefs.pageSize) >= 0 ? prefs.pageSize : 6, view: prefs.view === "list" ? "list" : "grid", data: null, loading: false, error: "", filterOpen: false };
  var TYPES = [];
  var seq = 0, searchTimer = null, root = null, refs = {};
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ view: S.view, pageSize: S.pageSize })); } catch (e) { /* private mode */ } }

  /* ---------- data ---------- */
  function query() {
    var p = new URLSearchParams();
    ["q", "channel", "status", "perf", "type"].forEach(function (k) { if (S[k]) p.set(k, S[k]); });
    p.set("page", S.page); p.set("pageSize", S.pageSize);
    return p.toString();
  }
  function load() {
    var mine = ++seq;
    S.loading = true; S.error = ""; render();
    return api("/api/admin/stores/directory?" + query(), { method: "GET" }).then(function (r) {
      if (mine !== seq) return;
      S.data = r; S.loading = false;
      if (r.page !== S.page) S.page = r.page;     // server clamps an out-of-range page (e.g. after a delete)
      render();
    }).catch(function (e) {
      if (mine !== seq) return;
      S.loading = false; S.error = (e && e.message) || "Error"; render();
    });
  }
  function loadTypes() {
    return api("/api/admin/store-types", { method: "GET" }).then(function (r) {
      TYPES = (r.types || []).filter(function (t) { return t.enabled !== false; });
      render();
    }).catch(function () { /* the type filter is simply hidden if this fails */ });
  }
  var typeLabel = function (id) { var t = TYPES.filter(function (x) { return x.id === id; })[0]; return t ? nm(t.name, id) : id; };

  /* ---------- small components ---------- */
  function badge(kind, text) { return h("span", { class: "sp-badge " + kind }, h("i", { "aria-hidden": "true" }), text); }
  function avatar(s, size) {
    var box = h("span", { class: "sp-avatar" + (size ? " " + size : ""), "aria-hidden": "true" });
    if (s.logo) {
      var img = h("img", { alt: "", loading: "lazy", width: 40, height: 40 });
      img.src = s.logo;
      img.addEventListener("error", function () { img.remove(); box.textContent = initial(s); });
      box.appendChild(img);
    } else box.textContent = initial(s);
    var hue = 0, i, id = String(s.id); for (i = 0; i < id.length; i++) hue = (hue * 31 + id.charCodeAt(i)) % 360;
    box.style.setProperty("--hue", hue);
    return box;
  }
  function initial(s) { var t = nm(s.name, s.label).trim(); return (t.charAt(0) || "?").toUpperCase(); }
  var PERF_TXT = function (p) { return p === "good" ? L("جيد", "Good", "Bon") : p === "average" ? L("متوسط", "Average", "Moyen") : p === "attention" ? L("يحتاج اهتماماً", "Needs Attention", "À surveiller") : L("بدون تقييمات", "No reviews yet", "Pas d'avis"); };
  function field(label, value, cls) { return h("div", { class: "sp-field" }, h("span", { class: "sp-fl" }, label), h("span", { class: "sp-fv " + (cls || ""), dir: cls === "ltr" ? "ltr" : null }, value)); }
  function addressOf(s) {
    if (s.channel === "online" && s.website) return s.website;
    var parts = [s.address, s.area, s.city].filter(Boolean);
    return parts.length ? parts.join(", ") : s.website || "—";
  }

  function kpi(value, label, strong) { return h("div", { class: "sp-kpi" + (strong ? " strong" : "") }, h("b", {}, value), h("span", {}, label)); }
  function summary() {
    var m = S.data && S.data.summary, none = "—";
    var big = h("div", { class: "sp-kpis" }, [
      kpi(m ? num(m.totalStores) : none, L("إجمالي المتاجر", "Total Stores", "Total boutiques"), true),
      kpi(m ? num(m.onlineStores) : none, L("متاجر إلكترونية", "Online Stores", "En ligne"), true),
      kpi(m ? num(m.offlineStores) : none, L("متاجر فعلية", "Offline Stores", "Physiques"), true),
      kpi(m ? num(m.openStores) : none, L("متاجر مفتوحة", "Open Stores", "Ouvertes"), true),
      kpi(m ? num(m.closedStores) : none, L("متاجر مغلقة", "Closed Stores", "Fermées"), true)
    ]);
    var g = m && m.salesGrowthPct;
    var small = h("div", { class: "sp-kpis2" }, [
      kpi(m ? money(m.totalSales) : none, L("إجمالي المبيعات", "Total Sales", "Ventes totales")),
      kpi(m ? num(m.totalOrders) : none, L("إجمالي الطلبات", "Total Orders", "Commandes")),
      kpi(m && g != null ? (g > 0 ? "+" : "") + g + "%" : none, L("نمو المبيعات (30 يوماً)", "Sales Growth (30d)", "Croissance (30 j)")),
      kpi(m && m.avgRating != null ? m.avgRating + " / 5" : none, L("متوسط التقييم", "Avg. Rating", "Note moyenne")),
      kpi(m && m.topStore ? nm(m.topStore.name, m.topStore.label) : none, L("أفضل متجر", "Top Store", "Meilleure boutique"))
    ]);
    return h("section", { class: "sp-panel sp-summary", "aria-label": L("ملخص المتاجر", "Store summary", "Résumé") }, big, small);
  }

  function storeCard(s) {
    var rating = s.rating != null
      ? h("span", { class: "sp-rating" }, icon("star"), h("b", {}, String(s.rating)), " (" + num(s.reviews) + " " + L("تقييم", "reviews", "avis") + ")")
      : h("span", { class: "sp-rating muted" }, L("لا توجد تقييمات بعد", "No reviews yet", "Pas encore d'avis"));
    var perfCls = s.performance === "good" ? "ok" : s.performance === "average" ? "mid" : s.performance === "attention" ? "warn" : "muted";
    var title = nm(s.name, s.label);
    return h("article", { class: "sp-scard", "aria-label": title },
      h("header", { class: "sp-shead" }, avatar(s),
        h("div", { class: "sp-sname" }, h("h3", { title: title }, title), rating),
        s.isOpen ? badge("open", L("مفتوح", "Open", "Ouvert")) : badge("closed", L("مغلق", "Closed", "Fermé"))),
      h("div", { class: "sp-sbody" },
        field(L("النوع", "Type", "Type"), s.channel === "online" ? L("متجر إلكتروني", "Online Store", "En ligne") : L("متجر فعلي", "Offline Store", "Physique")),
        field(L("الأداء", "Performance", "Performance"), PERF_TXT(s.performance), perfCls),
        field(L("العنوان", "Address", "Adresse"), addressOf(s), "addr"),
        field(L("الهاتف", "Phone", "Téléphone"), s.phone || "—", "ltr")),
      h("footer", { class: "sp-sfoot" },
        h("button", { class: "sp-btn sp-location", type: "button", onclick: function () { showStoreLocation(s); } }, L("عرض الموقع", "Show Location", "Afficher le lieu")),
        h("button", { class: "sp-btn", type: "button", onclick: function () { viewStore(s); } }, L("عرض المتجر", "View Store", "Voir")),
        h("button", { class: "sp-btn green", type: "button", onclick: function (e) { editStore(s, e.currentTarget); } }, L("تعديل معلومات المتجر", "Edit Store Info", "Modifier"))));
  }

  function pageList(cur, total) {
    var out = [], i, set = {};
    [1, 2, cur - 1, cur, cur + 1, total - 1, total].forEach(function (n) { if (n >= 1 && n <= total) set[n] = 1; });
    var nums = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    for (i = 0; i < nums.length; i++) { if (i && nums[i] - nums[i - 1] > 1) out.push("…"); out.push(nums[i]); }
    return out;
  }
  function pagination() {
    var d = S.data, total = d.total, size = d.pageSize === "all" ? total : d.pageSize;
    var from = total ? (d.page - 1) * size + 1 : 0, to = Math.min(total, d.page * size);
    var nav = h("nav", { class: "sp-pages", "aria-label": L("الصفحات", "Pagination", "Pagination") });
    var go = function (p) { S.page = p; load(); };
    nav.appendChild(h("button", { class: "sp-pg", type: "button", disabled: d.page <= 1, onclick: function () { go(d.page - 1); } }, icon("chevL", "flip"), L("السابق", "Previous", "Précédent")));
    pageList(d.page, d.totalPages).forEach(function (p) {
      if (p === "…") nav.appendChild(h("span", { class: "sp-dots", "aria-hidden": "true" }, "…"));
      else nav.appendChild(h("button", { class: "sp-pg num" + (p === d.page ? " on" : ""), type: "button", "aria-current": p === d.page ? "page" : null, "aria-label": L("صفحة ", "Page ", "Page ") + p, onclick: function () { go(p); } }, String(p)));
    });
    nav.appendChild(h("button", { class: "sp-pg", type: "button", disabled: d.page >= d.totalPages, onclick: function () { go(d.page + 1); } }, L("التالي", "Next", "Suivant"), icon("chevR", "flip")));
    var sel = h("select", { class: "sp-select", "aria-label": L("عدد العناصر", "Page size", "Taille de page"), onchange: function () { S.pageSize = this.value === "all" ? "all" : Number(this.value); S.page = 1; savePrefs(); load(); } },
      [6, 12, 24, "all"].map(function (n) { return h("option", { value: n, selected: n === S.pageSize }, n === "all" ? L("عرض الكل", "Show All", "Tout afficher") : n + " / " + L("صفحة", "page", "page")); }));
    return h("div", { class: "sp-foot" }, nav,
      h("div", { class: "sp-count", "aria-live": "polite" }, total ? L("عرض " + from + " إلى " + to + " من " + total, "Showing " + from + " to " + to + " of " + total + " entries", from + " à " + to + " sur " + total) : ""), sel);
  }

  /* ---------- toolbar + filters ---------- */
  var activeFilters = function () { return ["channel", "status", "perf", "type"].filter(function (k) { return S[k]; }).length; };
  function selectField(key, label, options) {
    var id = "spf-" + key;
    return h("div", { class: "sp-ff" }, h("label", { for: id }, label),
      h("select", { id: id, class: "sp-select", onchange: function () { S[key] = this.value; S.page = 1; if (key === "channel") syncRoute(); load(); } },
        options.map(function (o) { return h("option", { value: o[0], selected: S[key] === o[0] }, o[1]); })));
  }
  function filterPanel() {
    var opts = [
      selectField("channel", L("نوع المتجر", "Store type", "Type de boutique"), [["", L("الكل", "All", "Tous")], ["online", L("إلكتروني", "Online", "En ligne")], ["offline", L("فعلي", "Offline", "Physique")]]),
      selectField("status", L("الحالة", "Status", "Statut"), [["", L("الكل", "All", "Tous")], ["open", L("مفتوح", "Open", "Ouvert")], ["closed", L("مغلق", "Closed", "Fermé")]]),
      selectField("perf", L("الأداء", "Performance", "Performance"), [["", L("الكل", "All", "Tous")], ["good", PERF_TXT("good")], ["average", PERF_TXT("average")], ["attention", PERF_TXT("attention")], ["none", PERF_TXT(null)]])
    ];
    if (TYPES.length) opts.push(selectField("type", L("نشاط المتجر", "Business type", "Activité"), [["", L("الكل", "All", "Tous")]].concat(TYPES.map(function (t) { return [t.id, nm(t.name, t.id)]; }))));
    opts.push(h("button", { class: "sp-btn small", type: "button", disabled: !activeFilters(), onclick: function () { S.channel = S.status = S.perf = S.type = ""; S.page = 1; syncRoute(); load(); } }, L("مسح التصفية", "Clear filters", "Effacer")));
    return h("div", { class: "sp-filters", id: "spFilters", role: "group", "aria-label": L("تصفية المتاجر", "Filter stores", "Filtrer") }, opts);
  }
  function toolbar() {
    var q = h("input", { id: "spSearch", type: "search", autocomplete: "off", placeholder: L("ابحث عن متجر…", "Search Store…", "Rechercher…"), "aria-label": L("بحث عن متجر", "Search stores", "Rechercher") });
    q.value = S.q;
    q.addEventListener("input", function () { clearTimeout(searchTimer); var v = q.value.trim(); searchTimer = setTimeout(function () { if (v !== S.q) { S.q = v; S.page = 1; load(); } }, 250); });
    var n = activeFilters();
    var fbtn = h("button", { class: "sp-btn tool" + (S.filterOpen || n ? " on" : ""), type: "button", "aria-expanded": String(S.filterOpen), "aria-controls": "spFilters", onclick: function () { S.filterOpen = !S.filterOpen; render(); } }, icon("filter"), L("تصفية", "Filter", "Filtrer"), n ? h("em", { class: "sp-n" }, String(n)) : null);
    var seg = h("div", { class: "sp-seg", role: "group", "aria-label": L("طريقة العرض", "Layout", "Affichage") },
      h("button", { type: "button", class: S.view === "grid" ? "on" : "", "aria-pressed": String(S.view === "grid"), "aria-label": L("شبكة", "Grid view", "Grille"), onclick: function () { S.view = "grid"; savePrefs(); render(); } }, icon("grid")),
      h("button", { type: "button", class: S.view === "list" ? "on" : "", "aria-pressed": String(S.view === "list"), "aria-label": L("قائمة", "List view", "Liste"), onclick: function () { S.view = "list"; savePrefs(); render(); } }, icon("list")));
    var add = h("button", { class: "sp-btn primary", type: "button", onclick: function (e) { addStore(e.currentTarget); } }, icon("plus"), L("إضافة متجر", "Add Store", "Ajouter"));
    return h("div", { class: "sp-tool" }, h("label", { class: "sp-search" }, icon("search"), q), h("div", { class: "sp-tool-r" }, fbtn, seg, add));
  }

  /* ---------- render ---------- */
  function listArea() {
    if (S.error) return h("div", { class: "sp-state", role: "alert" }, h("p", {}, L("تعذّر تحميل المتاجر: ", "Couldn't load stores: ", "Chargement impossible : ") + S.error), h("button", { class: "sp-btn", type: "button", onclick: load }, L("إعادة المحاولة", "Try again", "Réessayer")));
    if (!S.data) return h("div", { class: "sp-state", "aria-busy": "true" }, h("p", {}, L("جارٍ التحميل…", "Loading stores…", "Chargement…")));
    var d = S.data;
    if (!d.total) {
      var filtered = S.q || activeFilters();
      return h("div", { class: "sp-state" }, icon("store", "big"),
        h("p", {}, filtered ? L("لا توجد متاجر تطابق البحث أو التصفية.", "No stores match your search or filters.", "Aucune boutique ne correspond.") : L("لا توجد متاجر بعد. أضف أول متجر للبدء.", "No stores yet. Add your first store to get started.", "Aucune boutique. Ajoutez la première.")),
        filtered ? h("button", { class: "sp-btn", type: "button", onclick: function () { S.q = S.channel = S.status = S.perf = S.type = ""; S.page = 1; syncRoute(); load(); } }, L("مسح الكل", "Clear search and filters", "Tout effacer")) : h("button", { class: "sp-btn primary", type: "button", onclick: function (e) { addStore(e.currentTarget); } }, icon("plus"), L("إضافة متجر", "Add Store", "Ajouter")));
    }
    return h("div", { class: "sp-grid " + S.view + (S.loading ? " busy" : ""), role: "list" }, d.stores.map(function (s) { var c = storeCard(s); c.setAttribute("role", "listitem"); return c; }));
  }
  function render() {
    if (!root) return;
    var hadFocus = doc.activeElement && doc.activeElement.id === "spSearch";
    var pos = hadFocus ? doc.activeElement.selectionStart : 0;
    var nodes = [
      h("div", { class: "sp-head" }, h("nav", { class: "sp-crumb", "aria-label": "Breadcrumb" }, h("span", {}, L("القائمة الرئيسية", "Main Menu", "Menu principal")), h("i", { "aria-hidden": "true" }, "/"), h("b", { "aria-current": "page" }, L("المتاجر", "Stores", "Boutiques")))),
      summary(),
      h("section", { class: "sp-panel sp-list" }, toolbar(), S.filterOpen ? filterPanel() : null, listArea(), S.data && S.data.total ? pagination() : null)
    ];
    root.replaceChildren.apply(root, nodes);
    if (hadFocus) { var q = $("spSearch"); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } } }
    labels();
  }

  /* ---------- dialogs ---------- */
  function dialog(title, body, opener, wide) {
    var prev = opener || doc.activeElement;
    var ov = h("div", { class: "sp-ov", onmousedown: function (e) { if (e.target === ov) close(); } });
    var box = h("div", { class: "sp-dlg" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "sp-dhead" }, h("h3", {}, title), h("button", { class: "sp-x", type: "button", "aria-label": L("إغلاق", "Close", "Fermer"), onclick: function () { close(); } }, icon("x"))), body);
    ov.appendChild(box);
    function close() { doc.removeEventListener("keydown", key, true); ov.remove(); if (prev && prev.focus) try { prev.focus(); } catch (e) { /* detached */ } }
    function key(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      var f = box.querySelectorAll('button:not([disabled]),input,select,textarea,a[href]'); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    doc.addEventListener("keydown", key, true);
    doc.body.appendChild(ov);
    var f0 = box.querySelector("input,select,textarea,button.sp-btn"); if (f0) f0.focus();
    return { close: close, box: box };
  }

  function showStoreLocation(s) {
    if (window.SiyDispatch && typeof window.SiyDispatch.showStoreLocation === "function") {
      window.SiyDispatch.showStoreLocation(s);
      return;
    }
    say(L("تعذّر فتح خريطة التوزيع", "Couldn't open the dispatch map", "Impossible d'ouvrir la carte"));
  }

  function viewStore(s) {
    var body = h("div", { class: "sp-dbody" }, h("p", { class: "sp-muted" }, "…"));
    var dlg = dialog(nm(s.name, s.label), body, null, true);
    api("/api/admin/stores/" + encodeURIComponent(s.id) + "/overview", { method: "GET" }).then(function (r) {
      var st = r.stats || {}, store = r.store || {};
      var info = h("div", { class: "sp-dgrid" },
        field(L("الحالة", "Status", "Statut"), s.isOpen ? L("مفتوح", "Open", "Ouvert") : L("مغلق", "Closed", "Fermé"), s.isOpen ? "ok" : "bad"),
        field(L("النوع", "Type", "Type"), s.channel === "online" ? L("متجر إلكتروني", "Online Store", "En ligne") : L("متجر فعلي", "Offline Store", "Physique")),
        field(L("نشاط المتجر", "Business type", "Activité"), r.type ? nm(r.type.name, s.type) : typeLabel(s.type)),
        field(L("الأداء", "Performance", "Performance"), PERF_TXT(s.performance), s.performance === "good" ? "ok" : s.performance === "average" ? "mid" : s.performance === "attention" ? "warn" : "muted"),
        field(L("التقييم", "Rating", "Note"), s.rating != null ? s.rating + " / 5 (" + num(s.reviews) + ")" : "—"),
        field(L("الهاتف", "Phone", "Téléphone"), s.phone || "—", "ltr"),
        field(L("العنوان", "Address", "Adresse"), addressOf(s), "addr"),
        field(L("البريد", "Email", "E-mail"), store.contactEmail || store.loginEmail || "—", "ltr"));
      var stats = h("div", { class: "sp-dstats" },
        kpi(money(s.sales), L("إجمالي المبيعات", "Total sales", "Ventes totales")), kpi(num(s.orders), L("طلبات مكتملة", "Completed orders", "Commandes livrées")),
        kpi(num(st.productsTotal), L("المنتجات", "Products", "Produits")), kpi(num(st.activeOrders), L("طلبات نشطة", "Active orders", "Commandes actives")));
      body.replaceChildren(info, stats, h("div", { class: "sp-dact" },
        h("button", { class: "sp-btn", type: "button", onclick: function () { dlg.close(); editStore(s); } }, L("تعديل معلومات المتجر", "Edit Store Info", "Modifier")),
        h("button", { class: "sp-btn green", type: "button", onclick: function (e) { enterDashboard(s, e.currentTarget); } }, L("فتح لوحة المتجر", "Open store dashboard", "Ouvrir le tableau de bord"))));
    }).catch(function (e) { body.replaceChildren(h("p", { class: "sp-err", role: "alert" }, (e && e.message) || "Error")); });
  }
  function enterDashboard(s, btn) {
    var win = window.open("about:blank", "_blank"); btn.disabled = true;
    api("/api/admin/stores/" + encodeURIComponent(s.id) + "/enter", { method: "POST", body: "{}" }).then(function (r) {
      var url = "/store/#admintoken=" + encodeURIComponent(r.token) + "&store=" + encodeURIComponent(s.id);
      if (win) win.location.href = url; else window.location.href = url;
    }).catch(function (e) { if (win) win.close(); say("❌ " + ((e && e.message) || "Error")); }).then(function () { btn.disabled = false; });
  }

  function editStore(s, opener) {
    // reuse the full store editor already in the admin (all fields, logo, hours, categories); refresh data first if needed
    var open = function () { if (typeof openRestEdit === "function") openRestEdit(s.id); };
    var known = typeof adminRestaurants !== "undefined" && (adminRestaurants || []).some(function (x) { return String(x.id) === String(s.id); });
    if (known || typeof refreshMenuData !== "function") return open();
    if (opener) opener.disabled = true;
    refreshMenuData().then(open).catch(function (e) { say("❌ " + ((e && e.message) || "Error")); }).then(function () { if (opener) opener.disabled = false; });
  }

  function addStore(opener) {
    var err = {};
    function row(id, label, input, hint) {
      return h("div", { class: "sp-row" }, h("label", { for: id }, label), input, h("small", { class: "sp-hint", id: id + "-e", role: "alert" }, hint || ""));
    }
    var name = h("input", { id: "spaName", maxlength: 80, required: true, autocomplete: "off" });
    var channel = h("select", { id: "spaChannel" }, h("option", { value: "online" }, L("متجر إلكتروني", "Online Store", "En ligne")), h("option", { value: "offline" }, L("متجر فعلي", "Offline Store", "Physique")));
    var type = h("select", { id: "spaType" }, (TYPES.length ? TYPES : [{ id: "restaurant", name: { ar: "مطعم", en: "Restaurant", fr: "Restaurant" } }]).map(function (t) { return h("option", { value: t.id }, nm(t.name, t.id)); }));
    var phone = h("input", { id: "spaPhone", type: "tel", inputmode: "tel", maxlength: 24, dir: "ltr", placeholder: "+212 6 12 34 56 78" });
    var addr = h("input", { id: "spaAddr", maxlength: 160 });
    var city = h("input", { id: "spaCity", maxlength: 80 });
    var web = h("input", { id: "spaWeb", maxlength: 200, inputmode: "url", dir: "ltr", placeholder: "shop.example.com" });
    var submit = h("button", { class: "sp-btn primary", type: "submit" }, L("حفظ المتجر", "Save store", "Enregistrer"));
    var top = h("p", { class: "sp-err", role: "alert" });
    function setErr(id, msg) { var m = $(id + "-e"), i = $(id); if (m) m.textContent = msg || ""; if (i) { if (msg) i.setAttribute("aria-invalid", "true"); else i.removeAttribute("aria-invalid"); } return !msg; }
    function validate() {
      var ch = channel.value, ok = true;
      ok = setErr("spaName", name.value.trim().length < 2 ? L("أدخل اسم المتجر (حرفان على الأقل)", "Enter a store name (at least 2 characters)", "Saisissez un nom (2 caractères min.)") : "") && ok;
      ok = setErr("spaPhone", phone.value.trim() && !/^\+?[0-9 ()\-.]{6,20}$/.test(phone.value.trim()) ? L("رقم هاتف غير صالح", "Enter a valid phone number", "Numéro invalide") : "") && ok;
      ok = setErr("spaAddr", ch === "offline" && !addr.value.trim() ? L("العنوان مطلوب للمتجر الفعلي", "Address is required for an offline store", "Adresse requise") : "") && ok;
      ok = setErr("spaWeb", web.value.trim() && !/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(web.value.trim()) ? L("رابط غير صالح", "Enter a valid website, e.g. shop.example.com", "Site invalide") : (ch === "online" && !web.value.trim() && !addr.value.trim() ? L("أدخل الموقع أو العنوان", "Enter a website or an address", "Site ou adresse requis") : "")) && ok;
      return ok;
    }
    var form = h("form", { class: "sp-form", novalidate: true, onsubmit: function (e) {
      e.preventDefault(); top.textContent = "";
      if (!validate()) { var bad = form.querySelector("[aria-invalid]"); if (bad) bad.focus(); return; }
      submit.disabled = true;
      api("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: name.value.trim(), channel: channel.value, type: type.value, phone: phone.value.trim(), address: addr.value.trim(), city: city.value.trim(), website: web.value.trim(), status: "active" }) })
        .then(function () { dlg.close(); say("✅ " + L("تمت إضافة المتجر", "Store added", "Boutique ajoutée")); S.page = 1; load(); if (typeof refreshMenuData === "function") refreshMenuData().catch(function () {}); })
        .catch(function (e2) { top.textContent = (e2 && e2.message) || "Error"; submit.disabled = false; });
    } },
      top,
      row("spaName", L("اسم المتجر", "Store name", "Nom de la boutique"), name),
      h("div", { class: "sp-2" }, row("spaChannel", L("نوع المتجر", "Store type", "Type"), channel), row("spaType", L("نشاط المتجر", "Business type", "Activité"), type)),
      h("div", { class: "sp-2" }, row("spaPhone", L("الهاتف", "Phone", "Téléphone"), phone), row("spaWeb", L("الموقع الإلكتروني", "Website", "Site web"), web)),
      row("spaAddr", L("العنوان", "Address", "Adresse"), addr),
      row("spaCity", L("المدينة", "City", "Ville"), city),
      h("div", { class: "sp-dact" }, h("button", { class: "sp-btn", type: "button", onclick: function () { dlg.close(); } }, L("إلغاء", "Cancel", "Annuler")), submit));
    var dlg = dialog(L("إضافة متجر", "Add Store", "Ajouter une boutique"), form, opener);
    [name, phone, addr, web].forEach(function (i) { i.addEventListener("input", function () { if (i.hasAttribute("aria-invalid")) validate(); }); });
    channel.addEventListener("change", function () { if (form.querySelector("[aria-invalid]")) validate(); });
    void err;
  }

  /* ---------- routing hooks + legacy nav button (admin-nav.js opens pages through these) ---------- */
  function syncRoute() {
    var want = S.channel === "online" ? "storesOnline" : S.channel === "offline" ? "storesOffline" : "stores";
    if (window.adminNav && typeof window.adminNav.go === "function" && /^#\/stores/.test(location.hash)) window.adminNav.go(want);
  }
  function labels() {
    var set = function (id, t) { var n = $(id); if (n && n.textContent !== t) n.textContent = t; };
    set("storesText", L("المتاجر", "Stores", "Boutiques"));
    set("storesOnlineText", L("المتاجر الإلكترونية", "Online Stores", "En ligne"));
    set("storesOfflineText", L("المتاجر الفعلية", "Offline Stores", "Physiques"));
  }
  window.showStores = function (show) { var m = $("storesModal"); if (m) m.classList.toggle("show", !!show); };
  window.storesPage = {
    setChannel: function (c) { c = c === "online" || c === "offline" ? c : ""; if (S.channel === c) return; S.channel = c; S.page = 1; load(); },
    reload: function () { if ($("storesModal") && $("storesModal").classList.contains("show")) load(); }
  };

  function init() {
    root = $("storesRoot"); if (!root) return;
    labels();
    var btn = $("storesBtn");
    if (btn) btn.addEventListener("click", function () {
      window.showStores(true);
      if (!S.data && !S.loading) { loadTypes(); load(); } else load();
    });
    new MutationObserver(function () { labels(); if ($("storesModal").classList.contains("show")) render(); }).observe(doc.documentElement, { attributes: true, attributeFilter: ["lang", "dir"] });
    // keep the cards in sync when a store is saved from the editor
    if (typeof window.refreshMenuData === "function") {
      var orig = window.refreshMenuData;
      window.refreshMenuData = function () { var p = orig.apply(this, arguments); Promise.resolve(p).then(function () { window.storesPage.reload(); }).catch(function () {}); return p; };
    }
    render();
  }
  // admin-nav.js applies the current route while the page is still parsing, so bind right away when the markup
  // (which precedes this script) already exists; otherwise wait for the DOM.
  if ($("storesRoot") && $("storesBtn")) init(); else doc.addEventListener("DOMContentLoaded", init);
})();
