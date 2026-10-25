// AnimeAV1 — port para la app (contrato lol.json / CommonJS) — v1.7.0
//
// Contrato que usa la app (ver js_runtime.dart / content_service.dart):
//   getHome()                    -> [{ id, title, type, imageStyle, catalogId, items }]
//   getDiscoverFilters()         -> [{ id, label, options:[{id,label}] }]   (máx. 3)
//   getDiscover({page, ...})     -> { items, hasMore }
//   getCatalogs() / getCatalog(id, {page})
//   search(query)                -> [items]
//   getMeta(id)                  -> item con seasons[].episodes[]
//   getStreams(id, type, season, episode) -> [servidores]
//
// El `id` de cada item es el slug del sitio (p. ej. "one-piece-tv"); el id de episodio es
// "<slug>/<n>". Así getMeta y getStreams solo necesitan el id que la app ya les pasa.
//
// Voe va primero: MP4Upload sirve AV1 10-bit (sin decoder en muchas TV); Voe da H.264 720p HLS.

const ADDON_ID = "animeav1";
const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SEARCH_PAGES = 3;
const PAGE_LIMIT = 100;
const ROW_LIMIT = 40;

// ---------------------------------------------------------------------------------------------
// Utilidades (reemplazan lo que en Kino daba el objeto `kino`)

function mkErr(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function log() {
  try {
    console.log.apply(console, ["animeav1:"].concat(Array.prototype.slice.call(arguments)));
  } catch (_) {}
}

// Configuración del usuario. La app guarda el TEXTO de la opción elegida, no un código.
function cfg(key) {
  const g = globalThis.__nuvioConfig || {};
  const c = g[ADDON_ID] || g.current || {};
  const v = c[key];
  return v == null ? "" : String(v);
}

// fetch con tope de tiempo opcional (timeoutMs).
function kfetch(url, opts) {
  opts = opts || {};
  const ms = opts.timeoutMs;
  const o = Object.assign({}, opts);
  delete o.timeoutMs;
  const p = fetch(url, o);
  if (!ms) return p;
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () {
      reject(new Error("timeout " + ms + "ms"));
    }, ms);
    p.then(
      function (v) {
        clearTimeout(t);
        resolve(v);
      },
      function (e) {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function resolveUrl(base, rel) {
  rel = String(rel);
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(rel)) return rel;
  const m = String(base).match(/^([a-zA-Z][a-zA-Z0-9+.\-]*:)\/\/([^\/?#]*)([^?#]*)/);
  if (!m) return rel;
  if (rel.indexOf("//") === 0) return m[1] + rel;
  const origin = m[1] + "//" + m[2];
  if (rel.charAt(0) === "/") return origin + rel;
  const dir = m[3].replace(/[^\/]*$/, "");
  const segs = (dir + rel).split("/");
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === "..") out.pop();
    else if (segs[i] !== ".") out.push(segs[i]);
  }
  return origin + out.join("/");
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(function (it) {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Datos de SvelteKit (__data.json)

function unflatten(flat) {
  const cache = new Map();
  function get(i) {
    if (typeof i !== "number" || i < 0) return undefined;
    if (cache.has(i)) return cache.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") {
        cache.set(i, v[1]);
        return v[1];
      }
      const out = [];
      cache.set(i, out);
      for (const x of v) out.push(get(x));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      cache.set(i, out);
      for (const k of Object.keys(v)) out[k] = get(v[k]);
      return out;
    }
    cache.set(i, v);
    return v;
  }
  return get(0);
}

function lastNodeData(body) {
  const nodes = (body.nodes || []).filter(function (n) {
    return n && n.type === "data" && Array.isArray(n.data);
  });
  return nodes.length ? unflatten(nodes[nodes.length - 1].data) : null;
}

async function loadData(path, what) {
  const r = await kfetch(BASE + path + "/__data.json", { headers: { Accept: "application/json" } });
  if (r.status === 404) throw mkErr("not_found", what + ": " + path);
  if (r.status === 429) throw mkErr("rate_limited", what + ": HTTP 429");
  if (!r.ok) throw mkErr("unavailable", what + ": HTTP " + r.status);
  const body = await r.json();
  if (body.type === "redirect" || body.type === "error") {
    throw mkErr("not_found", what + ": " + body.type + " " + path);
  }
  const data = lastNodeData(body);
  if (!data) throw mkErr("unavailable", what + ": empty __data.json");
  return data;
}

// ---------------------------------------------------------------------------------------------
// Items

function isMovie(media) {
  const c = media.category || {};
  return c.slug === "pelicula" || c.malId === "Movie";
}

function toItem(media) {
  const numId = String(media.id);
  const movie = isMovie(media);
  const item = {
    id: String(media.slug), // slug: es lo que getMeta/getStreams reciben luego
    title: media.title,
    type: movie ? "movie" : "series",
    poster: CDN + "/covers/" + numId + ".jpg",
    backdrop: CDN + "/backdrops/" + numId + ".jpg",
    genres: ["Anime"],
  };
  if (media.synopsis) item.overview = String(media.synopsis).trim();
  const year = String(media.startDate || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) item.year = year;
  return item;
}

function mediaFromEpisode(e) {
  const m = e && e.media;
  if (!m || m.id == null || !m.slug || !m.title) return null;
  const it = toItem(m);
  if (e.number != null) {
    it.badges = ["EP " + e.number];
    // Series nuevas suelen no tener backdrop: la captura del último episodio siempre existe.
    it.backdrop = CDN + "/screenshots/" + String(m.id) + "/" + e.number + ".jpg";
  }
  return it;
}

// ---------------------------------------------------------------------------------------------
// Catálogo del sitio: ?page, ?order, ?status, ?genre, ?category, ?search
// Los valores válidos de order/status/category no están documentados: se prueban candidatos y se
// conserva el primero que cambia de verdad los resultados (resultado memorizado en la sesión).

const GENEROS = [
  ["accion", "Acción"],
  ["aventura", "Aventura"],
  ["comedia", "Comedia"],
  ["drama", "Drama"],
  ["fantasia", "Fantasía"],
  ["ciencia-ficcion", "Ciencia ficción"],
  ["romance", "Romance"],
  ["shounen", "Shounen"],
  ["misterio", "Misterio"],
  ["terror", "Terror"],
  ["deportes", "Deportes"],
  ["slice-of-life", "Slice of life"],
];

const ORDER_CANDIDATES = ["popular", "popularity", "views", "score", "rating"];
const STATUS_CANDIDATES = ["emision", "en-emision", "airing", "1"];
const MOVIE_CANDIDATES = ["pelicula", "peliculas", "movie"];

async function loadCatalog(params, page) {
  const qs = Object.keys(params)
    .map(function (k) {
      return k + "=" + encodeURIComponent(params[k]);
    })
    .concat(page > 1 ? ["page=" + page] : [])
    .join("&");
  const r = await kfetch(BASE + "/catalogo/__data.json" + (qs ? "?" + qs : ""), {
    headers: { Accept: "application/json" },
  });
  if (r.status === 429) throw mkErr("rate_limited", "catalog: HTTP 429");
  if (!r.ok) throw mkErr("unavailable", "catalog: HTTP " + r.status);
  const data = lastNodeData(await r.json()) || {};
  const raw = (data.results || []).filter(function (m) {
    return m && m.id != null && m.slug && m.title;
  });
  return {
    raw: raw,
    items: raw.map(toItem),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
    orderKey: data.orderKey,
  };
}

let baselinePromise = null;
function baseline() {
  if (!baselinePromise) {
    baselinePromise = loadCatalog({}, 1)
      .then(function (b) {
        return b.raw
          .slice(0, 10)
          .map(function (m) {
            return m.id;
          })
          .join(",");
      })
      .catch(function (e) {
        baselinePromise = null;
        throw e;
      });
  }
  return baselinePromise;
}

async function pickParams(candidates) {
  const base = await baseline();
  for (const c of candidates) {
    try {
      const res = await loadCatalog(c, 1);
      const ids = res.raw
        .slice(0, 10)
        .map(function (m) {
          return m.id;
        })
        .join(",");
      if (res.raw.length > 0 && (ids !== base || (res.orderKey && res.orderKey !== "default"))) return c;
    } catch (e) {
      log("probe failed", JSON.stringify(c), e && e.message);
    }
  }
  return null;
}

const paramMemo = {};
// ref: "ord" | "emi" | "peli" | "serie" | "eps" | "gen:<slug>"
function paramsFor(ref) {
  if (ref.indexOf("gen:") === 0) return Promise.resolve({ genre: ref.slice(4) });
  let cands = null;
  if (ref === "ord") cands = ORDER_CANDIDATES.map(function (o) { return { order: o }; });
  else if (ref === "emi") cands = STATUS_CANDIDATES.map(function (s) { return { status: s }; });
  else if (ref === "peli") cands = MOVIE_CANDIDATES.map(function (c) { return { category: c }; });
  if (!cands) return Promise.resolve(null);
  if (!paramMemo[ref]) {
    paramMemo[ref] = pickParams(cands).then(
      function (p) {
        if (!p) delete paramMemo[ref]; // no memorizar el fallo
        return p;
      },
      function (e) {
        delete paramMemo[ref];
        throw e;
      }
    );
  }
  return paramMemo[ref];
}

// ---------------------------------------------------------------------------------------------
// Home / filas

const CACHE_MS = 10 * 60 * 1000;
let homeCache = null;
async function loadHome() {
  if (!homeCache || Date.now() - homeCache.t > CACHE_MS) {
    homeCache = { t: Date.now(), data: await loadData("", "home") };
  }
  return homeCache.data;
}

async function latestEpisodeItems() {
  const d = await loadHome();
  return dedupe((d.latestEpisodes || []).map(mediaFromEpisode).filter(Boolean));
}

const rowCache = {};
async function rowItems(ref) {
  const hit = rowCache[ref];
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.items;
  let items = [];
  if (ref === "eps") {
    items = await latestEpisodeItems();
  } else if (ref === "serie") {
    const res = await loadCatalog({}, 1);
    items = res.raw.filter(function (m) { return !isMovie(m); }).map(toItem);
  } else {
    const p = await paramsFor(ref);
    if (p) items = (await loadCatalog(p, 1)).items;
    else if (ref === "emi") items = await latestEpisodeItems(); // lo que tiene episodio nuevo está en emisión
  }
  if (items.length) rowCache[ref] = { t: Date.now(), items: items };
  return items;
}

const backdropOk = new Map();
function hasBackdrop(url) {
  if (!backdropOk.has(url)) {
    backdropOk.set(
      url,
      kfetch(url, { method: "HEAD", timeoutMs: 6000 }).then(
        function (r) { return !!r.ok; },
        function () { return false; }
      )
    );
  }
  return backdropOk.get(url);
}

// Comprueba los primeros n backdrops. Devuelve { good, rest }: rest = sin backdrop verificado.
async function verifyBackdrops(items, n) {
  const head = items.slice(0, n);
  const checks = await Promise.all(head.map(function (it) { return it.backdrop ? hasBackdrop(it.backdrop) : false; }));
  const good = [];
  const rest = [];
  head.forEach(function (it, i) {
    if (checks[i]) good.push(it);
    else {
      const c = Object.assign({}, it);
      c.backdrop = c.poster; // la app puede pedir backdrop: que haya siempre una imagen
      rest.push(c);
    }
  });
  return { good: good, rest: rest.concat(items.slice(n)) };
}

const ROW_DEFS = [
  ["eps", "Últimos episodios", "backdrop"],
  ["emi", "En emisión", "poster"],
  ["ord", "Populares", "poster"],
  ["peli", "Películas", "poster"],
  ["serie", "Series", "poster"],
];

let genreTilesPromise = null;
function genreTiles() {
  if (!genreTilesPromise) {
    genreTilesPromise = Promise.all(
      GENEROS.map(function (g) {
        return loadCatalog({ genre: g[0] }, 1).then(
          function (r) {
            return { id: "gen:" + g[0], title: g[1], type: "catalog", poster: r.items[0] && r.items[0].poster };
          },
          function () {
            return { id: "gen:" + g[0], title: g[1], type: "catalog" };
          }
        );
      })
    ).catch(function (e) {
      genreTilesPromise = null;
      throw e;
    });
  }
  return genreTilesPromise;
}

async function getHome() {
  const lists = await Promise.all(
    ROW_DEFS.map(function (d) {
      return rowItems(d[0]).catch(function (e) {
        log("row", d[0], "failed:", e && e.message);
        return [];
      });
    })
  );

  const rows = [];

  // Hero: los últimos episodios (con captura verificada); si no, los populares con su póster.
  const epsItems = lists[0].length ? lists[0] : lists[2].length ? lists[2] : lists[1];
  if (epsItems.length) {
    const v = await verifyBackdrops(epsItems.slice(0, 8), 8);
    const heroItems = (v.good.length ? v.good : v.rest).slice(0, 6);
    rows.push({ id: "hero", title: "Destacados", type: "hero", imageStyle: "backdrop", items: heroItems });
  }

  for (let i = 0; i < ROW_DEFS.length; i++) {
    const def = ROW_DEFS[i];
    let items = lists[i];
    if (!items.length) continue;
    items = items.slice(0, ROW_LIMIT);
    if (def[2] === "backdrop") {
      const v = await verifyBackdrops(items, 12);
      items = v.good.concat(v.rest);
    }
    rows.push({ id: def[0], title: def[1], type: "row", imageStyle: def[2], catalogId: def[0], items: items });
  }

  try {
    rows.push({ id: "catalogs", title: "Géneros", type: "catalog", imageStyle: "poster", items: await genreTiles() });
  } catch (e) {
    log("genres failed:", e && e.message);
  }

  if (!rows.length) throw mkErr("unavailable", "home: no rows could be built");
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Catálogos (pantalla "Catálogos" y "Ver todos")

async function getCatalogs() {
  const out = [];
  const specials = [
    ["emi", "En emisión"],
    ["ord", "Populares"],
    ["peli", "Películas"],
    ["serie", "Series"],
  ];
  for (const s of specials) {
    const hit = rowCache[s[0]];
    const it = hit && hit.items[0];
    out.push({ id: s[0], title: s[1], poster: it && it.poster, backdrop: it && it.poster });
  }
  const tiles = await genreTiles();
  for (const t of tiles) out.push({ id: t.id, title: t.title, poster: t.poster, backdrop: t.poster });
  return out;
}

async function browseRef(ref, page) {
  ref = String(ref);
  if (ref === "eps") {
    return { items: (await latestEpisodeItems()).slice(0, PAGE_LIMIT), hasMore: false, page: 1, totalPages: 1 };
  }
  let res;
  let items;
  if (ref === "serie") {
    res = await loadCatalog({}, page);
    items = res.raw.filter(function (m) { return !isMovie(m); }).map(toItem);
  } else {
    const p = await paramsFor(ref);
    if (!p) {
      if (ref === "emi" && page === 1) {
        return { items: (await latestEpisodeItems()).slice(0, PAGE_LIMIT), hasMore: false, page: 1, totalPages: 1 };
      }
      throw mkErr("unavailable", "browse: filter not supported " + ref);
    }
    res = await loadCatalog(p, page);
    items = res.items;
  }
  return {
    items: dedupe(items).slice(0, PAGE_LIMIT),
    hasMore: page < res.totalPages,
    page: page,
    totalPages: res.totalPages,
  };
}

async function getCatalog(catalogId, opts) {
  const page = Math.max(1, parseInt(opts && opts.page, 10) || 1);
  return browseRef(catalogId, page);
}

// ---------------------------------------------------------------------------------------------
// Descubrir (filtros) y búsqueda

async function getDiscoverFilters() {
  return [
    {
      id: "genero",
      label: "Género",
      options: [{ id: "todos", label: "Todos" }].concat(GENEROS.map(function (g) { return { id: g[0], label: g[1] }; })),
    },
    {
      id: "tipo",
      label: "Tipo",
      options: [
        { id: "todos", label: "Todos" },
        { id: "serie", label: "Series" },
        { id: "pelicula", label: "Películas" },
      ],
    },
    {
      id: "lista",
      label: "Orden",
      options: [
        { id: "todos", label: "Recientes" },
        { id: "popular", label: "Populares" },
        { id: "emision", label: "En emisión" },
      ],
    },
  ];
}

async function getDiscover(opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const genero = String(opts.genero || opts.genre || "todos");
  const tipo = String(opts.tipo || "todos");
  const lista = String(opts.lista || "todos");

  const params = {};
  if (genero !== "todos") params.genre = genero;
  if (lista === "popular") Object.assign(params, (await paramsFor("ord")) || {});
  if (lista === "emision") Object.assign(params, (await paramsFor("emi")) || {});
  if (tipo === "pelicula") Object.assign(params, (await paramsFor("peli")) || {});

  const res = await loadCatalog(params, page);
  let items = res.items;
  if (tipo === "serie") items = items.filter(function (it) { return it.type !== "movie"; });
  if (tipo === "pelicula") items = items.filter(function (it) { return it.type === "movie"; });
  return {
    items: dedupe(items).slice(0, PAGE_LIMIT),
    hasMore: page < res.totalPages,
    page: page,
    totalPages: res.totalPages,
  };
}

async function searchPage(enc, page) {
  const r = await kfetch(BASE + "/catalogo/__data.json?search=" + enc + (page > 1 ? "&page=" + page : ""), {
    headers: { Accept: "application/json" },
  });
  if (r.status === 429) throw mkErr("rate_limited", "search: HTTP 429");
  if (!r.ok) throw mkErr("unavailable", "search: HTTP " + r.status);
  const data = lastNodeData(await r.json()) || {};
  return {
    items: (data.results || [])
      .filter(function (m) { return m && m.id != null && m.slug && m.title; })
      .map(toItem),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
  };
}

async function search(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const enc = encodeURIComponent(q).replace(/%20/g, "+");
  const first = await searchPage(enc, 1);
  const items = first.items.slice();
  const pages = Math.min(first.totalPages, SEARCH_PAGES);
  for (let p = 2; p <= pages; p++) {
    try {
      items.push.apply(items, (await searchPage(enc, p)).items);
    } catch (_) {
      break; // con la página 1 alcanza para responder
    }
  }
  return dedupe(items).slice(0, PAGE_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Detalle + episodios

async function getMeta(id) {
  const slug = String(id).split("/")[0];
  const data = await loadData("/media/" + slug, "meta");
  const media = data.media;
  if (!media) throw mkErr("not_found", "meta: no media for " + slug);

  const item = toItem(media);
  item.id = slug;

  const nums = Array.from(
    new Set((media.episodes || []).map(function (e) { return Number(e && e.number); }))
  )
    .filter(function (n) { return Number.isInteger(n) && n >= 1; })
    .sort(function (a, b) { return a - b; });

  if (item.type === "series" || nums.length > 1) {
    if (nums.length === 0) throw mkErr("not_found", "meta: no episodes for " + slug);
    item.type = "series";
    item.seasons = [
      {
        number: 1,
        name: "Episodios",
        episodes: nums.map(function (n) {
          return {
            number: n,
            id: slug + "/" + n,
            title: "Episodio " + n,
            still: CDN + "/screenshots/" + String(media.id) + "/" + n + ".jpg",
          };
        }),
      },
    ];
  }
  return item;
}

// ---------------------------------------------------------------------------------------------
// Servidores (hosters). Cada uno devuelve { url, hls, headers }.

function decodeEscapes(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\\//g, "/");
}

function decodeHtml(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

// Un mp4 sirve si el servidor contesta a un Range de 2 bytes.
async function checkVideo(url, headers) {
  const r = await kfetch(url, { headers: Object.assign({ Range: "bytes=0-1" }, headers), timeoutMs: 8000 });
  if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
  return r;
}

// Un HLS sirve si carga la lista y el primer segmento de la primera variante.
async function checkHls(url, headers) {
  const get = async function (u, h) {
    const r = await kfetch(u, { headers: h, timeoutMs: 8000 });
    if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
    return r;
  };
  const linesOf = function (t) {
    return String(t).split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  };
  let playlistUrl = url;
  let text = await (await get(playlistUrl, headers)).text();
  if (text.indexOf("#EXTM3U") === -1) throw new Error("not a playlist");
  let lines = linesOf(text);
  if (lines.some(function (l) { return l.indexOf("#EXT-X-STREAM-INF") === 0; })) {
    const variant = lines.find(function (l) { return l.charAt(0) !== "#"; });
    if (!variant) throw new Error("empty master playlist");
    playlistUrl = resolveUrl(playlistUrl, variant);
    text = await (await get(playlistUrl, headers)).text();
    lines = linesOf(text);
  }
  const seg = lines.find(function (l) { return l.charAt(0) !== "#"; });
  if (!seg) throw new Error("no segments in playlist");
  await get(resolveUrl(playlistUrl, seg), Object.assign({ Range: "bytes=0-1" }, headers));
}

// MP4Upload: un mp4 progresivo que solo responde con el Referer del sitio.
async function fromMp4Upload(embedUrl) {
  const r = await kfetch(embedUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!r.ok) throw new Error("mp4upload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
    html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+)["']/i) ||
    html.match(/<source[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("mp4upload: no video in embed");
  return {
    url: decodeEscapes(m[1]),
    hls: false,
    headers: { Referer: "https://www.mp4upload.com/", "User-Agent": BROWSER_UA },
  };
}

// Voe: JSON escondido con rot13, marcas basura, base64, desplazamiento de -3, reverso y base64.
function voeDecode(packed) {
  let s = packed.replace(/[a-zA-Z]/g, function (c) {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
  const junk = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
  for (let i = 0; i < junk.length; i++) s = s.split(junk[i]).join("");
  s = atob(s);
  let shifted = "";
  for (let i = 0; i < s.length; i++) shifted += String.fromCharCode(s.charCodeAt(i) - 3);
  return JSON.parse(atob(shifted.split("").reverse().join("")));
}

function voeSourceFrom(html) {
  const packed = html.match(/<script type="application\/json">\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/);
  if (packed) {
    const data = voeDecode(packed[1]);
    if (data && data.source) return data.source;
  }
  const hls = html.match(/["']hls["']\s*:\s*["']([^"']+)["']/);
  if (hls) {
    const v = hls[1];
    return v.indexOf("http") === 0 ? v : atob(v);
  }
  return null;
}

// voe.sx redirige con JS a un dominio espejo que rota; el espejo tiene el reproductor.
async function fromVoe(embedUrl) {
  let url = embedUrl;
  for (let hop = 0; hop < 3; hop++) {
    const r = await kfetch(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!r.ok) throw new Error("voe HTTP " + r.status);
    const html = await r.text();
    const source = voeSourceFrom(html);
    if (source) return { url: source, hls: true, headers: { "User-Agent": BROWSER_UA } };
    const next = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (!next) break;
    url = next[1];
  }
  throw new Error("voe: no source in page");
}

// YourUpload: el mp4 va en og:video y el host da 500 sin el Referer de YourUpload.
async function fromYourUpload(embedUrl) {
  const r = await kfetch(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
  if (!r.ok) throw new Error("yourupload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/<meta[^>]+og:video["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+og:video["']/i) ||
    html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("yourupload: no video in embed");
  const url = decodeHtml(decodeEscapes(m[1]));
  const headers = { Referer: "https://www.yourupload.com/", "User-Agent": BROWSER_UA };
  await checkVideo(url, headers);
  return { url: url, hls: false, headers: headers };
}

// StreamTape: el script de la página arma el link en dos trozos; get_video redirige al archivo
// real (firmado para la IP). La app necesita la dirección final.
async function fromStreamTape(embedUrl) {
  const r = await kfetch(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
  if (!r.ok) throw new Error("streamtape HTTP " + r.status);
  const html = await r.text();
  const re = /getElementById\(\s*['"](?:robotlink|ideoolink|norobotlink)['"]\s*\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(\s*['"]([^'"]*)['"]\s*\)((?:\s*\.substring\(\s*\d+\s*\))*)/g;
  const links = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    let tail = m[2];
    const cuts = m[3].match(/\d+/g) || [];
    for (let i = 0; i < cuts.length; i++) tail = tail.substring(Number(cuts[i]));
    const head = m[1];
    links.push((head.indexOf("//") === 0 ? "https:" : "") + head + tail);
  }
  if (links.length === 0) throw new Error("streamtape: no link in embed");
  let lastErr;
  for (const link of links.slice(0, 3)) {
    try {
      const v = await checkVideo(link, { "User-Agent": BROWSER_UA });
      return { url: v.url || link, hls: false, headers: { "User-Agent": BROWSER_UA } };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("streamtape: no working link");
}

// --- AES-128-CBC en JS puro (UPNShare contesta con hex de un JSON cifrado) -----------------------
const AES_SBOX_HEX = "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16";
const AES_SBOX = new Uint8Array(256);
const AES_INV = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  AES_SBOX[i] = parseInt(AES_SBOX_HEX.substr(i * 2, 2), 16);
  AES_INV[AES_SBOX[i]] = i;
}
function aesMul(a, b) {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
    b >>= 1;
  }
  return p;
}
const AES_M9 = new Uint8Array(256), AES_M11 = new Uint8Array(256), AES_M13 = new Uint8Array(256), AES_M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  AES_M9[i] = aesMul(i, 9);
  AES_M11[i] = aesMul(i, 11);
  AES_M13[i] = aesMul(i, 13);
  AES_M14[i] = aesMul(i, 14);
}
function aesExpandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      const x = t0;
      t0 = AES_SBOX[t1] ^ rcon;
      t1 = AES_SBOX[t2];
      t2 = AES_SBOX[t3];
      t3 = AES_SBOX[x];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}
function aesDecryptBlock(w, input, out) {
  const s = new Uint8Array(16);
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ w[160 + i];
  for (let round = 9; round >= 0; round--) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[((c + r) % 4) * 4 + r] = s[c * 4 + r];
    for (let i = 0; i < 16; i++) s[i] = AES_INV[t[i]] ^ w[round * 16 + i];
    if (round > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = AES_M14[a0] ^ AES_M11[a1] ^ AES_M13[a2] ^ AES_M9[a3];
        s[c * 4 + 1] = AES_M9[a0] ^ AES_M14[a1] ^ AES_M11[a2] ^ AES_M13[a3];
        s[c * 4 + 2] = AES_M13[a0] ^ AES_M9[a1] ^ AES_M14[a2] ^ AES_M11[a3];
        s[c * 4 + 3] = AES_M11[a0] ^ AES_M13[a1] ^ AES_M9[a2] ^ AES_M14[a3];
      }
    }
  }
  out.set(s);
}
function strBytes(str) {
  const u = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255;
  return u;
}
// hex de entrada -> texto de salida; key e iv son textos de 16 caracteres.
function aesCbcDecryptHex(hex, keyText, ivText) {
  const clean = String(hex).trim();
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 32 !== 0) throw new Error("not AES-CBC hex");
  const data = new Uint8Array(clean.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = parseInt(clean.substr(i * 2, 2), 16);
  const w = aesExpandKey(strBytes(keyText));
  let prev = strBytes(ivText);
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    aesDecryptBlock(w, data.subarray(off, off + 16), block);
    for (let i = 0; i < 16; i++) out[off + i] = block[i] ^ prev[i];
    prev = data.subarray(off, off + 16);
  }
  const pad = out[out.length - 1];
  const end = pad >= 1 && pad <= 16 ? out.length - pad : out.length;
  return new TextDecoder().decode(out.subarray(0, end));
}

// UPNShare: /api/v1/video devuelve la config del reproductor cifrada con una clave fija.
// Dentro: "cfNative" (lista servida por el host del reproductor) y "source" (la misma en una IP).
const UPN_KEY = "kiemtienmua911ca";
const UPN_IV = "1234567890oiuytr";
async function fromUpnShare(embedUrl) {
  const id = (String(embedUrl).split("#")[1] || "").replace(/^\//, "");
  const om = String(embedUrl).match(/^https?:\/\/[^\/#?]+/);
  if (!id || !om) throw new Error("upnshare: bad embed url");
  const origin = om[0];
  const headers = { Referer: origin + "/", "User-Agent": BROWSER_UA };
  const api = origin + "/api/v1/video?id=" + encodeURIComponent(id) + "&w=1920&h=1080&r=" + encodeURIComponent(BASE + "/");
  const r = await kfetch(api, { headers: headers });
  if (!r.ok) throw new Error("upnshare api HTTP " + r.status);
  let info;
  try {
    info = JSON.parse(aesCbcDecryptHex(await r.text(), UPN_KEY, UPN_IV));
  } catch (e) {
    throw new Error("upnshare: cannot read reply (" + (e && e.message) + ")");
  }
  const candidates = [info.cfNative, info.source]
    .filter(function (s) { return typeof s === "string" && s; })
    .map(function (s) { return resolveUrl(origin + "/", s); });
  if (candidates.length === 0) throw new Error("upnshare: no playlist in reply");
  let lastErr;
  for (const url of candidates) {
    try {
      await checkHls(url, headers);
      return { url: url, hls: true, headers: headers };
    } catch (e) {
      lastErr = e;
      log("upnshare candidate failed:", e && e.message);
    }
  }
  throw lastErr || new Error("upnshare: no playable link");
}

const RESOLVERS = {
  Voe: fromVoe,
  MP4Upload: fromMp4Upload,
  YourUpload: fromYourUpload,
  StreamTape: fromStreamTape,
  UPNShare: fromUpnShare,
};

const QUALITY_HINT = {
  Voe: "720p",
  UPNShare: "1080p",
  MP4Upload: "1080p AV1",
  YourUpload: "MP4",
  StreamTape: "MP4",
};

const LANG_LABEL = { DUB: "Latino", SUB: "Subtitulado" };

// ---------------------------------------------------------------------------------------------
// Preferencias (la app guarda el texto de la opción elegida)

// Grupos de idiomas, en orden: el siguiente grupo solo se prueba si el anterior no dio nada.
function languageGroups() {
  const v = cfg("idioma").toLowerCase();
  if (v.indexOf("solo latino") >= 0) return [["DUB"]];
  if (v.indexOf("solo sub") >= 0) return [["SUB"]];
  return [["DUB"], ["SUB"]];
}

const DEFAULT_ORDER = ["Voe", "UPNShare", "MP4Upload", "YourUpload", "StreamTape"];

function serverOrder() {
  const v = cfg("servidor").toLowerCase();
  let first = null;
  for (let i = 0; i < DEFAULT_ORDER.length; i++) {
    if (v.indexOf(DEFAULT_ORDER[i].toLowerCase()) === 0) first = DEFAULT_ORDER[i];
  }
  return first ? [first].concat(DEFAULT_ORDER.filter(function (s) { return s !== first; })) : DEFAULT_ORDER;
}

// ---------------------------------------------------------------------------------------------
// Streams

const RESOLVE_BUDGET_MS = 25000; // tope total
const GRACE_MS = 4000; // tras el primer servidor bueno se espera un poco a los demás

// Resuelve en paralelo todos los embeds; devuelve en cuanto hay uno bueno + un margen corto.
function resolveAll(jobs) {
  return new Promise(function (resolve) {
    const results = [];
    const failures = [];
    let pending = jobs.length;
    let done = false;
    let graceStarted = false;
    function finish() {
      if (done) return;
      done = true;
      resolve({ results: results.slice(), failures: failures.slice() });
    }
    if (pending === 0) return finish();
    setTimeout(finish, RESOLVE_BUDGET_MS);
    jobs.forEach(function (job) {
      job().then(
        function (r) {
          results.push(r);
          if (!graceStarted) {
            graceStarted = true;
            setTimeout(finish, GRACE_MS);
          }
        },
        function (e) {
          failures.push(e && e.message ? e.message : String(e));
        }
      ).then(function () {
        pending--;
        if (pending === 0) finish();
      });
    });
  });
}

async function embedsFor(slug, number) {
  let data;
  try {
    data = await loadData("/media/" + slug + "/" + number, "streams");
  } catch (e) {
    // Una película (slug solo) puede no tener episodio "1": usar el primero que liste el sitio.
    if (number !== "1") throw e;
    const media = (await loadData("/media/" + slug, "streams")).media || {};
    const nums = (media.episodes || [])
      .map(function (x) { return Number(x && x.number); })
      .filter(function (n) { return n >= 0; });
    if (nums.length === 0) throw e;
    number = String(Math.min.apply(null, nums));
    data = await loadData("/media/" + slug + "/" + number, "streams");
  }
  return { embeds: data.embeds || {}, number: number };
}

async function getStreams(id, type, season, episode) {
  const parts = String(id).split("/");
  const slug = parts[0];
  const number = String(episode != null ? episode : parts[1] || "1");

  const found = await embedsFor(slug, number);
  const embeds = found.embeds;
  const order = serverOrder();
  const groups = languageGroups();
  const allFailures = [];

  for (const group of groups) {
    const jobs = [];
    for (const lang of group) {
      const list = (embeds[lang] || []).filter(function (e) { return e && e.url && RESOLVERS[e.server]; });
      list.sort(function (a, b) { return order.indexOf(a.server) - order.indexOf(b.server); });
      for (const e of list) {
        jobs.push(function () {
          return RESOLVERS[e.server](e.url).then(function (r) {
            return {
              url: r.url,
              name: e.server,
              quality: QUALITY_HINT[e.server],
              language: LANG_LABEL[lang] || lang,
              provider: "AnimeAV1",
              headers: r.headers || {},
              isHls: !!r.hls,
              _rank: order.indexOf(e.server),
            };
          }).catch(function (err) {
            log(lang, e.server, "failed:", err && err.message);
            throw new Error(lang + "/" + e.server + ": " + (err && err.message));
          });
        });
      }
    }
    const res = await resolveAll(jobs);
    res.failures.forEach(function (f) { allFailures.push(f); });
    if (res.results.length) {
      res.results.sort(function (a, b) { return a._rank - b._rank; });
      return res.results.map(function (r) {
        delete r._rank;
        return r;
      });
    }
  }

  const offered = Object.keys(embeds).filter(function (k) { return (embeds[k] || []).length; }).join(", ") || "ninguno";
  log("sin streams para", slug, number, "| ofrece:", offered, "|", allFailures.join("; "));
  return [];
}

// ---------------------------------------------------------------------------------------------

module.exports = {
  getHome: getHome,
  getCatalogs: getCatalogs,
  getCatalog: getCatalog,
  getDiscoverFilters: getDiscoverFilters,
  getDiscover: getDiscover,
  search: search,
  getMeta: getMeta,
  getStreams: getStreams,
};
