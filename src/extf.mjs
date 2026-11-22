/**
 * extf.mjs: DATEV-Buchungsstapel (DATEV-Format, Kennzeichen EXTF oder DTVF, Version 700, Formatkategorie 21) lesen, prüfen und
 * schreiben. Reine Funktionen ohne Netz und ohne Abhängigkeiten; der MCP-Server (server.mjs) ist nur die Hülle darum.
 *
 * WAS DIE DATEI IST: Semikolon-CSV mit CRLF, Standard-Zeichensatz Windows-1252. Zeile 1 ist die Kopfzeile (31 Felder), Zeile 2
 * trägt 125 Spaltenüberschriften, danach folgt je Buchung eine Zeile. Textfelder stehen in Anführungszeichen (innen verdoppelt).
 * Der Umsatz steht ohne Vorzeichen mit Komma, die Seite im Soll/Haben-Kennzeichen; es bezieht sich auf das Feld „Konto“, das
 * Gegenkonto wird auf der anderen Seite bebucht. Das Belegdatum steht als TTMM, das Jahr ergibt sich aus dem Beginn des
 * Wirtschaftsjahrs in der Kopfzeile.
 *
 * WORAN GEPRÜFT WIRD: format.json führt zu jedem der 31 Kopffelder und jeder der 125 Spalten den regulären Ausdruck aus der
 * Formatbeschreibung der DATEV eG (developer.datev.de, Stand dort vermerkt). Zwei Stufen von Befunden:
 *   fehler      Der Stapel ist so nicht auswertbar oder widerspricht sich selbst (Feldzahl, Pflichtangabe fehlt, Wert nicht
 *               lesbar, Belegdatum außerhalb des Zeitraums, Konto gleich Gegenkonto).
 *   abweichung  Ein gefülltes Feld entspricht nicht dem Ausdruck der Formatbeschreibung, oder Zeichensatz, Zeilenende oder eine
 *               dort genannte Abhängigkeit zweier Felder weichen ab. Ob DATEV das beim Import hinnimmt, sagt dieser Befund nicht.
 * Ein leeres Feld (auch "") ist kein Befund, solange es keine Pflichtangabe ist.
 *
 * WAS SIE NICHT IST: keine Steuerentscheidung und keine Festschreibung. Konten und Steuerschlüssel kommen vom Anwender.
 */
import fs from "node:fs";

export const FORMAT = JSON.parse(fs.readFileSync(new URL("./format.json", import.meta.url), "utf8"));
export const SPALTEN = FORMAT.spalten.map((s) => s.name);
export const KOPFFELDER = FORMAT.kopf.map((k) => k.feld);
const KOPF_AUSDRUCK = FORMAT.kopf.map((k) => new RegExp(k.ausdruck));
const SPALTEN_AUSDRUCK = FORMAT.spalten.map((s) => new RegExp(s.ausdruck));
const K = Object.fromEntries(KOPFFELDER.map((feld, i) => [feld, i]));

/* Spalten, die jede Buchung als eigenes Feld bekommt (Index 0-basiert). Alles andere, das gefüllt ist, steht unter „weitere“
   mit seiner Überschrift, damit beim Lesen nichts verloren geht. */
const S = { umsatz: 0, sollHaben: 1, wkz: 2, basisumsatz: 4, wkzBasis: 5, konto: 6, gegenkonto: 7, buSchluessel: 8, belegdatum: 9, belegfeld1: 10, belegfeld2: 11, buchungstext: 13, geschaeftspartnerbank: 16, kost1: 36, kost2: 37, sepaMandat: 104, festschreibung: 113, leistungsdatum: 114, steuerperiode: 115 };
const BENANNT = new Set([S.umsatz, S.sollHaben, S.wkz, S.konto, S.gegenkonto, S.buSchluessel, S.belegdatum, S.belegfeld1, S.belegfeld2, S.buchungstext, S.kost1, S.kost2, S.festschreibung]);

/* Abhängigkeiten zweier Spalten, wie die Formatbeschreibung sie nennt: [a, b, beide Richtungen]. Ist a gefüllt, muss b es sein. */
const PAARE = [
  [S.basisumsatz, S.wkzBasis, true],
  [S.leistungsdatum, S.steuerperiode, false],
  [S.geschaeftspartnerbank, S.sepaMandat, true],
  ...Array.from({ length: 8 }, (_, n) => [20 + 2 * n, 21 + 2 * n, true]),    // Beleginfo Art und Inhalt 1 bis 8
  ...Array.from({ length: 20 }, (_, n) => [47 + 2 * n, 48 + 2 * n, true]),   // Zusatzinformation Art und Inhalt 1 bis 20
];

/* Windows-1252: 0x80 bis 0x9F weichen von ISO-8859-1 ab; fünf Bytes sind nicht belegt. */
const CP1252_HOCH = new Map([[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]]);
const CP1252_ZURUECK = new Map([...CP1252_HOCH].map(([zeichen, byte]) => [byte, zeichen]));

/** Text nach Windows-1252. Zeichen ohne Platz dort kommen in „fehlend“ zurück (und werden als „?“ geschrieben). */
export function nachCp1252(text) {
  const bytes = [], fehlend = [];
  for (const z of String(text)) {
    const cp = z.codePointAt(0);
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) bytes.push(cp);
    else if (CP1252_HOCH.has(cp)) bytes.push(CP1252_HOCH.get(cp));
    else { bytes.push(0x3f); fehlend.push(z); }
  }
  return { bytes: Buffer.from(bytes), fehlend };
}

/** Windows-1252 nach Text. Die fünf unbelegten Bytes kommen mit ihrer Position in „ungueltig“ zurück. */
export function ausCp1252(bytes) {
  let text = "";
  const ungueltig = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80 || b >= 0xa0) text += String.fromCharCode(b);
    else if (CP1252_ZURUECK.has(b)) text += String.fromCodePoint(CP1252_ZURUECK.get(b));
    else { text += String.fromCharCode(0xfffd); ungueltig.push(i); }
  }
  return { text, ungueltig };
}

/** Ist die Bytefolge gültiges UTF-8 mit mindestens einem Mehrbytezeichen? Reines ASCII zählt nicht (dort ist beides gleich). */
export function siehtNachUtf8Aus(bytes) {
  let mehrbyte = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    const laenge = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (!laenge || i + laenge > bytes.length) return false;
    for (let k = 1; k < laenge; k++) if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    mehrbyte++;
    i += laenge - 1;
  }
  return mehrbyte > 0;
}

/**
 * Bytes in Text wandeln. Laut DATEV ist Windows-1252 der Standard; Unicode liest DATEV nur mit Byte Order Mark, und dann nur
 * beim Import von Hand oder über die Schnittstelle accounting:extf-files. Gibt { text, zeichensatz, befunde } zurück.
 */
export function entziffern(bytes) {
  const befunde = [];
  const melde = (stufe, meldung) => befunde.push({ stufe, zeile: 0, feld: "Zeichensatz", meldung });
  const b = bytes;
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
    melde("fehler", "Die Datei ist UTF-16 oder UTF-32; dieses Werkzeug liest Windows-1252 und UTF-8.");
    return { text: "", zeichensatz: "utf-16", befunde };
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    melde("abweichung", "UTF-8 mit Byte Order Mark statt Windows-1252: DATEV liest das nur beim Import von Hand und über accounting:extf-files.");
    return { text: Buffer.from(b.subarray(3)).toString("utf8"), zeichensatz: "utf-8-bom", befunde };
  }
  if (siehtNachUtf8Aus(b)) {
    melde("abweichung", "UTF-8 ohne Byte Order Mark: DATEV liest Unicode nur mit Byte Order Mark und sonst als Windows-1252, Umlaute kämen dort falsch an.");
    return { text: Buffer.from(b).toString("utf8"), zeichensatz: "utf-8", befunde };
  }
  const { text, ungueltig } = ausCp1252(b);
  if (ungueltig.length) melde("abweichung", `${ungueltig.length} Byte(s) sind in Windows-1252 nicht belegt, erstes an Position ${ungueltig[0]}.`);
  return { text, zeichensatz: "windows-1252", befunde };
}

/**
 * Eine Zeile in Felder teilen. Je Feld: roh (wie in der Datei), wert (ohne Anführungszeichen, verdoppelte aufgelöst) und
 * text (stand in Anführungszeichen). Ein Textfeld darf ein Semikolon enthalten. „offen“ meldet ein nicht geschlossenes Textfeld.
 */
export function felder(zeile) {
  const aus = [];
  let wert = "", imText = false, warText = false, start = 0;
  const schliesse = (ende) => { aus.push({ roh: zeile.slice(start, ende), wert, text: warText }); wert = ""; warText = false; start = ende + 1; };
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (imText) {
      if (c !== '"') wert += c;
      else if (zeile[i + 1] === '"') { wert += '"'; i++; }
      else imText = false;
    } else if (c === '"' && i === start) { imText = true; warText = true; }
    else if (c === ";") schliesse(i);
    else wert += c;
  }
  schliesse(zeile.length);
  return { felder: aus, offen: imText };
}

const istDatum8 = (s) => {
  if (!/^\d{8}$/.test(s)) return false;
  const j = Number(s.slice(0, 4)), m = Number(s.slice(4, 6)), t = Number(s.slice(6, 8));
  const d = new Date(Date.UTC(j, m - 1, t));
  return d.getUTCFullYear() === j && d.getUTCMonth() === m - 1 && d.getUTCDate() === t;
};
const iso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
/** Letzter Tag des Wirtschaftsjahrs, das am Tag wjBeginn (JJJJMMTT) beginnt, als JJJJMMTT. */
const wjEnde = (wjBeginn) => {
  const d = new Date(Date.UTC(Number(wjBeginn.slice(0, 4)) + 1, Number(wjBeginn.slice(4, 6)) - 1, Number(wjBeginn.slice(6, 8))));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
};

/** Umsatz „1234,56“ in Cent (ganze Zahl), sonst null. Gerechnet wird nie mit Kommazahlen. „64083“ und „1,5“ sind lesbar. */
export function umsatzInCent(s) {
  const m = /^(\d{1,10})(?:,(\d{1,2}))?$/.exec(String(s));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
}
export const centAlsUmsatz = (cent) => `${Math.trunc(cent / 100)},${String(cent % 100).padStart(2, "0")}`;
export const centAlsText = (cent) => `${cent < 0 ? "-" : ""}${Math.trunc(Math.abs(cent) / 100).toLocaleString("de-DE")},${String(Math.abs(cent) % 100).padStart(2, "0")} €`;

/**
 * Belegdatum TTMM zum vollen Datum ergänzen. Das Jahr folgt aus dem Beginn des Wirtschaftsjahrs (Kopffeld 13): Tage ab dem
 * Beginn liegen in dessen Jahr, Tage davor im Folgejahr. Gibt JJJJ-MM-TT zurück oder null, wenn es den Tag dort nicht gibt.
 */
export function vollesDatum(ttmm, wjBeginn) {
  if (!/^\d{4}$/.test(ttmm) || !istDatum8(wjBeginn)) return null;
  const mmtt = `${ttmm.slice(2)}${ttmm.slice(0, 2)}`;
  const jahr = Number(wjBeginn.slice(0, 4)) + (mmtt < wjBeginn.slice(4) ? 1 : 0);
  const kandidat = `${jahr}${mmtt}`;
  return istDatum8(kandidat) ? iso(kandidat) : null;
}

const leer = (feld) => feld === undefined || feld.roh === "" || feld.roh === '""';

/**
 * Stapel lesen und prüfen. Gibt immer ein Ergebnis zurück (auch bei Fehlern), damit ein Aufrufer sehen kann, was gelesen wurde:
 * { ok, formatgerecht, befunde: [{ stufe, zeile, feld, meldung }], zeichensatz, kopf, buchungen, summen: { sollCent, habenCent } }.
 * ok heißt: kein Befund der Stufe fehler. formatgerecht heißt: gar kein Befund.
 */
export function lesen(bytes) {
  const entziffert = entziffern(bytes);
  const befunde = [...entziffert.befunde];
  const melde = (stufe, zeile, feld, meldung) => befunde.push({ stufe, zeile, feld, meldung });
  const text = entziffert.text;
  const ergebnis = (kopf, buchungen, summen) => {
    const ok = !befunde.some((b) => b.stufe === "fehler");
    return { ok, formatgerecht: befunde.length === 0, befunde, zeichensatz: entziffert.zeichensatz, kopf, buchungen, summen };
  };
  if (befunde.some((b) => b.stufe === "fehler")) return ergebnis({}, [], { sollCent: 0, habenCent: 0 });

  if (!text.includes("\r\n")) melde("abweichung", 0, "Zeilenende", "Zeilenende ist nicht CRLF; die Formatbeschreibung verlangt CR/LF am Ende jeder Zeile.");
  else if (/[\r\n]/.test(text.split("\r\n").join(""))) melde("abweichung", 0, "Zeilenende", "Zeilenenden sind gemischt (CRLF und einzelnes LF oder CR).");
  /* An jedem Zeilenende teilen: Bliebe eine LF-Datei eine einzige Zeile, fielen alle weiteren Prüfungen still aus. */
  const zeilen = text.split(/\r\n|\n|\r/);
  while (zeilen.length && zeilen[zeilen.length - 1] === "") zeilen.pop();

  /* Kopfzeile */
  const kopfTeile = felder(zeilen[0] ?? "");
  const kf = kopfTeile.felder;
  const kopf = Object.fromEntries(KOPFFELDER.map((name, i) => [name, kf[i]?.wert ?? ""]));
  if (kf.length !== 31) melde("fehler", 1, "Kopfzeile", `Kopfzeile hat ${kf.length} Felder statt 31.`);
  if (kopfTeile.offen) melde("fehler", 1, "Kopfzeile", "Ein Textfeld der Kopfzeile ist nicht geschlossen (Anführungszeichen fehlt).");
  if (kopf.kennzeichen !== "EXTF" && kopf.kennzeichen !== "DTVF") melde("fehler", 1, "Kennzeichen", `Kennzeichen „${kopf.kennzeichen}“ ist weder EXTF noch DTVF.`);
  if (kopf.versionsnummer !== "700") melde("fehler", 1, "Versionsnummer", `Versionsnummer „${kopf.versionsnummer}“ statt 700.`);
  if (kopf.formatkategorie !== "21" || kopf.formatname !== "Buchungsstapel") melde("fehler", 1, "Formatkategorie", `Formatkategorie „${kopf.formatkategorie}“ mit Formatname „${kopf.formatname}“ ist kein Buchungsstapel (21, „Buchungsstapel“).`);
  const wjOk = istDatum8(kopf.wjBeginn);
  if (!wjOk) melde("fehler", 1, "WJ-Beginn", `Wirtschaftsjahresbeginn „${kopf.wjBeginn}“ ist kein Datum JJJJMMTT; ohne ihn hat kein Belegdatum ein Jahr.`);
  const zeitraumOk = istDatum8(kopf.datumVon) && istDatum8(kopf.datumBis) && kopf.datumVon <= kopf.datumBis;
  if (!zeitraumOk) melde("fehler", 1, "Datum von/bis", `Zeitraum „${kopf.datumVon}“ bis „${kopf.datumBis}“ ist kein gültiger Zeitraum.`);
  else if (wjOk && (kopf.datumVon < kopf.wjBeginn || kopf.datumBis > wjEnde(kopf.wjBeginn))) melde("fehler", 1, "Datum von/bis", `Zeitraum ${iso(kopf.datumVon)} bis ${iso(kopf.datumBis)} liegt nicht im Wirtschaftsjahr ${iso(kopf.wjBeginn)} bis ${iso(wjEnde(kopf.wjBeginn))}.`);
  for (const feld of ["formatversion", "erzeugtAm", "beraternummer", "mandantennummer", "sachkontenlaenge"]) {
    if (leer(kf[K[feld]])) melde("abweichung", 1, FORMAT.kopf[K[feld]].ueberschrift, "Pflichtangabe der Kopfzeile fehlt.");
  }
  kf.slice(0, 31).forEach((f, i) => {
    if (leer(f) || KOPF_AUSDRUCK[i].test(f.roh)) return;
    melde("abweichung", 1, FORMAT.kopf[i].ueberschrift, `${f.roh} entspricht nicht dem Ausdruck ${FORMAT.kopf[i].ausdruck} (Kopffeld ${i + 1}).`);
  });
  const kontenlaenge = /^[4-8]$/.test(kopf.sachkontenlaenge) ? Number(kopf.sachkontenlaenge) : null;

  /* Zeile 2: Die Namen der Spalten unterscheiden sich je nach Herkunft der Datei leicht, geprüft wird deshalb nur ihre Zahl. */
  const ueberschriften = felder(zeilen[1] ?? "").felder.map((f) => f.wert);
  if (ueberschriften.length !== 125) melde("fehler", 2, "Spaltenüberschriften", `Zeile 2 hat ${ueberschriften.length} Spalten statt 125.`);
  const namen = ueberschriften.length === 125 ? ueberschriften : SPALTEN;

  /* Buchungen */
  const buchungen = [];
  let sollCent = 0, habenCent = 0;
  for (let n = 2; n < zeilen.length; n++) {
    const nr = n + 1;
    if (zeilen[n] === "") { melde("fehler", nr, "Zeile", "Leere Zeile mitten im Stapel."); continue; }
    const t = felder(zeilen[n]);
    if (t.offen) melde("fehler", nr, "Zeile", "Ein Textfeld ist nicht geschlossen (Anführungszeichen fehlt).");
    if (t.felder.length !== 125) { melde("fehler", nr, "Zeile", `${t.felder.length} Felder statt 125.`); continue; }
    const f = t.felder;
    const w = f.map((x) => x.wert);
    f.forEach((feld, i) => {
      if (leer(feld) || SPALTEN_AUSDRUCK[i].test(feld.roh)) return;
      melde("abweichung", nr, SPALTEN[i], `${feld.roh} entspricht nicht dem Ausdruck ${FORMAT.spalten[i].ausdruck} (Spalte ${i + 1}).`);
    });
    for (const [a, b, beide] of PAARE) {
      if (!leer(f[a]) && leer(f[b])) melde("abweichung", nr, SPALTEN[b], `„${SPALTEN[a]}“ ist gefüllt, „${SPALTEN[b]}“ fehlt; die Formatbeschreibung verlangt beide.`);
      else if (beide && leer(f[a]) && !leer(f[b])) melde("abweichung", nr, SPALTEN[a], `„${SPALTEN[b]}“ ist gefüllt, „${SPALTEN[a]}“ fehlt; die Formatbeschreibung verlangt beide.`);
    }
    const cent = umsatzInCent(w[S.umsatz]);
    if (leer(f[S.umsatz])) melde("fehler", nr, SPALTEN[S.umsatz], "Umsatz fehlt.");
    else if (cent === null) melde("fehler", nr, SPALTEN[S.umsatz], `Umsatz „${w[S.umsatz]}“ ist nicht lesbar (erwartet 1234,56 ohne Vorzeichen und ohne Tausenderpunkt).`);
    /* Ohne Kennzeichen gilt Soll: So steht es in der Formatbeschreibung („S = SOLL (default)“). */
    const seite = w[S.sollHaben] === "" ? "S" : w[S.sollHaben];
    if (seite !== "S" && seite !== "H") melde("fehler", nr, SPALTEN[S.sollHaben], `Kennzeichen „${w[S.sollHaben]}“ ist weder S noch H.`);
    for (const i of [S.konto, S.gegenkonto]) {
      if (leer(f[i])) melde("fehler", nr, SPALTEN[i], "Kontonummer fehlt.");
      else if (!/^\d{1,9}$/.test(w[i])) melde("fehler", nr, SPALTEN[i], `„${w[i]}“ ist keine Kontonummer (1 bis 9 Ziffern).`);
      else if (kontenlaenge && w[i].length > kontenlaenge + 1) melde("abweichung", nr, SPALTEN[i], `„${w[i]}“ hat mehr Stellen als die Sachkontenlänge ${kontenlaenge} plus eine Stelle für Personenkonten.`);
    }
    if (w[S.konto] !== "" && Number(w[S.konto]) === Number(w[S.gegenkonto])) melde("fehler", nr, SPALTEN[S.gegenkonto], `Konto und Gegenkonto sind gleich (${w[S.konto]}).`);
    const datum = wjOk ? vollesDatum(w[S.belegdatum], kopf.wjBeginn) : null;
    if (leer(f[S.belegdatum])) melde("fehler", nr, SPALTEN[S.belegdatum], "Belegdatum fehlt.");
    else if (!/^\d{4}$/.test(w[S.belegdatum])) melde("fehler", nr, SPALTEN[S.belegdatum], `Belegdatum „${w[S.belegdatum]}“ ist nicht TTMM.`);
    else if (wjOk && !datum) melde("fehler", nr, SPALTEN[S.belegdatum], `Belegdatum ${w[S.belegdatum]} gibt es im Wirtschaftsjahr ab ${iso(kopf.wjBeginn)} nicht.`);
    else if (zeitraumOk && datum && (datum < iso(kopf.datumVon) || datum > iso(kopf.datumBis))) melde("fehler", nr, SPALTEN[S.belegdatum], `Belegdatum ${datum} liegt nicht im Zeitraum ${iso(kopf.datumVon)} bis ${iso(kopf.datumBis)}.`);
    if (cent !== null) { if (seite === "S") sollCent += cent; else if (seite === "H") habenCent += cent; }
    const weitere = {};
    w.forEach((wert, i) => { if (wert !== "" && !BENANNT.has(i)) weitere[namen[i]] = wert; });
    buchungen.push({
      zeile: nr, umsatz: w[S.umsatz], umsatzCent: cent, sollHaben: seite, wkz: w[S.wkz], konto: w[S.konto], gegenkonto: w[S.gegenkonto],
      buSchluessel: w[S.buSchluessel], belegdatum: w[S.belegdatum], datum, belegfeld1: w[S.belegfeld1], belegfeld2: w[S.belegfeld2],
      buchungstext: w[S.buchungstext], kost1: w[S.kost1], kost2: w[S.kost2], festschreibung: w[S.festschreibung], weitere,
    });
  }
  if (!buchungen.length && zeilen.length <= 2) melde("fehler", 0, "Stapel", "Der Stapel enthält keine Buchung.");
  return ergebnis(kopf, buchungen, { sollCent, habenCent });
}

/** Salden je Konto. Das Soll/Haben-Kennzeichen gilt für „Konto“; das Gegenkonto wird auf der anderen Seite bebucht. */
export function salden(buchungen) {
  const konten = new Map();
  const buche = (konto, seite, cent) => {
    const k = konten.get(konto) ?? { konto, sollCent: 0, habenCent: 0, buchungen: 0 };
    k[seite === "S" ? "sollCent" : "habenCent"] += cent;
    k.buchungen++;
    konten.set(konto, k);
  };
  for (const b of buchungen) {
    if (b.umsatzCent === null || (b.sollHaben !== "S" && b.sollHaben !== "H") || !/^\d{1,9}$/.test(b.konto) || !/^\d{1,9}$/.test(b.gegenkonto)) continue;
    buche(b.konto, b.sollHaben, b.umsatzCent);
    buche(b.gegenkonto, b.sollHaben === "S" ? "H" : "S", b.umsatzCent);
  }
  return [...konten.values()].map((k) => ({ ...k, saldoCent: k.sollCent - k.habenCent })).sort((a, b) => Number(a.konto) - Number(b.konto) || a.konto.localeCompare(b.konto));
}

/** Buchungen filtern. Alle Angaben sind wahlweise und werden mit UND verbunden; „konto“ trifft Konto oder Gegenkonto. */
export function suchen(buchungen, { konto, text, von, bis, betragAbCent, betragBisCent, sollHaben } = {}) {
  const nadel = text ? String(text).toLocaleLowerCase("de") : null;
  return buchungen.filter((b) => {
    if (konto && b.konto !== String(konto) && b.gegenkonto !== String(konto)) return false;
    if (sollHaben && b.sollHaben !== sollHaben) return false;
    if (nadel && !`${b.buchungstext} ${b.belegfeld1} ${b.belegfeld2}`.toLocaleLowerCase("de").includes(nadel)) return false;
    if (von && (!b.datum || b.datum < von)) return false;
    if (bis && (!b.datum || b.datum > bis)) return false;
    if (betragAbCent !== undefined && (b.umsatzCent === null || b.umsatzCent < betragAbCent)) return false;
    if (betragBisCent !== undefined && (b.umsatzCent === null || b.umsatzCent > betragBisCent)) return false;
    return true;
  });
}

const textfeld = (s) => `"${String(s ?? "").replaceAll('"', '""')}"`;

/**
 * Stapel schreiben. kopf: { beraternummer, mandantennummer, wjBeginn (JJJJ-MM-TT), bezeichnung, sachkontenrahmen ("03", "04"),
 * sachkontenlaenge (Standard 4), exportiertVon, diktatkuerzel, erzeugt (Date) }. buchungen: [{ umsatzCent, sollHaben, konto,
 * gegenkonto, datum (JJJJ-MM-TT), buchungstext, belegfeld1, belegfeld2, buSchluessel, kost1, kost2 }]. Der Zeitraum der Kopfzeile
 * folgt aus den Buchungen. Geschrieben wird in Windows-1252 und nie festgeschrieben (Festschreibung 0): Der Steuerberater soll
 * ändern können. Leere Textfelder stehen wie in den Musterdaten von DATEV als "".
 * Gibt { bytes, pruefung } zurück; wirft, wenn der fertige Stapel auch nur einen Befund hat (Fehler oder Abweichung).
 */
export function schreiben(kopf, buchungen) {
  if (!Array.isArray(buchungen) || !buchungen.length) throw new Error("Keine Buchungen übergeben.");
  const tage = buchungen.map((b) => String(b.datum ?? "")).sort();
  if (tage.some((t) => !/^\d{4}-\d{2}-\d{2}$/.test(t) || !istDatum8(t.replaceAll("-", "")))) throw new Error("Jede Buchung braucht ein Datum im Format JJJJ-MM-TT.");
  const wj = String(kopf.wjBeginn ?? "").replaceAll("-", "");
  if (!istDatum8(wj)) throw new Error("Der Beginn des Wirtschaftsjahrs fehlt oder ist kein Datum JJJJ-MM-TT.");
  const von = tage[0].replaceAll("-", ""), bis = tage[tage.length - 1].replaceAll("-", "");
  if (von < wj || bis > wjEnde(wj)) throw new Error(`Die Buchungen (${tage[0]} bis ${tage[tage.length - 1]}) liegen nicht alle im Wirtschaftsjahr ${iso(wj)} bis ${iso(wjEnde(wj))}; ein Stapel gehört zu genau einem Wirtschaftsjahr.`);
  const e = kopf.erzeugt ?? new Date();
  const z2 = (n, l = 2) => String(n).padStart(l, "0");
  const stempel = `${e.getFullYear()}${z2(e.getMonth() + 1)}${z2(e.getDate())}${z2(e.getHours())}${z2(e.getMinutes())}${z2(e.getSeconds())}${z2(e.getMilliseconds(), 3)}`;
  const kopfzeile = [
    textfeld("EXTF"), 700, 21, textfeld("Buchungsstapel"), 13, stempel, "", textfeld("RE"), textfeld(kopf.exportiertVon ?? ""), textfeld(""),
    kopf.beraternummer, kopf.mandantennummer, wj, kopf.sachkontenlaenge ?? 4, von, bis,
    textfeld(kopf.bezeichnung ?? ""), textfeld(kopf.diktatkuerzel ?? ""), 1, 0, 0, textfeld("EUR"), "", textfeld(""), "", "",
    textfeld(kopf.sachkontenrahmen ?? ""), "", "", textfeld(""), textfeld(""),
  ];
  const zeilen = buchungen.map((b) => {
    const f = FORMAT.spalten.map((s) => (s.text ? '""' : ""));
    f[S.umsatz] = Number.isInteger(b.umsatzCent) && b.umsatzCent >= 0 ? centAlsUmsatz(b.umsatzCent) : String(b.umsatzCent);
    f[S.sollHaben] = textfeld(b.sollHaben);
    f[S.wkz] = textfeld("EUR");
    f[S.konto] = String(b.konto ?? "");
    f[S.gegenkonto] = String(b.gegenkonto ?? "");
    f[S.buSchluessel] = textfeld(b.buSchluessel);
    f[S.belegdatum] = `${b.datum.slice(8, 10)}${b.datum.slice(5, 7)}`;
    f[S.belegfeld1] = textfeld(b.belegfeld1);
    f[S.belegfeld2] = textfeld(b.belegfeld2);
    f[S.buchungstext] = textfeld(b.buchungstext);
    f[S.kost1] = textfeld(b.kost1);
    f[S.kost2] = textfeld(b.kost2);
    f[S.festschreibung] = "0";
    return f.join(";");
  });
  const text = [kopfzeile.join(";"), SPALTEN.join(";"), ...zeilen].join("\r\n") + "\r\n";
  const { bytes, fehlend } = nachCp1252(text);
  const pruefung = lesen(bytes);
  if (fehlend.length) pruefung.befunde.push({ stufe: "fehler", zeile: 0, feld: "Zeichensatz", meldung: `Zeichen ohne Platz in Windows-1252: ${[...new Set(fehlend)].join(" ")}` });
  if (pruefung.befunde.length) {
    const fehler = new Error(`Der Stapel besteht die Prüfung nicht: ${pruefung.befunde.slice(0, 5).map((x) => `Zeile ${x.zeile}, ${x.feld}: ${x.meldung}`).join(" | ")}`);
    fehler.befunde = pruefung.befunde;
    fehler.vermerk = `Prüfung nicht bestanden, ${pruefung.befunde.length} Befund(e)`;
    throw fehler;
  }
  return { bytes, pruefung };
}
