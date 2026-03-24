export interface SelectOption {
  label: string;
  value: string;
}

export const internalUsers = [
  'Dr. Jochen Langguth',
  'Dr. Juergen Schellenberger',
  'Ahmad Khan',
  'Sageer A. Shaikh',
  'Christoph Langguth',
  'Patton Lucas',
  'Dr. Kathrin Langguth',
] as const;

export const regionOptions: SelectOption[] = [
  { value: '', label: 'Select Region...' },
  { value: 'DACH', label: 'DACH (Germany, Austria, Switzerland)' },
  { value: 'GCC', label: 'GCC (Gulf Cooperation Council)' },
  { value: 'UK_IE', label: 'UK & Ireland' },
  { value: 'MIDDLE_EAST', label: 'Middle East (General)' },
  { value: 'UAE', label: 'UAE' },
  { value: 'SAUDI_ARABIA', label: 'Saudi Arabia' },
  { value: 'QATAR', label: 'Qatar' },
  { value: 'OMAN', label: 'Oman' },
  { value: 'BAHRAIN', label: 'Bahrain' },
  { value: 'KUWAIT', label: 'Kuwait' },
  { value: 'INDIA', label: 'India' },
  { value: 'SOUTHEAST_ASIA', label: 'Southeast Asia' },
];

export const industryOptions: SelectOption[] = [
  { value: 'BEARING_TRADER', label: 'Bearing Traders / Distributors' },
  { value: 'OIL_GAS', label: 'Oil & Gas / Petrochemicals' },
  { value: 'FOOD_BEV', label: 'Food & Beverage Manufacturing' },
  { value: 'PHARMA', label: 'Pharmaceutical / Cleanroom' },
  { value: 'CHEMICAL', label: 'Chemical Processing & Pumps' },
  { value: 'DESAL_WATER', label: 'Desalination / Water Treatment' },
  { value: 'CEMENT', label: 'Cement & Construction Materials' },
  { value: 'POWER_GEN', label: 'Power Generation / Energy' },
  { value: 'MINING', label: 'Mining & Minerals' },
  { value: 'AUTOMOTIVE', label: 'Automotive Manufacturing' },
  { value: 'TEXTILE', label: 'Textile Machinery' },
  { value: 'VACUUM', label: 'Vacuum Technology' },
  { value: 'CRYO', label: 'Cryogenic Applications' },
  { value: 'UNIVERSITY', label: 'Universities & Scientific Institutes' },
  { value: 'ROBOTICS', label: 'Robotics & Automation' },
  { value: 'ELECTROPLATING', label: 'Electroplating / Surface Treatment' },
  { value: 'INDUSTRIAL_DIST', label: 'Industrial Component Distributors' },
];

export const companyTypeOptions: SelectOption[] = [
  { value: 'BEARING_TRADER', label: 'Bearing Trader' },
  { value: 'MANUFACTURER', label: 'Manufacturer' },
  { value: 'DISTRIBUTOR', label: 'Distributor' },
  { value: 'UNIVERSITY', label: 'University' },
  { value: 'OEM', label: 'OEM (Original Equipment Manufacturer)' },
  { value: 'END_USER', label: 'End User' },
  { value: 'CONSULTANT', label: 'Consultant / Engineering Firm' },
  { value: 'TRADING_COMPANY', label: 'Trading Company' },
  { value: 'EPC_CONTRACTOR', label: 'EPC Contractor' },
];

export const leadStatusOptions: SelectOption[] = [
  { value: 'RAW', label: 'Raw' },
  { value: 'ENRICHED', label: 'Enriched' },
  { value: 'QUALIFIED', label: 'Qualified' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'IN_OUTREACH', label: 'In Outreach' },
  { value: 'CONTACTED', label: 'Contacted' },
  { value: 'OPPORTUNITY', label: 'Opportunity' },
  { value: 'WON', label: 'Won' },
  { value: 'LOST', label: 'Lost' },
  { value: 'DISQUALIFIED', label: 'Disqualified' },
];

export const technicalFitOptions: SelectOption[] = [
  { value: '', label: 'Unassessed' },
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
  { value: 'NOT_FIT', label: 'Not a Fit' },
];

export const trackingLevelOptions: SelectOption[] = [
  { value: 'WATCHLIST', label: 'Watchlist' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'HIGH_PRIORITY', label: 'High Priority' },
  { value: 'STRATEGIC', label: 'Strategic' },
];

export const trackingStatusOptions: SelectOption[] = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'RESEARCHED', label: 'Researched' },
  { value: 'QUALIFIED', label: 'Qualified' },
  { value: 'NURTURING', label: 'Nurturing' },
  { value: 'ON_HOLD', label: 'On Hold' },
];

export const userRoleOptions: SelectOption[] = [
  { value: 'Sales', label: 'Sales' },
  { value: 'Admin', label: 'Admin' },
  { value: 'Research', label: 'Research' },
  { value: 'Manager', label: 'Manager' },
];
