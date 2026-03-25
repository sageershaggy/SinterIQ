import React, { useRef, useState } from 'react';
import { Euro, MapPin } from 'lucide-react';
import { Company } from './appTypes';
import { formatCompactEur } from './formatters';

const PIPELINE_STAGES = [
  { key: 'RAW', label: 'Raw', bg: 'bg-slate-50', border: 'border-slate-200', header: 'bg-slate-100 text-slate-700' },
  { key: 'ENRICHED', label: 'Enriched', bg: 'bg-blue-50', border: 'border-blue-200', header: 'bg-blue-100 text-blue-700' },
  { key: 'QUALIFIED', label: 'Qualified', bg: 'bg-purple-50', border: 'border-purple-200', header: 'bg-purple-100 text-purple-700' },
  { key: 'APPROVED', label: 'Approved', bg: 'bg-green-50', border: 'border-green-200', header: 'bg-green-100 text-green-700' },
  { key: 'IN_OUTREACH', label: 'In Outreach', bg: 'bg-yellow-50', border: 'border-yellow-200', header: 'bg-yellow-100 text-yellow-700' },
  { key: 'CONTACTED', label: 'Contacted', bg: 'bg-orange-50', border: 'border-orange-200', header: 'bg-orange-100 text-orange-700' },
  { key: 'OPPORTUNITY', label: 'Opportunity', bg: 'bg-amber-50', border: 'border-amber-200', header: 'bg-amber-100 text-amber-700' },
  { key: 'WON', label: 'Won', bg: 'bg-emerald-50', border: 'border-emerald-200', header: 'bg-emerald-100 text-emerald-700' },
  { key: 'LOST', label: 'Lost', bg: 'bg-red-50', border: 'border-red-200', header: 'bg-red-100 text-red-700' },
  { key: 'DISQUALIFIED', label: 'Disqualified', bg: 'bg-gray-50', border: 'border-gray-300', header: 'bg-gray-200 text-gray-700' },
];

interface KanbanBoardProps {
  companies: Company[];
  onCompanyClick: (id: number) => void;
  onStatusChange: (id: number, newStatus: string) => Promise<void>;
}

export default function KanbanBoard({ companies, onCompanyClick, onStatusChange }: KanbanBoardProps) {
  const dragIdRef = useRef<number | null>(null);
  const [draggingOver, setDraggingOver] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragStart = (e: React.DragEvent, id: number) => {
    dragIdRef.current = id;
    setIsDragging(true);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    setDraggingOver(null);
  };

  const handleDragOver = (e: React.DragEvent, stageKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDraggingOver(stageKey);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the column entirely
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDraggingOver(null);
    }
  };

  const handleDrop = async (e: React.DragEvent, stageKey: string) => {
    e.preventDefault();
    setDraggingOver(null);
    setIsDragging(false);
    if (dragIdRef.current !== null) {
      const id = dragIdRef.current;
      dragIdRef.current = null;
      await onStatusChange(id, stageKey);
    }
  };

  const totalByStage = (key: string) => {
    return companies.filter((c) => c.lead_status === key).reduce((s, c) => s + (c.revenue_eur || 0), 0);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Pipeline Board</h1>
        <p className="text-sm text-slate-500">Drag cards between columns to update status</p>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: '75vh' }}>
        {PIPELINE_STAGES.map((stage) => {
          const stageCompanies = companies.filter((c) => c.lead_status === stage.key);
          const stageValue = totalByStage(stage.key);
          const isOver = draggingOver === stage.key;

          return (
            <div
              key={stage.key}
              className={`flex-shrink-0 w-60 rounded-xl border-2 flex flex-col transition-all duration-150 ${stage.border} ${
                isOver ? 'ring-2 ring-blue-400 ring-offset-1 scale-[1.01]' : ''
              }`}
              onDragOver={(e) => handleDragOver(e, stage.key)}
              onDrop={(e) => handleDrop(e, stage.key)}
              onDragLeave={handleDragLeave}
            >
              {/* Column header */}
              <div className={`px-3 py-2.5 rounded-t-xl ${stage.header}`}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">{stage.label}</span>
                  <span className="bg-white/70 text-xs font-bold px-1.5 py-0.5 rounded-full">
                    {stageCompanies.length}
                  </span>
                </div>
                {stageValue > 0 && (
                  <div className="text-xs opacity-70 mt-0.5 flex items-center gap-0.5">
                    <Euro className="w-3 h-3" />
                    {formatCompactEur(stageValue)}
                  </div>
                )}
              </div>

              {/* Cards */}
              <div className={`flex-1 p-2 space-y-2 ${stage.bg} rounded-b-xl min-h-24`}>
                {stageCompanies.length === 0 && isDragging && (
                  <div className="border-2 border-dashed border-slate-300 rounded-lg h-16 flex items-center justify-center text-slate-400 text-xs">
                    Drop here
                  </div>
                )}
                {stageCompanies.map((company) => (
                  <div
                    key={company.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, company.id)}
                    onDragEnd={handleDragEnd}
                    onClick={() => onCompanyClick(company.id)}
                    className="bg-white border border-slate-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:shadow-md hover:border-blue-300 transition-all select-none group"
                  >
                    <div className="font-medium text-slate-900 text-sm leading-snug mb-1.5 group-hover:text-blue-700 transition-colors">
                      {company.company_name}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-slate-500 mb-2">
                      <MapPin className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        {company.city ? `${company.city}, ` : ''}{company.country}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      {company.revenue_eur ? (
                        <span className="text-xs text-slate-600 flex items-center gap-0.5 font-medium">
                          <Euro className="w-3 h-3" />
                          {formatCompactEur(company.revenue_eur)}
                        </span>
                      ) : <span />}
                      {company.technical_fit && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                          company.technical_fit === 'HIGH' ? 'bg-green-100 text-green-700' :
                          company.technical_fit === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' :
                          company.technical_fit === 'LOW' ? 'bg-orange-100 text-orange-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {company.technical_fit.replace('_', ' ')}
                        </span>
                      )}
                    </div>
                    {company.assigned_to && (
                      <div className="mt-1.5 text-[10px] text-slate-400 truncate">
                        {company.assigned_to}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
