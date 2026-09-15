import type { EmailBlock } from './email-blocks';

export type TemplateCategory = 'outreach' | 'follow_up' | 'meeting' | 'transactional';
export interface EmailTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  subject: string;
  preview_text: string;
  blocks: EmailBlock[];
}

/**
 * Starter templates. Copy is intentionally plain and claim-free: the pre-send checks flag
 * promotional language, and a research email that oversells fails its own qualification.
 * Merge fields resolve from the lead; anything unresolved is reported before sending.
 */
export const emailTemplates: EmailTemplate[] = [
  {
    id: 'support',
    name: 'Support email',
    category: 'transactional',
    description: 'A simple starting point for helping a company. Edit the details before sending.',
    subject: 'Support for {{company}}',
    preview_text: 'How can we help your team?',
    blocks: [
      { type: 'heading', text: 'How can we help?', level: 'h2', align: 'left' },
      { type: 'text', text: 'Hello,', align: 'left' },
      {
        type: 'text',
        text: 'I am getting in touch with the team at {{company}}. Please let us know what you need help with, and we can discuss the next steps.',
        align: 'left',
      },
      {
        type: 'text',
        text: 'You can reply directly to this email.\n\nBest regards,\n{{sender_name}}',
        align: 'left',
      },
    ],
  },
  {
    id: 'first-contact',
    name: 'First contact',
    category: 'outreach',
    description: 'Short opener that names the reason this company came up.',
    subject: 'A short introduction for {{company}}',
    preview_text: 'A question about whether there is a fit.',
    blocks: [
      { type: 'text', text: 'Hello,', align: 'left' },
      {
        type: 'text',
        text: 'I was reading about {{company}} and wanted to learn more about your current requirements.',
        align: 'left',
      },
      {
        type: 'text',
        text: 'Would a short conversation be useful to see whether there is a fit? If not, no need to reply.',
        align: 'left',
      },
      { type: 'text', text: 'Best regards', align: 'left' },
    ],
  },
  {
    id: 'after-call',
    name: 'After a call',
    category: 'follow_up',
    description: 'Recap what was discussed and set the next step.',
    subject: 'Following up on our conversation',
    preview_text: 'A short summary of what we discussed and the next step.',
    blocks: [
      { type: 'text', text: 'Hello {{contact_first_name}},', align: 'left' },
      {
        type: 'text',
        text: 'Thank you for your time earlier. To recap what we discussed:',
        align: 'left',
      },
      { type: 'text', text: '— \n— \n— ', align: 'left' },
      { type: 'divider' },
      {
        type: 'text',
        text: 'I will send the technical details we talked about. If anything above is wrong, tell me and I will correct it.',
        align: 'left',
      },
      { type: 'text', text: 'Best regards', align: 'left' },
    ],
  },
  {
    id: 'technical-brief',
    name: 'Technical brief',
    category: 'outreach',
    description: 'Leads with the application rather than the product.',
    subject: 'A technical discussion with {{company}}',
    preview_text: 'Understanding the application and its requirements.',
    blocks: [
      {
        type: 'heading',
        text: 'Understanding your application',
        level: 'h1',
        align: 'left',
      },
      {
        type: 'text',
        text: 'Hello {{contact_first_name}}, a short brief in case it is relevant to {{company}}.',
        align: 'left',
      },
      {
        type: 'quote',
        text: 'Application requirements, operating conditions and constraints help us assess whether there is a useful fit.',
        cite: '',
      },
      {
        type: 'text',
        text: 'If you have a position that is failing early, the operating conditions usually tell us quickly whether this is worth pursuing.',
        align: 'left',
      },
      { type: 'spacer', size: 'small' },
      { type: 'text', text: 'Best regards', align: 'left' },
    ],
  },
  {
    id: 'meeting-request',
    name: 'Meeting request',
    category: 'meeting',
    description: 'Proposes a specific, short conversation.',
    subject: 'A short call about {{company}}?',
    preview_text: 'Twenty minutes to see whether there is a fit.',
    blocks: [
      { type: 'text', text: 'Hello {{contact_first_name}},', align: 'left' },
      {
        type: 'text',
        text: 'Would twenty minutes be worth it to see whether what we do is relevant to {{company}}? I would rather find out quickly than send you material you did not ask for.',
        align: 'left',
      },
      { type: 'spacer', size: 'small' },
      { type: 'text', text: 'Best regards — {{sender_name}}', align: 'left' },
    ],
  },
  {
    id: 'documents',
    name: 'Sending documents',
    category: 'transactional',
    description: 'Plain note for sending information that was asked for.',
    subject: 'The details you asked for',
    preview_text: 'The information from our conversation.',
    blocks: [
      { type: 'text', text: 'Hello {{contact_first_name}},', align: 'left' },
      { type: 'text', text: 'Here is the information you asked for.', align: 'left' },
      { type: 'text', text: 'Tell me if anything is unclear and I will follow up.', align: 'left' },
      { type: 'text', text: 'Best regards', align: 'left' },
    ],
  },
];
export const templateCategories: Array<{ value: TemplateCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'outreach', label: 'Outreach' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'meeting', label: 'Meetings' },
  { value: 'transactional', label: 'Transactional' },
];
