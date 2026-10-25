// AnimeAV1 para tu app — v2.0.0
// Port del plugin Kino v1.6.1 al runtime CommonJS de la app (flutter_js / QuickJS).
//
// Qué cambió respecto a Kino (la lógica de datos y de servidores es la misma):
//  - En vez de `export async function ...` + `kino.fetch`, el plugin usa `module.exports` y el
//    `fetch` global que la app puentea a Dart (sigue redirects, devuelve status/headers/body texto).
//  - La app llama: getHome(), getDiscoverFilters(f), getDiscover({page,...}), search(q),
//    getMeta(id), getStreams(id, type, season, episode), getCatalogs(), getCatalog(id,{page}).
//    El `id` de cada item es el slug de animeav1 ("one-piece"); el de cada episodio "slug/N".
//  - getStreams devuelve TODOS los servidores que funcionan (la app deja cambiar de servidor en
//    el reproductor), ordenados: idioma primero, luego el servidor preferido de Configurar.
//  - La app guarda los <select> de Configurar con el TEXTO de la opción, no con un "value";
//    por eso la configuración se interpreta por texto (ver cfgIdioma / cfgServidor).
//  - Sin descargas con Range: el puente de la app lee el cuerpo completo en memoria, así que los
//    enlaces mp4 se verifican con HEAD y StreamTape con un redirect manual (nunca se baja el video).
//
// Los datos salen de los endpoints `__data.json` de SvelteKit (el mismo payload con el que el sitio
// hidrata sus páginas), no de HTML, así que un cambio de diseño no rompe el plugin.

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";
const ADDON_ID = "animeav1";
const PROVIDER = "AnimeAV1";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SEARCH_PAGES = 3; // páginas de resultados que se piden por búsqueda
const HOME_ROW_LIMIT = 30; // items por fila del inicio (el inicio se cachea 24 h en la app)
const PAGE_LIMIT = 60; // items máximos por página en Descubrir / Categorías
const REQUEST_MS = 15000; // tope por petición
const SERVER_MS = 18000; // tope por servidor al resolver video
const MEMO_MS = 10 * 60 * 1000; // caché en memoria de páginas de catálogo

// ---------------------------------------------------------------------------------------------
// Utilidades

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const t = setTimeout(function () {
      if (!done) {
        done = true;
        reject(new Error((label || "operación") + ": tiempo agotado (" + ms + " ms)"));
      }
    }, ms);
    promise.then(
      function (v) {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      function (e) {
        if (!done) {
          done = true;
          clearTimeout(t);
          reject(e);
        }
      }
    );
  });
}

function http(url, opts, ms) {
  return withTimeout(fetch(url, opts || {}), ms || REQUEST_MS, "fetch");
}

const memoStore = {};
function memo(key, ttl, fn) {
  const hit = memoStore[key];
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = Promise.resolve().then(fn);
  memoStore[key] = { t: Date.now(), p: p };
  p.catch(function () {
    if (memoStore[key] && memoStore[key].p === p) delete memoStore[key];
  });
  return p;
}

function dedupe(items) {
  const seen = {};
  return items.filter(function (it) {
    if (seen[it.id]) return false;
    seen[it.id] = true;
    return true;
  });
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).href;
  } catch (_) {
    return rel;
  }
}

function decodeEscapes(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    })
    .replace(/\\\//g, "/");
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// ---------------------------------------------------------------------------------------------
// Configuración (Configurar → Idioma / Servidor preferido)
// La app guarda el texto de la opción elegida; también se aceptan los valores internos.

function cfg(key) {
  try {
    const all = globalThis.__nuvioConfig;
    const mine = all && all[ADDON_ID];
    const v = mine && mine[key];
    return v == null ? "" : String(v).trim().toLowerCase();
  } catch (_) {
    return "";
  }
}

function cfgIdioma() {
  const v = cfg("idioma");
  if (v === "dub" || v.indexOf("solo latino") === 0) return "dub";
  if (v === "sub" || v.indexOf("solo sub") === 0) return "sub";
  return "dub-sub"; // por defecto: latino, o subtitulado si no hay
}

function languagesToTry() {
  const m = cfgIdioma();
  if (m === "sub") return ["SUB"];
  if (m === "dub") return ["DUB"];
  return ["DUB", "SUB"];
}

const DEFAULT_ORDER = ["Voe", "UPNShare", "MP4Upload", "YourUpload", "StreamTape"];

function cfgServidor() {
  const v = cfg("servidor");
  if (v.indexOf("upnshare") >= 0) return "UPNShare";
  if (v.indexOf("mp4upload") >= 0) return "MP4Upload";
  if (v.indexOf("yourupload") >= 0) return "YourUpload";
  if (v.indexOf("streamtape") >= 0) return "StreamTape";
  if (v.indexOf("voe") >= 0) return "Voe";
  return "Voe";
}

// Voe primero (H.264 720p reproduce en cualquier TV), luego UPNShare (H.264 hasta 1080p) y al final
// los mp4 planos (AV1, se traban en muchas TV). Lo elegido en Configurar va primero.
function serverOrder() {
  const first = cfgServidor();
  return [first].concat(
    DEFAULT_ORDER.filter(function (s) {
      return s !== first;
    })
  );
}

// ---------------------------------------------------------------------------------------------
// Datos de SvelteKit

// Reconstruye el arreglo "aplanado" (devalue) que traen los nodos de `__data.json`.
function unflatten(flat) {
  const cache = new Map();
  function get(i) {
    if (typeof i !== "number" || i < 0) return undefined;
    if (cache.has(i)) return cache.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      // Un valor tipado (["Date", "..."], ["Map", ...]) empieza con una etiqueta de texto.
      if (typeof v[0] === "string") {
        cache.set(i, v[1]);
        return v[1];
      }
      const out = [];
      cache.set(i, out);
      for (let k = 0; k < v.length; k++) out.push(get(v[k]));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      cache.set(i, out);
      const keys = Object.keys(v);
      for (let k = 0; k < keys.length; k++) out[keys[k]] = get(v[keys[k]]);
      return out;
    }
    cache.set(i, v);
    return v;
  }
  return get(0);
}

function lastDataNode(body) {
  const nodes = (body.nodes || []).filter(function (n) {
    return n && n.type === "data" && Array.isArray(n.data);
  });
  return nodes.length ? unflatten(nodes[nodes.length - 1].data) : null;
}

async function loadData(path, what) {
  const r = await http(BASE + path + "/__data.json", { headers: { Accept: "application/json" } });
  if (r.status === 404) throw new Error(what + ": no encontrado (" + path + ")");
  if (r.status === 429) throw new Error(what + ": demasiadas peticiones (HTTP 429)");
  if (!r.ok) throw new Error(what + ": HTTP " + r.status);
  const body = await r.json();
  if (body.type === "redirect" || body.type === "error") {
    throw new Error(what + ": " + body.type + " " + path);
  }
  // El nodo de la página es el último con datos; los anteriores son layouts (menús, sesión).
  const data = lastDataNode(body);
  if (!data) throw new Error(what + ": __data.json vacío");
  return data;
}

// ---------------------------------------------------------------------------------------------
// Items

function isMovie(media) {
  const c = media.category || {};
  return c.slug === "pelicula" || c.malId === "Movie";
}

function toItem(media, full) {
  const id = String(media.id);
  const item = {
    id: String(media.slug), // la app usa este id para getMeta / getStreams / favoritos
    title: String(media.title),
    poster: CDN + "/covers/" + id + ".jpg",
    backdrop: CDN + "/backdrops/" + id + ".jpg",
    type: isMovie(media) ? "movie" : "series",
    genres: ["Anime"],
  };
  if (media.synopsis) {
    const s = String(media.synopsis).trim();
    item.overview = full ? s : s.slice(0, 400);
  }
  const year = String(media.startDate || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) item.year = year;
  return item;
}

// ---------------------------------------------------------------------------------------------
// Catálogo (filtros del sitio: page, order, status, genre, category, search)
// Los VALORES aceptados de order/status/category no están documentados: se prueban varios y se
// queda el primero que de verdad cambia los resultados. Una fila que falle no rompe las demás.

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
  const r = await http(BASE + "/catalogo/__data.json" + (qs ? "?" + qs : ""), {
    headers: { Accept: "application/json" },
  });
  if (r.status === 429) throw new Error("catálogo: demasiadas peticiones (HTTP 429)");
  if (!r.ok) throw new Error("catálogo: HTTP " + r.status);
  const body = await r.json();
  const data = lastDataNode(body) || {};
  const raw = (data.results || []).filter(function (m) {
    return m && m.id != null && m.slug && m.title;
  });
  return {
    raw: raw,
    items: raw.map(function (m) {
      return toItem(m);
    }),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
    orderKey: data.orderKey,
  };
}

// Ids de los primeros resultados del catálogo sin filtrar (referencia para detectar filtros que sí funcionan).
function baseline() {
  return memo("baseline", MEMO_MS, async function () {
    const b = await loadCatalog({}, 1);
    return b.raw
      .slice(0, 10)
      .map(function (m) {
        return m.id;
      })
      .join(",");
  });
}

// Prueba cada candidato; devuelve el primero cuyos resultados difieren del catálogo sin filtrar.
async function pickParams(candidates) {
  const base = await baseline();
  for (let i = 0; i < candidates.length; i++) {
    try {
      const res = await loadCatalog(candidates[i], 1);
      const ids = res.raw
        .slice(0, 10)
        .map(function (m) {
          return m.id;
        })
        .join(",");
      if (res.raw.length > 0 && (ids !== base || (res.orderKey && res.orderKey !== "default"))) {
        return candidates[i];
      }
    } catch (_) {}
  }
  return null;
}

const paramsCache = {};
// ref: "ord" | "emi" | "peli" | "gen:<slug>"  (el resultado correcto se recuerda mientras la app viva)
async function paramsFor(ref) {
  if (ref.indexOf("gen:") === 0) return { genre: ref.slice(4) };
  if (paramsCache[ref]) return paramsCache[ref];
  let p = null;
  if (ref === "ord") {
    p = await pickParams(
      ORDER_CANDIDATES.map(function (o) {
        return { order: o };
      })
    );
  } else if (ref === "emi") {
    p = await pickParams(
      STATUS_CANDIDATES.map(function (s) {
        return { status: s };
      })
    );
  } else if (ref === "peli") {
    p = await pickParams(
      MOVIE_CANDIDATES.map(function (c) {
        return { category: c };
      })
    );
  }
  if (p) paramsCache[ref] = p;
  return p;
}

function loadHome() {
  return memo("home", MEMO_MS, function () {
    return loadData("", "inicio");
  });
}

async function latestEpisodeItems() {
  const d = await loadHome();
  return dedupe(
    (d.latestEpisodes || []).map(function (e) {
      const m = e && e.media;
      if (!m || m.id == null || !m.slug || !m.title) return null;
      const it = toItem(m);
      if (e.number != null) {
        it.badge = "EP " + e.number;
        it.backdrop = CDN + "/screenshots/" + m.id + "/" + e.number + ".jpg";
      }
      return it;
    }).filter(Boolean)
  );
}

// Una página de una lista con nombre ("emi", "eps", "ord", "peli", "serie", "gen:<slug>").
function catalogPage(ref, page) {
  return memo("cat:" + ref + ":" + page, MEMO_MS, async function () {
    if (ref === "eps") {
      return { items: await latestEpisodeItems(), totalPages: 1 };
    }
    if (ref === "serie") {
      const res = await loadCatalog({}, page);
      return {
        items: res.raw
          .filter(function (m) {
            return !isMovie(m);
          })
          .map(function (m) {
            return toItem(m);
          }),
        totalPages: res.totalPages,
      };
    }
    const p = await paramsFor(ref);
    if (!p) {
      // Sin filtro de "en emisión" en el sitio: lo que recibió episodio hace poco está en emisión.
      if (ref === "emi") return { items: await latestEpisodeItems(), totalPages: 1 };
      throw new Error("filtro no soportado: " + ref);
    }
    const res = await loadCatalog(p, page);
    return { items: res.items, totalPages: res.totalPages };
  });
}

// Conserva solo backdrops que existen y los pone primero (la app usa el primero como portada de
// cada categoría y de cada banner). Si ninguno existe, el primero usa su póster.
const backdropOk = {};
function hasBackdrop(it) {
  if (!it.backdrop) return Promise.resolve(false);
  if (!backdropOk[it.backdrop]) {
    backdropOk[it.backdrop] = http(it.backdrop, { method: "HEAD" }, 8000).then(
      function (r) {
        return !!r.ok;
      },
      function () {
        return false;
      }
    );
  }
  return backdropOk[it.backdrop];
}

async function withVerifiedBackdrops(items, n) {
  const head = items.slice(0, n);
  const checks = await Promise.all(head.map(hasBackdrop));
  const good = [];
  const rest = [];
  head.forEach(function (it, i) {
    if (checks[i]) good.push(it);
    else {
      const copy = Object.assign({}, it);
      delete copy.backdrop;
      rest.push(copy);
    }
  });
  const out = good.concat(rest, items.slice(n));
  if (good.length === 0 && out.length > 0 && out[0].poster) {
    out[0] = Object.assign({}, out[0], { backdrop: out[0].poster });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Inicio y categorías

const CATALOG_DEFS = [
  ["emi", "En emisión"],
  ["ord", "Populares"],
  ["peli", "Películas"],
  ["serie", "Series"],
  ["eps", "Últimos episodios"],
].concat(
  GENEROS.map(function (g) {
    return ["gen:" + g[0], g[1]];
  })
);

async function catalogTile(def) {
  try {
    const res = await catalogPage(def[0], 1);
    if (!res.items.length) return null;
    const items = await withVerifiedBackdrops(res.items, 4);
    const first = items[0];
    return {
      id: def[0],
      title: def[1],
      type: "catalog",
      poster: first.poster,
      backdrop: first.backdrop || first.poster,
    };
  } catch (_) {
    return null;
  }
}

function catalogTiles(defs) {
  const key = "tiles:" + defs.map(function (d) { return d[0]; }).join(",");
  return memo(key, MEMO_MS, async function () {
    const tiles = await Promise.all(defs.map(catalogTile));
    return tiles.filter(Boolean);
  });
}

async function buildRow(def) {
  // def: [id, título, ref, estilo de imagen]
  let items = [];
  try {
    items = (await catalogPage(def[2], 1)).items;
  } catch (_) {}
  if (!items.length) return null;
  return {
    id: def[0],
    title: def[1],
    type: "row",
    imageStyle: def[3],
    items: items.slice(0, HOME_ROW_LIMIT),
  };
}

async function getHome() {
  const defs = [
    ["emi", "En emisión", "emi", "backdrop"],
    ["eps", "Últimos episodios", "eps", "backdrop"],
    ["ord", "Populares", "ord", "poster"],
    ["peli", "Películas", "peli", "poster"],
    ["serie", "Series", "serie", "poster"],
  ];
  const built = await Promise.all(defs.map(buildRow));
  const rows = built.filter(Boolean);

  if (rows.length) {
    // La primera fila es el banner grande: backdrops verificados primero.
    try {
      rows[0].items = (await withVerifiedBackdrops(rows[0].items, 8)).slice(0, 10);
    } catch (_) {}
    rows[0].type = "hero";
  }

  const tiles = await catalogTiles(
    GENEROS.map(function (g) {
      return ["gen:" + g[0], g[1]];
    })
  );
  if (tiles.length) {
    rows.push({ id: "categorias", title: "Categorías", type: "catalog", imageStyle: "backdrop", items: tiles });
  }

  if (rows.length === 0) throw new Error("inicio: no se pudo armar ninguna fila");
  return { rows: rows };
}

async function getCatalogs() {
  return { catalogs: await catalogTiles(CATALOG_DEFS) };
}

async function getCatalog(catalogId, opts) {
  const page = Math.max(1, parseInt(opts && opts.page, 10) || 1);
  const res = await catalogPage(String(catalogId), page);
  return {
    items: dedupe(res.items).slice(0, PAGE_LIMIT),
    hasMore: page < res.totalPages,
    page: page,
  };
}

// ---------------------------------------------------------------------------------------------
// Descubrir (filtros: Género, Tipo, Orden)

const TIPO_OPTIONS = [
  { id: "all", label: "Todos" },
  { id: "series", label: "Series" },
  { id: "peliculas", label: "Películas" },
];
const ORDEN_OPTIONS = [
  { id: "recientes", label: "Recientes" },
  { id: "populares", label: "Populares" },
  { id: "emision", label: "En emisión" },
];

async function getDiscoverFilters() {
  return [
    {
      id: "genero",
      label: "Género",
      options: [{ id: "all", label: "Todos" }].concat(
        GENEROS.map(function (g) {
          return { id: g[0], label: g[1] };
        })
      ),
    },
    { id: "tipo", label: "Tipo", options: TIPO_OPTIONS },
    { id: "orden", label: "Orden", options: ORDEN_OPTIONS },
  ];
}

async function getDiscover(opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const genero = String(opts.genero || opts.genre || opts.filter || "all");
  const tipo = String(opts.tipo || "all");
  const orden = String(opts.orden || "recientes");

  const params = {};
  if (genero && genero !== "all") params.genre = genero;
  if (tipo === "peliculas") {
    const p = await paramsFor("peli");
    if (p) Object.assign(params, p);
  }
  if (orden === "populares") {
    const p = await paramsFor("ord");
    if (p) Object.assign(params, p);
  } else if (orden === "emision") {
    const p = await paramsFor("emi");
    if (p) Object.assign(params, p);
  }

  // "Series" se filtra aquí (el sitio no tiene un valor fiable de categoría para series). Si una
  // página queda vacía al filtrar, se sigue con la siguiente para no cortar el scroll infinito.
  let cur = page;
  let res = await loadCatalog(params, cur);
  let items = res.raw;
  if (tipo === "series") {
    items = items.filter(function (m) {
      return !isMovie(m);
    });
    let guard = 0;
    while (items.length === 0 && cur < res.totalPages && guard < 3) {
      cur++;
      guard++;
      res = await loadCatalog(params, cur);
      items = res.raw.filter(function (m) {
        return !isMovie(m);
      });
    }
  }
  const list = dedupe(
    items.map(function (m) {
      return toItem(m);
    })
  ).slice(0, PAGE_LIMIT);
  return { items: list, hasMore: cur < res.totalPages, page: page };
}

// ---------------------------------------------------------------------------------------------
// Búsqueda

async function loadSearch(enc, page) {
  const r = await http(BASE + "/catalogo/__data.json?search=" + enc + (page > 1 ? "&page=" + page : ""), {
    headers: { Accept: "application/json" },
  });
  if (r.status === 429) throw new Error("búsqueda: demasiadas peticiones (HTTP 429)");
  if (!r.ok) throw new Error("búsqueda: HTTP " + r.status);
  const body = await r.json();
  const data = lastDataNode(body) || {};
  return {
    items: (data.results || [])
      .filter(function (m) {
        return m && m.id != null && m.slug && m.title;
      })
      .map(function (m) {
        return toItem(m);
      }),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
  };
}

async function searchOnce(q) {
  const enc = encodeURIComponent(q).replace(/%20/g, "+");
  const first = await loadSearch(enc, 1);
  let items = first.items.slice();
  const pages = Math.min(first.totalPages, SEARCH_PAGES);
  const more = [];
  for (let p = 2; p <= pages; p++) more.push(loadSearch(enc, p).then(function (x) { return x.items; }, function () { return []; }));
  const extra = await Promise.all(more);
  extra.forEach(function (list) {
    items = items.concat(list);
  });
  return items;
}

async function search(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const tries = [q];
  const plain = q.replace(/[:;,.!?¡¿"'()\[\]\-–—_\/\\]+/g, " ").replace(/\s+/g, " ").trim();
  if (plain && plain !== q) tries.push(plain);
  for (let i = 0; i < tries.length; i++) {
    const items = await searchOnce(tries[i]);
    if (items.length) return dedupe(items).slice(0, 100);
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Detalle y episodios

function genresOf(media) {
  const g = media.genres;
  if (Array.isArray(g) && g.length) {
    const out = g
      .map(function (x) {
        if (typeof x === "string") return x;
        return x && (x.name || x.title || x.slug) ? String(x.name || x.title || x.slug) : "";
      })
      .filter(Boolean);
    if (out.length) return out;
  }
  return ["Anime"];
}

async function getMeta(id) {
  const slug = String(id).split("/")[0];
  const data = await loadData("/media/" + slug, "detalle");
  const media = data.media;
  if (!media) throw new Error("detalle: sin datos para " + slug);

  const item = toItem(media, true);
  item.genres = genresOf(media);
  const score = Number(media.score);
  if (isFinite(score) && score > 0 && score <= 10) item.rating = score;

  if (item.type === "movie") return item;

  const mid = String(media.id);
  const seen = {};
  const nums = (media.episodes || [])
    .map(function (e) {
      return Number(e && e.number);
    })
    .filter(function (n) {
      if (!isFinite(n) || Math.floor(n) !== n || n < 1 || seen[n]) return false;
      seen[n] = true;
      return true;
    })
    .sort(function (a, b) {
      return a - b;
    });
  if (nums.length === 0) throw new Error("detalle: " + slug + " no tiene episodios");

  item.seasons = [
    {
      number: 1,
      name: "Episodios",
      episodes: nums.map(function (n) {
        return {
          number: n,
          id: slug + "/" + n, // la app lo reenvía a getStreams al pasar al siguiente episodio
          title: "Episodio " + n,
          still: CDN + "/screenshots/" + mid + "/" + n + ".jpg",
        };
      }),
    },
  ];
  return item;
}

// ---------------------------------------------------------------------------------------------
// Servidores de video

// MP4Upload: un mp4 progresivo (hoy AV1 10-bit 1080p) en hosts que solo contestan con el Referer del sitio.
async function fromMp4Upload(embedUrl) {
  const r = await http(embedUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!r.ok) throw new Error("mp4upload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
    html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+)["']/i) ||
    html.match(/<source[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("mp4upload: no hay video en el embed");
  return {
    url: decodeEscapes(m[1]),
    isHls: false,
    quality: "1080p",
    headers: { Referer: "https://www.mp4upload.com/", "User-Agent": BROWSER_UA },
  };
}

// Voe esconde sus fuentes en un texto JSON: rot13, marcas basura, base64, desplazamiento de -3,
// reverso y base64 otra vez.
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
  // Páginas viejas de Voe.
  const hls = html.match(/["']hls["']\s*:\s*["']([^"']+)["']/);
  if (hls) {
    const v = hls[1];
    return v.indexOf("http") === 0 ? v : atob(v);
  }
  return null;
}

// Voe: voe.sx contesta con una redirección JS a un dominio espejo que rota; el espejo tiene el
// reproductor. El HLS vive en un CDN cuyo dominio también rota.
async function fromVoe(embedUrl) {
  let url = embedUrl;
  for (let hop = 0; hop < 3; hop++) {
    const r = await http(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!r.ok) throw new Error("voe HTTP " + r.status);
    const html = await r.text();
    const source = voeSourceFrom(html);
    if (source) {
      return { url: source, isHls: true, quality: "720p", headers: { "User-Agent": BROWSER_UA } };
    }
    const next = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (!next) break;
    url = next[1];
  }
  throw new Error("voe: no hay fuente en la página");
}

// Un enlace mp4 es bueno si el servidor contesta un HEAD sin error (405/501 = no soporta HEAD).
async function checkVideo(url, headers) {
  const r = await http(url, { method: "HEAD", headers: headers }, 8000);
  if (r.status >= 400 && r.status !== 405 && r.status !== 501) throw new Error("HTTP " + r.status);
  return r;
}

// Un HLS es bueno si carga la lista, y el primer segmento de la primera variante contesta.
// Devuelve la mayor altura anunciada en la lista maestra (para etiquetar la calidad).
async function checkHls(url, headers) {
  const getText = async function (u) {
    const r = await http(u, { headers: headers }, 8000);
    if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
    return r.text();
  };
  const linesOf = function (t) {
    return String(t)
      .split("\n")
      .map(function (l) {
        return l.trim();
      })
      .filter(Boolean);
  };
  let playlistUrl = url;
  let text = await getText(playlistUrl);
  if (text.indexOf("#EXTM3U") === -1) throw new Error("no es una lista HLS");
  let lines = linesOf(text);
  let best = 0;
  if (
    lines.some(function (l) {
      return l.indexOf("#EXT-X-STREAM-INF") === 0;
    })
  ) {
    lines.forEach(function (l) {
      const m = /RESOLUTION=\d+x(\d+)/.exec(l);
      if (m) best = Math.max(best, parseInt(m[1], 10));
    });
    const variant = lines.find(function (l) {
      return l.charAt(0) !== "#";
    });
    if (!variant) throw new Error("lista maestra vacía");
    playlistUrl = resolveUrl(playlistUrl, variant);
    text = await getText(playlistUrl);
    lines = linesOf(text);
  }
  const seg = lines.find(function (l) {
    return l.charAt(0) !== "#";
  });
  if (!seg) throw new Error("la lista no tiene segmentos");
  await checkVideo(resolveUrl(playlistUrl, seg), headers);
  return best;
}

// YourUpload: el embed nombra el mp4 en su meta og:video, y el host del archivo contesta 500
// si la petición no trae el Referer del propio YourUpload.
async function fromYourUpload(embedUrl) {
  const r = await http(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
  if (!r.ok) throw new Error("yourupload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/<meta[^>]+og:video["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+og:video["']/i) ||
    html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("yourupload: no hay video en el embed");
  const url = decodeHtml(decodeEscapes(m[1]));
  const headers = { Referer: "https://www.yourupload.com/", "User-Agent": BROWSER_UA };
  await checkVideo(url, headers);
  return { url: url, isHls: false, quality: null, headers: headers };
}

// StreamTape: el script de la página arma el enlace en dos pedazos
//   el.innerHTML = '//streamtape.com/get_vide' + ('xcdo?id=...&token=...').substring(2).substring(1)
// (en el HTML hay una copia señuelo con el token malo). get_video contesta con una redirección al
// archivo real, firmado para la IP de quien pide; esa dirección final es la que recibe el reproductor.
async function fromStreamTape(embedUrl) {
  const r = await http(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
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
  if (links.length === 0) throw new Error("streamtape: no hay enlace en el embed");
  let lastErr;
  const tries = links.slice(0, 3);
  for (let i = 0; i < tries.length; i++) {
    try {
      // Redirect manual: la app lee el cuerpo completo, así que nunca se sigue hasta el archivo.
      const g = await http(tries[i], { headers: { "User-Agent": BROWSER_UA }, redirect: "manual" }, 10000);
      const loc = g.headers && g.headers.get("location");
      if (g.status >= 300 && g.status < 400 && loc) {
        const finalUrl = resolveUrl(tries[i], loc);
        await checkVideo(finalUrl, { "User-Agent": BROWSER_UA });
        return { url: finalUrl, isHls: false, quality: null, headers: { "User-Agent": BROWSER_UA } };
      }
      throw new Error("sin redirección (HTTP " + g.status + ")");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("streamtape: ningún enlace sirve");
}

// --- AES-128-CBC en JS puro (UPNShare contesta con el hex de un JSON cifrado con AES-CBC) ----------
const AES_SBOX_HEX =
  "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16";
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
const AES_M9 = new Uint8Array(256);
const AES_M11 = new Uint8Array(256);
const AES_M13 = new Uint8Array(256);
const AES_M14 = new Uint8Array(256);
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
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
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
        const a0 = s[c * 4];
        const a1 = s[c * 4 + 1];
        const a2 = s[c * 4 + 2];
        const a3 = s[c * 4 + 3];
        s[c * 4] = AES_M14[a0] ^ AES_M11[a1] ^ AES_M13[a2] ^ AES_M9[a3];
        s[c * 4 + 1] = AES_M9[a0] ^ AES_M14[a1] ^ AES_M11[a2] ^ AES_M13[a3];
        s[c * 4 + 2] = AES_M13[a0] ^ AES_M9[a1] ^ AES_M14[a2] ^ AES_M11[a3];
        s[c * 4 + 3] = AES_M11[a0] ^ AES_M13[a1] ^ AES_M9[a2] ^ AES_M14[a3];
      }
    }
  }
  out.set(s);
}
// hex de entrada -> texto de salida; key e iv son textos de 16 caracteres.
function aesCbcDecryptHex(hex, keyText, ivText) {
  const clean = String(hex).trim();
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 32 !== 0) throw new Error("no es AES-CBC en hex");
  const data = new Uint8Array(clean.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = parseInt(clean.substr(i * 2, 2), 16);
  const keyBytes = new Uint8Array(16);
  const ivBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    keyBytes[i] = keyText.charCodeAt(i);
    ivBytes[i] = ivText.charCodeAt(i);
  }
  const w = aesExpandKey(keyBytes);
  let prev = ivBytes;
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

// UPNShare: /api/v1/video contesta con los ajustes del reproductor, cifrados con una llave fija
// que usa el propio reproductor del sitio. Adentro: "cfNative" (la lista servida por el host del
// reproductor) y "source" (la misma lista en una IP directa). Ambas piden el Referer del reproductor.
const UPN_KEY = "kiemtienmua911ca";
const UPN_IV = "1234567890oiuytr";
async function fromUpnShare(embedUrl) {
  const id = (String(embedUrl).split("#")[1] || "").replace(/^\//, "");
  const om = String(embedUrl).match(/^https?:\/\/[^\/#?]+/);
  if (!id || !om) throw new Error("upnshare: url de embed inválida");
  const origin = om[0];
  const headers = { Referer: origin + "/", "User-Agent": BROWSER_UA };
  const api =
    origin + "/api/v1/video?id=" + encodeURIComponent(id) + "&w=1920&h=1080&r=" + encodeURIComponent(BASE + "/");
  const r = await http(api, { headers: headers });
  if (!r.ok) throw new Error("upnshare api HTTP " + r.status);
  let info;
  try {
    info = JSON.parse(aesCbcDecryptHex(await r.text(), UPN_KEY, UPN_IV));
  } catch (e) {
    throw new Error("upnshare: no se pudo leer la respuesta (" + (e && e.message) + ")");
  }
  const candidates = [info.cfNative, info.source]
    .filter(function (s) {
      return typeof s === "string" && s;
    })
    .map(function (s) {
      return resolveUrl(origin + "/", s);
    });
  if (candidates.length === 0) throw new Error("upnshare: no hay lista en la respuesta");
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const height = await checkHls(candidates[i], headers);
      return { url: candidates[i], isHls: true, quality: height ? height + "p" : null, headers: headers };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("upnshare: ningún enlace reproduce");
}

const RESOLVERS = {
  Voe: fromVoe,
  MP4Upload: fromMp4Upload,
  YourUpload: fromYourUpload,
  StreamTape: fromStreamTape,
  UPNShare: fromUpnShare,
};

// ---------------------------------------------------------------------------------------------
// getStreams(id, type, season, episode)
// `id` puede ser "slug" (la app manda el id de la serie + el número de episodio) o "slug/N"
// (al pasar al siguiente episodio la app manda el id del episodio).

function loadEpisodePage(slug, number) {
  return loadData("/media/" + slug + "/" + number, "episodio");
}

async function getStreams(id, type, season, episode) {
  const parts = String(id || "").split("/");
  const slug = parts[0];
  if (!slug) return [];
  let number = parts[1] || (episode != null && episode !== "" ? String(episode) : "");

  let data;
  if (number) {
    data = await loadEpisodePage(slug, number);
  } else {
    // Película (o llamada sin episodio): usar el primer episodio que liste el sitio.
    const media = (await loadData("/media/" + slug, "episodio")).media || {};
    const nums = (media.episodes || [])
      .map(function (x) {
        return Number(x && x.number);
      })
      .filter(function (n) {
        return isFinite(n) && n >= 0;
      });
    if (nums.length === 0) return [];
    number = String(Math.min.apply(null, nums));
    data = await loadEpisodePage(slug, number);
  }
  const embeds = data.embeds || {};
  const order = serverOrder();
  const langs = languagesToTry();

  for (let li = 0; li < langs.length; li++) {
    const lang = langs[li];
    const list = (embeds[lang] || [])
      .filter(function (e) {
        return e && e.url && RESOLVERS[e.server];
      })
      .sort(function (a, b) {
        return order.indexOf(a.server) - order.indexOf(b.server);
      });
    if (list.length === 0) continue;

    // Todos los servidores del idioma se resuelven a la vez; los que fallen se descartan.
    const resolved = await Promise.all(
      list.map(function (e) {
        return withTimeout(
          Promise.resolve().then(function () {
            return RESOLVERS[e.server](e.url);
          }),
          SERVER_MS,
          e.server
        ).then(
          function (s) {
            return {
              url: s.url,
              name: e.server,
              quality: s.quality || null,
              language: lang === "DUB" ? "Latino" : "Subtitulado",
              provider: PROVIDER,
              headers: s.headers || {},
              isHls: !!s.isHls,
            };
          },
          function () {
            return null;
          }
        );
      })
    );
    const streams = resolved.filter(Boolean);
    // Latino, o subtitulado si no hay: se queda con el primer idioma que dé al menos un servidor.
    if (streams.length) return streams;
  }
  return [];
}

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
