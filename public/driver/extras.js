/* Driver extras: "Customer ratings" card in the profile tab. */
(function () {
  "use strict";
  const TX = {
    ar: { title: "تقييمات الزبناء", none: "لا توجد تقييمات بعد", based: "من", rates: "تقييم", recent: "آخر التعليقات", err: "تعذّر تحميل التقييمات" },
    en: { title: "Customer ratings", none: "No ratings yet", based: "from", rates: "ratings", recent: "Recent comments", err: "Couldn't load ratings" },
    fr: { title: "Avis des clients", none: "Pas encore d'avis", based: "sur", rates: "avis", recent: "Derniers commentaires", err: "Chargement impossible" },
  };
  const T = () => TX[typeof lang !== "undefined" ? lang : "ar"] || TX.ar;
  const $ = (id) => document.getElementById(id);
  const stars = (n) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));
  function mk(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  async function loadRatings() {
    const box = $("ratingsCard"); if (!box) return;
    const t = T(); box.hidden = false; box.textContent = "";
    box.appendChild(mk("div", "rt-title", t.title));
    try {
      const r = await api("/api/driver/ratings");
      if (!r.count) { box.appendChild(mk("p", "muted", t.none)); return; }
      const top = mk("div", "rt-top");
      top.appendChild(mk("b", "rt-avg", r.avg.toFixed(1)));
      const side = mk("div", "rt-side");
      side.appendChild(mk("div", "rt-stars", stars(r.avg)));
      side.appendChild(mk("div", "muted", `${t.based} ${r.count} ${t.rates}`));
      top.appendChild(side); box.appendChild(top);
      const dist = mk("div", "rt-dist");
      for (let i = 5; i >= 1; i--) {
        const row = mk("div", "rt-row"); row.appendChild(mk("span", null, String(i)));
        const bar = mk("div", "rt-bar"), fill = mk("i"); fill.style.width = Math.round(((r.dist[i] || 0) / r.count) * 100) + "%";
        bar.appendChild(fill); row.appendChild(bar); row.appendChild(mk("span", "muted", String(r.dist[i] || 0))); dist.appendChild(row);
      }
      box.appendChild(dist);
      const withText = (r.reviews || []).filter((x) => x.comment);
      if (withText.length) {
        box.appendChild(mk("div", "rt-sub", t.recent));
        withText.slice(0, 10).forEach((x) => {
          const it = mk("div", "rt-rev");
          it.appendChild(mk("span", "rt-stars", stars(x.stars)));
          it.appendChild(mk("p", null, x.comment));
          if (x.at) it.appendChild(mk("span", "muted", new Date(x.at).toLocaleDateString()));
          box.appendChild(it);
        });
      }
    } catch (_e) { box.appendChild(mk("p", "muted", t.err)); }
  }
  window.SiymonDriverExtras = { loadRatings };
})();
