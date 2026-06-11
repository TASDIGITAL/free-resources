// Cloudflare Worker for the TAS Digital Free Resources site.
// Serves the static site (index.html) and exposes GET /api/resources,
// which returns resource rows from Airtable as JSON.
// Also injects a small script into HTML pages that wires each resource
// card's "Open" button to its Airtable link (after the email gate).
// Requires the AIRTABLE_TOKEN secret (set in the Cloudflare dashboard).

const AIRTABLE_BASE = "appU32zN67pMhC0IU";
const AIRTABLE_TABLE = "tblymxflXKKk955LI";
const EDGE_CACHE_SECONDS = 300; // 5 minutes

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

    // Everything else: serve the static assets (index.html etc.)
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      return new HTMLRewriter()
        .on("body", {
          element(el) {
            el.append("<script>" + WIRE_SCRIPT + "<\/script>", { html: true });
          },
        })
        .transform(assetResponse);
    }
    return assetResponse;
  },
};

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

// Injected into every HTML page. Two jobs:
// 1) Capture runtime errors (window.__errCapture) for diagnostics and hide
//    the page's leftover debug overlay (#__bundler_err) from visitors.
// 2) Fetch /api/resources, pair each resource card with its Airtable row
//    (token-overlap matching, since card titles are display copy), then make
//    "Open" buttons open the link in a new tab once the visitor has passed
//    the email gate (lead in localStorage).
// If the page later ships its own wiring (window.__resourceLinksWired),
// this script backs off.
const WIRE_SCRIPT = `(function () {
  if (window.__resourceLinksWired) return;
  window.__resourceLinksWired = true;
  window.__errCapture = [];
  window.addEventListener("error", function (e) {
    try { window.__errCapture.push(String((e.error && e.error.stack) || e.message || e.type).slice(0, 400)); } catch (x) {}
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    try { window.__errCapture.push("promise: " + String((e.reason && e.reason.stack) || e.reason).slice(0, 400)); } catch (x) {}
  });
  function hideDebugOverlay() {
    var d = document.getElementById("__bundler_err");
    if (d) d.style.display = "none";
  }
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
  function wire() {
    hideDebugOverlay();
    setTimeout(hideDebugOverlay, 1500);
    fetch("/api/resources").then(function (r) { return r.json(); }).then(function (data) {
      var resources = (data.resources || []).filter(function (r) { return r.link; });
      var cards = [].slice.call(document.querySelectorAll("article.card")).filter(function (c) {
        return c.querySelector(".card__title");
      });
      var pairs = [];
      cards.forEach(function (c, ci) {
        var T = norm(c.querySelector(".card__title").textContent);
        resources.forEach(function (r, ri) {
          var N = norm(r.name), hit = 0;
          Object.keys(T).forEach(function (w) { if (N[w]) hit++; });
          var s = hit / Math.max(1, Math.min(size(T), size(N)));
          if (s >= 0.5) pairs.push([s, ci, ri]);
        });
      });
      pairs.sort(function (a, b) { return b[0] - a[0]; });
      var usedC = {}, usedR = {};
      pairs.forEach(function (p) {
        if (usedC[p[1]] || usedR[p[2]]) return;
        usedC[p[1]] = 1; usedR[p[2]] = 1;
        cards[p[1]].setAttribute("data-link", resources[p[2]].link);
      });
    }).catch(function (e) { console.error("resource wiring failed", e); });
  }
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest(".card__open");
    if (!btn) return;
    var card = btn.closest("article.card");
    var link = card && card.getAttribute("data-link");
    if (link && unlocked()) {
      e.preventDefault();
      e.stopPropagation();
      window.open(link, "_blank", "noopener");
    }
  }, true);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();`;
