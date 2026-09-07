import { BookOpen, History, Users } from 'lucide-react';
import type { Lead, PreservedRecord } from '../shared/types';
import { date } from './api';
import { ExternalLink } from './ui';

const value = (item: unknown) =>
  item === null || item === undefined
    ? ''
    : typeof item === 'object'
      ? JSON.stringify(item, null, 2)
      : String(item);
function Fields({
  data,
  fields,
}: {
  data: Record<string, unknown>;
  fields: Array<[string, string]>;
}) {
  const available = fields.filter(([key]) => value(data[key]) !== '');
  if (!available.length) return null;
  return (
    <dl className="preserved-fields">
      {available.map(([key, title]) => (
        <div key={key}>
          <dt>{title}</dt>
          <dd>{value(data[key])}</dd>
        </div>
      ))}
    </dl>
  );
}
function Contact({ record }: { record: PreservedRecord }) {
  const data = record.data;
  return (
    <article className="preserved-contact">
      <h4>{value(data.full_name) || 'Saved contact'}</h4>
      <p className="muted">
        {[data.job_title, data.department].map(value).filter(Boolean).join(' · ') ||
          'Role not recorded'}
      </p>
      <Fields
        data={data}
        fields={[
          ['email', 'Email'],
          ['phone_direct', 'Direct phone'],
          ['phone_mobile', 'Mobile'],
          ['contact_role', 'Research role'],
          ['verification_source', 'Original verification source'],
          ['verified_date', 'Verification date on record'],
          ['interest_reason', 'Relevance'],
          ['ceramic_bearing_experience', 'Ceramic bearing experience'],
          ['operating_media', 'Operating media'],
          ['attempted_solution', 'Previous solution'],
          ['hybrid_bearing_alternative', 'Hybrid alternative'],
          ['cooperation_interest', 'Cooperation interest'],
          ['notes', 'Saved notes'],
        ]}
      />
      {Boolean(data.linkedin_url) && <ExternalLink url={value(data.linkedin_url)} />}
      <details className="raw-record">
        <summary>Original contact record</summary>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </details>
    </article>
  );
}
export function PreviousResearch({ lead, projectName }: { lead: Lead; projectName: string }) {
  let company: Record<string, unknown>;
  try {
    company = JSON.parse(lead.legacy_json || 'null');
  } catch {
    return null;
  }
  if (!company) return null;
  const records = lead.preserved_records || [];
  const contacts = records.filter((row) => row.kind === 'contacts');
  const history = records.filter((row) => row.kind !== 'contacts');
  return (
    <section className="previous-research">
      <div className="section-title">
        <h3>
          <BookOpen size={19} />
          Existing {projectName} research
        </h3>
        <span className="reference-label">Preserved reference</span>
      </div>
      <p className="muted">
        Your earlier company details, contacts and reasoning remain available. New qualification
        uses approved project training and checks historical claims against current evidence.
      </p>
      <Fields
        data={company}
        fields={[
          ['company_type', 'Business type'],
          ['business_role', 'Business role'],
          ['legal_form', 'Legal form'],
          ['city', 'City'],
          ['region', 'Region'],
          ['employee_count', 'Employees on record'],
          ['revenue_eur', 'Revenue on record (EUR)'],
          ['corporate_parent', 'Corporate parent'],
          ['main_products', 'Products'],
          ['product_fit', 'Sintertechnik product relevance'],
          ['technical_fit', 'Previous technical fit'],
          ['lead_priority', 'Previous priority'],
          ['lead_status', 'Previous status'],
          ['lead_score', 'Previous score'],
        ]}
      />
      {Boolean(company.opportunity_notes) && (
        <div className="prior-reasoning">
          <h4>Product and application opportunities</h4>
          <p>{value(company.opportunity_notes)}</p>
        </div>
      )}
      <details className="context-details">
        <summary>Previous qualification and review reasoning</summary>
        <Fields
          data={company}
          fields={[
            ['qualification_notes', 'Qualification reasoning'],
            ['ai_qualified_at', 'Analysis date'],
            ['disqualification_reason', 'Disqualification reason'],
            ['disqualification_category', 'Exclusion category'],
            ['human_review_notes', 'Human review notes'],
            ['human_reviewed_by', 'Reviewed by'],
            ['human_reviewed_at', 'Review date'],
          ]}
        />
        <p className="fine-print">
          These decisions predate the current training workflow. They do not count as a current
          qualification.
        </p>
      </details>
      <details className="context-details">
        <summary>
          <Users size={16} />
          Saved contacts <span>{contacts.length}</span>
        </summary>
        <p className="fine-print">
          Contact details and verification dates are preserved as originally recorded. Contact
          names, email and phone fields are not included in AI qualification requests.
        </p>
        {contacts.length ? (
          <div className="preserved-contacts">
            {contacts.map((record) => (
              <Contact key={record.id} record={record} />
            ))}
          </div>
        ) : (
          <p className="muted">No earlier contact records available for this company.</p>
        )}
      </details>
      <details className="context-details">
        <summary>
          <History size={16} />
          Earlier research and notes <span>{history.length}</span>
        </summary>
        {history.length ? (
          history.map((record) => (
            <article className="preserved-activity" key={record.id}>
              <h4>
                {value(record.data.subject || record.data.type || record.data.company_name) ||
                  'Earlier research'}
              </h4>
              <small>
                {date(value(record.data.activity_date || record.data.created_at))} ·{' '}
                {value(record.data.performed_by || record.data.author) || 'Previous workspace'}
              </small>
              <Fields
                data={record.data}
                fields={[
                  ['activity_type', 'Activity'],
                  ['details', 'Research details'],
                  ['outcome', 'Outcome'],
                  ['message', 'Note'],
                  ['results_json', 'Research results'],
                ]}
              />
              <details className="raw-record">
                <summary>Original research record</summary>
                <pre>{JSON.stringify(record.data, null, 2)}</pre>
              </details>
            </article>
          ))
        ) : (
          <p className="muted">No earlier activities or notes recorded for this company.</p>
        )}
      </details>
      <details className="raw-record">
        <summary>All preserved company fields</summary>
        <pre>{JSON.stringify(company, null, 2)}</pre>
      </details>
    </section>
  );
}
