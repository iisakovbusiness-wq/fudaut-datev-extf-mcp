#!/usr/bin/env node
/**
 * server.mjs: MCP-Server für DATEV-Buchungsstapel (DATEV-Format, Formatkategorie 21). Ein KI-Assistent mit MCP-Anschluss kann
 * damit Stapel prüfen, lesen, durchsuchen, Salden bilden und neue Stapel schreiben, ohne das Dateiformat kennen zu müssen.
 *
 * GRENZEN, die im Server liegen und nicht im Modell:
 *   1. Ein Ordner. Jeder Pfad wird gegen DATEV_STAPEL_ORDNER aufgelöst (Standard: Arbeitsverzeichnis); alles außerhalb, auch über
 *      Verknüpfungen, wird abgelehnt. So bleibt ein Mandant ein Ordner.
 *   2. Lesen ist der Normalfall. Schreiben gibt es nur als neue Datei (nie überschreiben), nie festgeschrieben, und nur wenn
 *      DATEV_STAPEL_SCHREIBEN=1 gesetzt ist; der fertige Stapel muss die eigene Prüfung ohne jeden Befund bestehen.
 *   3. Protokoll. Jeder Aufruf schreibt eine Zeile nach stderr (Zeit, Werkzeug, Datei, Ergebnis), ohne Beträge und ohne Texte.
 * Der Server ruft nichts im Netz auf und entscheidet nichts Steuerliches; Konten und Schlüssel kommen vom Anwender.
 *
 * START: node src/server.mjs   (stdio; stdout gehört dem Protokoll, Meldungen gehen nach stderr)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { lesen, salden, suchen, schreiben, centAlsText, FORMAT } from "./extf.mjs";

const BASIS = fs.realpathSync(path.resolve(process.env.DATEV_STAPEL_ORDNER ?? process.cwd()));
const SCHREIBEN_ERLAUBT = process.env.DATEV_STAPEL_SCHREIBEN === "1";
const HOECHSTENS = 200;
const GROESSTE_DATEI = 20 * 1024 * 1024;

const protokoll = (werkzeug, datei, ergebnis) => console.error(JSON.stringify({ zeit: new Date().toISOString(), werkzeug, datei, ergebnis }));

/** Pfad im freigegebenen Ordner auflösen; wirft bei allem, was hinausführt (auch über eine Verknüpfung). */
function imOrdner(pfad, { mussBestehen }) {
  const voll = path.resolve(BASIS, String(pfad));
  const pruefe = (p) => { const rel = path.relative(BASIS, p); if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Der Pfad „${pfad}“ liegt nicht im freigegebenen Ordner.`); };
  pruefe(voll);
  if (fs.existsSync(voll)) pruefe(fs.realpathSync(voll));
  else if (mussBestehen) throw new Error(`Die Datei „${pfad}“ gibt es im freigegebenen Ordner nicht.`);
  else {
    if (!fs.existsSync(path.dirname(voll))) throw new Error(`Den Zielordner von „${pfad}“ gibt es im freigegebenen Ordner nicht.`);
    pruefe(path.join(fs.realpathSync(path.dirname(voll)), path.basename(voll)));
  }
  return voll;
}
function ladeStapel(pfad) {
  const voll = imOrdner(pfad, { mussBestehen: true });
  const stand = fs.statSync(voll);
  if (!stand.isFile()) throw new Error(`„${pfad}“ ist keine Datei.`);
  if (stand.size > GROESSTE_DATEI) throw new Error(`„${pfad}“ ist größer als 20 MB und wird nicht gelesen.`);
  return lesen(fs.readFileSync(voll));
}

const kurz = (b) => ({ zeile: b.zeile, datum: b.datum, umsatzCent: b.umsatzCent, sollHaben: b.sollHaben, konto: b.konto, gegenkonto: b.gegenkonto, buSchluessel: b.buSchluessel, belegfeld1: b.belegfeld1, buchungstext: b.buchungstext });
const buchungszeile = (b) => `${b.datum ?? "?"}  ${centAlsText(b.umsatzCent ?? 0).padStart(14)} ${b.sollHaben}  ${b.konto} / ${b.gegenkonto}  ${b.buchungstext}`;
const anzahl = (befunde, stufe) => befunde.filter((b) => b.stufe === stufe).length;
/** Gleichartige Befunde (Stufe und Feld) zusammenfassen: Anzahl, die ersten Zeilen, die erste Meldung als Beispiel. */
function gruppiert(befunde) {
  const gruppen = new Map();
  for (const b of befunde) {
    const g = gruppen.get(`${b.stufe}|${b.feld}`) ?? { stufe: b.stufe, feld: b.feld, anzahl: 0, zeilen: [], beispiel: b.meldung };
    g.anzahl++;
    if (g.zeilen.length < 10) g.zeilen.push(b.zeile);
    gruppen.set(`${b.stufe}|${b.feld}`, g);
  }
  return [...gruppen.values()].sort((a, b) => (a.stufe === b.stufe ? b.anzahl - a.anzahl : a.stufe === "fehler" ? -1 : 1));
}
const vorbehalt = (s) => (s.ok ? "" : ` Achtung: Die Prüfung meldet ${anzahl(s.befunde, "fehler")} Fehler, die Angaben sind deshalb unvollständig; Einzelheiten nennt stapel_pruefen.`);

/** Ein Werkzeug so einhüllen, dass ein Fehler als Ergebnis mit isError beim Assistenten ankommt und im Protokoll steht. */
const werkzeug = (name, fn) => async (eingabe) => {
  try {
    const { text, daten, vermerk } = await fn(eingabe);
    protokoll(name, eingabe.pfad ?? eingabe.ziel ?? "", vermerk);
    return { content: [{ type: "text", text }], structuredContent: daten };
  } catch (e) {
    /* Ins Protokoll geht der Vermerk ohne Feldinhalte; die volle Meldung bekommt nur der Aufrufer. */
    protokoll(name, eingabe?.pfad ?? eingabe?.ziel ?? "", `Fehler: ${e.vermerk ?? e.message}`);
    return { content: [{ type: "text", text: `Fehler: ${e.message}` }], isError: true };
  }
};

const BUCHUNG = z.object({ zeile: z.number(), datum: z.string().nullable(), umsatzCent: z.number().nullable(), sollHaben: z.string(), konto: z.string(), gegenkonto: z.string(), buSchluessel: z.string(), belegfeld1: z.string(), buchungstext: z.string() });
const BEFUND = z.object({ stufe: z.enum(["fehler", "abweichung"]), zeile: z.number(), feld: z.string(), meldung: z.string() });
const GRUPPE = z.object({ stufe: z.enum(["fehler", "abweichung"]), feld: z.string(), anzahl: z.number(), zeilen: z.array(z.number()), beispiel: z.string() });
const PFAD = z.string().min(1).describe("Pfad des Buchungsstapels, relativ zum freigegebenen Ordner, zum Beispiel EXTF_Buchungsstapel_2026.csv");
const TAG = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const KONTO = z.string().regex(/^(?!0+$)\d{1,9}$/);

export function baueServer() {
  const server = new McpServer({ name: "datev-stapel", version: "1.0.0" });

  server.registerTool("stapel_pruefen", {
    title: "Buchungsstapel prüfen",
    description: `Prüft einen DATEV-Buchungsstapel (DATEV-Format, EXTF oder DTVF) gegen die Formatbeschreibung der DATEV eG (Stand ${FORMAT.quelle.abgerufen}): 31 Kopffelder und 125 Spalten je Buchung, jedes gefüllte Feld gegen den dort veröffentlichten Ausdruck, dazu Zeichensatz, Zeilenende, Pflichtangaben, Belegdatum im Zeitraum und im Wirtschaftsjahr. Zwei Stufen: „fehler“ (nicht auswertbar oder widersprüchlich) und „abweichung“ (weicht von der Formatbeschreibung ab). Nennt jeden Befund mit Zeile und Feld. Ändert nichts.`,
    inputSchema: z.object({ pfad: PFAD }),
    outputSchema: z.object({ ok: z.boolean(), formatgerecht: z.boolean(), zeichensatz: z.string(), buchungen: z.number(), sollCent: z.number(), habenCent: z.number(), fehlerAnzahl: z.number(), abweichungAnzahl: z.number(), gruppen: z.array(GRUPPE), befunde: z.array(BEFUND) }),
    annotations: { readOnlyHint: true },
  }, werkzeug("stapel_pruefen", ({ pfad }) => {
    const s = ladeStapel(pfad);
    const fehler = anzahl(s.befunde, "fehler"), abweichungen = anzahl(s.befunde, "abweichung");
    const gruppen = gruppiert(s.befunde);
    const daten = { ok: s.ok, formatgerecht: s.formatgerecht, zeichensatz: s.zeichensatz, buchungen: s.buchungen.length, sollCent: s.summen.sollCent, habenCent: s.summen.habenCent, fehlerAnzahl: fehler, abweichungAnzahl: abweichungen, gruppen, befunde: s.befunde.slice(0, HOECHSTENS) };
    const kopf = `${s.buchungen.length} Buchungen gelesen, Soll ${centAlsText(s.summen.sollCent)}, Haben ${centAlsText(s.summen.habenCent)}, Zeichensatz ${s.zeichensatz}.`;
    const text = s.formatgerecht
      ? `Stapel ohne Befund. ${kopf}`
      : `${fehler} Fehler, ${abweichungen} Abweichung(en) von der Formatbeschreibung. ${kopf}\n`
        + gruppen.map((g) => `${g.stufe === "fehler" ? "FEHLER    " : "Abweichung"} ${g.anzahl}×  ${g.feld}  (Zeile ${g.zeilen.join(", ")}${g.anzahl > g.zeilen.length ? ", …" : ""}): ${g.beispiel}`).join("\n");
    return { text, daten, vermerk: s.formatgerecht ? "ohne Befund" : `${fehler} Fehler, ${abweichungen} Abweichungen` };
  }));

  server.registerTool("stapel_lesen", {
    title: "Buchungsstapel lesen",
    description: `Liest Kopfzeile und Buchungen eines DATEV-Buchungsstapels. Das Belegdatum kommt als volles Datum (das Jahr folgt aus dem Beginn des Wirtschaftsjahrs). Liefert höchstens ${HOECHSTENS} Buchungen je Aufruf; mit „ab“ weiterblättern. Ändert nichts.`,
    inputSchema: z.object({ pfad: PFAD, ab: z.number().int().min(0).default(0).describe("Nummer der ersten Buchung, bei 0 beginnend"), anzahl: z.number().int().min(1).max(HOECHSTENS).default(50).describe("Wie viele Buchungen geliefert werden") }),
    outputSchema: z.object({ pruefungOk: z.boolean(), beraternummer: z.string(), mandantennummer: z.string(), wjBeginn: z.string(), zeitraumVon: z.string(), zeitraumBis: z.string(), bezeichnung: z.string(), sachkontenrahmen: z.string(), festgeschrieben: z.boolean(), gesamt: z.number(), ab: z.number(), buchungen: z.array(BUCHUNG) }),
    annotations: { readOnlyHint: true },
  }, werkzeug("stapel_lesen", ({ pfad, ab, anzahl: wieViele }) => {
    const s = ladeStapel(pfad);
    const teil = s.buchungen.slice(ab, ab + wieViele).map(kurz);
    const k = s.kopf;
    const daten = { pruefungOk: s.ok, beraternummer: k.beraternummer ?? "", mandantennummer: k.mandantennummer ?? "", wjBeginn: k.wjBeginn ?? "", zeitraumVon: k.datumVon ?? "", zeitraumBis: k.datumBis ?? "", bezeichnung: k.bezeichnung ?? "", sachkontenrahmen: k.sachkontenrahmen ?? "", festgeschrieben: k.festschreibung === "1" || s.buchungen.some((b) => b.festschreibung === "1"), gesamt: s.buchungen.length, ab, buchungen: teil };
    const text = `„${daten.bezeichnung}“, Berater ${daten.beraternummer}, Mandant ${daten.mandantennummer}, ${daten.zeitraumVon} bis ${daten.zeitraumBis}, SKR ${daten.sachkontenrahmen}: Buchungen ${teil.length ? ab + 1 : 0} bis ${ab + teil.length} von ${s.buchungen.length} (Datum, Umsatz, Seite des Kontos, Konto / Gegenkonto, Text).${vorbehalt(s)}\n`
      + teil.map(buchungszeile).join("\n");
    return { text, daten, vermerk: `${teil.length} von ${s.buchungen.length}` };
  }));

  server.registerTool("buchungen_suchen", {
    title: "Buchungen suchen",
    description: "Sucht Buchungen in einem DATEV-Buchungsstapel nach Konto (trifft Konto oder Gegenkonto), Textteil (Buchungstext und Belegfelder), Zeitraum, Betragsspanne und Seite. Alle Angaben sind wahlweise und gelten zusammen. Ändert nichts.",
    inputSchema: z.object({
      pfad: PFAD,
      konto: z.string().regex(/^\d{1,9}$/).optional().describe("Kontonummer, trifft Konto oder Gegenkonto"),
      text: z.string().min(2).optional().describe("Textteil, Groß- und Kleinschreibung egal"),
      von: TAG.optional().describe("frühestes Belegdatum JJJJ-MM-TT"),
      bis: TAG.optional().describe("spätestes Belegdatum JJJJ-MM-TT"),
      betragAbCent: z.number().int().min(0).optional().describe("kleinster Umsatz in Cent"),
      betragBisCent: z.number().int().min(0).optional().describe("größter Umsatz in Cent"),
      sollHaben: z.enum(["S", "H"]).optional().describe("nur Buchungen mit diesem Kennzeichen"),
    }),
    outputSchema: z.object({ pruefungOk: z.boolean(), treffer: z.number(), summeSollCent: z.number(), summeHabenCent: z.number(), gezeigt: z.number(), buchungen: z.array(BUCHUNG) }),
    annotations: { readOnlyHint: true },
  }, werkzeug("buchungen_suchen", ({ pfad, ...filter }) => {
    const s = ladeStapel(pfad);
    const treffer = suchen(s.buchungen, filter);
    const summe = (seite) => treffer.filter((b) => b.sollHaben === seite).reduce((a, b) => a + (b.umsatzCent ?? 0), 0);
    const teil = treffer.slice(0, HOECHSTENS).map(kurz);
    const daten = { pruefungOk: s.ok, treffer: treffer.length, summeSollCent: summe("S"), summeHabenCent: summe("H"), gezeigt: teil.length, buchungen: teil };
    const text = `${treffer.length} Treffer, Soll ${centAlsText(daten.summeSollCent)}, Haben ${centAlsText(daten.summeHabenCent)}.${vorbehalt(s)}\n`
      + teil.slice(0, 50).map(buchungszeile).join("\n");
    return { text, daten, vermerk: `${treffer.length} Treffer` };
  }));

  server.registerTool("konten_salden", {
    title: "Salden je Konto",
    description: "Bildet aus einem DATEV-Buchungsstapel je Konto die Summen im Soll und im Haben und den Saldo (Soll minus Haben). Das Soll/Haben-Kennzeichen einer Buchung gilt für ihr Konto, das Gegenkonto wird auf der anderen Seite bebucht; Automatikkonten und Steuerschlüssel werden nicht aufgelöst, die Steuer steckt also im Umsatz. Ändert nichts.",
    inputSchema: z.object({ pfad: PFAD }),
    outputSchema: z.object({ pruefungOk: z.boolean(), konten: z.array(z.object({ konto: z.string(), sollCent: z.number(), habenCent: z.number(), saldoCent: z.number(), buchungen: z.number() })), summeSollCent: z.number(), summeHabenCent: z.number() }),
    annotations: { readOnlyHint: true },
  }, werkzeug("konten_salden", ({ pfad }) => {
    const s = ladeStapel(pfad);
    const konten = salden(s.buchungen);
    const summeSollCent = konten.reduce((a, k) => a + k.sollCent, 0), summeHabenCent = konten.reduce((a, k) => a + k.habenCent, 0);
    const daten = { pruefungOk: s.ok, konten, summeSollCent, summeHabenCent };
    const text = `${konten.length} Konten, Summe Soll ${centAlsText(summeSollCent)}, Summe Haben ${centAlsText(summeHabenCent)}.${vorbehalt(s)}\n`
      + konten.map((k) => `${k.konto.padStart(9)}  Soll ${centAlsText(k.sollCent).padStart(14)}  Haben ${centAlsText(k.habenCent).padStart(14)}  Saldo ${centAlsText(k.saldoCent).padStart(15)}`).join("\n");
    return { text, daten, vermerk: `${konten.length} Konten` };
  }));

  server.registerTool("stapel_schreiben", {
    title: "Buchungsstapel schreiben",
    description: "Schreibt aus Buchungen einen neuen DATEV-Buchungsstapel als Datei im freigegebenen Ordner (Windows-1252, CRLF, Textfelder in Anführungszeichen). Überschreibt nie, schreibt nie festgeschrieben, und nur wenn der Betreiber das Schreiben eingeschaltet hat. Der fertige Stapel wird vor dem Speichern gegen die Formatbeschreibung geprüft; hat er auch nur einen Befund, wird nichts gespeichert. Konten und Steuerschlüssel werden nicht bewertet.",
    inputSchema: z.object({
      ziel: z.string().regex(/(^|[\\/])EXTF_[^\\/]+\.csv$/i).describe("Dateiname der neuen Datei; das DATEV-Format verlangt den Anfang EXTF_ und die Endung .csv"),
      beraternummer: z.number().int().min(1001).max(9999999).describe("DATEV-Beraternummer des Steuerberaters"),
      mandantennummer: z.number().int().min(1).max(99999).describe("DATEV-Mandantennummer"),
      wjBeginn: TAG.describe("Beginn des Wirtschaftsjahrs JJJJ-MM-TT; alle Buchungen müssen in diesem Wirtschaftsjahr liegen"),
      bezeichnung: z.string().regex(/^[\w./ ]{0,30}$/).describe("Bezeichnung des Stapels: höchstens 30 Zeichen aus Buchstaben ohne Umlaute, Ziffern, Punkt, Schrägstrich und Leerzeichen, zum Beispiel Rechnungsausgang 03/2026"),
      sachkontenrahmen: z.string().regex(/^\d{2}$/).describe("Sachkontenrahmen, zum Beispiel 03 oder 04"),
      sachkontenlaenge: z.number().int().min(4).max(8).default(4).describe("Nummernlänge der Sachkonten; muss zum Mandanten in DATEV passen"),
      buchungen: z.array(z.object({
        datum: TAG.describe("Belegdatum JJJJ-MM-TT"),
        umsatzCent: z.number().int().min(1).max(999999999999).describe("Umsatz in Cent, ohne Vorzeichen"),
        sollHaben: z.enum(["S", "H"]).describe("Seite, auf der das Konto bebucht wird"),
        konto: KONTO.describe("Sach- oder Personenkonto"),
        gegenkonto: KONTO.describe("Gegenkonto ohne BU-Schlüssel"),
        buchungstext: z.string().max(60).regex(/^[^\x00-\x1f]*$/).describe("höchstens 60 Zeichen, ohne Zeilenumbruch"),
        belegfeld1: z.string().regex(/^[\w$&%*+\-/]{0,36}$/).optional().describe("Rechnungs- oder Belegnummer: Buchstaben ohne Umlaute, Ziffern und $ & % * + - /"),
        buSchluessel: z.string().regex(/^\d{1,4}$/).optional().describe("BU-Schlüssel, vom Anwender vorgegeben"),
        kost1: z.string().regex(/^[\w ]{0,36}$/).optional().describe("Kostenstelle KOST1"),
        kost2: z.string().regex(/^[\w ]{0,36}$/).optional().describe("Kostenstelle KOST2"),
      })).min(1).max(5000),
    }),
    outputSchema: z.object({ datei: z.string(), buchungen: z.number(), sollCent: z.number(), habenCent: z.number(), bytes: z.number(), festgeschrieben: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, werkzeug("stapel_schreiben", ({ ziel, buchungen, ...kopf }) => {
    if (!SCHREIBEN_ERLAUBT) throw new Error("Schreiben ist auf diesem Server ausgeschaltet (DATEV_STAPEL_SCHREIBEN ist nicht 1).");
    const voll = imOrdner(ziel, { mussBestehen: false });
    const { bytes, pruefung } = schreiben(kopf, buchungen);
    /* „wx“: anlegen, aber nie überschreiben; zwei gleichzeitige Aufrufe können sich so nicht überdecken. */
    try { fs.writeFileSync(voll, bytes, { flag: "wx" }); } catch (e) { if (e.code === "EEXIST") throw new Error(`Die Datei „${ziel}“ gibt es schon; überschrieben wird nicht.`); throw e; }
    const daten = { datei: path.relative(BASIS, voll).replaceAll("\\", "/"), buchungen: pruefung.buchungen.length, sollCent: pruefung.summen.sollCent, habenCent: pruefung.summen.habenCent, bytes: bytes.length, festgeschrieben: false };
    return { text: `Geschrieben: ${daten.datei}, ${daten.buchungen} Buchungen, Soll ${centAlsText(daten.sollCent)}, Haben ${centAlsText(daten.habenCent)}, nicht festgeschrieben. Prüfung gegen die Formatbeschreibung ohne Befund.`, daten, vermerk: `${daten.buchungen} Buchungen geschrieben` };
  }));

  return server;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const griff = serveStdio(baueServer);
  console.error(`datev-stapel: bereit auf stdio, Ordner ${BASIS}, Schreiben ${SCHREIBEN_ERLAUBT ? "ein" : "aus"}`);
  process.on("SIGINT", () => { void griff.close(); });
}
