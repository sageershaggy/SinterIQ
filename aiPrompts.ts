// AI lead-qualification prompts for Sintertechnik, extracted from server.ts so
// the prompt copy can be edited and reviewed without wading through request
// handlers. buildQualifyUserPrompt interpolates the per-company context blocks.

export const QUALIFY_SYSTEM_PROMPT = `You are an expert B2B sales intelligence agent for Sintertechnik GmbH (Germany), a manufacturer of precision ceramic bearings, hybrid bearings, and ceramic components. Your job is to deeply qualify leads and generate actionable sales intelligence. Return only strict JSON with no markdown or code fences.`;

export function buildQualifyUserPrompt(
  company: any,
  contactsBlock: string,
  activitiesBlock: string,
  websiteContext: string | null,
): string {
  return `
Perform a comprehensive lead qualification and sales intelligence analysis for the following company.

COMPANY DATA:
- Name: ${company.company_name}
- Country: ${company.country}
- City: ${company.city || 'Unknown'}
- Industry: ${company.industry}
- Company Type: ${company.company_type}
- Revenue (EUR): ${company.revenue_eur ? `€${(company.revenue_eur/1000000).toFixed(1)}M` : 'Unknown'}
- Employees: ${company.employee_count || 'Unknown'}
- Website: ${company.website || 'Unknown — search the web to find it'}
- Existing Notes: ${company.qualification_notes || 'None'}
${contactsBlock}${activitiesBlock}
${websiteContext ? `WEBSITE CONTENT SNAPSHOT (multiple pages merged):\n${websiteContext}\n` : 'Website could not be fetched — use web search to gather information.\n'}

SINTERTECHNIK PRODUCTS:
- Full ceramic bearings (ZrO2, Si3N4, Al2O3) — ideal for corrosive/hygienic/high-temp environments
- Hybrid ceramic bearings (steel races + ceramic balls) — higher speed, longer life, reduced maintenance
- Ceramic components (shafts, bushings, rollers, seal seats)
- Key applications: pumps, food processing, pharma, chemical, desalination, oil & gas, vacuum, cryogenic, electroplating

RESEARCH TASKS:
1. Search the web for this company — find their website, LinkedIn, social media, recent news
2. Assess their industry fit for ceramic bearings (pump manufacturers, bearing distributors, food/pharma/chemical end-users are top fits)
3. Estimate employee fit (20-2000 employees = ideal addressable range; larger = longer procurement process)
4. Check if they have active social media and recent posts
5. Look for signals: expansion, new facilities, sustainability goals, engineering team presence, bearing mentions

CRITICAL EXCLUSION RULES — apply FIRST, before any scoring. If ANY rule below matches, set lead_priority=NOT_A_TARGET, category=NO_FIT, score=0, technical_fit=NOT_FIT. State the matched rule explicitly in 'reasoning'.

The core test in EVERY rule: "Does THIS legal entity, at THIS German address, have the R&D / engineering / manufacturing authority to DESIGN-IN a Sintertechnik ceramic or hybrid bearing into a product or internal production line?" If the answer is no — even if their parent or corporate group does — they are NOT_A_TARGET (or LOW_PRIORITY if the parent is a reachable target and should be pursued separately).

RULE 1 — DIRECT BEARING COMPETITORS (NOT_A_TARGET, score 0):
The company manufactures rolling bearings (ball, roller, spherical, tapered, angular contact, spindle, thin-section, deep-groove, ceramic, hybrid) as a primary product. Includes precision bearing makers, aerospace bearing makers, and "Kugellagerfabrik" / "Wälzlager" / "Kugellager" companies with in-house production.
Known examples: HQW Precision, HWG Horst Weidner, RWG Germany (Kaman), Artur Küpper, TKF Thüringer Kugellagerfabrik, Wälzlagertechnik GmbH, WSW Wälzlager Wolfgang Streich, ASK-Kugellagerfabrik Artur Seyfert.
PLAIN bearing (Gleitlager) makers like Gleitlagertechnik Essen are also too close to core business — NOT_A_TARGET or at most LOW_PRIORITY if they have no rolling bearing line at all.

RULE 2 — SUBSIDIARIES / HOLDINGS OF BEARING COMPETITORS:
Any subsidiary, brand, or holding affiliate of a known bearing manufacturer = NOT_A_TARGET.

RULE 3 — NON-MANUFACTURING WHOLESALERS / MAIL-ORDER / RETAILERS / TRADE-AND-INSTALLATION (NOT_A_TARGET, score 0):
Core business = buying finished goods and reselling, renting, or installing them. No in-house manufacturing, no R&D, no engineering team specifying mechanical components. Linguistic flags: "Handel", "Großhandel", "Versandhandel", "Mail-order", "Vertrieb" WITHOUT "Produktion", "Handelsgesellschaft", "e.K.", "eG" (trade cooperative).
Subcategories to exclude:
  3a. Dental / medical consumable mail-order (M+W Dental Müller & Weygandt, GC Germany as corporate dental sales office).
  3b. Plumbing / heating / sanitary / HVAC / electrical trade wholesalers (Elmer GmbH Bönen, Cl. Bergmann, Georg C. Hansen, Niehaus, P & P Handelsgesellschaft, Reiss Kälte-Klima).
  3c. Building-materials / hardware wholesalers and trade cooperatives (e.g. FLEISCHERRING eG — logistics/trade org for meat craft sector).
  3d. Construction-machinery and material-handling dealers, rental-and-service businesses, authorized heavy-equipment dealers, forklift dealers. They buy finished excavators/cranes/forklifts from global OEMs and sell/rent/service them — they do NOT design the hydraulic systems, slew rings, or motors. Examples: Kurt König Baumaschinen, Hoch Baumaschinen, Wille Baugeräte-Schalungstechnik, MF Baumaschinen, KLARMANN-LEMBACH, Odenwälder Baumaschinen, Transport-Bau-Fördergeräte, Ziesmann Baugeräte, DiTec, Atlas-Kern (Yanmar/Mecalac/Magni dealer), Diez Fördertechnik (Linde-style dealer), MV Fördertechnik (Linde dealer), Degener Staplertechnik (Mitsubishi forklift dealer).
  3e. Specialty chemicals distributors / chemical trading KGs (Azelis Deutschland, Carlofon, Chemische Fabrik Wocklum as trading KG).
  3f. Petroleum / fuel / heating-oil / LPG distributors and energy-logistics operators (Erik Walther W.J. Mineralölhandelsgesellschaft).
  3g. Industrial packaging consultants / material wholesalers without in-house machine R&D (Knüppel Verpackung).
  3h. Consumer-goods / giftware / decoration / seasonal-article wholesalers (CEPEWA).
  3i. Automotive spare-parts wholesalers and aftermarket parts traders — they sell ready-to-install OEM spares, no design authority (Wütschner Fahrzeugteile, Alcar Logistik as wheel-distribution hub).
  3j. Agricultural/recycling trading KGs and regional end-user traders (Wiegmann NaturPower, M. Ellebracht wood-trading).
  3k. Scientific / laboratory / biotech distributors and reseller catalogs (VWR International, New England Biolabs GmbH as German distribution sub, Ing. Fritz Schroeder as Duplo print-finishing distributor).
  3l. Trade-and-installation businesses (Wilhelm Marx — buys packaging machines and installs them in food plants; does not build them).
  3m. Microgenics and similar distributors of diagnostic immunoassays — no bearing design authority.

RULE 4 — UTILITY OPERATORS / ENERGY TRADERS / SOFTWARE-FLEX OPERATORS (NOT_A_TARGET):
Companies that OPERATE energy, water, or infrastructure systems — or TRADE energy on spot markets via software — but do not DESIGN or BUILD mechanical equipment. Their "machinery" is a server rack, a dashboard, or a turnkey purchased asset they just run. Examples: ENTEGA Plus (green-energy utility), Carbon Zero Flex Energy (SaaS/algorithmic BESS and wind/solar optimizer — software company, not a machine builder).

RULE 5 — PURE SERVICE PROVIDERS / MRO-ONLY / SITE-OPERATORS (NOT_A_TARGET):
They USE automated or heavy equipment but do not MANUFACTURE it and have no engineering authority over mechanical specs. Includes: diagnostic-lab services (amedes), packaging-pool cleaning services (Cartonplast), aviation-fuel hydrant operators (Skytanking — operates airport fueling, does not build the pumps), fire-extinguisher refilling / service stations (Bavaria-Feuerschutz Riesa site), regional welding-equipment and robot-integration distributors who only swap in OEM spares (Wenk Schweißtechnik), fleet / construction-site logistics firms (IBB Logistik), commercial-kitchen service/planning firms with no manufacturing (LODDER Großküchentechnik, Döbrich & Kohl), retrofit floor-heating millers (DML Fußbodenheizung), specialized installers of pre-bought explosives/ordnance for construction (Essing Sprengtechnik — distributor for Poudrerie d'Aubonne / MAXAM), regional tractor/truck repair shops (Christian Halbig / Halbig Landtechnik).

RULE 6 — GLOBAL ENTERPRISES OUTSIDE THE SME PROFILE (NOT_A_TARGET):
Companies with >5,000 global employees where mechanical-component procurement is centralized at HQ outside Germany and the German entity has no spec authority. Examples: Fresenius Medical Care (>110k employees, rigid medical regulatory cycles), Dow Produktions und Vertriebs GmbH, SodaStream GmbH (PepsiCo subsidiary — consumer plastic, procurement in Israel/Netherlands), Celltrion Healthcare Deutschland (strictly sales/admin HQ; manufacturing in South Korea/USA), Toray International Europe (Japanese trading/regional HQ with zero local production).

RULE 7 — REGIONAL SALES BRANCHES / AUTHORIZED DEALERS / "VERTRIEBS-GMBH" SUBSIDIARIES (NOT_A_TARGET — with possible PARENT REDIRECT):
This is a subtle but HIGH-VOLUME pattern. The German legal entity exists only to SELL, SUPPORT, WAREHOUSE, or SERVICE products designed and built abroad by a parent. No mechanical spec authority at this address. Linguistic flags: "Vertriebs-GmbH", "Deutschland GmbH" of a Japanese/Korean/US parent, "Europe GmbH", "International GmbH", "Nord/Süd GmbH" (regional branch). Flag them NOT_A_TARGET at this entity level.
IMPORTANT PARENT-REDIRECT LOGIC: If the PARENT company IS a plausible target (e.g. genuinely manufactures machinery that uses bearings), say so explicitly in 'opportunity_notes' — e.g. "NOT_A_TARGET at this Vertriebs-GmbH, but the parent Eberspächer Group manufactures high-speed fans/blowers and should be researched as a separate target."
Known examples:
  • HYUNDAI Baumaschinen Nord GmbH — regional Hyundai excavator dealer; manufacturing in South Korea.
  • J. MORITA EUROPE GMBH — German sales office; manufacturing at J. Morita Mfg. Corp. Kyoto.
  • Tanaka Kikinzoku International (Europe) GmbH — Frankfurt sales/import gateway for TANAKA Precious Metals Japan.
  • Tokyo Sangyo Europe GmbH — technical trading / project-management hub for Mitsubishi Heavy Industries.
  • ETI Deutschland GmbH — German sales/distribution HQ of ETI Group Slovenia.
  • ADVICS Europe GmbH — Tier-1 automotive hub, sales/application engineering only; bearing specs controlled in Japan.
  • Unigloves GmbH — German sales/logistics; manufacturing in Asia.
  • KEYENCE Deutschland GmbH — Frankfurt sales/support office.
  • LONGI Solar Technologie GmbH — European commercial HQ, no local manufacturing.
  • Fresenius Kabi MedTech Services GmbH — Alzenau service/repair center; primary pump manufacturing is elsewhere.
  • Uniparts India GmbH — Hennef warehouse/customer-service node; ~85% manufacturing in India.
  • Eberspächer Heizung Vertriebs-GmbH & Co. KG — sales arm. (Parent Eberspächer Group IS a potential target — call this out.)
  • ASSA ABLOY Global Solutions GmbH — software/RFID/electronic-locks sales hub (ultimate parent ASSA ABLOY AB is not mechanical-bearing-relevant either).

RULE 8 — EPC CONTRACTORS / SYSTEM INTEGRATORS / PROJECT DEVELOPERS / SPECIALIZED INSTALLERS (NOT_A_TARGET):
They bid and install turnkey systems (solar plants, heating, electrical, building technology) using third-party components. No manufacturing, no R&D, no design-in authority. Examples: Tholen Gebäudetechnik (building technology installer), Prima Solar & Bau (solar EPC), SUNfarming (solar project developer & EPC — system integrator only, does not make cells or trackers), DML Fußbodenheizung (retrofit heating installer).

RULE 9 — SMALL CRAFT PRODUCERS / REGIONAL END-USERS WITH LOW MECHANICAL COMPLEXITY (NOT_A_TARGET):
Tiny craft producers and regional operators with no design authority and minimal bearing-purchase volume. Examples: Maibacher Brauerei (small craft brewery — standard low-complexity equipment).

RULE 10 — LEGAL-FORM NAME PATTERNS THAT SIGNAL NON-MANUFACTURING (check and apply above rules):
  • "e.K." (eingetragener Kaufmann), "eG" (eingetragene Genossenschaft), "Handelsgesellschaft mbH" → almost always trade/retail → Rule 3.
  • "Vertriebs-GmbH" / "Vertriebs-Gesellschaft" → sales arm → Rule 7.
  • "Dienstleistungen GmbH" / "Services GmbH" / "Service GmbH" → service org → Rule 5.
  • "Logistik GmbH" → logistics/operator → Rule 3d/5.
  • "Projekt und Systemtechnik" / "Systemtechnik" stand-alone (with installation focus) → Rule 8.
  • "Beteiligungsgesellschaft" / "Holding" alone → holding; check operating subsidiaries.

LEAD PRIORITY CLASSIFICATION (by Ahmad Khan):
Classify the company into one of these four categories:

- HIGH_PRIORITY: 20–2000 employees, OEM/Manufacturer of products that USE bearings (NOT a bearing maker), operates in extreme environments (corrosive, high-temp, hygienic, vacuum, cryogenic, chemical, food/pharma, oil & gas, desalination), has visible technical/R&D capability, and has industry-multiplier potential (one win = large-scale or repeat custom project).

- STRONG: 20–2000 employees, manufacturer of non-bearing products OR a technical distributor/bearing trader/reseller acting as a sales-channel partner. Has some but not all HIGH_PRIORITY features.

- LOW_PRIORITY: Some relevance but limited fit. Use for:
  • Static-product manufacturers with few rotating parts (cable trays, packaging trays, lighting fixtures, simple PE films) — PE-PACKAGING, Artemide Deutschland, OBO Bettermann (external products static; internal stamping/galvanizing plants may be a weak indirect angle).
  • Solid-state electronics manufacturers where moving parts are only cooling fans — Riello UPS.
  • Solar/renewable EPC integrators who do NOT make panels or trackers — SUNfarming (also covered by Rule 8; use LOW_PRIORITY only if there is some in-house mechanical/production exposure).
  • Medical/textile manufacturers whose process machines use only standard industrial rollers with no extreme-environment need — Raguse.
  • German sales/support subsidiaries of global tech conglomerates with no local spec authority (Rule 7) — if the parent is unreachable for SME-style outreach, LOW_PRIORITY is appropriate here.
  • Plain-bearing (Gleitlager) specialists too close to core business but technically adjacent — Gleitlagertechnik Essen.
  • Specialty chemical suppliers for automotive sector with no R&D/maintenance division requiring industrial bearings — Carlofon (borderline with Rule 3).
  • Aftermarket / MRO-only partners where only spare-parts sales are plausible — Döbrich & Kohl, LODDER Großküchentechnik, ZTR Rossmanek, Fresenius Kabi MedTech Services (service/repair entity).
  • Small regional dealers, traders, and service providers with weak technical depth.
  • Manufacturers of safety/fire-protection consumables with no in-house fabrication of the mechanical housings/valves — Bavaria-Feuerschutz Riesa site.
  • "Vertriebs-GmbH" subsidiaries where the PARENT is a genuine target (flag parent-redirect in opportunity_notes) — Eberspächer Heizung Vertriebs-GmbH is NOT_A_TARGET but note the parent.

- NOT_A_TARGET: Anything matching RULES 1–9, plus pure service providers, wholesalers/retailers/mail-order with no manufacturing, no visible production activity, or no relevant industrial requirement.

DECISION CHECKLIST (run in order — stop at the first hit):
1. Bearing manufacturer or subsidiary of one? -> NOT_A_TARGET (Rule 1/2)
2. Pure wholesaler / retailer / mail-order / authorized dealer / trade-and-install / scientific distributor / aftermarket parts trader? -> NOT_A_TARGET (Rule 3)
3. Utility operator or software-flex energy trader (SaaS optimizer)? -> NOT_A_TARGET (Rule 4)
4. Pure service / MRO-only / site-operator / aviation-fuel hydrant operator / lab-service / fire-extinguisher refiller? -> NOT_A_TARGET (Rule 5)
5. >5000 employees with centralized global procurement and no local spec authority? -> NOT_A_TARGET (Rule 6)
6. Regional sales branch / authorized dealer / Vertriebs-GmbH / Europe-GmbH / Deutschland-GmbH of a foreign parent with no German spec authority? -> NOT_A_TARGET (Rule 7). If the PARENT is plausibly a target, flag parent-redirect in opportunity_notes.
7. EPC / system integrator / project developer / specialized installer using only third-party components? -> NOT_A_TARGET (Rule 8). If they have a small in-house shop, consider LOW_PRIORITY.
8. Tiny craft producer / micro end-user? -> NOT_A_TARGET (Rule 9)
9. Company size 20–2000 employees? (very small or very large often drops to LOW_PRIORITY; mid-SME caps at STRONG/HIGH_PRIORITY)
10. OEM / Manufacturer of products that USE bearings (not MAKE bearings)? -> potential HIGH_PRIORITY/STRONG
11. Static products / solid-state electronics / aftermarket-only / adjacent specialty? -> LOW_PRIORITY
12. Extreme operating environment (corrosive/high-temp/hygienic/vacuum/cryogenic)? Strong signal for HIGH_PRIORITY
13. Visible technical / R&D capability on website? Strong signal for HIGH_PRIORITY
14. Industry-multiplier potential (one win = large-scale or repeat custom project)? Strong signal for HIGH_PRIORITY

When writing 'reasoning': always state WHICH rule was matched by number, and — if Rule 7 (Vertriebs-GmbH / regional branch) matches — explicitly name the parent and state whether the parent looks worth pursuing as a separate target. Put the parent-redirect recommendation at the START of 'opportunity_notes' so the sales manager sees it immediately.

Return a JSON object with EXACTLY these fields:
{
  "score": <integer 0-100, overall lead quality>,
  "confidence": <integer 0-100, how confident you are in this classification based on evidence found — HIGH if you found website + clear industry signals; LOW if you had to infer heavily from the company name only. Used for human-review routing.>,
  "buying_probability": <integer 0-100, likelihood they need ceramic bearings in next 12 months>,
  "technical_fit": <"HIGH" | "MEDIUM" | "LOW" | "NOT_FIT">,
  "product_fit": <"Ceramic Bearings" | "Hybrid Bearings" | "Ceramic Components" | "Multiple Products" | "None">,
  "category": <"STRATEGIC_PARTNER" | "BEARING_CUSTOMER" | "LOW_FIT" | "NO_FIT">,
  "lead_priority": <"HIGH_PRIORITY" | "STRONG" | "LOW_PRIORITY" | "NOT_A_TARGET">,
  "city": <string or null, the city/town where the company headquarters is located — search the web if unknown>,
  "country": <string or null, the country where the company headquarters is located — search the web if unknown>,
  "website": <string, the company's main website URL if found — IMPORTANT if company has no website set>,
  "employee_count": <integer or null, estimated employee count if found>,
  "website_score": <integer 0-100, website quality and activity level>,
  "social_score": <integer 0-100, social media presence and activity>,
  "social_media_active": <boolean>,
  "social_media_urls": <array of strings, LinkedIn/Twitter/Facebook/Instagram/YouTube URLs found>,
  "social_profiles": <array of objects with {platform, url, followers, lastActive, lastPost} — for each social media account found. platform is "LinkedIn"/"Facebook"/"Instagram"/"YouTube"/"Twitter/X". followers is a string like "5.2K" or "12,340" or "unknown". lastActive is approximate date string like "March 2026" or "Active" or "unknown". lastPost is a short description of their most recent post or "unknown">,
  "mentions_technology": <boolean, do they mention bearings, ceramics, precision components>,
  "reasoning": <string, 3-5 sentence strategic analysis explaining the score and fit — written for a sales manager>,
  "opportunity_notes": <string, specific opportunities or pain points relevant to ceramic bearings — be specific to their industry>,
  "approach_strategy": <string, 2-3 sentence recommended approach: who to contact, what angle to use, timing>,
  "sales_script": <string, 5-8 bullet talking points for a sales call — specific to this company and industry, mention their applications>,
  "email_script": <string, complete cold outreach email — subject line + body, max 150 words, personalized to this company, mention a specific product application relevant to their industry>,
  "key_contacts": <array of objects with {fullName, jobTitle, email, phone, linkedinUrl} — find 2-5 key decision makers (CEO, procurement, maintenance, engineering) from web/LinkedIn search. Leave fields as empty string if unknown>
}`;
}
