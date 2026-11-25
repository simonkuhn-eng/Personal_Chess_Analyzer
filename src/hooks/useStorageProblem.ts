import { useEffect, useState } from 'react';
import { hasPendingStorageWrites, STORAGE_STATUS_EVENT } from '../utils/learningStorage';

export function useStorageProblem(): boolean {
  const [problem, setProblem] = useState(hasPendingStorageWrites);
  useEffect(() => {
    const update = () => setProblem(hasPendingStorageWrites());
    window.addEventListener(STORAGE_STATUS_EVENT, update);
    update();
    return () => window.removeEventListener(STORAGE_STATUS_EVENT, update);
  }, []);
  return problem;
}
