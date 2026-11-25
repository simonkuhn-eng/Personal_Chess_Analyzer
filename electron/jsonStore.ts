import fs from 'fs';
import path from 'path';

/**
 * Atomarer JSON-Schreibvorgang (T05):
 * 1. Erst in eine temporäre Datei im selben Verzeichnis schreiben (gleiche Partition → rename ist atomar)
 * 2. Fehler beim Schreiben propagieren — NIEMALS stillschweigend Erfolg melden
 * 3. Nach erfolgreichem flush: rename über die Zieldatei
 *
 * Ein Absturz zwischen den Schritten hinterlässt entweder die alte, intakte
 * Datei oder die neue, vollständige — aber nie eine halb geschriebene.
 */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  const payload = JSON.stringify(data, null, 2);
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Windows scanners can hold a just-written JSON file briefly. Retry only
    // transient sharing errors; never unlink/truncate the old destination.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmpPath, filePath); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, [10, 25, 50, 100, 200][attempt]);
      }
    }
  } catch (err) {
    // Tempdatei aufräumen, damit keine Mülldateien zurückbleiben
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      /* Cleanup ist best-effort */
    }
    throw err;
  }
}
