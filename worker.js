// Cloudflare Worker for the TAS Digital Free Resources site.
// - Serves the static site (index.html).
// - GET /api/resources: resource rows from Airtable as JSON.
// - POST /api/gate: upserts the visitor as a GHL contact (lead magnet +
//   existing clients). Requires the GHL_TOKEN secret; returns 503 until set.
// - Proxies the brand logo images from the TAS Digital Webflow CDN.
// - Injects CSS + a script: hides the page's leftover debug overlay, adds
//   subtle card animations, sizes the logo, wires each card's "Open"
//   button to its Airtable link, and mirrors gate submissions to /api/gate.
// Requires the AIRTABLE_TOKEN secret (set in the Cloudflare dashboard).

const AIRTABLE_BASE = "appU32zN67pMhC0IU";
const AIRTABLE_TABLE = "tblymxflXKKk955LI";
const EDGE_CACHE_SECONDS = 300; // 5 minutes
const GHL_LOCATION = "UU7LapvpwFZtFHJHRtAA";

// Brand images referenced by index.html but missing from the repo.
const IMAGE_PROXY = {
  "/assets/tas-logo-black.png":
    "https://cdn.prod.website-files.com/654e8713431b6e197569c212/6647386838d851201c65f7a0_talas%20logo%201.png",
  "/assets/tas-mark.png":
    "https://cdn.prod.website-files.com/654e8713431b6e197569c212/6554d536c8357781ef074345_tas%20webicon.png",
};

const INJECT_CSS = [
  "#__bundler_err{display:none !important}",
  "#__bundler_thumbnail{display:none !important}",
  "#tas-welcome{position:fixed;inset:0;z-index:100000;background:#fff;display:flex;align-items:center;justify-content:center;text-align:center;padding:28px;transition:opacity .8s ease}",
  "#tas-welcome.tas-welcome--out{opacity:0}",
  ".tas-welcome__inner{max-width:700px}",
  ".tas-welcome__inner h2{font-size:48px;line-height:1.15;margin:0 0 20px;color:#171130}",
  ".tas-welcome__inner p{font-size:19px;line-height:1.65;color:#4a445c;margin:0 0 14px}",
  "@media (prefers-reduced-motion: no-preference){",
  ".tas-welcome__line{opacity:0;animation:tasFadeUp .9s ease forwards}",
  ".tas-welcome__line:nth-child(1){animation-delay:.3s}",
  ".tas-welcome__line:nth-child(2){animation-delay:1.4s}",
  ".tas-welcome__line:nth-child(3){animation-delay:2.5s}",
  "@keyframes tasFadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}",
  "}",
  ".topbar__logo{height:36px !important}",
  ".foot__logo{height:30px !important}",
  "@media (prefers-reduced-motion: no-preference){",
  ".tas-anim{opacity:0}",
  ".tas-anim.tas-in{animation:tasReveal .55s ease forwards}",
  "@keyframes tasReveal{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}",
  "article.card{transition:transform .25s ease,box-shadow .25s ease}",
  "article.card:hover{transform:translateY(-4px);box-shadow:0 14px 30px rgba(20,10,50,.12)}",
  ".card__open{transition:transform .15s ease}",
  ".card__open:hover{transform:scale(1.06)}",
  "}",
  ".tas-dupe{display:none}",
  "@media (prefers-reduced-motion: no-preference){",
  ".quotes__viewport{position:relative;max-height:560px;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 14%,#000 85%,transparent 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 14%,#000 85%,transparent 100%)}",
  ".quotes__grid.tas-vscroll{animation:tasVScroll 75s linear infinite}",
  ".quotes__viewport:hover .quotes__grid.tas-vscroll{animation-play-state:paused}",
  ".quotes__grid.tas-vscroll .tas-dupe{display:flex}",
  "@keyframes tasVScroll{from{transform:translateY(0)}to{transform:translateY(-50%)}}",
  "}",
].join("");

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/resources") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      try {
        return await resources(request, env, ctx);
      } catch (err) {
        console.error("resources error:", err);
        return json({ error: "Failed to load resources" }, 502);
      }
    }

    if (url.pathname === "/api/gate") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      try {
        return await gate(request, env);
      } catch (err) {
        console.error("gate error:", err);
        return json({ ok: false }, 502);
      }
    }

    if (IMAGE_PROXY[url.pathname]) {
      try {
        return await proxyImage(url.pathname, request, ctx);
      } catch (err) {
        console.error("image proxy error:", err);
        return new Response("Not found", { status: 404 });
      }
    }

    // Everything else: serve the static assets (index.html etc.)
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      return new HTMLRewriter()
        .on("head", {
          element(el) {
            el.append("<style>" + INJECT_CSS + "</style>", { html: true });
          },
        })
        .on("body", {
          element(el) {
            el.append(
              "<script>var TAS_CSS=" + JSON.stringify(INJECT_CSS) + ";" + WIRE_SCRIPT + "<\/script>",
              { html: true }
            );
          },
        })
        .transform(assetResponse);
    }
    return assetResponse;
  },
};

// Upsert the visitor into GHL. Existing contacts are recognised by email;
// new visitors become new contacts. Both get the d2c-resource-library tag,
// so automations can target them (new contacts also fire GHL's
// "contact created" trigger for lead-magnet follow-up).
async function gate(request, env) {
  if (!env.GHL_TOKEN) return json({ ok: false, error: "Gate not configured" }, 503);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const name = String(body.full_name || "").trim().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: "Invalid email" }, 400);
  }
  const res = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GHL_TOKEN,
      Version: "2021-07-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locationId: GHL_LOCATION,
      email: email,
      name: name || undefined,
      source: "D2C Resource Library",
      tags: ["d2c-resource-library"],
    }),
  });
  if (!res.ok) throw new Error("GHL upsert responded " + res.status);
  const data = await res.json();
  return json({ ok: true, existing: !(data && data.new) });
}

async function proxyImage(pathname, request, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(pathname, request.url));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetch(IMAGE_PROXY[pathname]);
  if (!upstream.ok) throw new Error("upstream " + upstream.status);
  const response = new Response(upstream.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function resources(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/resources", request.url));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // Fetch every record from Airtable (handles pagination).
  const records = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: "100" });
    if (offset) qs.set("offset", offset);
    const res = await fetch(
      "https://api.airtable.com/v0/" + AIRTABLE_BASE + "/" + AIRTABLE_TABLE + "?" + qs,
      { headers: { Authorization: "Bearer " + env.AIRTABLE_TOKEN } }
    );
    if (!res.ok) throw new Error("Airtable responded " + res.status);
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  // Map to a clean public shape; internal fields are never exposed.
  const items = records
    .map(function (r) {
      return {
        id: r.id,
        name: r.fields.Name || "",
        summary: r.fields.Summary || "",
        description: r.fields.Description || "",
        category: r.fields.Category || "",
        link: r.fields.Link || "",
      };
    })
    .filter(function (r) {
      return r.name && r.link;
    });

  const response = json({ resources: items }, 200, {
    "Cache-Control": "public, max-age=60, s-maxage=" + EDGE_CACHE_SECONDS,
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(body, status, extraHeaders) {
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    extraHeaders || {}
  );
  return new Response(JSON.stringify(body), { status: status || 200, headers });
}

// Injected into every HTML page. Jobs:
// 1) Capture runtime errors (window.__errCapture) for diagnostics.
// 2) Re-insert injected CSS after the page's bootloader wipes the DOM and
//    keep the debug overlay hidden via MutationObserver.
// 3) Fetch /api/resources, pair each resource card with its Airtable row
//    (token-overlap matching), and make "Open" buttons open the link in a
//    new tab once the visitor has passed the email gate.
// 4) Reveal cards with a soft fade/slide as they scroll into view.
// 5) Mirror gate form submissions to /api/gate (GHL contact upsert).
// If the page later ships its own wiring (window.__resourceLinksWired),
// this script backs off.
const WIRE_SCRIPT = `(function () {
  if (window.__resourceLinksWired) return;
  window.__resourceLinksWired = true;
  window.__errCapture = [];
  window.addEventListener("error", function (e) {
    try {
      var t = e.target || {};
      var info = (e.error && e.error.stack) || e.message || (t.tagName ? t.tagName + " " + (t.src || t.href || "") : e.type);
      window.__errCapture.push(String(info).slice(0, 400));
    } catch (x) {}
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    try { window.__errCapture.push("promise: " + String((e.reason && e.reason.stack) || e.reason).slice(0, 400)); } catch (x) {}
  });
  function killOverlay(n) {
    if (n && n.id === "__bundler_err") {
      try { n.style.setProperty("display", "none", "important"); } catch (x) {}
    }
  }
  function ensureCss() {
    try {
      if (!document.getElementById("tas-inject-css")) {
        var st = document.createElement("style");
        st.id = "tas-inject-css";
        st.textContent = TAS_CSS;
        (document.head || document.documentElement).appendChild(st);
      }
      killOverlay(document.getElementById("__bundler_err"));
    } catch (x) {}
  }
  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        killOverlay(m.target);
        if (m.addedNodes) {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (n.nodeType === 1) {
              killOverlay(n);
              if (n.querySelector) killOverlay(n.querySelector("#__bundler_err"));
            }
          }
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "id"] });
  } catch (x) {}
  // Animated welcome overlay shown right after a successful gate submit.
  function showWelcome(fullName) {
    if (document.getElementById("tas-welcome")) return;
    var first = String(fullName || "").trim().split(" ")[0] || "";
    var safeFirst = first.replace(/[<>&"']/g, "");
    var el = document.createElement("div");
    el.id = "tas-welcome";
    el.innerHTML =
      '<div class="tas-welcome__inner">' +
      '<h2 class="tas-welcome__line">Welcome' + (safeFirst ? ", " + safeFirst : "") + "</h2>" +
      '<p class="tas-welcome__line">Here is your growth playbook \u2014 resources on Creative Strategy, Advertising, Email Marketing and CRO.</p>' +
      '<p class="tas-welcome__line">It\u2019s lifetime access \u2014 and guess what: we\u2019re always adding new resources, so check back from time to time.</p>' +
      "</div>";
    document.body.appendChild(el);
    function dismiss() {
      if (el.__closing) return;
      el.__closing = true;
      el.classList.add("tas-welcome--out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 850);
    }
    el.addEventListener("click", dismiss);
    setTimeout(dismiss, 5800);
  }
  // Mirror gate submissions to /api/gate so GHL gets a contact upsert.
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || !f.classList || !f.classList.contains("gate__form")) return;
    try {
      var nameEl = document.getElementById("g-name");
      var emailEl = document.getElementById("g-email");
      var payload = { full_name: nameEl ? nameEl.value : "", email: emailEl ? emailEl.value : "" };
      if (payload.email) {
        fetch("/api/gate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(function () {});
      }
      var em = String(payload.email || "").trim();
      var at = em.indexOf("@");
      var validEmail = at > 0 && em.indexOf(" ") === -1 && em.indexOf(".", at + 2) > at + 1 && em.lastIndexOf(".") < em.length - 1;
      var validName = String(payload.full_name || "").trim().length >= 2;
      if (validEmail && validName) {
        setTimeout(function () { showWelcome(payload.full_name); }, 420);
      }
    } catch (x) {}
  }, true);
  function unlocked() {
    try { return !!localStorage.getItem("tas_bundle_lead_v1"); } catch (e) { return false; }
  }
  var STOP = { the: 1, a: 1, an: 1, of: 1, for: 1, with: 1, using: 1, to: 1, and: 1, full: 1, process: 1, your: 1, by: 1 };
  function norm(s) {
    var out = {};
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/ +/).forEach(function (w) {
      if (w && !STOP[w]) out[w] = 1;
    });
    return out;
  }
  function size(o) { return Object.keys(o).length; }
  function animInit() {
    if (!("IntersectionObserver" in window)) return;
    if (!window.__tasObserver) {
      window.__tasObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("tas-in");
            window.__tasObserver.unobserve(en.target);
          }
        });
      }, { threshold: 0.12 });
    }
    var els = [].slice.call(document.querySelectorAll("article.card:not(.tas-anim)"));
    els.forEach(function (el, i) {
      el.classList.add("tas-anim");
      el.style.animationDelay = (i % 3) * 90 + "ms";
      window.__tasObserver.observe(el);
    });
  }
  var resourceList = null;
  function applyLinks() {
    if (!resourceList) return 0;
    var cards = [].slice.call(document.querySelectorAll("article.card")).filter(function (c) {
      return c.querySelector(".card__title");
    });
    if (!cards.length) return 0;
    var pairs = [];
    cards.forEach(function (c, ci) {
      var T = norm(c.querySelector(".card__title").textContent);
      resourceList.forEach(function (r, ri) {
        var N = norm(r.name), hit = 0;
        Object.keys(T).forEach(function (w) { if (N[w]) hit++; });
        var s = hit / Math.max(1, Math.min(size(T), size(N)));
        if (s >= 0.5) pairs.push([s, ci, ri]);
      });
    });
    pairs.sort(function (a, b) { return b[0] - a[0]; });
    var usedC = {}, usedR = {}, wired = 0;
    pairs.forEach(function (p) {
      if (usedC[p[1]] || usedR[p[2]]) return;
      usedC[p[1]] = 1; usedR[p[2]] = 1;
      cards[p[1]].setAttribute("data-link", resourceList[p[2]].link);
      wired++;
    });
    return wired;
  }
  var attempts = 0;
  function tryWire() {
    attempts++;
    ensureCss();
    animInit();
    var wired = applyLinks();
    if (wired === 0 && attempts < 30) setTimeout(tryWire, 700);
  }
  // Keep CSS present and overlay hidden during the page's boot phase.
  var guard = setInterval(ensureCss, 400);
  setTimeout(function () { clearInterval(guard); }, 25000);
  function start() {
    ensureCss();
    fetch("/api/resources").then(function (r) { return r.json(); }).then(function (data) {
      resourceList = (data.resources || []).filter(function (r) { return r.link; });
      tryWire();
    }).catch(function (e) {
      console.error("resource wiring failed", e);
      if (attempts < 5) { attempts++; setTimeout(start, 2000); }
    });
  }
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest(".card__open");
    if (!btn) return;
    var card = btn.closest("article.card");
    var link = card && card.getAttribute("data-link");
    if (!link && resourceList) { applyLinks(); link = card && card.getAttribute("data-link"); }
    if (link && unlocked()) {
      e.preventDefault();
      e.stopPropagation();
      window.open(link, "_blank", "noopener");
    }
  }, true);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();`;
