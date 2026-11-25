import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/** Keep short lists visible; long lists start compact. Hiding preserves search,
 * sort and nested detail state when the user closes and reopens the section. */
export const AnalysisList: React.FC<{
  title: React.ReactNode;
  count: number;
  noun?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, count, noun = 'Einträge', description, children }) => {
  const [expanded, setExpanded] = useState(count <= 6);
  const contentId = useId();
  return <div className="analysis-list">
    <h3 className="analysis-list-heading"><button className="analysis-list-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <span className="analysis-list-title">{title}</span>
      <span className="analysis-list-count">{count} {noun}</span>
      <ChevronDown size={18} aria-hidden="true" />
    </button></h3>
    {description && <p className="analysis-list-description">{description}</p>}
    <div className="analysis-list-content" id={contentId} hidden={!expanded}>{children}</div>
  </div>;
};
