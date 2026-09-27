// Tahmin motoru — grafik_html.py'deki Python kodunun tarayıcı sürümü.
// Sunucu yok: veriyi doğrudan Binance'in halka açık API'sinden çeker, hesabı burada yapar.
const API = "https://fapi.binance.com";
const MS5 = 300000, MS1 = 60000;
const MIN_BENZER = 30, MIN_GUN = 5, GECMIS_SAAT = 24, MUM1_GUN = 3;
const KESKIN_ORTA = 50, KESKIN_COK = 8;
const KUME_ESIK = 0.006, FIB_SAAT = 48, FIB_ORAN = [0.382, 0.5, 0.618];

async function jget(yol, par = {}) {
  const u = new URL(API + yol);
  Object.entries(par).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`${yol} ${r.status}`);
  return r.json();
}

// Binance tek istekte en fazla 1500 mum verir; aralık bunu aşarsa sayfa sayfa çeker
async function klinesAralik(symbol, interval, bas, son, adimMs) {
  const out = [];
  let t = bas;
  while (t < son) {
    const d = await jget("/fapi/v1/klines", { symbol, interval, startTime: t, limit: 1500 });
    if (!d.length) break;
    for (const x of d) if (x[6] < son) out.push({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[7], kapanis: x[6] });
    t = d[d.length - 1][0] + adimMs;
    if (d.length < 1500) break;
  }
  return out;
}
async function klines(symbol, interval, limit) {
  const d = await jget("/fapi/v1/klines", { symbol, interval, limit });
  return d.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[7], kapanis: x[6] }));
}
const fiyatAl = async symbol => +(await jget("/fapi/v1/ticker/price", { symbol })).price;

// ---------- göstergeler (kod.py ile aynı formüller) ----------
function ema(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i];
  let e = s / n; out[n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(c, n = 14) {                       // Wilder yumuşatması
  const out = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atr(k, n = 14) {
  const out = new Array(k.length).fill(null);
  if (k.length <= n) return out;
  const tr = k.map((x, i) => i === 0 ? x.h - x.l
    : Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)));
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr[i];
  a /= n; out[n] = a;
  for (let i = n + 1; i < k.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}
const medyan = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const yuzdelik = (sirali, q) => sirali.length ? sirali[Math.min(sirali.length - 1, Math.floor(q * sirali.length))] : 0;

// ---------- tahmin motoru ----------
class Tahminci {
  constructor(symbol, ufukDk = 60) {
    this.symbol = symbol;
    this.adim = Math.max(3, Math.floor(ufukDk / 5));
    this.ufuklar = [...new Set([Math.max(1, Math.round(this.adim / 4)), Math.max(1, Math.round(this.adim / 2)), this.adim])].sort((a, b) => a - b);
    this.k = []; this.mum1 = []; this.kayitlar = new Map();
  }

  async veriGuncelle(ilerle) {
    const now = Date.now();
    if (!this.k.length) {
      ilerle && ilerle("60 günlük 5 dakikalık veri indiriliyor…");
      this.k = await klinesAralik(this.symbol, "5m", now - 60 * 86400000, now, MS5);
    } else {
      const yeni = await klinesAralik(this.symbol, "5m", this.k[this.k.length - 1].t - 2 * MS5, now, MS5);
      if (yeni.length) this.k = this.k.filter(x => x.t < yeni[0].t).concat(yeni);
    }
    if (this.k.length < 600) throw new Error("yeterli geçmiş yok");
    if (!this.mum1.length) {
      ilerle && ilerle("3 günlük 1 dakikalık veri indiriliyor…");
      this.mum1 = await klinesAralik(this.symbol, "1m", now - MUM1_GUN * 86400000, now, MS1);
    } else {
      const y = await klinesAralik(this.symbol, "1m", this.mum1[this.mum1.length - 1].t - 2 * MS1, now, MS1);
      if (y.length) this.mum1 = this.mum1.filter(x => x.t < y[0].t).concat(y);
    }
    const sinir = now - MUM1_GUN * 86400000;
    if (this.mum1.length && this.mum1[0].t < sinir) this.mum1 = this.mum1.filter(x => x.t >= sinir);

    ilerle && ilerle("göstergeler hesaplanıyor…");
    const k = this.k, c = k.map(x => x.c);
    this.c = c;
    const rs = rsi(c), e20 = ema(c, 20), e50 = ema(c, 50), at = atr(k, 14);
    const n = k.length;
    this.gecerli = []; this.M60 = []; this.RSI = []; this.TR = []; this.VOL = [];
    for (let i = 0; i < n; i++) {
      this.gecerli.push(i >= 60 && rs[i] !== null && e50[i] !== null && !!at[i]);
      this.M60.push(i >= 12 ? (c[i] / c[i - 12] - 1) * 100 : 0);
      this.RSI.push(rs[i] || 0);
      this.TR.push((e20[i] || 0) > (e50[i] || 0) ? 1 : -1);
      this.VOL.push(at[i] ? at[i] / c[i] * 100 : 0);
    }
    ilerle && ilerle("geçmiş tahminler hesaplanıyor…");
    const ilk = Math.max(200, n - 1 - GECMIS_SAAT * 12 - this.adim);
    for (let m = ilk; m < n; m++) {
      const t = k[m].t;
      if (!this.kayitlar.has(t)) this.kayitlar.set(t, this._tahmin(m));
    }
    const sinirT = k[n - 1].t - (GECMIS_SAAT * 3600000 + this.adim * MS5 + MS5);
    for (const t of [...this.kayitlar.keys()]) if (t < sinirT) this.kayitlar.delete(t);
    this.simdi = this._tahmin(n - 1, true);
    this.kayitlar.set(k[n - 1].t, this.simdi);
  }

  // m. mum kapanışındaki tahmin. Aday anlar sadece m'den önce tamamlanmış olanlar (geleceğe bakmaz).
  _tahmin(m, yollarSakla) {
    const { k, c, gecerli: G, M60: M, RSI: R, TR: T, VOL: V, adim: A } = this;
    const m60 = M[m], r0 = R[m], tr0 = T[m], v0 = V[m];
    const vmin = 0.6 * v0, vmax = 1.6 * v0, mtol = 2.5 * v0;
    const ben = [];
    for (let i = 60; i <= m - A; i++) {
      if (G[i] && T[i] === tr0 && V[i] >= vmin && V[i] <= vmax
          && Math.abs(M[i] - m60) <= mtol && Math.abs(R[i] - r0) <= 10) ben.push(i);
    }
    // her benzer anın yolu, oynaklık oranıyla ölçeklenir (bant kalibrasyonunu düzeltir)
    const yollar = ben.map(i => {
      const s = v0 / V[i], yol = [];
      for (let h = 1; h <= A; h++) yol.push([(c[i + h] / c[i] - 1) * s, (k[i + h].h / c[i] - 1) * s, (k[i + h].l / c[i] - 1) * s]);
      return yol;
    });
    // keskin mod: en yakın k komşu (Lorentzian benzeri mesafe)
    const mesafe = ben.map(i => Math.log1p(Math.abs(M[i] - m60) / Math.max(v0, 1e-9))
      + Math.log1p(Math.abs(R[i] - r0) / 10) + Math.log1p(Math.abs(V[i] / v0 - 1)));
    const sira = ben.map((_, j) => j).sort((a, b) => mesafe[a] - mesafe[b]);
    const yakin = { p50o: sira.slice(0, KESKIN_ORTA), p50k: sira.slice(0, KESKIN_COK) };
    const dagilim = [];
    for (let h = 0; h < A; h++) {
      const g = yollar.map(y => y[h][0]).sort((a, b) => a - b);
      const d = { p10: yuzdelik(g, .1), p25: yuzdelik(g, .25), p50: yuzdelik(g, .5),
                  p75: yuzdelik(g, .75), p90: yuzdelik(g, .9),
                  yuk: g.length ? g.filter(x => x > 0).length / g.length : 0 };
      for (const [ad, js] of Object.entries(yakin)) d[ad] = medyan(js.map(j => yollar[j][h][0]));
      dagilim.push(d);
    }
    const gunler = new Set(ben.map(i => new Date(k[i].t).toISOString().slice(5, 10)));
    return { t: k[m].t, baz: c[m], n: ben.length, gun: gunler.size, m60, rsi: r0, trend: tr0, vol: v0,
             dagilim, yollar: yollarSakla ? yollar : null };
  }

  karne() {
    const idx = new Map(this.k.map((x, j) => [x.t, j]));
    const n = this.k.length, out = {};
    for (const h of this.ufuklar) {
      let top = 0, ic80 = 0, ic50 = 0, yonN = 0, yonOk = 0;
      let hm = 0, hn = 0, ho = 0, hk = 0;
      for (const [t, kay] of this.kayitlar) {
        const m = idx.get(t);
        if (m === undefined || m + h >= n || !yeterli(kay)) continue;
        const gercek = this.c[m + h] / this.c[m] - 1, d = kay.dagilim[h - 1];
        top++;
        if (d.p10 <= gercek && gercek <= d.p90) ic80++;
        if (d.p25 <= gercek && gercek <= d.p75) ic50++;
        if (d.yuk >= .55 || d.yuk <= .45) { yonN++; if ((gercek > 0) === (d.yuk >= .55)) yonOk++; }
        hm += Math.abs(gercek - d.p50); ho += Math.abs(gercek - d.p50o);
        hk += Math.abs(gercek - d.p50k); hn += Math.abs(gercek);
      }
      out[h] = { dk: h * 5, top,
        ic80: top ? 100 * ic80 / top : null, ic50: top ? 100 * ic50 / top : null,
        yon_n: yonN, yon: yonN ? 100 * yonOk / yonN : null,
        hata_model: top ? 100 * hm / top : null, hata_orta: top ? 100 * ho / top : null,
        hata_keskin: top ? 100 * hk / top : null, hata_naif: top ? 100 * hn / top : null };
    }
    return out;
  }
}
const yeterli = kay => kay.n >= MIN_BENZER && kay.gun >= MIN_GUN;

// ---------- destek / direnç ----------
function fibSeviyeleri(cs) {
  cs = cs.slice(-FIB_SAAT);
  if (cs.length < 12) return [];
  let iDip = 0, iTepe = 0;
  cs.forEach((x, j) => { if (x.l < cs[iDip].l) iDip = j; if (x.h > cs[iTepe].h) iTepe = j; });
  const dip = cs[iDip].l, tepe = cs[iTepe].h;
  if (tepe <= dip) return [];
  const yukselis = iDip < iTepe;      // önce dip sonra tepe: geri çekilmeler alttadır
  return FIB_ORAN.map(r => [yukselis ? tepe - (tepe - dip) * r : dip + (tepe - dip) * r, `fib %${(r * 100).toFixed(1)}`]);
}

async function seviyeler(symbol, price) {
  const now = Date.now(), ham = [], kl = {};
  for (const [iv, adet] of [["1h", 170], ["15m", 100], ["5m", 60]]) {
    const cs = (await klines(symbol, iv, adet)).filter(x => x.kapanis < now);
    kl[iv] = cs;
    for (let j = 2; j < cs.length - 2; j++) {
      const komsu = [cs[j - 2], cs[j - 1], cs[j + 1], cs[j + 2]];
      if (cs[j].h > Math.max(...komsu.map(x => x.h))) ham.push([cs[j].h, cs[j].t, iv]);
      if (cs[j].l < Math.min(...komsu.map(x => x.l))) ham.push([cs[j].l, cs[j].t, iv]);
    }
  }
  ham.sort((a, b) => a[0] - b[0]);
  const kumeler = [];
  for (const [fiyat, t, iv] of ham) {
    const son = kumeler[kumeler.length - 1];
    if (son && Math.abs(fiyat / son.ort - 1) <= KUME_ESIK) {
      son.fiyatlar.push(fiyat);
      son.ort = son.fiyatlar.reduce((a, b) => a + b, 0) / son.fiyatlar.length;
      son.son = Math.max(son.son, t); son.iv.add(iv);
    } else kumeler.push({ fiyatlar: [fiyat], ort: fiyat, son: t, iv: new Set([iv]) });
  }
  const saat = ms => new Date(ms).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
  const duzenle = (k, tur) => ({ fiyat: k.ort, tur, test: k.fiyatlar.length, kaynak: [...k.iv].sort().join("+"), son: saat(k.son) });
  const direncler = kumeler.filter(k => k.ort > price).sort((a, b) => a.ort - b.ort).slice(0, 4).map(k => duzenle(k, "direnç"));
  const destekler = kumeler.filter(k => k.ort < price).sort((a, b) => b.ort - a.ort).slice(0, 4).map(k => duzenle(k, "destek"));
  for (const [sv, ad] of fibSeviyeleri(kl["1h"])) {
    const hedef = sv > price ? direncler : destekler, tur = sv > price ? "direnç" : "destek";
    const yakin = hedef.filter(x => Math.abs(x.fiyat / price - 1) <= 0.10);
    if (yakin.length < 3 && Math.abs(sv / price - 1) <= 0.30 && hedef.every(x => Math.abs(sv / x.fiyat - 1) > KUME_ESIK))
      hedef.push({ fiyat: sv, tur, test: 0, kaynak: ad, son: "—" });
  }
  direncler.sort((a, b) => a.fiyat - b.fiyat);
  destekler.sort((a, b) => b.fiyat - a.fiyat);
  return [direncler, destekler];
}

// ---------- ICT katmanı ----------
const KILLZONE = [["Asya", 60, 180], ["Londra", 540, 720], ["NY AM", 840, 1020], ["NY PM", 1230, 1380]];
const EQ_TOL = 0.0015, EQ_GUN = 3;

function ictKatmani(k, tz, gorunenBas, now) {
  const bas = Math.max(0, k.length - EQ_GUN * 288);
  const tepe = [], dip = [];
  for (let j = bas + 2; j < k.length - 2; j++) {
    const p = k[j];
    if (p.h > Math.max(k[j-2].h, k[j-1].h, k[j+1].h, k[j+2].h)) tepe.push([k[j + 2].t + MS5, p.h, p.t]);
    if (p.l < Math.min(k[j-2].l, k[j-1].l, k[j+1].l, k[j+2].l)) dip.push([k[j + 2].t + MS5, p.l, p.t]);
  }
  const havuzlar = (liste, ust) => {
    const out = [];
    for (let a = 0; a < liste.length; a++) {
      for (let b = a + 1; b < Math.min(a + 6, liste.length); b++) {
        if (Math.abs(liste[b][1] / liste[a][1] - 1) <= EQ_TOL) {
          const onay = liste[b][0], seviye = (liste[a][1] + liste[b][1]) / 2;
          const sup = k.find(x => x.t >= onay && (ust ? x.h > seviye : x.l < seviye));
          out.push({ fiyat: seviye, onay, supuruldu: sup ? sup.t : null, tur: ust ? "EQH" : "EQL",
                     uclar: [[liste[a][2], liste[a][1]], [liste[b][2], liste[b][1]]] });
          break;
        }
      }
    }
    const tekil = [];
    for (const x of [...out].sort((p, q) => q.onay - p.onay))
      if (tekil.every(y => Math.abs(x.fiyat / y.fiyat - 1) > EQ_TOL || (x.supuruldu && x.supuruldu < y.onay))) tekil.push(x);
    return tekil.sort((p, q) => p.onay - q.onay);
  };
  let eq = havuzlar(tepe, true).concat(havuzlar(dip, false));
  eq = eq.filter(x => x.supuruldu === null || x.supuruldu >= gorunenBas).slice(-14);
  const supurme = [];
  for (const x of eq) {
    if (!x.supuruldu) continue;
    const i = k.findIndex(c => c.t === x.supuruldu);
    if (i < 0 || k[i].t < now - 86400000) continue;
    const geri = x.tur === "EQH" ? k[i].c < x.fiyat : k[i].c > x.fiyat;
    const ileri = k.slice(i + 1, i + 13);
    const yuk = ileri.length ? (Math.max(...ileri.map(c => c.h)) / k[i].c - 1) * 100 : 0;
    const dus = ileri.length ? (Math.min(...ileri.map(c => c.l)) / k[i].c - 1) * 100 : 0;
    const bekliyor = ileri.length < 12;
    const [lehte, aleyhte] = x.tur === "EQH" ? [-dus, yuk] : [yuk, -dus];
    const z = new Date(k[i].t);
    supurme.push({ saat: (z.toDateString() === new Date().toDateString() ? "" : "dün ") +
                     z.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
                   tur: x.tur, fiyat: x.fiyat, geri, sonra_yuk: yuk, sonra_dus: dus, bekliyor,
                   tuttu: bekliyor || !geri ? null : lehte > aleyhte, zaman: Math.floor(k[i].t / 1000) + tz });
  }
  let acilis = null;
  for (let i = k.length - 1; i >= 0; i--) {
    const z = new Date(k[i].t);
    if (z.getHours() === 7 && z.getMinutes() === 0) {
      acilis = { fiyat: k[i].o, saat: z.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", ""),
                 zaman: Math.floor(k[i].t / 1000) + tz };
      break;
    }
  }
  return {
    eq: eq.map(x => ({ fiyat: x.fiyat, tur: x.tur,
      onay: new Date(x.onay).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
      supuruldu: !!x.supuruldu, bitis: x.supuruldu ? Math.floor(x.supuruldu / 1000) + tz : null,
      uclar: x.uclar.map(([t, p]) => ({ zaman: Math.floor(t / 1000) + tz, fiyat: p })) })),
    killzone: KILLZONE.map(([ad, b, c]) => ({ ad, bas: b, bit: c })),
    supurmeler: supurme.sort((a, b) => a.zaman - b.zaman).slice(-8), gun_acilis: acilis };
}

// ---------- SSL Hybrid + Echo (video sistemi) ----------
const SSL_BAZ = 200, SSL_KANAL = 0.2, ECHO_DEG = 50, ECHO_ILERI = 50, TP_PAY = 0.9;

function wma(x, p) {
  const out = new Array(x.length).fill(NaN);
  const tp = p * (p + 1) / 2;
  for (let i = p - 1; i < x.length; i++) {
    let s = 0;
    for (let j = 0; j < p; j++) s += x[i - p + 1 + j] * (j + 1);
    out[i] = s / tp;
  }
  return out;
}
function hma(x, p) {
  const w = wma(x, Math.floor(p / 2)), w2 = wma(x, p);
  const ara = x.map((_, i) => 2 * w[i] - w2[i]);
  const s = Math.round(Math.sqrt(p));
  const out = new Array(x.length).fill(NaN);
  const gecerliBas = p - 1;
  const parca = wma(ara.slice(gecerliBas), s);
  for (let i = 0; i < parca.length; i++) out[gecerliBas + i] = parca[i];
  return out;
}
function emaDizi(x, p) {
  const out = new Array(x.length); const k = 2 / (p + 1); let e = x[0];
  for (let i = 0; i < x.length; i++) { e = x[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function sslDurum(h, l, c) {
  const baz = hma(c, SSL_BAZ);
  const kanal = emaDizi(h.map((x, i) => x - l[i]), SSL_BAZ).map(x => x * SSL_KANAL);
  const d = c.map((x, i) => isNaN(baz[i]) ? 0 : (x > baz[i] + kanal[i] ? 1 : (x < baz[i] - kanal[i] ? -1 : 0)));
  return [baz, d];
}
// son F kapanışa en çok benzeyen pencereyi hemen öncesindeki L konumda ara, sonrasını şimdiki fiyata ekle
function echoYol(c, m, F = ECHO_ILERI, L = ECHO_DEG) {
  const ref = c.slice(m - F + 1, m + 1);
  const mo = ref.reduce((a, b) => a + b, 0) / F;
  const so = Math.sqrt(ref.reduce((a, b) => a + (b - mo) ** 2, 0) / F) + 1e-12;
  const zr = ref.map(x => (x - mo) / so);
  let enIyi = -2, eIyi = null;
  for (let i = 0; i < L; i++) {
    const e = m - F - i;
    if (e - F + 1 < 0) break;
    const w = c.slice(e - F + 1, e + 1);
    const mw = w.reduce((a, b) => a + b, 0) / F;
    const sw = Math.sqrt(w.reduce((a, b) => a + (b - mw) ** 2, 0) / F) + 1e-12;
    let r = 0;
    for (let j = 0; j < F; j++) r += zr[j] * (w[j] - mw) / sw;
    r /= F;
    if (r > enIyi) { enIyi = r; eIyi = e; }
  }
  if (eIyi === null) return [];
  return c.slice(eIyi + 1, eIyi + F + 1).map(x => c[m] + (x - c[eIyi]));
}
function sslEchoSinyaller(h, l, c, lev, marj = 12, maliyet = 0.0018, mmr = 0.015) {
  const [baz, d] = sslDurum(h, l, c);
  const n = c.length, F = ECHO_ILERI, liqMes = 1 / lev - mmr;
  const out = []; let sonRenk = 0, acikBitis = -1;
  for (let i = Math.max(2 * F + ECHO_DEG + 1, SSL_BAZ + 5); i < n; i++) {
    if (d[i - 1] !== 0) sonRenk = d[i - 1];
    if (d[i] === 0 || sonRenk !== -d[i] || i <= acikBitis) continue;
    const yon = d[i], P = echoYol(c, i);
    if (!P.length) continue;
    let gecerli = Math.sign(P[P.length - 1] - c[i]) === yon;
    let j = 0;
    P.forEach((v, q) => { if (v * yon > P[j] * yon) j = q; });
    const tp = c[i] + TP_PAY * (P[j] - c[i]);
    const dipDizi = P.slice(0, j + 1).map(v => v * yon);
    const dip = Math.min(...dipDizi) * yon;
    const sl = (dip - c[i]) * yon < 0 ? dip
      : (yon > 0 ? Math.min(...l.slice(i - 9, i + 1)) : Math.max(...h.slice(i - 9, i + 1)));
    if ((tp - c[i]) * yon <= 0) gecerli = false;
    const kayit = { i, yon, gecerli, giris: c[i], tp, sl, echo: P, sonuc: null, kz: null };
    if (gecerli) {
      const liq = c[i] * (1 - liqMes * yon);
      let bitis = null;
      for (let q = i + 1; q < Math.min(n, i + F + 1); q++) {
        const ters = yon > 0 ? l[q] : h[q], lehte = yon > 0 ? h[q] : l[q];
        if ((ters - liq) * yon <= 0 && (liq - sl) * yon >= 0) { Object.assign(kayit, { sonuc: "likidasyon", kz: -marj }); bitis = q; break; }
        if ((ters - sl) * yon <= 0) { Object.assign(kayit, { sonuc: "stop", kz: ((sl / c[i] - 1) * yon - maliyet) * lev * marj }); bitis = q; break; }
        if ((lehte - tp) * yon >= 0) { Object.assign(kayit, { sonuc: "hedef", kz: ((tp / c[i] - 1) * yon - maliyet) * lev * marj }); bitis = q; break; }
      }
      if (bitis === null && i + F < n) { bitis = i + F; Object.assign(kayit, { sonuc: "süre doldu", kz: ((c[bitis] / c[i] - 1) * yon - maliyet) * lev * marj }); }
      acikBitis = bitis === null ? n : bitis;
    }
    out.push(kayit);
  }
  return [baz, d, out];
}

function videoKatmani(k, tz, gorunenBas, lev, mmr) {
  const t = k.map(x => x.t), h = k.map(x => x.h), l = k.map(x => x.l), c = k.map(x => x.c);
  const [baz, d, S] = sslEchoSinyaller(h, l, c, lev, 12, 0.0018, mmr);
  const z = (ms, j = 0) => Math.floor((ms + MS5 * (j + 1) - 60000) / 1000) + tz;
  const n = c.length, P = echoYol(c, n - 1);
  const saat = i => new Date(t[i]).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  const sinyal = S.filter(x => t[x.i] >= gorunenBas).map(x => ({
    time: z(t[x.i]), saat: saat(x.i), yon: x.yon, gecerli: x.gecerli, giris: x.giris, tp: x.tp, sl: x.sl,
    sonuc: x.sonuc, kz: x.kz, echo_yukari: x.echo[x.echo.length - 1] > x.giris }));
  const g = S.filter(x => x.gecerli && x.kz !== null), kz = g.map(x => x.kz);
  const son = [...S].reverse().find(x => x.gecerli);
  const echoIz = son && t[son.i] >= gorunenBas
    ? [{ time: z(t[son.i]), value: son.giris }].concat(son.echo.map((v, j) => ({ time: z(t[son.i], j + 1), value: v })))
    : [];
  const say = r => g.filter(x => x.sonuc === r).length;
  return {
    echo_iz: echoIz, echo_iz_saat: echoIz.length ? saat(son.i) : null,
    renk: k.map((x, i) => [Math.floor(x.t / 1000) + tz, d[i]]).filter((_, i) => t[i] >= gorunenBas - MS5),
    baz: k.map((x, i) => ({ time: z(x.t), value: baz[i] })).filter((x, i) => t[i] >= gorunenBas - MS5 && !isNaN(baz[i])),
    echo: [{ time: z(t[n - 1]), value: c[n - 1] }].concat(P.map((v, j) => ({ time: z(t[n - 1], j + 1), value: v }))),
    sinyaller: sinyal, trend: d[n - 1], echo_degisim: P.length ? (P[P.length - 1] / c[n - 1] - 1) * 100 : 0,
    karne: { gun: Math.round((t[n - 1] - t[0]) / 86400000), islem: g.length, hedef: say("hedef"), stop: say("stop"),
             likid: say("likidasyon"), kazanan: kz.length ? 100 * kz.filter(v => v > 0).length / kz.length : null,
             ort: kz.length ? kz.reduce((a, b) => a + b, 0) / kz.length : null,
             toplam: kz.reduce((a, b) => a + b, 0), lev } };
}

// ---------- 15 formasyon (formasyonlar.py'nin tarayıcı sürümü) ----------
function frmHazirla(k) {
  const o = k.map(x => x.o), h = k.map(x => x.h), l = k.map(x => x.l), c = k.map(x => x.c);
  const n = c.length;
  const g = c.map((x, i) => Math.abs(x - o[i]));
  const r = h.map((x, i) => Math.max(x - l[i], 1e-12));
  return { o, h, l, c, n, g, r,
    ust: h.map((x, i) => x - Math.max(o[i], c[i])), alt: c.map((x, i) => Math.min(o[i], c[i]) - l[i]),
    yesil: c.map((x, i) => x > o[i]),
    e20: emaDizi(c, 20), e50: emaDizi(c, 50), e200: emaDizi(c, 200),
    rsi: rsi(c, 14).map(x => x === null ? 50 : x),
    atr: atr(k, 14).map(x => x === null ? 0 : x) };
}
const _pivot = (x, i, k, ust) => {
  if (i < k || i + k >= x.length) return false;
  const p = x.slice(i - k, i + k + 1);
  return x[i] === (ust ? Math.max(...p) : Math.min(...p));
};
const FORMASYONLAR = {
  "Yutan mum (engulfing)": d => { const out = [];
    for (let i = 1; i < d.n; i++) { if (d.g[i] < d.g[i-1] * 1.1) continue;
      if (d.c[i] > d.o[i] && d.c[i-1] < d.o[i-1] && d.c[i] >= d.o[i-1] && d.o[i] <= d.c[i-1]) out.push([i, 1]);
      if (d.c[i] < d.o[i] && d.c[i-1] > d.o[i-1] && d.c[i] <= d.o[i-1] && d.o[i] >= d.c[i-1]) out.push([i, -1]); }
    return out; },
  "Çekiç / ters çekiç": d => { const out = [];
    for (let i = 1; i < d.n; i++) { if (d.g[i] > 0.35 * d.r[i]) continue;
      if (d.alt[i] > 2 * d.g[i] && d.ust[i] < 0.3 * d.r[i]) out.push([i, 1]);
      if (d.ust[i] > 2 * d.g[i] && d.alt[i] < 0.3 * d.r[i]) out.push([i, -1]); }
    return out; },
  "Sabah/akşam yıldızı": d => { const out = [];
    for (let i = 2; i < d.n; i++) { const a = i - 2, b = i - 1;
      if (d.g[b] > 0.4 * d.g[a]) continue;
      if (d.g[a] < 0.6 * d.r[a] || d.g[i] < 0.6 * d.r[i]) continue;
      if (d.c[a] < d.o[a] && d.c[i] > d.o[i] && d.c[i] > (d.o[a] + d.c[a]) / 2) out.push([i, 1]);
      if (d.c[a] > d.o[a] && d.c[i] < d.o[i] && d.c[i] < (d.o[a] + d.c[a]) / 2) out.push([i, -1]); }
    return out; },
  "3 asker / 3 karga": d => { const out = [];
    for (let i = 2; i < d.n; i++) { const u = [i-2, i-1, i];
      if (u.every(j => d.c[j] > d.o[j] && d.g[j] > 0.5 * d.r[j]) && d.c[u[0]] < d.c[u[1]] && d.c[u[1]] < d.c[u[2]]) out.push([i, 1]);
      if (u.every(j => d.c[j] < d.o[j] && d.g[j] > 0.5 * d.r[j]) && d.c[u[0]] > d.c[u[1]] && d.c[u[1]] > d.c[u[2]]) out.push([i, -1]); }
    return out; },
  "Harami": d => { const out = [];
    for (let i = 1; i < d.n; i++) { if (d.g[i] > 0.5 * d.g[i-1] || d.g[i-1] < 1e-9) continue;
      const ust = Math.max(d.o[i-1], d.c[i-1]), alt = Math.min(d.o[i-1], d.c[i-1]);
      if (!(alt <= Math.min(d.o[i], d.c[i]) && Math.max(d.o[i], d.c[i]) <= ust)) continue;
      out.push([i, d.c[i-1] < d.o[i-1] ? 1 : -1]); }
    return out; },
  "Delen mum (piercing/dark cloud)": d => { const out = [];
    for (let i = 1; i < d.n; i++) { if (d.g[i-1] < 0.5 * d.r[i-1]) continue;
      const orta = (d.o[i-1] + d.c[i-1]) / 2;
      if (d.c[i-1] < d.o[i-1] && d.o[i] < d.c[i-1] && d.c[i] > orta && d.c[i] < d.o[i-1]) out.push([i, 1]);
      if (d.c[i-1] > d.o[i-1] && d.o[i] > d.c[i-1] && d.c[i] < orta && d.c[i] > d.o[i-1]) out.push([i, -1]); }
    return out; },
  "Marubozu": d => { const out = [];
    for (let i = 0; i < d.n; i++) if (d.g[i] >= 0.9 * d.r[i]) out.push([i, d.yesil[i] ? 1 : -1]);
    return out; },
  "İkili dip / ikili tepe": d => { const out = [], k = 5, tol = 0.004;
    const dipler = [], tepeler = [];
    for (let i = k; i < d.n - k; i++) { if (_pivot(d.l, i, k, false)) dipler.push(i); if (_pivot(d.h, i, k, true)) tepeler.push(i); }
    for (const [lst, yon, x] of [[dipler, 1, d.l], [tepeler, -1, d.h]])
      for (let q = 0; q + 1 < lst.length; q++) { const a = lst[q], b = lst[q + 1];
        if (b - a >= 6 && b - a <= 60 && Math.abs(x[b] / x[a] - 1) <= tol) out.push([Math.min(b + k, d.n - 1), yon]); }
    return out; },
  "Omuz-baş-omuz": d => { const out = [], k = 5;
    const tepeler = [], dipler = [];
    for (let i = k; i < d.n - k; i++) { if (_pivot(d.h, i, k, true)) tepeler.push(i); if (_pivot(d.l, i, k, false)) dipler.push(i); }
    for (const [lst, yon, x, basBuyuk] of [[tepeler, -1, d.h, true], [dipler, 1, d.l, false]])
      for (let q = 0; q + 2 < lst.length; q++) { const a = lst[q], b = lst[q+1], c_ = lst[q+2];
        if (!(c_ - a >= 6 && c_ - a <= 120)) continue;
        const omuzEs = Math.abs(x[c_] / x[a] - 1) <= 0.02;
        if (basBuyuk && x[b] > x[a] * 1.01 && x[b] > x[c_] * 1.01 && omuzEs) out.push([Math.min(c_ + k, d.n - 1), yon]);
        if (!basBuyuk && x[b] < x[a] * 0.99 && x[b] < x[c_] * 0.99 && omuzEs) out.push([Math.min(c_ + k, d.n - 1), yon]); }
    return out; },
  "Sıkışma kırılımı": d => { const out = [], p = 48;
    for (let i = p + 1; i < d.n; i++) {
      const ph = Math.max(...d.h.slice(i - p, i)), pl = Math.min(...d.l.slice(i - p, i));
      if ((ph - pl) / Math.max(d.c[i], 1e-9) > 0.05) continue;
      if (d.c[i] > ph) out.push([i, 1]); else if (d.c[i] < pl) out.push([i, -1]); }
    return out; },
  "Bollinger sıkışması": d => { const out = [], p = 20, k = 2;
    for (let i = p * 3; i < d.n; i++) {
      const w = d.c.slice(i - p, i), m = w.reduce((a, b) => a + b, 0) / p;
      const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / p);
      if (sd <= 0) continue;
      const gen = 2 * k * sd / m, onceki = [];
      for (let j = i - p; j < i; j += 5) { const w2 = d.c.slice(j - p, j); if (w2.length < p) continue;
        const m2 = w2.reduce((a, b) => a + b, 0) / p;
        onceki.push(Math.sqrt(w2.reduce((a, b) => a + (b - m2) ** 2, 0) / p) / m2); }
      if (!onceki.length) continue;
      const med = [...onceki].sort((a, b) => a - b)[Math.floor(onceki.length / 2)];
      if (gen > med * 2 * k * 0.8) continue;
      if (d.c[i] > m + k * sd) out.push([i, 1]); else if (d.c[i] < m - k * sd) out.push([i, -1]); }
    return out; },
  "RSI uyumsuzluğu": d => { const out = [], k = 5;
    const dipler = [], tepeler = [];
    for (let i = k; i < d.n - k; i++) { if (_pivot(d.l, i, k, false)) dipler.push(i); if (_pivot(d.h, i, k, true)) tepeler.push(i); }
    for (let q = 0; q + 1 < dipler.length; q++) { const a = dipler[q], b = dipler[q+1];
      if (b - a >= 6 && b - a <= 80 && d.l[b] < d.l[a] && d.rsi[b] > d.rsi[a] + 2) out.push([Math.min(b + k, d.n - 1), 1]); }
    for (let q = 0; q + 1 < tepeler.length; q++) { const a = tepeler[q], b = tepeler[q+1];
      if (b - a >= 6 && b - a <= 80 && d.h[b] > d.h[a] && d.rsi[b] < d.rsi[a] - 2) out.push([Math.min(b + k, d.n - 1), -1]); }
    return out; },
  "Altın/ölüm kesişimi": d => { const out = [];
    for (let i = 1; i < d.n; i++) {
      if (d.e50[i-1] <= d.e200[i-1] && d.e50[i] > d.e200[i]) out.push([i, 1]);
      if (d.e50[i-1] >= d.e200[i-1] && d.e50[i] < d.e200[i]) out.push([i, -1]); }
    return out; },
  "RSI 30/70 dönüşü": d => { const out = [];
    for (let i = 1; i < d.n; i++) {
      if (d.rsi[i-1] < 30 && d.rsi[i] >= 30) out.push([i, 1]);
      if (d.rsi[i-1] > 70 && d.rsi[i] <= 70) out.push([i, -1]); }
    return out; },
  "Ortalamaya dönüş (z=2)": d => { const out = [], p = 48;
    for (let i = p; i < d.n; i++) { const w = d.c.slice(i - p, i);
      const m = w.reduce((a, b) => a + b, 0) / p;
      const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / p);
      if (sd <= 0) continue;
      const z = (d.c[i] - m) / sd;
      if (z <= -2) out.push([i, 1]); else if (z >= 2) out.push([i, -1]); }
    return out; },
};

function formasyonKatmani(k, tz, gorunenBas, olcum) {
  const d = frmHazirla(k), t = k.map(x => x.t);
  const z = ms => Math.floor((ms + MS5 - 60000) / 1000) + tz;
  const out = [];
  for (const [ad, fn] of Object.entries(FORMASYONLAR)) {
    let sig; try { sig = fn(d); } catch (e) { continue; }
    const o = olcum[ad] || {};
    for (const [i, yon] of sig) {
      if (i >= t.length || t[i] < gorunenBas) continue;
      const ileri = i + 12 < t.length ? (d.c[i + 12] / d.c[i] - 1) * 100 : null;
      out.push({ ad, time: z(t[i]), saat: new Date(t[i]).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", ""),
                 yon, fiyat: d.c[i], sonra: ileri === null ? null : Math.round(ileri * 100) / 100,
                 isabet: o.isabet2, n: o.n });
    }
  }
  out.sort((a, b) => a.time - b.time);
  const liste = Object.entries(olcum).map(([ad, v]) => ({ ad, ...v }))
    .sort((a, b) => -((a.isabet1 || 0) + (a.isabet2 || 0)) + ((b.isabet1 || 0) + (b.isabet2 || 0)));
  return { sinyaller: out.slice(-60), olcum: liste, rastgele: { isabet1: 48.3, isabet2: 49.3, ort1: -0.011, ort2: -0.002 }, maliyet: 0.18 };
}

// ---------- tarayıcı (bütün coinler) ----------
const TARAYICI_MIN_HACIM = 5e6;
let _tarOnbellek = { t: 0, veri: null };
function tabanKova(deg, taban) {
  for (const v of Object.values(taban.kovalar || {})) if (v.alt <= deg && deg < v.ust) return v;
  return null;
}
async function tarayiciVeri(lev, taban) {
  if (_tarOnbellek.veri && Date.now() - _tarOnbellek.t < 20000) return _tarOnbellek.veri;
  const [tic, prem] = await Promise.all([jget("/fapi/v1/ticker/24hr"), jget("/fapi/v1/premiumIndex")]);
  const pm = new Map(prem.map(x => [x.symbol, x]));
  const out = [];
  for (const x of tic) {
    if (!x.symbol.endsWith("USDT") || !pm.has(x.symbol)) continue;
    const hacim = +x.quoteVolume;
    if (hacim < TARAYICI_MIN_HACIM) continue;
    const fiyat = +x.lastPrice, deg = +x.priceChangePercent, kova = tabanKova(deg, taban);
    out.push({ symbol: x.symbol, fiyat, degisim: deg, hacim,
      fon: (+(pm.get(x.symbol).lastFundingRate || 0)) * 100,
      tepeye: (+x.highPrice / fiyat - 1) * 100, dibe: (+x.lowPrice / fiyat - 1) * 100,
      durum: kova ? kova.ad : null, t4: kova ? kova["4s"] : null, t24: kova ? kova["24s"] : null });
  }
  out.sort((a, b) => Math.abs(b.degisim) - Math.abs(a.degisim));
  const veri = { coinler: out.slice(0, 80), lev, taban_coin: taban.coin, taban_gun: taban.gun,
                 guncelleme: new Date().toLocaleTimeString("tr-TR") };
  _tarOnbellek = { t: Date.now(), veri };
  return veri;
}

// ---------- paket: sayfanın beklediği V nesnesini üretir (Python'daki paket() ile aynı) ----------
async function paketUret(tah, symbol, lev, fee, mmr, olcum, ilerle) {
  await tah.veriGuncelle(ilerle);
  ilerle && ilerle("katmanlar hazırlanıyor…");
  const now = Date.now();
  const price = await fiyatAl(symbol);
  const tz = -new Date().getTimezoneOffset() * 60;
  const s = tah.simdi, A = tah.adim;
  const saat = ms => new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  const zaman = (tMs, h) => Math.floor((tMs + MS5 * (h + 1) - 60000) / 1000) + tz;

  const mumlar = tah.mum1.map(x => ({ time: Math.floor(x.t / 1000) + tz, open: x.o, high: x.h, low: x.l, close: x.c }));
  const gorunenBas = tah.mum1[0].t;

  const koni = {}; for (const q of ["p10", "p25", "p50", "p75", "p90", "p50o", "p50k"]) koni[q] = [];
  if (yeterli(s)) for (const q of Object.keys(koni)) {
    koni[q].push({ time: zaman(s.t, 0), value: s.baz });
    s.dagilim.forEach((dg, h) => koni[q].push({ time: zaman(s.t, h + 1), value: s.baz * (1 + dg[q]) }));
  }
  const gecmis = {};
  for (const h of tah.ufuklar) {
    const seri = { p10: [], p50: [], p90: [] };
    for (const t of [...tah.kayitlar.keys()].sort((a, b) => a - b)) {
      const kay = tah.kayitlar.get(t), hedef = t + MS5 * (h + 1);
      if (!yeterli(kay) || hedef > now || hedef < gorunenBas) continue;
      const d = kay.dagilim[h - 1];
      for (const q of Object.keys(seri)) seri[q].push({ time: zaman(t, h), value: kay.baz * (1 + d[q]) });
    }
    gecmis[h] = seri;
  }
  const [direncler, destekler] = await seviyeler(symbol, price);
  const degme = (yollar, oran) => {
    if (!yollar || !yollar.length) return 0;
    let s2 = 0;
    for (const y of yollar) if (y.some(([, hi, lo]) => oran > 0 ? hi >= oran : lo <= oran)) s2++;
    return s2 / yollar.length;
  };
  for (const sv of direncler.concat(destekler)) {
    const oran = sv.fiyat / price - 1;
    sv.uzaklik = oran * 100; sv.roe = oran * 100 * lev;
    sv.degme = degme(s.yollar, oran) * 100;
  }
  const kapanis = s.t + MS5;
  const dilimler = [];
  if (yeterli(s)) for (const h of [...new Set([1, 2, 3, 4].map(q => Math.max(1, Math.round(A * q / 4))))].sort((a, b) => a - b)) {
    const dg = s.dagilim[h - 1], yuk = dg.yuk * 100;
    dilimler.push({ aralik: `${saat(kapanis)} → ${saat(kapanis + h * MS5)}`, yuk,
      egilim: yuk >= 55 ? "yukarı eğilim" : yuk <= 45 ? "aşağı eğilim" : "kararsız",
      orta: s.baz * (1 + dg.p50), alt: s.baz * (1 + dg.p10), ust: s.baz * (1 + dg.p90),
      roe_alt: dg.p10 * 100 * lev, roe_ust: dg.p90 * 100 * lev });
  }
  const liqRoe = (1 / lev - mmr) * 100 * lev;
  const senaryolar = [];
  if (destekler.length && direncler.length && yeterli(s)) {
    const S = destekler[0].fiyat, R = direncler[0].fiyat, SR_TAMPON = 0.003;
    for (const [yon, stop, hedef] of [["LONG", S * (1 - SR_TAMPON), R], ["SHORT", R * (1 + SR_TAMPON), S]]) {
      const sg = yon === "LONG" ? 1 : -1;
      const stopPct = (price - stop) / price * sg, hedefPct = (hedef - price) / price * sg;
      if (stopPct <= 0 || hedefPct <= 0) continue;
      let u = 0, top = 0;
      for (const y of s.yollar || []) {
        let sonuc = null;
        for (const [, hi, lo] of y) {
          const lehte = sg > 0 ? hi : -lo, aleyhte = sg > 0 ? -lo : hi;
          if (lehte >= hedefPct && aleyhte >= stopPct) { sonuc = "belirsiz"; break; }
          if (lehte >= hedefPct) { sonuc = "hedef"; break; }
          if (aleyhte >= stopPct) { sonuc = "stop"; break; }
        }
        if (sonuc === "hedef") u++;
        if (sonuc === "hedef" || sonuc === "stop") top++;
      }
      const pHedef = top ? u / top : 0;
      const beklenti = top ? (pHedef * hedefPct - (1 - pHedef) * stopPct - 2 * fee) * 100 * lev : 0;
      senaryolar.push({ yon, giris: price, stop, hedef, stop_roe: stopPct * 100 * lev,
        hedef_roe: hedefPct * 100 * lev, p_hedef: pHedef * 100, beklenti,
        likidasyon: stopPct * 100 * lev >= liqRoe });
    }
  }
  const zincir = [];
  for (const t of [...tah.kayitlar.keys()].sort((a, b) => a - b)) {
    const kay = tah.kayitlar.get(t), kap = t + MS5, an = new Date(kap);
    if ((an.getHours() * 60 + an.getMinutes()) % (A * 5) || !yeterli(kay) || kap + A * MS5 < gorunenBas) continue;
    const yol = {};
    for (const q of ["p10", "p50", "p90", "p50o", "p50k"]) {
      yol[q] = [{ time: zaman(t, 0), value: kay.baz }];
      for (let h = 1; h <= A; h++) yol[q].push({ time: zaman(t, h), value: kay.baz * (1 + kay.dagilim[h - 1][q]) });
    }
    zincir.push({ saat: saat(kap), bitis: saat(kap + A * MS5), ...yol });
  }
  const hayalet = [];
  for (const t of [...tah.kayitlar.keys()].sort((a, b) => b - a)) {
    const kay = tah.kayitlar.get(t), kap = t + MS5;
    if (t >= s.t || kap < s.t + MS5 - 1 * 15 * 60000) continue;
    if (new Date(kap).getMinutes() % 15 || !yeterli(kay)) continue;
    const nokta = [{ time: zaman(t, 0), value: kay.baz, vo: kay.baz, vk: kay.baz }];
    for (let h = 1; h <= A; h++) nokta.push({ time: zaman(t, h),
      value: kay.baz * (1 + kay.dagilim[h - 1].p50), vo: kay.baz * (1 + kay.dagilim[h - 1].p50o),
      vk: kay.baz * (1 + kay.dagilim[h - 1].p50k) });
    hayalet.push(nokta);
    if (hayalet.length >= 1) break;
  }
  return { symbol, lev, price, tz, liq_roe: liqRoe,
    guncelleme: new Date().toLocaleTimeString("tr-TR"), tarih: new Date().toLocaleDateString("tr-TR"),
    tahmin_saati: saat(kapanis), simdi_zaman: zaman(s.t, 0), min_benzer: MIN_BENZER, min_gun: MIN_GUN,
    keskin_k: [KESKIN_ORTA, KESKIN_COK], ufuk_dk: A * 5, ufuklar: tah.ufuklar,
    benzer: { n: s.n, gun: s.gun, m60: s.m60, rsi: s.rsi, trend: s.trend, vol: s.vol },
    zincir, hayalet, mmr, mumlar, koni, gecmis, karne: tah.karne(), dilimler,
    ict: ictKatmani(tah.k, tz, gorunenBas, now),
    video: videoKatmani(tah.k, tz, gorunenBas, lev, mmr),
    formasyon: formasyonKatmani(tah.k, tz, gorunenBas, olcum),
    direncler, destekler, senaryolar };
}

// ---------- ölçüm tabloları (dosyadan okumak yerine gömülü: dosyaya çift tıklayınca da çalışsın) ----------
const TABAN_GOMULU = {"kovalar": {"-100|-20": {"ad": "−%20'den fazla düştü", "alt": -100.0, "ust": -20.0, "4s": {"n": 13182, "yukari": 45.3, "ort": -0.12, "oynaklik": 6.33, "liq5_long": 5.7, "liq20_long": 58.9, "liq5_short": 8.3, "liq20_short": 56.8}, "24s": {"n": 13182, "yukari": 40.7, "ort": -0.69, "oynaklik": 15.34, "liq5_long": 27.1, "liq20_long": 84.1, "liq5_short": 28.6, "liq20_short": 79.7}}, "-20|-10": {"ad": "−%20 ile −%10", "alt": -20.0, "ust": -10.0, "4s": {"n": 57297, "yukari": 49.0, "ort": 0.08, "oynaklik": 2.92, "liq5_long": 0.7, "liq20_long": 30.8, "liq5_short": 1.2, "liq20_short": 31.6}, "24s": {"n": 57297, "yukari": 44.8, "ort": -0.15, "oynaklik": 7.13, "liq5_long": 6.0, "liq20_long": 67.4, "liq5_short": 10.1, "liq20_short": 64.1}}, "-10|-5": {"ad": "−%10 ile −%5", "alt": -10.0, "ust": -5.0, "4s": {"n": 205287, "yukari": 50.0, "ort": 0.07, "oynaklik": 1.77, "liq5_long": 0.2, "liq20_long": 14.4, "liq5_short": 0.3, "liq20_short": 14.3}, "24s": {"n": 205287, "yukari": 48.1, "ort": 0.11, "oynaklik": 4.44, "liq5_long": 1.6, "liq20_long": 49.6, "liq5_short": 3.9, "liq20_short": 49.2}}, "-5|5": {"ad": "−%5 ile +%5 (sakin)", "alt": -5.0, "ust": 5.0, "4s": {"n": 1885448, "yukari": 47.8, "ort": 0.04, "oynaklik": 1.25, "liq5_long": 0.1, "liq20_long": 6.2, "liq5_short": 0.2, "liq20_short": 8.1}, "24s": {"n": 1885448, "yukari": 49.0, "ort": 0.27, "oynaklik": 3.25, "liq5_long": 0.6, "liq20_long": 33.9, "liq5_short": 2.2, "liq20_short": 37.3}}, "5|10": {"ad": "+%5 ile +%10", "alt": 5.0, "ust": 10.0, "4s": {"n": 184371, "yukari": 45.6, "ort": 0.07, "oynaklik": 2.1, "liq5_long": 0.3, "liq20_long": 16.4, "liq5_short": 0.7, "liq20_short": 21.5}, "24s": {"n": 184371, "yukari": 45.2, "ort": 0.56, "oynaklik": 5.12, "liq5_long": 2.0, "liq20_long": 52.8, "liq5_short": 6.7, "liq20_short": 54.7}}, "10|25": {"ad": "+%10 ile +%25", "alt": 10.0, "ust": 25.0, "4s": {"n": 80479, "yukari": 45.8, "ort": 0.07, "oynaklik": 3.83, "liq5_long": 1.3, "liq20_long": 41.3, "liq5_short": 2.8, "liq20_short": 41.7}, "24s": {"n": 80479, "yukari": 41.3, "ort": 0.33, "oynaklik": 8.92, "liq5_long": 7.4, "liq20_long": 74.5, "liq5_short": 16.9, "liq20_short": 68.8}}, "25|40": {"ad": "+%25 ile +%40", "alt": 25.0, "ust": 40.0, "4s": {"n": 13085, "yukari": 46.4, "ort": -0.08, "oynaklik": 6.59, "liq5_long": 4.6, "liq20_long": 66.7, "liq5_short": 8.3, "liq20_short": 64.2}, "24s": {"n": 13085, "yukari": 39.2, "ort": 0.21, "oynaklik": 15.39, "liq5_long": 24.8, "liq20_long": 88.7, "liq5_short": 33.5, "liq20_short": 81.3}}, "40|1000000000.0": {"ad": "+%40'tan fazla yükseldi", "alt": 40.0, "ust": 1000000000.0, "4s": {"n": 8505, "yukari": 46.1, "ort": 0.07, "oynaklik": 10.45, "liq5_long": 14.4, "liq20_long": 79.2, "liq5_short": 20.0, "liq20_short": 75.6}, "24s": {"n": 8505, "yukari": 40.1, "ort": 0.62, "oynaklik": 24.08, "liq5_long": 46.8, "liq20_long": 92.9, "liq5_short": 49.1, "liq20_short": 87.5}}}, "coin": 528, "gun": 200};
const OLCUM_GOMULU = {"Yutan mum (engulfing)": {"n": 128154, "isabet1": 48.2, "isabet2": 48.3, "ort1": -0.0062, "ort2": -0.0106}, "Çekiç / ters çekiç": {"n": 141540, "isabet1": 48.1, "isabet2": 49.1, "ort1": -0.0142, "ort2": 0.003}, "Sabah/akşam yıldızı": {"n": 36416, "isabet1": 48.5, "isabet2": 48.3, "ort1": -0.0002, "ort2": -0.0023}, "3 asker / 3 karga": {"n": 29636, "isabet1": 45.6, "isabet2": 45.5, "ort1": -0.0359, "ort2": -0.0288}, "Harami": {"n": 133359, "isabet1": 49.6, "isabet2": 50.0, "ort1": 0.0024, "ort2": -0.0003}, "Delen mum (piercing/dark cloud)": {"n": 22519, "isabet1": 49.8, "isabet2": 49.9, "ort1": -0.0183, "ort2": -0.0316}, "Marubozu": {"n": 78473, "isabet1": 46.6, "isabet2": 47.3, "ort1": -0.0273, "ort2": -0.0193}, "İkili dip / ikili tepe": {"n": 58196, "isabet1": 47.5, "isabet2": 47.9, "ort1": 0.0031, "ort2": 0.0168}, "Omuz-baş-omuz": {"n": 2984, "isabet1": 49.0, "isabet2": 48.8, "ort1": -0.0768, "ort2": -0.1327}, "Sıkışma kırılımı": {"n": 49045, "isabet1": 44.7, "isabet2": 43.6, "ort1": -0.0188, "ort2": -0.0487}, "Bollinger sıkışması": {"n": 60370, "isabet1": 46.5, "isabet2": 44.8, "ort1": 0.0061, "ort2": -0.0322}, "RSI uyumsuzluğu": {"n": 10328, "isabet1": 48.9, "isabet2": 49.8, "ort1": -0.0013, "ort2": 0.0156}, "Altın/ölüm kesişimi": {"n": 13172, "isabet1": 45.5, "isabet2": 46.2, "ort1": -0.0113, "ort2": -0.0139}, "RSI 30/70 dönüşü": {"n": 39316, "isabet1": 50.7, "isabet2": 52.7, "ort1": -0.0241, "ort2": 0.0127}, "Ortalamaya dönüş (z=2)": {"n": 71914, "isabet1": 53.5, "isabet2": 54.8, "ort1": 0.0271, "ort2": 0.0451}};
