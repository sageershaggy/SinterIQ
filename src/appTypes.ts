export interface AppUser {
  created_at?: string;
  email?: string | null;
  full_name: string;
  id: number;
  is_active: number;
  notes?: string | null;
  role: string;
  updated_at?: string;
}

export interface Company {
  assigned_to: string | null;
  city: string | null;
  company_name: string;
  company_type: string;
  contact_count?: number;
  country: string;
  follow_up_date?: string | null;
  id: number;
  industry: string;
  lead_score: number | null;
  lead_status: string;
  next_tracking_date?: string | null;
  revenue_eur: number | null;
  technical_fit: string | null;
  tracking_level?: string | null;
  tracking_notes?: string | null;
  tracking_status?: string | null;
}

export interface LlmSettings {
  api_key: string;
  base_url: string;
  has_api_key: boolean;
  model: string;
  provider_name: string;
  provider_type: 'gemini' | 'openai_compatible';
  source: 'database' | 'environment' | 'default';
  supports_web_search: boolean;
}
