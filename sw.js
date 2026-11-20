/* Entschluesselt das Foliendeck im Browser. Online liegen nur AES-GCM-Bloecke
   unter d/. Der Inhaltsschluessel kommt erst nach dem Passwort hierher. */
const BASIS = new URL("./", self.registration.scope).href;
const DECK = BASIS + "deck/";
const DECK_PFAD = new URL(DECK).pathname;
let cek = null, karte = null;
const merk = new Map(); // entschluesselte Videos, damit Range-Abrufe nicht jedes Mal neu rechnen

function db() {
  return new Promise((ok, nein) => {
    const r = indexedDB.open("kgg-deck", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("k");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => nein(r.error);
  });
}
async function idb(art, wert) {
  const d = await db();
  return new Promise((ok, nein) => {
    const t = d.transaction("k", art === "get" ? "readonly" : "readwrite").objectStore("k");
    const r = art === "get" ? t.get("cek") : art === "del" ? t.delete("cek") : t.put(wert, "cek");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => nein(r.error);
  });
}
async function entschluessle(buf) {
  const b = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, cek, b.slice(12));
}
async function bereit() {
  if (!cek) {
    const roh = await idb("get");
    if (!roh) return false;
    cek = await crypto.subtle.importKey("raw", roh, "AES-GCM", false, ["decrypt"]);
  }
  if (!karte) {
    const a = await fetch(BASIS + "d/karte.dat", { cache: "no-cache" });
    try {
      karte = JSON.parse(new TextDecoder().decode(await entschluessle(await a.arrayBuffer())));
    } catch (e) {
      // Neuer Bau = neuer Schluessel. Alten verwerfen, Passwort neu abfragen.
      cek = null; karte = null; await idb("del");
      return false;
    }
  }
  return true;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  if (e.data && e.data.typ === "schluessel") {
    cek = null; karte = null; merk.clear();
    e.waitUntil(idb("put", e.data.roh).then(() => e.source.postMessage({ typ: "gespeichert" })));
  }
  if (e.data && e.data.typ === "abmelden") {
    cek = null; karte = null; merk.clear();
    e.waitUntil(idb("del").then(() => e.source.postMessage({ typ: "abgemeldet" })));
  }
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(DECK)) return;
  e.respondWith(liefere(e.request));
});

async function liefere(req) {
  const url = new URL(req.url);
  let pfad = decodeURIComponent(url.pathname.slice(DECK_PFAD.length));
  if (pfad === "" || pfad.endsWith("/")) pfad += "index.html";
  if (!(await bereit())) {
    if (req.mode === "navigate") return Response.redirect(BASIS, 302);
    return new Response("gesperrt", { status: 401 });
  }
  const eintrag = karte[pfad];
  if (!eintrag) return new Response("nicht vorhanden", { status: 404 });
  const [name, typ] = eintrag;
  let daten = merk.get(pfad);
  if (!daten) {
    const a = await fetch(BASIS + "d/" + name + ".dat");
    if (!a.ok) return new Response("Ladefehler", { status: 502 });
    daten = await entschluessle(await a.arrayBuffer());
    if (typ.startsWith("video/")) merk.set(pfad, daten);
  }
  const kopf = { "Content-Type": typ, "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
  const bereich = req.headers.get("Range");
  const m = bereich && /bytes=(\d*)-(\d*)/.exec(bereich);
  if (m) {
    const n = daten.byteLength;
    let von = m[1] === "" ? Math.max(0, n - Number(m[2])) : Number(m[1]);
    let bis = m[1] === "" || m[2] === "" ? n - 1 : Math.min(Number(m[2]), n - 1);
    if (von >= n) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + n } });
    kopf["Content-Range"] = `bytes ${von}-${bis}/${n}`;
    kopf["Content-Length"] = String(bis - von + 1);
    return new Response(daten.slice(von, bis + 1), { status: 206, headers: kopf });
  }
  kopf["Content-Length"] = String(daten.byteLength);
  return new Response(daten, { status: 200, headers: kopf });
}
