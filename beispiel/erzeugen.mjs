/**
 * erzeugen.mjs: schreibt zwei Musterstapel in diesen Ordner. Alle Angaben sind erfunden (Berater 1001, Mandant 1, Musterfirmen);
 * kein echter Buchungsbestand. Der Zeitstempel ist fest, damit ein erneuter Lauf dieselben Bytes liefert.
 *
 *   EXTF_Buchungsstapel_Muster.csv            ohne Befund, 14 Buchungen im März 2026, SKR 03
 *   EXTF_Buchungsstapel_Muster_fehlerhaft.csv derselbe Stapel mit sechs typischen Mängeln, zum Ausprobieren von stapel_pruefen:
 *                                             vier Fehler (nicht auswertbar), dazu fünf Abweichungen von der Formatbeschreibung
 *
 * Aufruf: node beispiel/erzeugen.mjs
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { schreiben, ausCp1252, nachCp1252 } from "../src/extf.mjs";

export const KOPF = { beraternummer: 1001, mandantennummer: 1, wjBeginn: "2026-01-01", bezeichnung: "Muster 03/2026", sachkontenrahmen: "03", erzeugt: new Date(2026, 3, 2, 9, 0, 0, 0) };

/* SKR 03: 1200 Bank, 1000 Kasse, 8400 Erlöse 19 %, 4210 Miete, 4930 Bürobedarf, 4920 Telefon, 4360 Versicherungen,
   3400 Wareneingang 19 %, 1800 Privatentnahmen; 10000 bis 69999 Debitoren, 70000 bis 99999 Kreditoren. */
export const BUCHUNGEN = [
  { datum: "2026-03-02", umsatzCent: 119000, sollHaben: "S", konto: "10001", gegenkonto: "8400", belegfeld1: "RE-2026-031", buchungstext: "Musterbau GmbH; Wartung Februar" },
  { datum: "2026-03-03", umsatzCent: 85000, sollHaben: "S", konto: "4210", gegenkonto: "1200", belegfeld1: "MIETE-03", buchungstext: "Miete Büro März" },
  { datum: "2026-03-04", umsatzCent: 5950, sollHaben: "S", konto: "4930", gegenkonto: "70002", belegfeld1: "B-44871", buchungstext: "Papier und Toner" },
  { datum: "2026-03-05", umsatzCent: 238000, sollHaben: "S", konto: "10002", gegenkonto: "8400", belegfeld1: "RE-2026-032", buchungstext: "Beispiel & Söhne KG, Projekt \"Lager\"" },
  { datum: "2026-03-09", umsatzCent: 119000, sollHaben: "S", konto: "1200", gegenkonto: "10001", belegfeld1: "RE-2026-031", buchungstext: "Zahlung Musterbau GmbH" },
  { datum: "2026-03-10", umsatzCent: 4165, sollHaben: "S", konto: "4920", gegenkonto: "70003", belegfeld1: "T-2026-03", buchungstext: "Telefon und Internet" },
  { datum: "2026-03-12", umsatzCent: 357000, sollHaben: "S", konto: "3400", gegenkonto: "70001", belegfeld1: "ER-90112", buchungstext: "Wareneingang Großhandel Nord" },
  { datum: "2026-03-13", umsatzCent: 5950, sollHaben: "S", konto: "70002", gegenkonto: "1200", belegfeld1: "B-44871", buchungstext: "Zahlung Papier und Toner" },
  { datum: "2026-03-16", umsatzCent: 47600, sollHaben: "S", konto: "10003", gegenkonto: "8400", belegfeld1: "RE-2026-033", buchungstext: "Praxis Dr. Muster, Einrichtung" },
  { datum: "2026-03-18", umsatzCent: 12900, sollHaben: "S", konto: "4360", gegenkonto: "1200", belegfeld1: "VS-2026-1", buchungstext: "Betriebshaftpflicht 1. Quartal" },
  { datum: "2026-03-20", umsatzCent: 200000, sollHaben: "S", konto: "70001", gegenkonto: "1200", belegfeld1: "ER-90112", buchungstext: "Teilzahlung Großhandel Nord" },
  { datum: "2026-03-24", umsatzCent: 30000, sollHaben: "S", konto: "1800", gegenkonto: "1200", belegfeld1: "PE-03", buchungstext: "Privatentnahme" },
  { datum: "2026-03-27", umsatzCent: 238000, sollHaben: "S", konto: "1200", gegenkonto: "10002", belegfeld1: "RE-2026-032", buchungstext: "Zahlung Beispiel & Söhne KG" },
  { datum: "2026-03-31", umsatzCent: 2380, sollHaben: "H", konto: "1000", gegenkonto: "4930", belegfeld1: "K-0331", buchungstext: "Briefmarken bar" },
];

/* Sechs Mängel, wie sie in selbst erzeugten Stapeln vorkommen: [gesuchte Stelle, Ersatz]. Jede Stelle muss genau einmal treffen. */
export const MAENGEL = [
  ['1190,00;"S";"EUR";;;"";10001;8400', '1.190,00;"S";"EUR";;;"";10001;8400'],   // Fehler: Tausenderpunkt im Umsatz
  [';4210;1200;"";0303;', ';4210;1200;"";0304;'],                                // Fehler: Belegdatum 3. April, Zeitraum endet am 31. März
  ['59,50;"S";"EUR";;;"";4930;70002', '59,50;"X";"EUR";;;"";4930;70002'],        // Fehler: Kennzeichen weder S noch H
  [';1800;1200;"";2403;', ';1200;1200;"";2403;'],                                // Fehler: Konto gleich Gegenkonto
  ['"T-2026-03"', '"T 2026/03 #1"'],                                             // Abweichung: Leerzeichen und # im Belegfeld 1
  ['2380,00;"S";"EUR";;;"";10002;8400', '2380,00;S;EUR;;;"";10002;8400'],        // zwei Abweichungen: Textfelder ohne Anführungszeichen
];

/** Den fehlerhaften Stapel aus dem sauberen ableiten. Wirft, wenn eine Stelle nicht genau einmal vorkommt. */
export function mitMaengeln(bytes) {
  let text = ausCp1252(bytes).text;
  for (const [alt, neu] of MAENGEL) {
    if (text.split(alt).length !== 2) throw new Error(`Stelle kommt nicht genau einmal vor: ${alt}`);
    text = text.replace(alt, neu);
  }
  return nachCp1252(text).bytes;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const ordner = new URL("./", import.meta.url);
  const { bytes } = schreiben(KOPF, BUCHUNGEN);
  fs.writeFileSync(new URL("EXTF_Buchungsstapel_Muster.csv", ordner), bytes);
  fs.writeFileSync(new URL("EXTF_Buchungsstapel_Muster_fehlerhaft.csv", ordner), mitMaengeln(bytes));
  console.log(`geschrieben: EXTF_Buchungsstapel_Muster.csv (${bytes.length} Bytes, ${BUCHUNGEN.length} Buchungen) und EXTF_Buchungsstapel_Muster_fehlerhaft.csv`);
}
