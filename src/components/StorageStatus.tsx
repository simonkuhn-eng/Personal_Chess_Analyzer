import { useStorageProblem } from '../hooks/useStorageProblem';
import { retryLearningWrites, snapshotLearningStorage } from '../utils/learningStorage';
import { useState } from 'react';
import { useI18n } from '../utils/i18n';

export function StorageStatus() {
  const { tr } = useI18n();
  const problem = useStorageProblem();
  const [exportError, setExportError] = useState<string | null>(null);
  if (!problem) return null;
  const download = async () => {
    if (window.electronAPI?.data.exportData) {
      try { await window.electronAPI.data.exportData(snapshotLearningStorage()); setExportError(null); }
      catch (error) { setExportError(error instanceof Error ? error.message : tr('Export fehlgeschlagen.', 'Export failed.')); }
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshotLearningStorage(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'chess-learning-backup.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="storage-status" role="alert">
    <span>{tr('Lernstand nicht gespeichert. Er bleibt vorläufig in dieser App-Sitzung erhalten. Vor dem Schließen erneut speichern oder exportieren.', 'Learning progress could not be saved to disk yet. It remains active for this session—retry saving or export a backup before closing.')} {exportError}</span>
    <button className="btn-secondary" onClick={retryLearningWrites}>{tr('Erneut speichern', 'Retry save')}</button>
    <button className="btn-secondary" onClick={download}>{tr('Lernstand retten', 'Export backup')}</button>
  </div>;
}
