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
  id: number;
  company_name: string;
  country: string;
  address?: string | null;
  city: string | null;
  region?: string | null;
  industry: string;
  company_type: string;
  employee_count?: number | null;
  revenue_eur: number | null;
  website?: string | null;
  company_email?: string | null;
  legal_form?: string | null;
  business_role?: string | null;
  main_products?: string | null;
  related_companies?: string | null;
  corporate_parent?: string | null;
  duns_number?: string | null;
  source?: string | null;
  is_subsidiary?: boolean | number | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;

  // Lead qualification
  lead_score: number | null;
  lead_status: string;
  technical_fit: string | null;
  qualification_notes?: string | null;
  product_fit?: string | null;
  mentions_technology?: boolean | number | null;

  lead_priority?: string | null;

  // AI qualification
  ai_qualified_at?: string | null;
  ai_confidence?: number | null;
  website_score?: number | null;
  social_score?: number | null;
  buying_probability?: number | null;
  approach_strategy?: string | null;
  sales_script?: string | null;
  email_script?: string | null;
  opportunity_notes?: string | null;

  // Social media
  social_media_urls?: string | null;
  social_media_active?: boolean | number | null;
  social_profiles_json?: string | null;

  // Contacts / follow-ups
  contact_count?: number;
  follow_up_date?: string | null;
  assigned_to: string | null;

  // Tracking
  tracking_level?: string | null;
  tracking_status?: string | null;
  tracking_notes?: string | null;
  next_tracking_date?: string | null;
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
