"""format-uebernehmen.py: baut src/format.json aus der Formatbeschreibung der DATEV eG neu.

Nichts wird abgetippt: Nummer, Überschrift und Ausdruck jedes Feldes kommen aus dem Text der beiden Seiten der Formatbeschreibung
(Kopfzeile und Buchungsstapel), die Spaltennamen der Zeile 2 aus der Musterdatei von DATEV. Jede Unregelmäßigkeit der Quelle ist
unten benannt und wird geprüft; ändert DATEV die Seiten so, dass eine Annahme nicht mehr stimmt, bricht das Skript ab, statt
etwas Falsches zu schreiben.

So wird das Format aktualisiert (etwa wenn DATEV eine neue Formatversion veröffentlicht):
  1. Text der beiden Seiten speichern (Adressen: BASIS unten, dahinter /format-description/header und
     /format-description/booking-batch): node werkzeug/seite-als-text.mjs <adresse> <datei.txt>
  2. Musterdaten von der Seite „Musterdaten“ laden und entpacken (EXTF_Buchungsstapel.csv).
  3. python werkzeug/format-uebernehmen.py --kopf kopf.txt --stapel buchungsstapel.txt --muster EXTF_Buchungsstapel.csv --abgerufen JJJJ-MM-TT
  4. npm test mit DATEV_MUSTERDATEN=<Ordner der Musterdaten>, danach node beispiel/erzeugen.mjs.
"""
import argparse, io, json, os, re, sys

BASIS = "https://developer.datev.de/de/file-formats/details/datev-format"
ap = argparse.ArgumentParser(description="Baut src/format.json aus der Formatbeschreibung der DATEV eG neu.")
ap.add_argument("--kopf", required=True, help="Text der Seite format-description/header")
ap.add_argument("--stapel", required=True, help="Text der Seite format-description/booking-batch")
ap.add_argument("--muster", required=True, help="EXTF_Buchungsstapel.csv aus den Musterdaten von DATEV")
ap.add_argument("--abgerufen", required=True, help="Tag, an dem die Seiten gelesen wurden, JJJJ-MM-TT")
ap.add_argument("--musterdaten-adresse", default="https://developer.datev.de/assets/Musterdaten_DATEV_Format_0_7f9322b9cc.zip")
ap.add_argument("--ziel", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "format.json"))
arg = ap.parse_args()
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", arg.abgerufen):
    sys.exit("--abgerufen braucht ein Datum JJJJ-MM-TT")


def zeilen_der_tabelle(text, anzahl):
    """Teilt den Seitentext in Tabellenzeilen 1..anzahl. Eine Zeile beginnt mit ihrer Nummer und einem Tabulator."""
    zeilen = text.split("\n")
    start = {}
    erwartet = 1
    for i, z in enumerate(zeilen):
        m = re.match(r"^(\d{1,3})\t", z)
        if m and int(m.group(1)) == erwartet:
            start[erwartet] = i
            erwartet += 1
            if erwartet > anzahl:
                break
    if len(start) != anzahl:
        sys.exit(f"nur {len(start)} von {anzahl} Tabellenzeilen gefunden")
    ende = next(i for i, z in enumerate(zeilen) if i > start[anzahl] and z.strip() == "Nach oben")
    aus = []
    for nr in range(1, anzahl + 1):
        bis = start[nr + 1] if nr < anzahl else ende
        teile = "\n".join(zeilen[start[nr]:bis]).split("\t")
        if len(teile) < 4:
            sys.exit(f"Zeile {nr}: nur {len(teile)} Spalten")
        aus.append({"nr": nr, "ueberschrift": " ".join(teile[1].split()).replace("\u2013", "-").replace("\u2014", "-"), "ausdruck": teile[2].strip(), "beschreibung": "\t".join(teile[3:]).strip()})
    return aus


kopf_roh = zeilen_der_tabelle(io.open(arg.kopf, encoding="utf-8").read(), 31)
stapel_roh = zeilen_der_tabelle(io.open(arg.stapel, encoding="utf-8").read(), 125)

# Unregelmäßigkeiten der Quelle, einzeln geprüft:
# a) „^[]$“ steht in der Kopfzeile für ein Leerfeld; als regulärer Ausdruck ist das nicht ausführbar. Hier: leer.
# b) Spalte 6 (WKZ Basisumsatz) hat keinen Ausdruck; die Beschreibung verlangt einen ISO-Code wie Spalte 3. Hier: Ausdruck von Spalte 3.
# c) Spalte 20 (Beleglink) nennt zwei Ausdrücke; hier gilt der allgemeine („Generell:“).
leerfelder = [k["nr"] for k in kopf_roh if k["ausdruck"] == "^[]$"]
assert leerfelder == [7, 23, 25, 26, 29], leerfelder
for k in kopf_roh:
    if k["ausdruck"] == "^[]$":
        k["ausdruck"] = "^$"
        k["angepasst"] = "Leerfeld; in der Quelle als ^[]$ notiert"
assert stapel_roh[5]["ueberschrift"] == "WKZ Basisumsatz" and stapel_roh[5]["ausdruck"] == "", stapel_roh[5]
assert stapel_roh[2]["ausdruck"] == '^["]([A-Z]{3})["]$', stapel_roh[2]
stapel_roh[5]["ausdruck"] = stapel_roh[2]["ausdruck"]
stapel_roh[5]["angepasst"] = "Quelle ohne Ausdruck; Ausdruck von Spalte 3 (ISO-Code der Währung) übernommen"
m = re.match(r'^Generell:(\^\(\["\]\.\{0,210\}\["\]\)\$)\n', stapel_roh[19]["ausdruck"])
assert stapel_roh[19]["ueberschrift"] == "Beleglink" and m, stapel_roh[19]
stapel_roh[19]["ausdruck"] = m.group(1)
stapel_roh[19]["angepasst"] = "Quelle nennt zwei Ausdrücke; hier der allgemeine"
# d) Spalte 9 (BU-Schlüssel): Die Quelle verlangt genau vier Ziffern. Die Musterdatei von DATEV führt selbst ein- bis vierstellige
#    Schlüssel (am 13.10.2026: 13 von 17 gefüllten Feldern mit weniger als vier Ziffern, etwa "9", "40", "501"). Hier: eine bis vier.
assert stapel_roh[8]["ueberschrift"] == "BU-Schlüssel" and stapel_roh[8]["ausdruck"] == r'^(["]\d{4}["])$', stapel_roh[8]
stapel_roh[8]["ausdruck"] = r'^(["]\d{1,4}["])$'
stapel_roh[8]["angepasst"] = "Quelle verlangt genau vier Ziffern; die Musterdatei von DATEV führt selbst ein- bis vierstellige Schlüssel"
for e in kopf_roh + stapel_roh:
    a = e["ausdruck"]
    assert a.startswith("^") and a.endswith("$") and "\n" not in a and "\t" not in a, (e["nr"], a)

# Spaltennamen der Zeile 2 wörtlich aus der Musterdatei von DATEV (dort UTF-8 ohne Byte Order Mark).
muster = io.open(arg.muster, "rb").read().decode("utf-8")
namen = muster.split("\r\n")[1].split(";")
assert len(namen) == 125, len(namen)
kopfnamen = ["kennzeichen", "versionsnummer", "formatkategorie", "formatname", "formatversion", "erzeugtAm", "importiert", "herkunft",
             "exportiertVon", "importiertVon", "beraternummer", "mandantennummer", "wjBeginn", "sachkontenlaenge", "datumVon", "datumBis",
             "bezeichnung", "diktatkuerzel", "buchungstyp", "rechnungslegungszweck", "festschreibung", "wkz", "reserviert1",
             "derivatskennzeichen", "reserviert2", "reserviert3", "sachkontenrahmen", "branchenloesungId", "reserviert4", "reserviert5",
             "anwendungsinformation"]


def eintrag(e, extra):
    aus = {"nr": e["nr"], **extra, "ueberschrift": e["ueberschrift"], "ausdruck": e["ausdruck"], "text": '["]' in e["ausdruck"]}
    if "angepasst" in e:
        aus["angepasst"] = e["angepasst"]
    return aus


daten = {
    "quelle": {
        "kopfzeile": BASIS + "/format-description/header",
        "buchungsstapel": BASIS + "/format-description/booking-batch",
        "musterdaten": arg.musterdaten_adresse,
        "abgerufen": arg.abgerufen,
        "hinweis": "Nummer, Überschrift und Ausdruck aus der Formatbeschreibung der DATEV eG (Gedankenstriche in Überschriften als Bindestrich normalisiert); Spaltennamen der Zeile 2 aus deren Musterdatei EXTF_Buchungsstapel.csv. Wo die Quelle keinen ausführbaren Ausdruck nennt, steht das Feld angepasst mit Begründung.",
    },
    "kopf": [eintrag(e, {"feld": kopfnamen[i]}) for i, e in enumerate(kopf_roh)],
    "spalten": [eintrag(e, {"name": namen[i]}) for i, e in enumerate(stapel_roh)],
}
with io.open(arg.ziel, "w", encoding="utf-8", newline="\n") as f:
    json.dump(daten, f, ensure_ascii=False, indent=1)
    f.write("\n")
print("Kopffelder", len(daten["kopf"]), "| Spalten", len(daten["spalten"]), "| davon Textspalten", sum(1 for s in daten["spalten"] if s["text"]),
      "| angepasst", sum(1 for e in daten["kopf"] + daten["spalten"] if "angepasst" in e))
