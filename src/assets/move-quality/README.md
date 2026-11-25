# Zugbewertungs-Symbole

Die zehn PNGs sind Ausschnitte aus den vom Nutzer bereitgestellten Chess.com-Screenshots `zugbewertungen.png` und `zugbewertungen_2.png`. Brillant stammt aus dem zweiten Bild, alle anderen Symbole aus dem ersten. Die originalen Symbole wurden nicht nachgezeichnet oder generativ ersetzt.

Format: 128 × 128 Pixel, RGBA, transparenter Hintergrund. Nur am Kreisrand wurde die Mischung mit dem dunklen Screenshot-Hintergrund rückgerechnet; die Innenfläche bleibt ein Ausschnitt der Originalpixel. Vergrößerung mit Lanczos und vormultipliziertem Alpha. Die normale Anzeigegröße bleibt 24–34 CSS-Pixel.

Reproduktion: Beide unveränderten Screenshots im Projektverzeichnis belassen, Pillow installieren und `python scripts/extractQualityIcons.py` ausführen. Python/Pillow werden ausschließlich zur Asset-Erstellung benötigt. `source.json` enthält Quell-Hashes und Ausschnittkoordinaten. Die Screenshots werden nicht in den App-Build eingebunden.

Herkunft der dargestellten Symbole: Chess.com; dies sind keine eigens für dieses Projekt entworfenen Icons.
