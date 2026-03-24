import React, { useRef, useState } from 'react';
import { Upload, FileSpreadsheet, Linkedin, FileText, ArrowRight, CheckCircle2, AlertCircle, MapPin } from 'lucide-react';
import * as XLSX from 'xlsx';

// D&B Hoovers expected columns
const DNB_FIELD_MAP: Record<string, string> = {
  'Company Name': 'Company Name',
  'Trade Name': 'Company Name',
  'Country': 'Country/Territory',
  'City': 'City',
  'Industry': 'Primary Industry',
  'Employees': 'Number of Employees (Single Site)',
  'Revenue': 'Revenue',
  'Website': 'Web Address',
  'DUNS': 'D-U-N-S Number',
  'Corporate Parent': 'Global Ultimate Parent',
};

// LinkedIn Sales Navigator expected columns
const LINKEDIN_FIELD_MAP: Record<string, string> = {
  'Company Name': 'Company',
  'Country': 'Geography',
  'City': 'City',
  'Industry': 'Industry',
  'Employees': 'Company Headcount',
  'Website': 'Website',
  'Contact Name': 'First Name,Last Name',
  'Job Title': 'Title',
  'LinkedIn URL': 'Person Linkedin Url',
};

interface ImportTabProps {
  onImportComplete: () => void;
}

type ImportSource = 'dnb' | 'linkedin' | 'csv';

interface ColumnMapping {
  csvColumn: string;
  appField: string;
}

const APP_FIELDS = [
  { value: '', label: '-- Skip --' },
  { value: 'company_name', label: 'Company Name' },
  { value: 'country', label: 'Country' },
  { value: 'city', label: 'City' },
  { value: 'region', label: 'Region' },
  { value: 'industry', label: 'Industry' },
  { value: 'company_type', label: 'Company Type' },
  { value: 'employee_count', label: 'Employee Count' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'website', label: 'Website' },
  { value: 'duns_number', label: 'DUNS Number' },
  { value: 'corporate_parent', label: 'Corporate Parent' },
  { value: 'contact_name', label: 'Contact Full Name' },
  { value: 'job_title', label: 'Contact Job Title' },
  { value: 'email', label: 'Contact Email' },
  { value: 'phone', label: 'Contact Phone' },
  { value: 'linkedin_url', label: 'Contact LinkedIn URL' },
  { value: 'notes', label: 'Notes' },
];

export default function ImportTab({ onImportComplete }: ImportTabProps) {
  const [source, setSource] = useState<ImportSource>('dnb');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // CSV mapping state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<Record<string, string>[]>([]);
  const [csvRawRows, setCsvRawRows] = useState<Record<string, string>[]>([]);
  const [columnMappings, setColumnMappings] = useState<ColumnMapping[]>([]);
  const [showMapping, setShowMapping] = useState(false);

  const resetState = () => {
    setResult(null);
    setCsvHeaders([]);
    setCsvPreview([]);
    setCsvRawRows([]);
    setColumnMappings([]);
    setShowMapping(false);
  };

  const handleDnBUpload = async (file: File) => {
    setImporting(true);
    setResult(null);
    try {
      const data = await readFile(file);
      const workbook = XLSX.read(data, { type: 'binary' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      const response = await fetch('/api/companies/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: rows }),
      });
      if (!response.ok) throw new Error('Import failed');
      const result = await response.json();
      setResult({ success: true, message: `Successfully imported ${result.imported || rows.length} companies from D&B Hoovers.` });
      onImportComplete();
    } catch (err) {
      setResult({ success: false, message: 'Failed to import D&B Hoovers file. Check the file format.' });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleLinkedInUpload = async (file: File) => {
    setImporting(true);
    setResult(null);
    try {
      const data = await readFile(file);
      const workbook = XLSX.read(data, { type: 'binary' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet);

      // Transform LinkedIn format to our import format
      const companies: any[] = [];
      const companyMap = new Map<string, any>();

      for (const row of rows) {
        const companyName = row['Company'] || row['Company Name'] || row['Account Name'] || '';
        if (!companyName) continue;

        if (!companyMap.has(companyName)) {
          companyMap.set(companyName, {
            'Company Name': companyName,
            'Country/Territory': row['Geography'] || row['Country'] || row['Company HQ Location'] || '',
            'City': row['City'] || '',
            'Primary Industry': row['Industry'] || '',
            'Number of Employees (Single Site)': row['Company Headcount'] || row['# Employees'] || '',
            'Web Address': row['Website'] || row['Company Website'] || '',
            contacts: [],
          });
        }

        const firstName = row['First Name'] || '';
        const lastName = row['Last Name'] || '';
        const fullName = `${firstName} ${lastName}`.trim();
        if (fullName) {
          companyMap.get(companyName).contacts.push({
            full_name: fullName,
            job_title: row['Title'] || row['Job Title'] || '',
            email: row['Email'] || row['Email Address'] || '',
            linkedin_url: row['Person Linkedin Url'] || row['LinkedIn URL'] || row['Profile URL'] || '',
          });
        }
      }

      // Build import payload
      const importPayload = Array.from(companyMap.values()).map(c => {
        const { contacts, ...companyData } = c;
        return { ...companyData, _contacts: contacts };
      });

      const response = await fetch('/api/companies/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: importPayload, source: 'LINKEDIN' }),
      });
      if (!response.ok) throw new Error('Import failed');
      const res = await response.json();
      const contactCount = Array.from(companyMap.values()).reduce((sum, c) => sum + c.contacts.length, 0);
      setResult({
        success: true,
        message: `Imported ${res.imported || companyMap.size} companies and ${contactCount} contacts from LinkedIn.`,
      });
      onImportComplete();
    } catch (err) {
      console.error(err);
      setResult({ success: false, message: 'Failed to import LinkedIn file. Ensure it is a Sales Navigator CSV/XLSX export.' });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCsvParse = async (file: File) => {
    setResult(null);
    try {
      const data = await readFile(file);
      const workbook = XLSX.read(data, { type: 'binary' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet);
      if (rows.length === 0) {
        setResult({ success: false, message: 'File is empty or has no data rows.' });
        return;
      }
      const headers = Object.keys(rows[0]);
      setCsvHeaders(headers);
      setCsvPreview(rows.slice(0, 3));
      setCsvRawRows(rows);
      // Auto-map by guessing
      const mappings: ColumnMapping[] = headers.map(h => {
        const lower = h.toLowerCase();
        let matched = '';
        if (lower.includes('company') && lower.includes('name')) matched = 'company_name';
        else if (lower === 'company' || lower === 'account') matched = 'company_name';
        else if (lower.includes('country') || lower.includes('territory')) matched = 'country';
        else if (lower === 'city') matched = 'city';
        else if (lower.includes('industry')) matched = 'industry';
        else if (lower.includes('employee') || lower.includes('headcount')) matched = 'employee_count';
        else if (lower.includes('revenue') || lower.includes('sales')) matched = 'revenue';
        else if (lower.includes('web') || lower === 'url') matched = 'website';
        else if (lower.includes('duns') || lower.includes('d-u-n-s')) matched = 'duns_number';
        else if (lower.includes('parent')) matched = 'corporate_parent';
        else if (lower.includes('name') && (lower.includes('contact') || lower.includes('first') || lower.includes('full'))) matched = 'contact_name';
        else if (lower.includes('title') || lower.includes('role') || lower.includes('position')) matched = 'job_title';
        else if (lower.includes('email')) matched = 'email';
        else if (lower.includes('phone') || lower.includes('tel')) matched = 'phone';
        else if (lower.includes('linkedin')) matched = 'linkedin_url';
        return { csvColumn: h, appField: matched };
      });
      setColumnMappings(mappings);
      setShowMapping(true);
    } catch (err) {
      setResult({ success: false, message: 'Failed to read file.' });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCsvImport = async () => {
    setImporting(true);
    setResult(null);
    try {
      const nameField = columnMappings.find(m => m.appField === 'company_name')?.csvColumn;
      if (!nameField) {
        setResult({ success: false, message: 'You must map a column to "Company Name".' });
        setImporting(false);
        return;
      }

      const importPayload = csvRawRows.map(row => {
        const mapped: any = {};
        for (const m of columnMappings) {
          if (!m.appField) continue;
          mapped[m.appField] = row[m.csvColumn] || '';
        }
        return {
          'Company Name': mapped.company_name || '',
          'Country/Territory': mapped.country || '',
          City: mapped.city || '',
          'Primary Industry': mapped.industry || '',
          'Number of Employees (Single Site)': mapped.employee_count || '',
          Revenue: mapped.revenue || '',
          'Web Address': mapped.website || '',
          'D-U-N-S Number': mapped.duns_number || '',
          'Global Ultimate Parent': mapped.corporate_parent || '',
          _contacts: mapped.contact_name ? [{
            full_name: mapped.contact_name,
            job_title: mapped.job_title || '',
            email: mapped.email || '',
            phone_direct: mapped.phone || '',
            linkedin_url: mapped.linkedin_url || '',
          }] : [],
        };
      }).filter(r => r['Company Name']);

      const response = await fetch('/api/companies/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: importPayload, source: 'CSV' }),
      });
      if (!response.ok) throw new Error('Import failed');
      setResult({ success: true, message: `Successfully imported ${importPayload.length} companies from CSV.` });
      setShowMapping(false);
      onImportComplete();
    } catch (err) {
      setResult({ success: false, message: 'Import failed. Check the data.' });
    } finally {
      setImporting(false);
    }
  };

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (source === 'dnb') handleDnBUpload(file);
    else if (source === 'linkedin') handleLinkedInUpload(file);
    else handleCsvParse(file);
  };

  const readFile = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsBinaryString(file);
    });
  };

  const tabs: { key: ImportSource; label: string; icon: React.ReactNode; desc: string }[] = [
    { key: 'dnb', label: 'D&B Hoovers', icon: <FileSpreadsheet className="w-5 h-5" />, desc: 'Import from Dun & Bradstreet Hoovers export' },
    { key: 'linkedin', label: 'LinkedIn', icon: <Linkedin className="w-5 h-5" />, desc: 'Import from LinkedIn Sales Navigator export' },
    { key: 'csv', label: 'Manual CSV', icon: <FileText className="w-5 h-5" />, desc: 'Import any CSV/XLSX with custom column mapping' },
  ];

  return (
    <div className="space-y-6 max-w-3xl mx-auto mt-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Import Data</h1>
        <p className="text-slate-500 mt-2">Import companies and contacts from multiple sources.</p>
      </div>

      {/* Source tabs */}
      <div className="grid grid-cols-3 gap-3">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => { setSource(t.key); resetState(); }}
            className={`p-4 rounded-xl border-2 text-left transition-all ${
              source === t.key
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
          >
            <div className={`mb-2 ${source === t.key ? 'text-blue-600' : 'text-slate-400'}`}>{t.icon}</div>
            <div className="font-semibold text-sm text-slate-900">{t.label}</div>
            <div className="text-xs text-slate-500 mt-1">{t.desc}</div>
          </button>
        ))}
      </div>

      {/* Expected columns hint */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm">
        <div className="font-medium text-slate-800 mb-2">
          {source === 'dnb' && 'Expected D&B Hoovers columns:'}
          {source === 'linkedin' && 'Expected LinkedIn Sales Navigator columns:'}
          {source === 'csv' && 'Upload any CSV/XLSX — you will map columns manually.'}
        </div>
        {source === 'dnb' && (
          <div className="flex flex-wrap gap-1.5">
            {Object.values(DNB_FIELD_MAP).map(v => (
              <span key={v} className="text-xs bg-white border border-slate-200 px-2 py-0.5 rounded">{v}</span>
            ))}
          </div>
        )}
        {source === 'linkedin' && (
          <div className="flex flex-wrap gap-1.5">
            {Object.values(LINKEDIN_FIELD_MAP).map(v => (
              <span key={v} className="text-xs bg-white border border-slate-200 px-2 py-0.5 rounded">{v}</span>
            ))}
          </div>
        )}
      </div>

      {/* Upload area */}
      {!showMapping && (
        <div className="bg-white border-2 border-dashed border-slate-300 rounded-xl p-10 text-center hover:bg-slate-50 transition-colors">
          <Upload className="w-10 h-10 text-slate-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-900 mb-1">Upload a file</h3>
          <p className="text-sm text-slate-500 mb-6">XLSX or CSV format up to 10MB</p>
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" ref={fileInputRef} onChange={handleFile} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-md font-medium transition-colors disabled:opacity-50"
          >
            {importing ? 'Importing...' : 'Select File'}
          </button>
        </div>
      )}

      {/* CSV Column Mapping UI */}
      {showMapping && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4">
          <h3 className="font-semibold text-slate-900">Map Columns</h3>
          <p className="text-sm text-slate-500">Map your CSV columns to SinterIQ fields. Unmapped columns will be skipped.</p>

          <div className="space-y-2 max-h-[350px] overflow-y-auto">
            {columnMappings.map((m, i) => (
              <div key={m.csvColumn} className="flex items-center gap-3">
                <div className="w-1/3 text-sm font-medium text-slate-700 truncate" title={m.csvColumn}>{m.csvColumn}</div>
                <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
                <select
                  value={m.appField}
                  onChange={e => {
                    const updated = [...columnMappings];
                    updated[i] = { ...m, appField: e.target.value };
                    setColumnMappings(updated);
                  }}
                  className={`flex-1 border rounded-md px-2 py-1.5 text-sm ${m.appField ? 'border-green-300 bg-green-50' : 'border-slate-300'}`}
                >
                  {APP_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
            ))}
          </div>

          {/* Preview */}
          {csvPreview.length > 0 && (
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Preview (first {csvPreview.length} rows):</div>
              <div className="overflow-x-auto text-xs border border-slate-200 rounded-lg">
                <table className="w-full">
                  <thead className="bg-slate-50">
                    <tr>
                      {csvHeaders.slice(0, 6).map(h => <th key={h} className="px-2 py-1 text-left font-medium text-slate-600 truncate max-w-[120px]">{h}</th>)}
                      {csvHeaders.length > 6 && <th className="px-2 py-1 text-slate-400">+{csvHeaders.length - 6} more</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.map((row, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        {csvHeaders.slice(0, 6).map(h => <td key={h} className="px-2 py-1 text-slate-700 truncate max-w-[120px]">{row[h] || ''}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <span className="text-sm text-slate-500">{csvRawRows.length} rows to import</span>
            <div className="flex gap-2">
              <button onClick={() => { setShowMapping(false); resetState(); }} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
              <button
                onClick={() => void handleCsvImport()}
                disabled={importing || !columnMappings.some(m => m.appField === 'company_name')}
                className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-md text-sm font-medium disabled:opacity-50"
              >
                {importing ? 'Importing...' : `Import ${csvRawRows.length} Companies`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Result message */}
      {result && (
        <div className={`flex items-start gap-3 p-4 rounded-xl border ${
          result.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
        }`}>
          {result.success ? <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" /> : <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />}
          <span className={`text-sm font-medium ${result.success ? 'text-green-800' : 'text-red-800'}`}>{result.message}</span>
        </div>
      )}
    </div>
  );
}
