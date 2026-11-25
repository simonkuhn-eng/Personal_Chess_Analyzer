/**
 * Repertoire-Baum für den Eröffnungstrainer.
 *
 * Quellen der Varianten (verifiziert):
 *  - lichess-org/chess-openings (offizielle ECO-Datenbank, abgeleitet aus der
 *    Encyclopaedia of Chess Openings) — https://github.com/lichess-org/chess-openings
 *  - London: D00 "Queen's Pawn Game: Accelerated London System" (inkl. Steinitz-Countergambit)
 *  - Caro-Kann: B15 → B18/B19 "Classical Variation" (3.Nc3 dxe4 4.Nxe4 Bf5 5.Ng3 Bg6)
 *  - Slawisch: D10-D18 "Slav Defense / Czech Variation" (5.a4 Bf5)
 *
 * Modell:
 *  - mainMoves: fixe Hauptvariante (UCI), beginnt mit Weiß (Index 0).
 *  - deviations: an einem Zug-Slot atPly (Gegner am Zug) weicht der Gegner mit
 *    `uci` statt mainMoves[atPly] ab; `continuation` = empfohlene Antwortfolge
 *    (beginnt IMMER mit dem eigenen Zug), danach Ende des Zweigs.
 */

export interface Deviation {
  /** Globaler Ply (0-basiert) in mainMoves, an dem der GEGNER abweicht. */
  atPly: number;
  /** Abweichender Gegner-Zug (UCI). */
  uci: string;
  /** ECO-Referenz für die Anzeige. */
  eco: string;
  /** Deutsche Erklärung: was ist das, was spiele ich darauf? */
  note: string;
  /** Empfohlene Antwortfolge (UCI), beginnt mit dem EIGENEN Zug. */
  continuation: string[];
}

export interface RepertoireLine {
  id: string;
  name: string;
  color: 'w' | 'b';
  ecoBase: string;
  description: string;
  plan: string[];
  mainMoves: string[];
  deviations: Deviation[];
  /** Hinweis am Ende der Buchlinie (Übergang ins Mittelspiel). */
  tabiya: string;
}

export const REPERTOIRE_LINES: RepertoireLine[] = [
  {
    id: 'london-system',
    name: 'London-System',
    color: 'w',
    ecoBase: 'D00 (Accelerated London)',
    description: 'Dein Aufbau mit Weiß: d4, Lf4, e3, Sf3, c3 — sicher ohne frühes c4.',
    plan: [
      'Zentrum d4 halten und den Läufer nach f4 entwickeln.',
      'Mit e3, Sf3 und c3 Figuren und Bauern aufstellen, dann kurz rochieren.',
      'Später Ld3 und Sbd2 aufstellen; mit e3-e4 machst du das Zentrum auf.',
    ],
    mainMoves: ['d2d4', 'd7d5', 'c1f4', 'g8f6', 'e2e3', 'e7e6', 'g1f3', 'c7c5', 'c2c3', 'b8c6'],
    tabiya: 'Haupt-Tabiya erreicht (5. Zug). Weiterer Plan: Ld3, Sbd2, 0-0 — danach mit e3-e4 ins Zentrum stoßen.',
    deviations: [
      {
        atPly: 1,
        uci: 'g8f6',
        eco: 'A45 — 1...Sf6 statt 1...d5 (transponiert ins London-System)',
        note: 'Kein Problem: dein Aufbau bleibt identisch (Lf4, e3, Sf3, c3). Zieht Schwarz später ...d5 nach, landest du in deiner Hauptvariante.',
        continuation: ['c1f4', 'e7e6', 'e2e3', 'd7d5', 'g1f3', 'c7c5', 'c2c3', 'b8c6'],
      },
      {
        atPly: 3,
        uci: 'c7c5',
        eco: 'D00 — Steinitz-Countergambit',
        note: '2...c5! ist die kritische Antwort (greift d4 an). Empfehlung: 3.dxc5 — Bauer gewinnen, dann normal aufbauen (Sf3, e3, Le2, 0-0).',
        continuation: ['d4c5', 'e7e6', 'g1f3', 'b8c6', 'e2e3', 'g8f6', 'f1e2', 'f8e7'],
      },
      {
        atPly: 3,
        uci: 'g7g6',
        eco: 'D00 — Fianchetto-Setup',
        note: '2...g6 bereitet das Fianchetto vor. Du kannst mit e3, Sf3 und Sbd2 weiterentwickeln. Behalte den Druck gegen d4 im Blick und entscheide anschließend zwischen Le2 und Ld3.',
        continuation: ['e2e3', 'f8g7', 'g1f3', 'g8f6', 'b1d2', 'e8g8'],
      },
      {
        atPly: 3,
        uci: 'c8f5',
        eco: 'D00 — Caro-Läufer vorweg',
        note: '2...Lf5 entwickelt den aktiven Läufer früh. Stört deinen Aufbau nicht: einfach weiter (e3, Sf3, c3, Le2/Ld3 mit Tausch-Angebot).',
        continuation: ['e2e3', 'e7e6', 'g1f3', 'g8f6', 'c2c3', 'f8e7'],
      },
      {
        atPly: 5,
        uci: 'c7c5',
        eco: 'D01 — 3...c5 statt 3...e6',
        note: 'Antwort: 4.c3 wie gewohnt, dann Sf3 und Ld3 — deine Standardaufstellung entsteht ohnehin.',
        continuation: ['c2c3', 'b8c6', 'g1f3', 'e7e6', 'f1d3', 'f8e7'],
      },
    ],
  },
  {
    id: 'caro-kann',
    name: 'Caro-Kann',
    color: 'b',
    ecoBase: 'B15 → B18/B19 (Klassisch)',
    description: 'Dein Aufbau mit Schwarz gegen 1.e4: solide Struktur, aktiver Läufer.',
    plan: [
      'Mit c6 das Feld d5 sichern, dann d7-d5 spielen und den e4-Bauer schlagen.',
      'Den Damenläufer über f5/g6 AKTIV entwickeln — außerhalb der Bauernkette.',
      'Solide Struktur behalten: wenig Raum, aber kaum Schwächen.',
    ],
    mainMoves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'c8f5', 'e4g3', 'f5g6', 'h2h4', 'h7h6', 'g1f3', 'b8d7', 'h4h5', 'g6h7', 'f1d3', 'h7d3', 'd1d3', 'e7e6'],
    tabiya: 'Klassische Stellung nach 10...e6 erreicht. Der weißfeldrige Läufer wurde vor dem Schließen der Bauernkette entwickelt und gegen Ld3 getauscht. Weiter mit ...Sgf6, ...Le7 und Königssicherheit; den weißen Raumvorteil am Königsflügel beachten.',
    deviations: [
      {
        atPly: 4,
        uci: 'e4d5',
        eco: 'B13 — Abtausch-Variante',
        note: '3.exd5 ist eine gängige Antwort. Antwort: 3...cxd5. Danach ruhig entwickeln: Sc6, Sf6, Le7/Lf5, 0-0. Solide Stellung.',
        continuation: ['c6d5', 'c1f4', 'b8c6', 'b1c3', 'g8f6', 'g1f3'],
      },
      {
        atPly: 4,
        uci: 'e4e5',
        eco: 'B12 — Vorstoß-Variante',
        note: '3.e5 rückt vor. Antwort: 3...Lf5 (der Caro-Läufer raus, BEVOR die Kette steht!). Danach ...e6 und ...c5 greift d4 an. Gegen 4.h4 (Raumangriff): einfach ...e6 und später ...h6.',
        continuation: ['c8f5', 'b1c3', 'e7e6', 'g1f3', 'c6c5'],
      },
      {
        atPly: 4,
        uci: 'f2f3',
        eco: 'B12 — Maróczy/Fantasy-Variante',
        note: '3.f3 („Fantasy“) ist eine ungewöhnliche Nebenvariante. Klassische Antwort: 3...dxe4 4.fxe4 e5! — sofort ins Zentrum. Danach ...Lf5 und ...Sc6.',
        continuation: ['d5e4', 'f3e4', 'e7e5', 'g1f3', 'e5d4'],
      },
      {
        atPly: 4,
        uci: 'b1d2',
        eco: 'B18 — Klassisch (Transposition)',
        note: '3.Sd2 transponiert in deine Klassische Variante — spiel weiter wie gewohnt: 3...dxe4 4.Sxe4 Lf5 5.Sg3 Lg6.',
        continuation: ['d5e4', 'd2e4', 'c8f5', 'e4g3', 'f5g6', 'h2h4', 'h7h6', 'g1f3', 'b8d7', 'h4h5', 'g6h7', 'f1d3', 'h7d3', 'd1d3', 'e7e6'],
      },
      {
        atPly: 2,
        uci: 'b1c3',
        eco: 'B10 — 2.Sc3 statt 2.d4',
        note: 'Antwort: 2...d5. Bei 3.Sf3: 3...dxe4 4.Sxe4 Lf5 — dieselbe glückliche Läufer-Entwicklung wie in deiner Hauptvariante.',
        continuation: ['d7d5', 'g1f3', 'd5e4', 'c3e4', 'c8f5'],
      },
      {
        atPly: 2,
        uci: 'c2c4',
        eco: 'B10 — beschleunigter Panov',
        note: '2.c4 ist der beschleunigte Panov-Angriff. Antwort: 2...d5. Nach 3.exd5 cxd5 4.cxd5 Sf6 hast du eine gesunde Halboffene Stellung.',
        continuation: ['d7d5', 'e4d5', 'c6d5', 'c4d5', 'g8f6'],
      },
    ],
  },
  {
    id: 'slav',
    name: 'Slawisch (gegen 1.d4)',
    color: 'b',
    ecoBase: 'D10 → D17/D18 (Czech Variation)',
    description: 'Dein Aufbau mit Schwarz gegen 1.d4 — gleiche c6+d5-Struktur wie die Caro-Kann.',
    plan: [
      'Mit ...d5 das Zentrum besetzen und den Bauern mit ...c6 stützen.',
      '...dxc4 ist kein Bauernraub: Wenn Weiß später Lxc4 schlägt, steht deine Entwicklung frei.',
      'Den Läufer über f5/g6 aktiv entwickeln — identische Ideen wie in der Caro-Kann.',
    ],
    mainMoves: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'd5c4', 'a2a4', 'c8f5', 'e2e3', 'e7e6', 'f1c4', 'f8b4'],
    tabiya: 'Slawische Haupt-Tabiya (ECO D17/D18). Plan: ...e6, ...Sbd7, ...0-0; der Lf5 bleibt aktiv — bietet Weiß Ld3, tauschst du (...Lxd3) und die Struktur bleibt gesund. Mit ...b5 Raum am Damenflügel (bei axb5: ...cxb5).',
    deviations: [
      {
        atPly: 2,
        uci: 'c1f4',
        eco: 'D02 — LONDON-System! (wichtigster Zweig)',
        note: 'Dein Gegner spielt London (2.Lf4 statt 2.c4). Merkregel: entwickle zuerst 2...Lf5 (NICHT erst ...e6 — sonst kommt der Läufer nicht mehr raus), dann ...e6, ...Sf6, ...Sbd7, ...Le7, 0-0. Bietet Weiß Ld3, tauschst du (...Lxd3).',
        continuation: ['c8f5', 'e2e3', 'e7e6', 'g1f3', 'g8f6', 'f1d3', 'f5d3'],
      },
      {
        atPly: 2,
        uci: 'g1f3',
        eco: 'D11 — 2.Sf3',
        note: '2.Sf3: meistens folgt 3.c4 → einfach weiter ...Sf6 spielen, dann Slawisch wie gewohnt.',
        continuation: ['g8f6', 'c2c4', 'c7c6', 'b1c3', 'd5c4', 'a2a4', 'c8f5'],
      },
      {
        atPly: 2,
        uci: 'e2e3',
        eco: 'D00 — Colle-Stil',
        note: '2.e3 (Colle-Aufbau): gleiche Merkregel wie gegen London — 2...Lf5 zuerst! Dann ...e6, ...Sf6, ...Sbd7, ...Le7, 0-0.',
        continuation: ['c8f5', 'g1f3', 'e7e6', 'c1d2', 'g8f6'],
      },
      {
        atPly: 2,
        uci: 'b1c3',
        eco: 'D10 — 2.Sc3',
        note: '2.Sc3: antworte 2...Sf6. Der Springer auf c3 verlegt c2-c4 nur VORÜBERGEHEND — zieht er weg (z. B. Se4 oder Sb5), wird der Slawen-Aufbau mit ...dxc4 wieder möglich. Solange c4 verlegt ist, entwickle dich solide: ...Lf5, ...e6, ...c6, ...Sbd7.',
        continuation: ['g8f6', 'c1f4', 'c8f5', 'e2e3', 'e7e6'],
      },
      {
        atPly: 4,
        uci: 'b1c3',
        eco: 'D15 — 3.Sc3 (Transposition)',
        note: '3.Sc3 statt 3.Sf3 → Transposition: 3...Sf6 4.Sf3, dann wie gewohnt ...dxc4, a4, Lf5.',
        continuation: ['g8f6', 'g1f3', 'd5c4', 'a2a4', 'c8f5'],
      },
      {
        atPly: 4,
        uci: 'e2e3',
        eco: 'D11 — Quiet Variation',
        note: '3.e3 (ruhige Variante): 3...Sf6 4.Sc3 dxc4! 5.Lxc4 — der Bauer ist weg, aber deine Entwicklung ist frei. Dann Lf5, e6, 0-0.',
        continuation: ['g8f6', 'b1c3', 'd5c4', 'f1c4', 'c8f5'],
      },
    ],
  },
];
