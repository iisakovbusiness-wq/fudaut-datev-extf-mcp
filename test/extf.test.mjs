/**
 * Prüft Lesen, Prüfen und Schreiben von Buchungsstapeln. Jeder Mangel wird am sauberen Musterstapel erzeugt; der saubere Stapel
 * selbst muss ohne Befund bleiben (Gegenprobe), sonst bewiese ein gefundener Mangel nichts.
 *
 * Aufruf: npm test
 * Mit den Musterdaten von DATEV (Download siehe README): DATEV_MUSTERDATEN=<Ordner> npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lesen, schreiben, salden, suchen, felder, vollesDatum, umsatzInCent, centAlsUmsatz, nachCp1252, ausCp1252, FORMAT, SPALTEN } from "../src/extf.mjs";
import { KOPF, BUCHUNGEN, MAENGEL, mitMaengeln } from "../beispiel/erzeugen.mjs";

const sauber = schreiben(KOPF, BUCHUNGEN).bytes;
const text = ausCp1252(sauber).text;
/** Den sauberen Stapel an genau einer Stelle ändern und neu lesen. */
const geaendert = (alt, neu) => {
  assert.equal(text.split(alt).length, 2, `Stelle kommt nicht genau einmal vor: ${alt}`);
  return lesen(nachCp1252(text.replace(alt, neu)).bytes);
};
const hat = (s, stufe, feld) => s.befunde.some((b) => b.stufe === stufe && b.feld === feld);
/* Anfang der ersten Buchung; kommt im Stapel genau einmal vor. */
const ERSTE = '1190,00;"S";"EUR";;;"";10001;8400';
const ZEILE1 = `${ERSTE};"";0203;"RE-2026-031"`;

test("Gegenprobe: der saubere Musterstapel hat keinen Befund", () => {
  const s = lesen(sauber);
  assert.deepEqual(s.befunde, []);
  assert.equal(s.ok, true);
  assert.equal(s.formatgerecht, true);
  assert.equal(s.zeichensatz, "windows-1252");
  assert.equal(s.buchungen.length, 14);
  assert.deepEqual(s.summen, { sollCent: 1462565, habenCent: 2380 });
  assert.equal(s.buchungen[0].datum, "2026-03-02");
  assert.equal(s.buchungen[3].buchungstext, 'Beispiel & Söhne KG, Projekt "Lager"');
  assert.equal(s.buchungen[0].buchungstext, "Musterbau GmbH; Wartung Februar");
});

test("die Dateien unter beispiel/ sind der aktuelle Stand des Erzeugers", () => {
  const ordner = new URL("../beispiel/", import.meta.url);
  assert.ok(sauber.equals(fs.readFileSync(new URL("EXTF_Buchungsstapel_Muster.csv", ordner))));
  assert.ok(mitMaengeln(sauber).equals(fs.readFileSync(new URL("EXTF_Buchungsstapel_Muster_fehlerhaft.csv", ordner))));
});

test("format.json: 31 Kopffelder und 125 Spalten, jeder Ausdruck ausführbar, Herkunft vermerkt", () => {
  assert.equal(FORMAT.kopf.length, 31);
  assert.equal(FORMAT.spalten.length, 125);
  assert.equal(new Set(SPALTEN).size, 125);
  for (const e of [...FORMAT.kopf, ...FORMAT.spalten]) assert.doesNotThrow(() => new RegExp(e.ausdruck), `${e.nr} ${e.ausdruck}`);
  assert.match(FORMAT.quelle.buchungsstapel, /^https:\/\/developer\.datev\.de\//);
  assert.match(FORMAT.quelle.abgerufen, /^\d{4}-\d{2}-\d{2}$/);
  /* Wo vom Wortlaut der Quelle abgewichen wird, steht es mit Begründung dabei; mehr als diese Stellen sind es nicht. */
  const angepasst = [...FORMAT.kopf.map((e) => `K${e.nr}`), ...FORMAT.spalten.map((e) => `S${e.nr}`)].filter((_, i) => [...FORMAT.kopf, ...FORMAT.spalten][i].angepasst);
  assert.deepEqual(angepasst, ["K7", "K23", "K25", "K26", "K29", "S6", "S9", "S20"]);
});

test("Kopfzeile: gleicher Aufbau wie das Beispiel in der Formatbeschreibung von DATEV", () => {
  const beispiel = '"EXTF";700;21;"Buchungsstapel";13;20240130140440439;;"RE";"";"";29098;55003;20240101;4;20240101;20240831;"Buchungsstapel";"WD";1;0;0;"EUR";;"";;;"03";;;"";""';
  const form = (zeile) => felder(zeile).felder.map((f) => (f.text ? "T" : f.roh === "" ? "-" : "Z")).join("");
  /* Feld 18 (Diktatkürzel) ist im Beispiel gefüllt und hier leer; beides sind Textfelder in Anführungszeichen. */
  assert.equal(form(text.split("\r\n")[0]), form(beispiel));
});

test("jeder der sechs Mängel des fehlerhaften Musters wird gefunden: 4 Fehler, 5 Abweichungen", () => {
  const s = lesen(mitMaengeln(sauber));
  assert.equal(s.ok, false);
  assert.equal(s.befunde.filter((b) => b.stufe === "fehler").length, 4);
  assert.equal(s.befunde.filter((b) => b.stufe === "abweichung").length, 5);
  assert.equal(MAENGEL.length, 6);
  /* Jeder Mangel einzeln: allein eingebaut muss er mindestens einen Befund auslösen. */
  for (const [alt, neu] of MAENGEL) assert.ok(geaendert(alt, neu).befunde.length > 0, `kein Befund für ${neu}`);
});

test("Fehler: was den Stapel unauswertbar oder widersprüchlich macht", () => {
  const faelle = [
    ["Umsatz mit Vorzeichen", ERSTE, '-' + ERSTE, "Umsatz (ohne Soll/Haben-Kz)"],
    ["Umsatz fehlt", ERSTE, ERSTE.replace("1190,00", ""), "Umsatz (ohne Soll/Haben-Kz)"],
    ["Kennzeichen unbekannt", ERSTE, ERSTE.replace('"S"', '"A"'), "Soll/Haben-Kennzeichen"],
    ["Konto mit Buchstaben", ";10001;8400;", ";1000A;8400;", "Konto"],
    ["Gegenkonto fehlt", ";10001;8400;", ";10001;;", "Gegenkonto (ohne BU-Schlüssel)"],
    ["Belegdatum gibt es nicht", '"";0203;"RE-2026-031"', '"";3102;"RE-2026-031"', "Belegdatum"],
    ["Belegdatum 29.02. im Jahr 2026", '"";0203;"RE-2026-031"', '"";2902;"RE-2026-031"', "Belegdatum"],
    ["Belegdatum außerhalb des Zeitraums", '"";0203;"RE-2026-031"', '"";0103;"RE-2026-031"', "Belegdatum"],
    ["Belegdatum fehlt", '"";0203;"RE-2026-031"', '"";;"RE-2026-031"', "Belegdatum"],
    ["ein Feld zu wenig", ZEILE1, '1190,00;"S";"EUR";;;"";10001;8400;"";0203', "Zeile"],
    ["Textfeld nicht geschlossen", '"Zahlung Musterbau GmbH"', '"Zahlung Musterbau GmbH', "Zeile"],
    ["Kennzeichen der Kopfzeile", '"EXTF";700', '"ABCD";700', "Kennzeichen"],
    ["Versionsnummer", '"EXTF";700;21', '"EXTF";510;21', "Versionsnummer"],
    ["kein Buchungsstapel", ';21;"Buchungsstapel";13;', ';16;"Debitoren/Kreditoren";5;', "Formatkategorie"],
    ["Wirtschaftsjahr kein Datum", ";1001;1;20260101;4;", ";1001;1;20261301;4;", "WJ-Beginn"],
    ["Zeitraum verdreht", ";20260302;20260331;", ";20260331;20260302;", "Datum von/bis"],
    ["Zeitraum außerhalb des Wirtschaftsjahrs", ";1001;1;20260101;4;", ";1001;1;20250101;4;", "Datum von/bis"],
  ];
  for (const [name, alt, neu, feld] of faelle) {
    const s = geaendert(alt, neu);
    assert.ok(hat(s, "fehler", feld), `${name}: kein Fehler am Feld ${feld}; Befunde ${JSON.stringify(s.befunde.slice(0, 3))}`);
    assert.equal(s.ok, false, name);
  }
});

test("Abweichungen: auswertbar, aber nicht nach der Formatbeschreibung", () => {
  const faelle = [
    ["Umsatz ohne Nachkommastellen", ERSTE, ERSTE.replace("1190,00", "1190"), "Umsatz (ohne Soll/Haben-Kz)"],
    ["Umsatz 0,00", ERSTE, ERSTE.replace("1190,00", "0,00"), "Umsatz (ohne Soll/Haben-Kz)"],
    ["Kennzeichen ohne Anführungszeichen", ERSTE, ERSTE.replace('"S"', "S"), "Soll/Haben-Kennzeichen"],
    ["Konto nur aus Nullen", ";10001;8400;", ";0000;8400;", "Konto"],
    ["Konto länger als Sachkontenlänge plus eins", ";10001;8400;", ";100011;8400;", "Konto"],
    ["BU-Schlüssel fünfstellig", ';10001;8400;"";', ';10001;8400;"12345";', "BU-Schlüssel"],
    ["Belegfeld 1 mit Umlaut", '"RE-2026-033"', '"RÄ-2026-033"', "Belegfeld 1"],
    ["Buchungstext länger als 60 Zeichen", '"Privatentnahme"', `"${"x".repeat(61)}"`, "Buchungstext"],
    ["Bezeichnung mit Umlaut", '"Muster 03/2026"', '"Muster März 2026"', "Bezeichnung"],
    ["Exportiert von mit Bindestrich", ';"RE";"";"";', ';"RE";"mein-export";"";', "Exportiert von"],
    ["Leerfeld der Kopfzeile gefüllt", ';20260402090000000;;"RE"', ';20260402090000000;x;"RE"', "Importiert"],
    ["Beraternummer dreistellig", ";1001;1;20260101;", ";999;1;20260101;", "Beraternummer"],
    ["Beleginfo-Art ohne Inhalt", '"RE-2026-033";"";;"Praxis Dr. Muster, Einrichtung";;"";;;;"";"";""', '"RE-2026-033";"";;"Praxis Dr. Muster, Einrichtung";;"";;;;"";"Quelle";""', "Beleginfo - Inhalt 1"],
  ];
  for (const [name, alt, neu, feld] of faelle) {
    const s = geaendert(alt, neu);
    assert.ok(hat(s, "abweichung", feld), `${name}: keine Abweichung am Feld ${feld}; Befunde ${JSON.stringify(s.befunde.slice(0, 3))}`);
    assert.equal(s.ok, true, `${name} darf kein Fehler sein: ${JSON.stringify(s.befunde.filter((b) => b.stufe === "fehler"))}`);
    assert.equal(s.buchungen.length, 14, name);
  }
  assert.equal(geaendert(ERSTE, ERSTE.replace("1190,00", "1190")).buchungen[0].umsatzCent, 119000);
});

test("ohne Soll/Haben-Kennzeichen gilt Soll, wie es die Formatbeschreibung als Vorgabe nennt", () => {
  const s = geaendert(ERSTE, ERSTE.replace('"S"', '""'));
  assert.deepEqual(s.befunde, []);
  assert.equal(s.buchungen[0].sollHaben, "S");
  assert.equal(s.summen.sollCent, 1462565);
});

test("Zeilenende und Zeichensatz", () => {
  const lf = lesen(nachCp1252(text.replaceAll("\r\n", "\n")).bytes);
  assert.ok(hat(lf, "abweichung", "Zeilenende"));
  assert.equal(lf.buchungen.length, 14, "eine LF-Datei darf nicht zu einer einzigen Zeile werden");
  const gemischt = lesen(nachCp1252(text.replace("\r\n", "\n")).bytes);
  assert.ok(hat(gemischt, "abweichung", "Zeilenende"));

  const utf8 = lesen(Buffer.from(text, "utf8"));
  assert.equal(utf8.zeichensatz, "utf-8");
  assert.ok(hat(utf8, "abweichung", "Zeichensatz"));
  assert.equal(utf8.buchungen[1].buchungstext, "Miete Büro März", "Umlaute müssen trotz falschem Zeichensatz richtig ankommen");
  const bom = lesen(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]));
  assert.equal(bom.zeichensatz, "utf-8-bom");
  assert.equal(bom.buchungen.length, 14);
  assert.equal(bom.kopf.kennzeichen, "EXTF", "das Byte Order Mark darf nicht im ersten Feld landen");
  const utf16 = lesen(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
  assert.equal(utf16.ok, false);
  assert.ok(hat(utf16, "fehler", "Zeichensatz"));
});

test("Windows-1252: jedes belegte Zeichen übersteht Hin- und Rückweg", () => {
  const alle = Buffer.from(Array.from({ length: 256 }, (_, i) => i).filter((b) => ![0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(b)));
  const { text: t, ungueltig } = ausCp1252(alle);
  assert.deepEqual(ungueltig, []);
  const zurueck = nachCp1252(t);
  assert.deepEqual(zurueck.fehlend, []);
  assert.ok(zurueck.bytes.equals(alle));
  assert.deepEqual([...nachCp1252("€äß").bytes], [0x80, 0xe4, 0xdf]);
  assert.deepEqual(nachCp1252("a→b").fehlend, ["→"]);
  assert.deepEqual(ausCp1252(Buffer.from([0x41, 0x81])).ungueltig, [1]);
});

test("felder(): Anführungszeichen, verdoppelte Anführungszeichen, Semikolon im Text", () => {
  const { felder: f, offen } = felder('"a;b";"c""d";;x;""');
  assert.equal(offen, false);
  assert.deepEqual(f.map((x) => x.wert), ["a;b", 'c"d', "", "x", ""]);
  assert.deepEqual(f.map((x) => x.roh), ['"a;b"', '"c""d"', "", "x", '""']);
  assert.deepEqual(f.map((x) => x.text), [true, true, false, false, true]);
  assert.equal(felder('"offen;1').offen, true);
});

test("Belegdatum: das Jahr folgt aus dem Beginn des Wirtschaftsjahrs", () => {
  assert.equal(vollesDatum("0203", "20260101"), "2026-03-02");
  assert.equal(vollesDatum("3112", "20260101"), "2026-12-31");
  /* abweichendes Wirtschaftsjahr ab 1. Juli */
  assert.equal(vollesDatum("0107", "20250701"), "2025-07-01");
  assert.equal(vollesDatum("3112", "20250701"), "2025-12-31");
  assert.equal(vollesDatum("0101", "20250701"), "2026-01-01");
  assert.equal(vollesDatum("3006", "20250701"), "2026-06-30");
  /* 29. Februar: nur wenn das Jahr, in das er fällt, ein Schaltjahr ist */
  assert.equal(vollesDatum("2902", "20230701"), "2024-02-29");
  assert.equal(vollesDatum("2902", "20240701"), null);
  assert.equal(vollesDatum("2902", "20240101"), "2024-02-29");
  assert.equal(vollesDatum("3102", "20260101"), null);
  assert.equal(vollesDatum("1x03", "20260101"), null);
});

test("Umsatz in Cent: ohne Kommazahlen gerechnet", () => {
  assert.equal(umsatzInCent("1234567890,12"), 123456789012);
  assert.equal(umsatzInCent("0,07"), 7);
  assert.equal(umsatzInCent("64083"), 6408300);
  assert.equal(umsatzInCent("1,5"), 150);
  for (const s of ["1.190,00", "-5,00", "5,123", "", "abc", "5.00"]) assert.equal(umsatzInCent(s), null, s);
  assert.equal(centAlsUmsatz(7), "0,07");
  assert.equal(centAlsUmsatz(119000), "1190,00");
});

test("Salden: Kennzeichen gilt für das Konto, das Gegenkonto steht auf der anderen Seite", () => {
  const konten = salden(lesen(sauber).buchungen);
  const k = Object.fromEntries(konten.map((x) => [x.konto, x]));
  assert.deepEqual(k["1200"], { konto: "1200", sollCent: 357000, habenCent: 333850, buchungen: 7, saldoCent: 23150 });
  assert.equal(k["10001"].saldoCent, 0);
  assert.equal(k["8400"].saldoCent, -404600);
  assert.deepEqual(k["1000"], { konto: "1000", sollCent: 0, habenCent: 2380, buchungen: 1, saldoCent: -2380 });
  assert.equal(k["4930"].saldoCent, 5950 + 2380);
  const soll = konten.reduce((a, x) => a + x.sollCent, 0), haben = konten.reduce((a, x) => a + x.habenCent, 0);
  assert.equal(soll, haben, "jede Buchung steht einmal im Soll und einmal im Haben");
  assert.equal(soll, 1462565 + 2380);
  assert.deepEqual(konten.map((x) => x.konto), [...konten.map((x) => x.konto)].sort((a, b) => Number(a) - Number(b)));
});

test("Suchen: Konto, Text, Zeitraum, Betrag, Seite", () => {
  const b = lesen(sauber).buchungen;
  assert.deepEqual(suchen(b, { konto: "8400" }).map((x) => x.zeile), [3, 6, 11]);
  assert.deepEqual(suchen(b, { text: "GROSSHANDEL" }).length, 0, "ß ist kein ss");
  assert.deepEqual(suchen(b, { text: "großhandel" }).map((x) => x.zeile), [9, 13]);
  assert.deepEqual(suchen(b, { text: "re-2026-032" }).map((x) => x.zeile), [6, 15]);
  assert.deepEqual(suchen(b, { von: "2026-03-20", bis: "2026-03-27" }).map((x) => x.zeile), [13, 14, 15]);
  assert.deepEqual(suchen(b, { betragAbCent: 238000, betragBisCent: 238000 }).map((x) => x.zeile), [6, 15]);
  assert.deepEqual(suchen(b, { sollHaben: "H" }).map((x) => x.zeile), [16]);
  assert.deepEqual(suchen(b, { konto: "1200", betragAbCent: 100000, sollHaben: "S" }).map((x) => x.zeile), [7, 13, 15]);
  assert.equal(suchen(b, {}).length, 14);
});

test("Schreiben: nur ohne jeden Befund, sonst wird nichts geliefert", () => {
  const eine = [{ datum: "2026-03-02", umsatzCent: 100, sollHaben: "S", konto: "4930", gegenkonto: "1200", buchungstext: "Probe", buSchluessel: "9" }];
  const gut = schreiben(KOPF, eine);
  assert.equal(gut.pruefung.formatgerecht, true);
  assert.match(ausCp1252(gut.bytes).text.split("\r\n")[2], /^1,00;"S";"EUR";;;"";4930;1200;"9";0203;"";"";;"Probe";/);
  assert.equal(gut.pruefung.buchungen[0].festschreibung, "0", "geschrieben wird nie festgeschrieben");
  assert.equal(gut.pruefung.kopf.festschreibung, "0");
  const wirft = (kopf, buchungen, muster) => assert.throws(() => schreiben(kopf, buchungen), muster);
  wirft(KOPF, [], /Keine Buchungen/);
  wirft(KOPF, [{ ...eine[0], datum: "02.03.2026" }], /Datum im Format/);
  wirft(KOPF, [{ ...eine[0], gegenkonto: "4930" }], /Konto und Gegenkonto sind gleich/);
  wirft(KOPF, [{ ...eine[0], buchungstext: "Pfeil → hier" }], /Windows-1252/);
  wirft(KOPF, [{ ...eine[0], sollHaben: "X" }], /weder S noch H/);
  wirft(KOPF, [{ ...eine[0], belegfeld1: "mit Leerzeichen" }], /Belegfeld 1/);
  wirft(KOPF, [{ ...eine[0], umsatzCent: 0 }], /Umsatz/);
  wirft(KOPF, [{ ...eine[0], umsatzCent: 10.5 }], /Umsatz/);
  wirft({ ...KOPF, bezeichnung: "März" }, eine, /Bezeichnung/);
  wirft({ ...KOPF, wjBeginn: undefined }, eine, /Wirtschaftsjahrs/);
  wirft(KOPF, [eine[0], { ...eine[0], datum: "2027-01-05" }], /genau einem Wirtschaftsjahr/);
  /* abweichendes Wirtschaftsjahr: Juli 2025 bis Juni 2026 in einem Stapel */
  const schief = schreiben({ ...KOPF, wjBeginn: "2025-07-01" }, [{ ...eine[0], datum: "2025-12-31" }, { ...eine[0], datum: "2026-01-02" }]);
  assert.deepEqual(schief.pruefung.buchungen.map((x) => x.datum), ["2025-12-31", "2026-01-02"]);
  assert.equal(schief.pruefung.kopf.datumVon, "20251231");
});

test("Musterdaten von DATEV (nur wenn DATEV_MUSTERDATEN gesetzt ist)", { skip: !process.env.DATEV_MUSTERDATEN }, () => {
  const s = lesen(fs.readFileSync(path.join(process.env.DATEV_MUSTERDATEN, "EXTF_Buchungsstapel.csv")));
  assert.equal(s.buchungen.length, 54);
  assert.equal(s.befunde.filter((b) => b.stufe === "fehler").length, 0, "die Musterdatei von DATEV muss auswertbar sein");
  /* Stand der Musterdatei vom 13.10.2026: Die Prüfung meldet 21 Abweichungen und keinen Fehler. Sie prüft den BU-Schlüssel mit einer
     bis vier Ziffern statt der wörtlich verlangten vier; mit dem wörtlichen Ausdruck wären es 34 (Prüfprotokoll Abschnitt 3). */
  const jeFeld = {};
  for (const b of s.befunde) jeFeld[b.feld] = (jeFeld[b.feld] ?? 0) + 1;
  assert.deepEqual(jeFeld, { "Zeichensatz": 1, "Geschäftspartnerbank": 1, "SEPA-Mandatsreferenz": 1, "Umsatz (ohne Soll/Haben-Kz)": 1, "Kost-Menge": 2, "Erlöskonto (Anzahlungen)": 12, "Kurs": 2, "Datum Zuord. Steuerperiode": 1 });
});
