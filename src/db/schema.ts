// NOTE: Deploys apply drizzle/schema-sync.sql (idempotent, additive), not
// `drizzle-kit push`. When you add a table/column/index here, mirror it there.
// The build's verify-schema gate fails the deploy if a column is missing, so a
// forgotten mirror is caught loudly - never shipped silently.
import {
  pgTable, text, integer, boolean, timestamp, serial, primaryKey, index, unique, numeric, jsonb, doublePrecision,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// ---------------------------------------------------------------------------
// Auth.js tables (required by the Drizzle adapter for email magic-link login)
// ---------------------------------------------------------------------------
export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique().notNull(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  // owner | staff | client_viewer | client_editor
  role: text("role").notNull().default("client_viewer"),
  /**
   * The fallback way in, for the days email doesn't arrive - a provider blocks a
   * domain, a filter eats the message. Set from inside the app by somebody
   * already signed in, so the address was proved before a password ever existed
   * for it; blank means this person has none and signs in by code as usual.
   * Format and rules live in lib/password.
   */
  /**
   * Which half of the app this person works in, on a company that does both -
   * "lab" or "reseller", blank to follow their organization's own setting.
   *
   * Theirs to set, not the operator's: it changes which question a page leads
   * with and nothing about what they may see or do, so it is a preference
   * rather than a privilege. Blank is the common answer and stays the default
   * forever - a company that starts or stops reselling carries along everybody
   * who never touched this. See lib/viewMode.
   */
  viewMode: text("view_mode").notNull().default(""),
  /**
   * When this person was shown where the view switch lives. Null = never, and
   * the card is waiting for them. Once, not on a timer: a tutorial that comes
   * back is an interruption, and this one is three sentences about a menu.
   */
  viewTourAt: timestamp("view_tour_at"),
  passwordHash: text("password_hash").notNull().default(""),
  passwordSetAt: timestamp("password_set_at"),
  /**
   * When a password stops working, for one an OWNER set rather than the person
   * themselves - the way in while email is not arriving at all. Null is the
   * ordinary case: a password somebody chose for their own account never
   * expires. A date here is a loan, and lib/passwordAuth refuses it the moment
   * it passes, so a credential handed over the phone cannot quietly become a
   * permanent one.
   */
  passwordTempUntil: timestamp("password_temp_until"),
  /**
   * Where to text a sign-in code, E.164. Set by the person themselves from
   * inside the app, so it is a second way back into an account rather than a way
   * to get one. Blank means codes go by email as they always have.
   */
  phone: text("phone").notNull().default(""),
  /**
   * When this person finished setting themselves up - their name, how they want
   * to be told things, and a password if they wanted one. Null means they have
   * never done it, which is what sends a first-time arrival to /welcome instead
   * of a dashboard they have no name on.
   *
   * A timestamp rather than a flag so "when did they join" is answerable, and so
   * that clearing it is a way to ask somebody to look again.
   */
  onboardedAt: timestamp("onboarded_at"),
  /**
   * Vestigial: the "What's new" changelog was removed from the product. The
    * column stays because dropping one is a migration and an unused text
    * column costs nothing; nothing reads or writes it any more.
   * Blank = never dismissed any, which for a new account simply means the
   * current batch shows once. On the user rather than in localStorage so a
   * dismissal on the desk PC holds on the phone in the lab.
   */
  whatsNewSeen: text("whats_new_seen").notNull().default(""),
  /**
   * The last time this person actually did something in the app, not the last
   * time they signed in. Sessions last a month (lib/sessionCookie), so sign-ins
   * count how often somebody is LOCKED OUT, not how often they work here -
   * whoever uses the portal every morning signs in twelve times a year. Written
   * at most once an hour per person (lib/loginLog.touchLastSeen), so a busy day
   * costs eight writes rather than eight hundred.
   */
  lastSeenAt: timestamp("last_seen_at"),
  /**
   * The structured halves of `name`, plus who this person is at their company.
   * Editable by an owner in Settings > Organizations; `name` stays the one
   * display name everywhere, rewritten from these whenever they are set so the
   * two can never disagree.
   */
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  title: text("title").notNull().default(""),
  /** Which of their organization's sites this person sits at. */
  siteId: integer("site_id").references((): AnyPgColumn => orgSites.id, { onDelete: "set null" }),
});

export const accounts = pgTable("accounts", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").$type<AdapterAccountType>().notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })]);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

/**
 * Sign-in throttling, one row per email address.
 *
 * The six-digit code that goes in the same email as the magic link is only a
 * credential because of what is counted here: wrong guesses, and codes asked
 * for. Kept in its own table rather than on the verification token, because the
 * counters have to outlive the code they are counting - a lock that vanished
 * with the token it protected would be no lock at all.
 *
 * Not tenant-stamped on purpose: this is about an address trying to get in, and
 * that happens before anybody knows whose workspace they belong to.
 */
export const loginAttempts = pgTable("login_attempts", {
  identifier: text("identifier").primaryKey(),   // the email, lowercased
  attempts: integer("attempts").notNull().default(0),
  requests: integer("requests").notNull().default(0),
  windowStart: timestamp("window_start").notNull().defaultNow(),
  lockedUntil: timestamp("locked_until"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires", { mode: "date" }).notNull(),
}, (t) => [primaryKey({ columns: [t.identifier, t.token] })]);

/**
 * One row every time somebody gets in. Append-only, like the audit log.
 *
 * There are two doors - a code from an email and a password (lib/passwordAuth)
 * - and the second one leaves no trace anywhere else: no mail is sent, so the
 * operator's own inbox stops being an accidental record of who is using the
 * platform. This table is the record, and both doors write to it.
 *
 * The email is stored alongside the user id rather than only joined to it,
 * because history has to outlive the account: "who was signing in last spring"
 * must still answer for somebody offboarded since. Same reason the audit log
 * keeps an actor string.
 *
 * `operatorOrgId` is who to show it to, resolved at sign-in from house
 * membership or the person's own organization. Not called tenantOrgId: nothing
 * stamps it, it is settled once when the row is written and never moves.
 */
export const loginEvents = pgTable("login_events", {
  id: serial("id").primaryKey(),
  // Null once the account is deleted; the email below still names who it was.
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  email: text("email").notNull(),
  // code | password. What door they came through, which is the whole reason
  // this exists - a password sign-in is otherwise invisible.
  method: text("method").notNull().default("code"),
  // Role and organization as they stood at that moment. A person promoted in
  // March should not rewrite what they were in January.
  role: text("role").notNull().default(""),
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "set null" }),
  orgName: text("org_name").notNull().default(""),
  operatorOrgId: integer("operator_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Coarse client detail: enough to tell a phone in a lab from a desktop in an
  // office, and to notice a sign-in from somewhere nobody expected. Truncated
  // on write - a full user-agent string is noise at this size.
  ip: text("ip").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("login_events_email_idx").on(t.email),
  index("login_events_created_idx").on(t.createdAt),
]);

// ---------------------------------------------------------------------------
// Domain tables
// ---------------------------------------------------------------------------

// Organizations the portal is shared WITH. Sierra Spectra itself is not a row
// here - staff/owner come from STAFF_EMAILS and see everything. A `client` owns
// or operates systems; a `provider` is an outside service outfit either side
// brings onto specific systems.
export const orgs = pgTable("orgs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("client"), // client | provider
  // Does this organization run a workspace of its own - staff, documents it
  // signs, clients it creates? That is what makes it a TENANT, and it is the
  // difference between the company selling the service and the companies buying
  // it. One operator is the root (app_settings.operator_org_id): the company
  // running the instance, whose staff support every tenant. See lib/tenants.
  isOperator: boolean("is_operator").notNull().default(false),
  // The operator this organization belongs to. Null for operators themselves.
  // Cascade because a tenant's clients are part of that tenant: offboarding the
  // operator takes its client list, their logins and their shares with it.
  parentOrgId: integer("parent_org_id").references((): AnyPgColumn => orgs.id, { onDelete: "cascade" }),
  // Workspace appearance, set by the org's own editors: header color (hex)
  // and a logo shown beside the wordmark. Blank = the platform default look.
  themeColor: text("theme_color").notNull().default(""),
  logoUrl: text("logo_url").notNull().default(""),
  /**
   * This workspace's own spectrum - the thin gradient above the header, which
   * is the one piece of the design that is purely identity.
   *
   * Blank stops and a null height both mean INHERIT, and they inherit
   * independently: an organization that wants the platform's colours a little
   * thicker sets the height and leaves the stops alone. One nullable column
   * and one blank-means-default column rather than a single JSON blob, because
   * "they never chose" and "they chose the default" are different states and
   * only one of them should follow the platform when the platform changes.
   *
   * Same shape and same validation as app_settings' pair - lib/appearance owns
   * both, and nothing reaches a style attribute without passing through it.
   */
  spectrumStops: text("spectrum_stops").notNull().default(""),
  spectrumHeight: integer("spectrum_height"),
  /**
   * How this service company numbers its paper, as JSON - see lib/docNumber.
   *
   * On the OPERATOR org, because a numbering scheme is a house convention:
   * Sierra Spectra threads a job number through every document (030120_INV1)
   * and the shop next door counts each type on its own (PO-1042), and both are
   * right. A client organization has no paper of its own to number, so the
   * column is simply unused on one.
   *
   * Blank means the stock shape, which is what every workspace had before this
   * existed - so nothing that has already been issued changes its name.
   */
  docScheme: text("doc_scheme").notNull().default(""),
  // Who at this organization receives its daily report. Each client gets its
  // own list and its own send button - one report per client, never a merged
  // one that would show them each other's systems.
  eodRecipients: text("eod_recipients").notNull().default(""),
  // Who at this organization receives the partner edition of the daily digest
  // - their engagement's section: status, yesterday's work, what's blocked and
  // whose move it is. Separate from eodRecipients on purpose: the EOD report
  // is hand-written and sent by a person, the digest is composed and sent by
  // the machine, and opting a client into one must never opt them into the
  // other. Blank = the digest stays internal for this organization.
  digestRecipients: text("digest_recipients").notNull().default(""),
  /** Days from issue to due. 30 unless their paper says otherwise. */
  termsDays: integer("terms_days").notNull().default(30),
  /** Where invoices and statements go. Blank falls back to the digest list. */
  apEmail: text("ap_email").notNull().default(""),
  /**
   * The blanket PO an invoice must reference, and what is left on it. Both
   * blank/zero means no PO on file - which is one of the two silent rejections
   * (the other is an exhausted PO), so a draft invoice checks and WARNS rather
   * than blocking. See lib/billing.poCheck.
   */
  poNumber: text("po_number").notNull().default(""),
  poBalanceCents: integer("po_balance_cents").notNull().default(0),
  /**
   * This client's billing rules, overriding the platform defaults in
   * app_settings - the same defaults-then-per-org layering the digest schedule
   * uses. Shape and parsing live in lib/billingPolicy; jsonb so the fields can
   * grow without a migration per knob.
   */
  billingPolicy: jsonb("billing_policy"),
  /**
   * The operator's own Stripe Connect account - THEIRS, not the platform's.
   * Money moves bank to bank between the client and the service company;
   * Ridgeline never holds funds and never sees a card number. Blank means
   * nobody has connected one, and the pay buttons simply do not render.
   */
  stripeAccountId: text("stripe_account_id").notNull().default(""),
  /** Whether Stripe has finished its checks on that account. */
  stripeReady: boolean("stripe_ready").notNull().default(false),
  /**
   * The hour (0-23, shop time) this organization's digest goes out. On the
   * operator's own row it is the internal edition's hour.
   *
   * Here rather than in the cron expression because vercel.json is a deploy
   * artifact: "send it at eight, not seven" should be a dropdown, not a pull
   * request. The cron runs every hour and sends whatever is due, which is also
   * what lets two organizations on one instance keep different hours.
   */
  digestHour: integer("digest_hour").notNull().default(7),
  /**
   * Which weekdays it fires, comma list of 0-6 (0 = Sunday), blank = every
   * day. The window self-heals around skipped days: an edition covers
   * everything since the last one went, so weekday-only sending folds the
   * weekend's work into Monday rather than losing it. See lib/digestDays.
   */
  digestDays: text("digest_days").notNull().default(""),
  /**
   * The shop day (YYYY-MM-DD) the digest last went out for this organization.
   * What turns an hourly cron into a daily email: a second run in the same
   * hour, a redeploy that re-fires the schedule, and the "send now" button all
   * read this first. Blank = never sent.
   */
  digestLastSentOn: text("digest_last_sent_on").notNull().default(""),
  // How much stored file the organization may hold, in megabytes. 0 means no
  // ceiling, which is what every organization that predates this column was
  // given - a limit nobody agreed to is not a limit, it's an outage. New
  // organizations start at the default and the operator moves them from
  // Settings. See lib/storage for what counts toward it.
  storageLimitMb: integer("storage_limit_mb").notNull().default(5120),
  // Remote support, sold as a tier: with this on, the organization's own editors
  // can reach their own machines from the portal. House staff always can - that
  // is the base service - so this dial is only about client self-service.
  remoteAccessEnabled: boolean("remote_access_enabled").notNull().default(false),
  /**
   * Whether this organization deals in used equipment.
   *
   * Off by default, which is the point: resale is a real business for a
   * handful of orgs and clutter on every page for the rest. A lab that
   * services four instruments has no use for a listing link on each of them,
   * and a control nobody will ever press still has to be read past every time.
   *
   * Gating the CONTROL, never a live listing - see canSell on the record
   * pages: anything already for sale keeps its controls whatever this says,
   * or turning it off would strand a listing with no way to end it.
   */
  resaleEnabled: boolean("resale_enabled").notNull().default(false),
  // The engine's device group for this organization, created the first time a
  // machine is enrolled for them. One group per org is what keeps one client's
  // machines invisible to another. Blank = no group yet.
  remoteGroupId: text("remote_group_id").notNull().default(""),
  // Where the invoice goes. One per company, because a company has one accounts
  // payable department - where the WORK happens is org_sites, of which there can
  // be several, and conflating the two is what makes a service business print
  // the wrong thing on paper.
  billingAddress: text("billing_address").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  /*
   * A name is unique WITHIN a workspace, not across the instance.
   *
   * It was global, which was invisible while one company ran the app and wrong
   * the moment two did: two service companies servicing the same lab both have
   * a client called "Emery Pharma", and that is not a collision - it is the
   * same company, seen from two sides. The old constraint made the second one
   * impossible to create at all, by hand or by a client share.
   *
   * Expressed as a partial index in schema-sync.sql (COALESCE(parent_org_id, 0),
   * name) so operators, which have no parent, keep their names unique among
   * themselves - two workspaces called "Sierra Spectra" would be a genuine
   * ambiguity. Drizzle has no expression-index form, so this stays declared as
   * the plain thing it is closest to and the SQL carries the real rule.
   */
  unique("org_name_unique").on(t.parentOrgId, t.name),
]);


/**
 * The tenant stamp.
 *
 * Every top-level record carries the operator whose workspace it belongs to, set
 * once at creation and never derived: a system, a spare, a procedure, a
 * stockroom. Staff see their own tenant's records plus whatever another operator
 * has shared with them (see lib/tenants).
 *
 * Deliberately nullable, and NULL means "no tenant" rather than "every tenant".
 * A record created without a stamp disappears from its own workspace - loud, and
 * caught in testing - instead of appearing in everybody else's. Reads fail
 * closed; only platform staff, who see every tenant anyway, can find one.
 *
 * ON DELETE CASCADE: offboarding an operator takes its work with it. The audit
 * log is the one exception (set null), because history should outlive the
 * account it describes.
 */
const tenantStamp = () => integer("tenant_org_id").references(() => orgs.id, { onDelete: "cascade" });

// The visibility rule, one row per (system, org): an org sees exactly the
// systems shared with it. `access` 'view' is read-only however the org's role
// is set; 'edit' lets its editors work the system.
export const systemShares = pgTable("system_shares", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("view"), // view | edit
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("system_share_unique").on(t.instrumentId, t.orgId),
  index("system_shares_org_idx").on(t.orgId),
]);

// Per-asset visibility, one row per (asset, org) - the standalone-asset twin
// of system_shares, so a spare's dossier can be shown to any number of
// organizations. An asset that sits on a system is normally reached through
// the system's shares; these rows matter for shelf stock and for units whose
// dossier should outlive a system detachment.
export const assetShares = pgTable("asset_shares", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("view"), // view | edit
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("asset_share_unique").on(t.assetId, t.orgId),
  index("asset_shares_org_idx").on(t.orgId),
]);

// Stage vocabulary lives in src/lib/stages.ts; stored here as a text array.
// A place an organization has instruments. A client can have three; a system
// lives at exactly one.
//
// `accessNotes` is the field that earns this table on its own: use the parking
// garage on Cedar, $30 a day, dock is round the back, ask for Rita. That is a
// fact about a BUILDING, not about a customer - on the company record it would
// be noise on the invoice screen and wrong the day they open a second lab.
/**
 * A service company's listing in the directory every other one can search.
 *
 * The platform's whole reason to have more than one operator on it: two shops
 * that both service mass specs, four hundred miles apart, each turning down
 * work the other would take. They cannot refer to each other if they cannot
 * find each other.
 *
 * OPT IN, and deliberately off until somebody fills it in. lib/tenancy's
 * visibleOrgs hides operators from each other on purpose - "a workspace handed
 * to a prospective buyer listed the seller; the seller's own list named the
 * buyer's workspace back" - and a directory that enrolled every workspace
 * automatically would undo that decision on everybody's behalf. Listing is a
 * thing a company chooses, the way it chooses to be in a trade directory.
 *
 * Not tenant-stamped: the row is ABOUT one operator, keyed by that operator's
 * org, and it is read across tenants by design. A stamp here would be an
 * invitation to filter on it, which is exactly what must not happen.
 */
export const providerProfiles = pgTable("provider_profiles", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().unique().references(() => orgs.id, { onDelete: "cascade" }),
  /** Off until somebody chooses. Nothing lists a company that has not asked to be listed. */
  listed: boolean("listed").notNull().default(false),
  /** A sentence about the shop, in their own words. */
  blurb: text("blurb").notNull().default(""),
  /** What they work on: "LC-MS", "GC", "Dissolution". Free text, searched. */
  services: text("services").array().notNull().default([]),
  /** Where they cover: "Northern California", "Seattle metro", "WA". */
  regions: text("regions").array().notNull().default([]),
  contactName: text("contact_name").notNull().default(""),
  contactEmail: text("contact_email").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default(""),
  website: text("website").notNull().default(""),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * One workspace's address book of the other service companies it works with.
 *
 * One-sided on purpose: adding somebody here is not a claim about them and
 * gives nothing away - it is a shortlist, so the share picker names four
 * companies rather than every listing on the instance. Consent happens where
 * it matters, at the share itself, which the other side approves or refuses.
 */
export const providerLinks = pgTable("provider_links", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  providerOrgId: integer("provider_org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("provider_link_unique").on(t.tenantOrgId, t.providerOrgId)]);

/**
 * An enquiry somebody has not taken: a LEAD, offered to service companies for
 * a finder's fee.
 *
 * The sibling of a client share and deliberately not the same thing. A share
 * hands over a client you already service - there are records, a fleet, a
 * history. A lead is somebody who wrote to you about four systems on the east
 * coast that you are never going to drive to. There is no client organization
 * behind it and there should not be one: putting a prospect into the client
 * list to sell them on would foul the one table every tenancy rule reads.
 *
 * BLIND UNTIL CLAIMED, which is the whole mechanism. What is published is the
 * work - what equipment, roughly where, what they asked for. The name, the
 * address and the person to call are held back until somebody takes it, because
 * a finder's fee is only worth anything while the finder is the only route.
 *
 * FIRST TO CLAIM WINS, and the rest are told it is gone. An enquiry offered to
 * four shops that all "accept" it is four shops phoning one lab, which is worse
 * for the lab than not being referred at all.
 */
export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** Held back until somebody claims it - see lib/lead. */
  contactName: text("contact_name").notNull().default(""),
  contactEmail: text("contact_email").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default(""),
  orgName: text("org_name").notNull().default(""),
  address: text("address").notNull().default(""),
  /** Published from the start: where, roughly, and what they want. */
  region: text("region").notNull().default(""),
  blurb: text("blurb").notNull().default(""),
  /** [{category, model, count}] as JSON - what they say they have. */
  systems: text("systems").notNull().default(""),
  /** What the finder is asking. Same vocabulary as a share's - see lib/referral. */
  feeKind: text("fee_kind").notNull().default("flat"),
  feeCents: integer("fee_cents").notNull().default(0),
  feeBps: integer("fee_bps").notNull().default(0),
  feeWindowMonths: integer("fee_window_months").notNull().default(12),
  feeMinCents: integer("fee_min_cents").notNull().default(0),
  feeMaxCents: integer("fee_max_cents").notNull().default(0),
  feeNote: text("fee_note").notNull().default(""),
  /** open | claimed | withdrawn */
  status: text("status").notNull().default("open"),
  claimedByOrgId: integer("claimed_by_org_id").references(() => orgs.id, { onDelete: "set null" }),
  claimedBy: text("claimed_by").notNull().default(""),
  claimedAt: timestamp("claimed_at"),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Which shops a lead was put in front of.
 *
 * A lead is offered to a chosen few rather than posted to the instance: a
 * board anybody could read is a board somebody scrapes, and the shortlist is
 * already how a share picks its recipients.
 */
export const leadOffers = pgTable("lead_offers", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references((): AnyPgColumn => leads.id, { onDelete: "cascade" }),
  toOrgId: integer("to_org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("lead_offers_to_idx").on(t.toOrgId),
  unique("lead_offer_unique").on(t.leadId, t.toOrgId),
]);

/**
 * One client, offered to one other service company.
 *
 * The payload is a FROZEN SNAPSHOT taken when the offer is made, and that is
 * the point: what the other shop approves is exactly what they get, and
 * accepting is deterministic however long they take to answer. Nothing is
 * written into their workspace until they say yes.
 *
 * Stamped with the SENDER, because sending is the sender's act. The recipient
 * reads by to_org_id, which is a scoped read of somebody else's row - the one
 * place in the app that is deliberately so, and the reason status lives here
 * rather than in either workspace's own tables.
 *
 * What a duplicate is NOT: a sync. Two records of one client in two workspaces
 * diverge from the moment either shop edits one, and nothing here pretends
 * otherwise - source_org_id and dest_org_id record where a copy came from so
 * the divergence is at least answerable.
 */
export const clientShares = pgTable("client_shares", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** The operator being offered the client. */
  toOrgId: integer("to_org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /** The client organization in the sender's workspace. */
  sourceOrgId: integer("source_org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /** What was created in the recipient's workspace on accept. Null until then. */
  destOrgId: integer("dest_org_id").references(() => orgs.id, { onDelete: "set null" }),
  /** The snapshot, as JSON - see lib/clientShare. */
  payload: text("payload").notNull().default(""),
  /** pending | countered | accepted | declined | withdrawn */
  status: text("status").notNull().default("pending"),
  /**
   * Show the work without showing whose it is, until they accept.
   *
   * A referral is worth something because the other shop cannot go round you,
   * and an unredacted list hands them the company, the street, the person to
   * ask for and serials a manufacturer will match to an owner. Blind is the
   * default for anything with a fee on it. See lib/clientShare redactPayload -
   * the snapshot itself is never redacted, only the way it is rendered before
   * the deal is struck.
   */
  blind: boolean("blind").notNull().default(false),
  note: text("note").notNull().default(""),
  /**
   * What the referrer is asking for, frozen into the offer with everything
   * else. none | flat | percent.
   *
   * On the OFFER rather than agreed afterwards, because a price discovered
   * after somebody has taken on a client is not a price, it is a bill. The
   * recipient sees what it costs before they accept, and accepting is the
   * agreement - which is also what makes the accrual something they consented
   * to rather than something read out of their books.
   */
  feeKind: text("fee_kind").notNull().default("none"),
  /** flat: what it costs to accept, once. */
  feeCents: integer("fee_cents").notNull().default(0),
  /** percent: basis points of what they bill this client inside the window. */
  feeBps: integer("fee_bps").notNull().default(0),
  feeWindowMonths: integer("fee_window_months").notNull().default(12),
  /** percent only: the fee is never less than this once they bill anything, nor more than that. 0 = unbounded. */
  feeMinCents: integer("fee_min_cents").notNull().default(0),
  feeMaxCents: integer("fee_max_cents").notNull().default(0),
  feeNote: text("fee_note").notNull().default(""),
  /**
   * What the RECIPIENT proposed instead, when they countered.
   *
   * The same five fields as the offer, so agreeing to a counter is a straight
   * copy rather than a translation - and the offer's own fields are left
   * alone, so the record still says what was originally asked for even after
   * the deal is struck at a different number.
   *
   * A counter is a CONDITIONAL ACCEPTANCE, not a rejection: "I will take this
   * client at $1,500." So the sender agreeing to it completes the deal, and
   * the client copies across at that moment - there is no second round trip
   * asking the recipient whether they meant it.
   */
  counterKind: text("counter_kind").notNull().default(""),
  counterCents: integer("counter_cents").notNull().default(0),
  counterBps: integer("counter_bps").notNull().default(0),
  counterWindowMonths: integer("counter_window_months").notNull().default(12),
  counterMinCents: integer("counter_min_cents").notNull().default(0),
  counterMaxCents: integer("counter_max_cents").notNull().default(0),
  counterNote: text("counter_note").notNull().default(""),
  counteredBy: text("countered_by").notNull().default(""),
  counteredAt: timestamp("countered_at"),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  decidedBy: text("decided_by").notNull().default(""),
  decidedAt: timestamp("decided_at"),
}, (t) => [index("client_shares_to_idx").on(t.toOrgId)]);

/**
 * A referral fee, once somebody has accepted the client it hangs off.
 *
 * Money between two service companies, and the platform is not in the middle
 * of it: payment runs through the PAYEE's own Stripe Connect account, the same
 * arrangement an invoice already uses (lib/stripe). Ridgeline never holds the
 * funds.
 *
 * WHAT THE REFERRER MAY SEE is the whole design of the percent case. The
 * billing happens in the payer's workspace and stays there - what crosses is
 * one aggregate, `billed_cents`, and never an invoice, a client name on a
 * line, or a date. `billed_from` says where even that number came from, and
 * the two answers are not the same kind of fact: 'invoices' is computed from
 * rows in the payer's own ledger, 'reported' is a figure a person typed. A
 * surface that showed them identically would be inviting somebody to read a
 * self-reported number as an audited one.
 */
export const referralFees = pgTable("referral_fees", {
  id: serial("id").primaryKey(),
  /** The payee's workspace: their receivable, so their stamp. */
  tenantOrgId: tenantStamp(),
  /**
   * The handover it came from, or the LEAD it came from. Exactly one is set.
   *
   * A lead's fee is the same debt as a share's - somebody was sent work and is
   * owed for it - so it is the same row and the same ledger rather than a
   * second table that would need its own invoicing, its own settlement and its
   * own reconciliation with the first.
   */
  shareId: integer("share_id").references((): AnyPgColumn => clientShares.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").references((): AnyPgColumn => leads.id, { onDelete: "cascade" }),
  /** Who is owed - the referrer. */
  payeeOrgId: integer("payee_org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /** Who owes - the shop that accepted. */
  payerOrgId: integer("payer_org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /** The payer's own copy of the client, which is what the percent is measured on. */
  clientOrgId: integer("client_org_id").references(() => orgs.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("flat"),
  feeCents: integer("fee_cents").notNull().default(0),
  feeBps: integer("fee_bps").notNull().default(0),
  /** The bounds agreed. See lib/referral - the floor waits for the first dollar billed. */
  minCents: integer("min_cents").notNull().default(0),
  maxCents: integer("max_cents").notNull().default(0),
  startsOn: text("starts_on").notNull().default(""),   // YYYY-MM-DD, the day it was accepted
  endsOn: text("ends_on").notNull().default(""),       // the window's last day
  /** The aggregate the percent is taken of. The ONLY figure that crosses. */
  billedCents: integer("billed_cents").notNull().default(0),
  /** invoices | reported - see the comment above; they are different facts. */
  billedFrom: text("billed_from").notNull().default("invoices"),
  billedAt: timestamp("billed_at"),
  paidCents: integer("paid_cents").notNull().default(0),
  /** open | settled | waived */
  status: text("status").notNull().default("open"),
  /**
   * The invoice raised for it, in the PAYEE's books. Null until somebody bills it.
   *
   * From the moment it exists the invoice is how this fee is collected, and the
   * fee stops keeping its own count: outstanding is the invoice's balance, paid
   * is the invoice's payments. Two places counting the same money is two places
   * free to disagree about it, and the disagreement always surfaces in front of
   * whoever is being chased. Same rule the agreements table states about stored
   * balances.
   */
  invoiceId: integer("invoice_id").references((): AnyPgColumn => invoices.id, { onDelete: "set null" }),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("referral_fees_payer_idx").on(t.payerOrgId),
  index("referral_fees_payee_idx").on(t.payeeOrgId),
]);

export const orgSites = pgTable("org_sites", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull().default(""),          // "Building 4 lab", "Reno"
  address: text("address").notNull().default(""),    // as typed, newlines kept
  accessNotes: text("access_notes").notNull().default(""),
  contactName: text("contact_name").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default(""),
  /** Who to tell we are coming - the en-route email's recipient. */
  contactEmail: text("contact_email").notNull().default(""),
  /**
   * Sales tax on PARTS at this address, in basis points (775 = 7.75%). Tax is
   * a property of where the goods landed, not of the client, which is why it
   * lives on the site. Zero means no tax line is drawn at all.
   */
  taxRateBps: integer("tax_rate_bps").notNull().default(0),
  /**
   * Road miles one-way from the shop, typed once by whoever set the site up.
   * Zero = never measured. It exists so the travel-rules strip on a work
   * order can answer from the site instead of asking the engineer to
   * remember, and it is a DEFAULT, not the truth - the engineer's own start
   * point wins, which is why the strip's miles field stays editable.
   */
  onewayMiles: integer("oneway_miles").notNull().default(0),
  /**
   * Where the address IS, geocoded best-effort when the address is saved.
   * Null means "never resolved" - the strip falls back to oneway_miles and
   * nothing anywhere waits on a maps provider to render a page.
   */
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  // Archived rather than deleted: a closed lab is still where an instrument was,
  // and systems still point at it.
  archived: boolean("archived").notNull().default(false),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("org_sites_org_idx").on(t.orgId)]);

export const instruments = pgTable("instruments", {
  id: serial("id").primaryKey(),
  /**
   * The photo of the whole system - an LC and an MS standing next to each other,
   * the thing an engineer recognizes across a room and a client recognizes as
   * theirs. A pointer to an ordinary attachment rather than a URL of its own, so
   * one file is one row: it counts against storage once, it is reachable only
   * through the authorized proxy, and deleting the file clears this by itself.
   */
  photoAttachmentId: integer("photo_attachment_id"),
  tenantOrgId: tenantStamp(),
  externalId: text("external_id").unique().notNull(), // e.g. T-003, CASA-001
  client: text("client").notNull(),                   // Testen, GMI, Utah, Casablanca
  // Shop-defined grouping, e.g. "LC-MS", "GC", "N2 generator". Added on the fly
  // from the system form; the vocabulary is whatever is in use.
  category: text("category").notNull().default(""),
  // A name you chose, which always wins over the composed one. Blank means
  // "name it from the assets" - fine for a two-box system, useless once seven
  // LC modules add up to a paragraph. See lib/systemLabel.
  name: text("name").notNull().default(""),
  // Legacy free-text description. No longer edited: a system with no chosen
  // name is named by its assets (lib/systemLabel). Kept as the fallback for
  // pre-asset records and sheet imports.
  model: text("model").notNull(),
  /**
   * The OTHER shop's tag for this machine, when the record arrived by a client
   * share. Blank for everything entered here.
   *
   * A duplicated client is two records of one machine in two workspaces, and
   * each shop tags its own equipment - their asset label is theirs, ours is
   * ours, and copying my "EP-001" into their workspace would be putting my
   * sticker on their shelf. What both shops actually need is to be able to say
   * "your EP-001 is our NW-114" on the phone, which is this column. See
   * lib/clientShare.
   */
  sourceRef: text("source_ref").notNull().default(""),
  manufacturer: text("manufacturer").notNull().default(""), // Shimadzu, Agilent, Thermo...
  serial: text("serial").notNull().default(""),             // the instrument's own serial
  location: text("location").notNull().default(""),         // room / bench on the client's floor
  // Which organization owns this system - a client, or a service company that
  // owns its own stock. Null = stewarded by the house: work the operator runs
  // directly, and systems a provider logged before the real owner joined the
  // platform ("unclaimed"). The owner's editors approve access requests;
  // visibility itself still comes only from system_shares.
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  /**
   * How this system relates to its maintenance calendar. '' = follow the owning
   * org: resellers get "advisory", everyone else "scheduled". An explicit
   * 'scheduled' or 'advisory' overrides that, either direction, at any time.
   * Advisory keeps every schedule - cadence, kit, last-done history - but the
   * machine stops acting on them: no generated tasks, no queue handoffs, no
   * overdue tint. Knowledge, not obligation. See lib/pmPosture.
   */
  pmPosture: text("pm_posture").notNull().default(""),
  // WHOSE QUEUE the system is sitting in - a third axis, independent of both
  // ownership and access. A refurbished system parked with the client while
  // they run application tests is still ours to own and everyone's to see, but
  // it is not our move: nothing we do clears it. Null = our queue.
  //
  // This is what lets a finished system leave the shop's board without being
  // archived or shipped, and it's why turnaround can stop counting days that
  // were never ours to spend (see lib/reports).
  queueOrgId: integer("queue_org_id").references(() => orgs.id, { onDelete: "set null" }),
  queueReason: text("queue_reason").notNull().default(""), // "waiting on your N2 generator tech"
  // When it landed in the current queue. Null = never moved, so read it as the
  // system's own createdAt rather than backfilling every row.
  queueSince: timestamp("queue_since"),
  // Whoever holds it has seen the handback. A queue position is not a notice
  // board: "back with you, nothing pending" is worth saying once and is noise
  // on the fortieth visit, so the holder can dismiss the line and the record
  // keeps who did it and when - which is also how the shop learns the handback
  // landed. Cleared by every move, so the NEXT one announces itself to a client
  // who dismissed the last.
  queueAckAt: timestamp("queue_ack_at"),
  queueAckBy: text("queue_ack_by").notNull().default(""),
  // Which of the owner's sites it is installed at. Null = nobody has said, which
  // is every system until somebody does. Set null on delete rather than cascade:
  // losing the site record must not take the instrument with it.
  siteId: integer("site_id").references((): AnyPgColumn => orgSites.id, { onDelete: "set null" }),
  // Resale state, set by the owning org (or staff). While for_sale is true the
  // listing_token URL serves a public, heavily redacted view of the system:
  // maintenance history and opted-in reports, never location/client/costs.
  // The token survives unmarking (the URL just 404s) so re-listing keeps links.
  forSale: boolean("for_sale").notNull().default(false),
  saleNote: text("sale_note").notNull().default(""), // public blurb on the listing
  listingToken: text("listing_token").notNull().default(""),
  priority: integer("priority").notNull().default(99),
  // Regulated (GxP) system: the one switch every compliance surface hangs off.
  // Off, the app shows no qualification standing, no validation shelf, no
  // expiring-cert nagging - a loaner UV-Vis never sees the word "IQ". Opt-in
  // per system rather than per client, because one client can run a GLP lab
  // and a non-GLP lab off the same book.
  gxp: boolean("gxp").notNull().default(false),
  // Who's driving this system - a name from the directory (lib/directory),
  // assignable by either side.
  lead: text("lead").notNull().default(""),
  // Retired from the active fleet but kept in full. Archiving is the editor-safe
  // alternative to deletion; hard delete stays owner-only.
  archived: boolean("archived").notNull().default(false),
  archivedAt: timestamp("archived_at"),
  archivedBy: text("archived_by").notNull().default(""),
  stages: text("stages").array().notNull().default([]),
  /**
   * Why this system is blocked, demanded at the moment of blocking and cleared
   * the moment it is unblocked (see actions.toggleStage, lib/stages).
   *
   * On the system rather than on a task because "Waiting / blocked" is a
   * statement about the SYSTEM: the work that is stuck may be several tasks or
   * none at all, and a reason that lives on one of them is a reason the board
   * cannot show. Blank on rows blocked before this was required - the digest
   * asks after those by name until somebody writes one.
   */
  blockedReason: text("blocked_reason").notNull().default(""),
  /** When it was blocked, so the digest can say how long. Null = unknown. */
  blockedSince: timestamp("blocked_since"),
  blockedBy: text("blocked_by").notNull().default(""),
  /**
   * Whose block this is - the organization it falls under, not the party being
   * waited on.
   *
   * The two are different facts and the app used to have only one, hardcoded:
   * lib/digest courted every block to "us" whatever it was about. That is right
   * most of the time and wrong in a way nobody could correct, because a system
   * on our bench is stuck with US even when the sentence is "waiting on LabZen
   * to approve the quote" - we are the ones holding it, and it is our chase.
   * The reason names who we are waiting on; this names whose problem it is.
   *
   * So it is CHOSEN at the moment of blocking rather than sniffed out of the
   * reason, defaulting to whoever is doing the blocking. Null is the operator,
   * which is what every row blocked before this column reads as and what the
   * old hardcoded answer said. Cleared with the block, like the reason.
   */
  blockedOrgId: integer("blocked_org_id").references(() => orgs.id, { onDelete: "set null" }),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// An organization's frozen copy of a system's record. `data` is the full
// dossier as of that instant - immutable by construction, later edits to the
// live system can never reach it. The record outlives the system (FK set null)
// and carries its own external_id/label so it still reads on its own.
//
// Two things mint one, and they read very differently to the holder:
//   'revoked'  a service provider's share was withdrawn - "they keep their own
//              service reports". Clients don't get one; unsharing a client is
//              cleanup, not the end of an engagement.
//   'handoff'  the system changed hands and this org was the outgoing owner.
//              Unlike a revocation this does NOT imply access ended: a reseller
//              kept on as a viewer holds a record AND still sees the live
//              system, which is why listings filter on live visibility rather
//              than assuming the record means "gone".
//
// A repeat event of the same kind for the same org supersedes the earlier
// record rather than stacking beside it - the newer dossier covers the same
// tenure. Superseded rows are kept (a dossier is evidence, never deleted) and
// simply drop out of the listings.
export const engagementRecords = pgTable("engagement_records", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("revoked"),
  externalId: text("external_id").notNull().default(""),
  label: text("label").notNull().default(""),
  revokedBy: text("revoked_by").notNull().default(""),
  revokedAt: timestamp("revoked_at").notNull().defaultNow(),
  supersededAt: timestamp("superseded_at"),
  data: jsonb("data").notNull(),
}, (t) => [index("engagement_records_org_idx").on(t.orgId)]);

// The operator's own people, and what they can do. Owner-managed from Settings
// so adding or revoking a colleague no longer means editing an environment
// variable and redeploying.
//
// Exact emails only - no "@domain" entries, for the same reason STAFF_EMAILS
// never allowed them: house access sees every organization's data, and one
// mistyped domain would hand that to everyone who happens to share it.
//
// role 'none' is a deliberate third value: it revokes somebody who is still
// listed in STAFF_EMAILS. The env list stays authoritative for the ROOT owner
// (see lib/houseRole) precisely so a bad edit here can never lock everyone out
// of an instance, but everyone else has to be revocable from the UI, and the
// only way to say "env says staff, we say no" is to record it.
export const houseMembers = pgTable("house_members", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  // Which operator this person is staff of - the workspace they run, and the
  // only tenant they are the house of. Null is a staff row with no company,
  // which lib/tenants resolves to seeing nothing rather than seeing everything.
  //
  // The email unique index below is deliberately kept: a person is staff of one
  // service company. An engineer who moves companies is moved, not duplicated.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("staff"), // owner | staff | none
  name: text("name").notNull().default(""),      // display only
  /**
   * HR. Whether this person administers their COLLEAGUES: files a
   * reimbursement claim on somebody else's behalf, and reads the workspace's
   * payroll register.
   *
   * A flag rather than a third role word, for three reasons. The office
   * manager who does HR is also staff and sometimes also the owner, so it has
   * to compose with a role rather than replace one. A new word in `role`
   * would have to be audited into every `=== "staff"` and `=== "owner"` test
   * in the app, and the failure mode of missing one is silent
   * over-permission. And clientAllowlist already carries its privileges this
   * way - canSeeMoney, canSeePayroll, canSeeAgreements - so this is the
   * house's half of a convention that already exists.
   *
   * It is NOT the books. lib/books stays owner-only: HR reads what the
   * company pays its people, not what it invoiced LabZen.
   */
  canAdminPeople: boolean("can_admin_people").notNull().default(false),
  /**
   * The engineer's own point zero - where the stipend radius is measured
   * from, and where a routed trip starts. Set by the engineer themselves on
   * their own settings page, because it is their home: nobody else should be
   * typing it, and they can leave it blank. Coordinates are the geocode of
   * the address at the time it was saved.
   */
  homeAddress: text("home_address").notNull().default(""),
  homeLat: doublePrecision("home_lat"),
  homeLng: doublePrecision("home_lng"),
  /**
   * The person file - the half of an employee record that is not pay.
   *
   * Kept on the roster row rather than in a second table because each is one
   * fact with no history worth keeping: a phone number that changes is simply
   * the new number. Pay is the opposite case and lives in `payroll`, which is
   * effective-dated for exactly that reason.
   */
  phone: text("phone").notNull().default(""),
  emergencyName: text("emergency_name").notNull().default(""),
  emergencyPhone: text("emergency_phone").notNull().default(""),
  startedOn: text("started_on").notNull().default(""),   // YYYY-MM-DD
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("house_member_email_unique").on(t.email)]);

// Chain of custody. instruments.owner_org_id is the fast "who owns it now"
// pointer; this is the history behind it, and for a resale market that history
// is the product - a serial number that can prove who has held a system and
// when is worth more than one that can't.
//
// A handoff (LabZen ships a refurbished system to their own client) writes one
// row here, leaves the service provider's share in place, and freezes an
// engagement record for the outgoing owner. Backfilled with one 'intake' row
// per already-owned system so the chain has a start.
export const custodyEvents = pgTable("custody_events", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  // intake (first known owner) | transfer (handed on) | claim (granted via a
  // serial claim) | release (back to house stewardship)
  kind: text("kind").notNull().default("transfer"),
  fromOrgId: integer("from_org_id").references(() => orgs.id, { onDelete: "set null" }),
  toOrgId: integer("to_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Names kept as text as well as ids: an org row can be deleted, but the
  // custody record has to stay readable forever.
  fromName: text("from_name").notNull().default(""),
  toName: text("to_name").notNull().default(""),
  note: text("note").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [
  index("custody_instrument_idx").on(t.instrumentId),
  index("custody_asset_idx").on(t.assetId),
]);

// Every time a system changed hands as WORK - who was expected to act next,
// and why. Distinct from custody_events, which is ownership: LabZen can own a
// system that sits in our queue, and can hold the queue on a system Acme owns.
//
// Kept as a ledger because the durations matter: three weeks waiting on the
// client's nitrogen contractor should not land in our turnaround figures, and
// the only way to prove that is a record of when the ball was in whose court.
export const queueEvents = pgTable("queue_events", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  fromOrgId: integer("from_org_id").references(() => orgs.id, { onDelete: "set null" }),
  toOrgId: integer("to_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Null org ids mean the house, whose name isn't in the orgs table on every
  // instance - so both names are stored as text too, and stay readable forever.
  fromName: text("from_name").notNull().default(""),
  toName: text("to_name").notNull().default(""),
  reason: text("reason").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("queue_events_instrument_idx").on(t.instrumentId), index("queue_events_at_idx").on(t.at)]);

// Someone knocking on the door: they matched a serial in /lookup and asked to
// be let onto the system. An 'access' request asks to be let in and is decided
// by staff or the owning org's editors; a 'claim' asserts "this instrument is
// ours" and only the platform operator may grant it, since approving one moves
// ownership - and a serial number is not proof of purchase.
export const accessRequests = pgTable("access_requests", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("access"), // access | claim
  requestedBy: text("requested_by").notNull().default(""),
  message: text("message").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending | approved | denied
  decidedBy: text("decided_by").notNull().default(""),
  decidedAt: timestamp("decided_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("access_requests_instrument_idx").on(t.instrumentId)]);

// Preventive maintenance, the calendar kind: "flush the lines every 90 days".
// A schedule belongs to a system or a standalone asset, and the daily cron
// turns each due schedule into an ordinary task (origin 'pm'), so everything
// downstream - assignment, checklists, notifications, sign-off packets - works
// on PM work with no special cases. Completing the task advances next_due from
// the day it was done (floating cadence), which is how shops actually run:
// changing a filter late doesn't owe you an extra change next week.
// One procedure catalog: everything defined against a module type (or
// "system") that turns into work on units automatically. WHEN it fires is a
// property, not a table: runs_at_intake covers the old checkout items,
// interval_days the old maintenance templates, and one row can carry both -
// "Leak check" at intake AND quarterly is one definition, not two that drift.
// interval_days null is the single statement of "does not repeat".
//
// parts is a JSON list [{name, number}] in a text column - same convention as
// parts.specs - because the parts table is per-work-order tracking rows, not
// an inventory entity a catalog could join.
export const procedures = pgTable("procedures", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  assetType: text("asset_type").notNull(),          // catalog module type or "system"
  kind: text("kind").notNull().default("task"),     // 'task' | 'test'
  name: text("name").notNull(),
  notes: text("notes").notNull().default(""),
  position: integer("position").notNull().default(0), // ordering within its type; generated tasks keep it
  // Test-only
  resultType: text("result_type").notNull().default("pass_fail"),
  target: text("target"),
  tolerancePct: numeric("tolerance_pct"),
  /**
   * The structured acceptance spec, JSON per result type (see lib/testResult):
   * measured carries criteria rows [{op, value, unit, center?}] joined by OR,
   * plus what it is measured with and whether raw replicates are recorded;
   * pass_fail carries the pass guidance and the attach-a-reading flag;
   * reading carries its unit and typical range; note carries the tech prompt.
   * "" = never set. `target`/`tolerance_pct` stay as the legacy prose spec -
   * a test with prose limits and no criteria shows in the Needs review filter
   * rather than being parsed automatically.
   */
  acceptance: text("acceptance").notNull().default(""),
  /**
   * A file (tune report, printout, photo) must be on the result before
   * sign-off. Split out of `required` (which used to imply it for tests) so
   * a test can gate sign-off on being done without demanding paper.
   * Backfilled true for required tests - see the needs-report migration.
   */
  needsReport: boolean("needs_report").notNull().default(false),
  /**
   * Usage-based cadence: "every 2000 injections", "every 500 hours". Display
   * and intake-stamp only - the calendar cron schedules `interval_days` and
   * nothing counts injections for us. Unit '' = no usage cadence.
   */
  usageEvery: integer("usage_every"),
  usageUnit: text("usage_unit").notNull().default(""),
  /**
   * How long this piece of work takes, in minutes. 0 = nobody has said.
   *
   * The one fact the catalog did not hold, and the one a fixed-price bid
   * cannot be built without: a PM on an API 5000 is a day and a PM on a 1260
   * LC is an afternoon, and pricing a five-year award needs that in hours
   * before anybody has opened a work order. Zero is an ABSENCE and reads as
   * one everywhere - an estimate says which procedures it could not time
   * rather than quietly totalling them as free (see lib/pmKit).
   */
  estMinutes: integer("est_minutes").notNull().default(0),
  // Task-only
  requiresNote: boolean("requires_note").notNull().default(false),
  consumesPart: boolean("consumes_part").notNull().default(false),
  // Timing. Both may be true; both false is rejected by the actions.
  runsAtIntake: boolean("runs_at_intake").notNull().default(false),
  intervalDays: integer("interval_days"),
  // Mandatory for sign-off: the work it generates must be Done, and a test
  // must additionally have a report filed against it, before anyone can sign.
  required: boolean("required").notNull().default(false),
  // Which qualification this belongs to on a regulated system: '' (none) |
  // IQ | OQ | PQ. Purely a grouping - the work generates and completes the
  // same either way; the binder and the standing rollup read it, so "the OQ"
  // is a set of procedures rather than a separate object to maintain.
  qualification: text("qualification").notNull().default(""),
  parts: text("parts").notNull().default(""),       // JSON [{name, number}], "" = none
  /**
   * The steps, one per line, stamped onto every task this makes.
   *
   * `notes` above is prose - the paragraph explaining what the job involves.
   * Prose is not tickable, so a fourteen-step teardown was either one checkbox
   * ticked at the end or fourteen items retyped by hand on every unit, every
   * visit. Lines rather than JSON because a checklist IS lines and people paste
   * them out of an SOP. Parsing (including the trailing-colon heading rule)
   * lives in lib/checklist.
   */
  checklist: text("checklist").notNull().default(""),
  modelScope: text("model_scope").array().notNull().default([]), // [] = all models
  // System-level procedures only: which system CATEGORIES this covers. [] = all
  // of them, which is what every system procedure meant before this existed.
  //
  // Its absence is what made system-level procedures unusable. They applied to
  // every system in the workspace with no way to narrow them, so an annual LC-MS
  // PM would also land on every GC - and the only safe move was to not use them
  // and write each system's upkeep out by hand, once per system. See
  // lib/procedureRole.
  categoryScope: text("category_scope").array().notNull().default([]),
  /**
   * Whose words these are: '' | original | facts | oem. A procedure written
   * from our own field notes is ours to license; one transcribed out of a
   * manufacturer's manual is not. See lib/provenance.
   */
  provenance: text("provenance").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// RETIRED: merged into `procedures` (see the procedures-merge migration).
// The table stays because the sync pipeline is additive-only; nothing reads it.
export const pmTemplates = pgTable("pm_templates", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull(), // MODULE_KINDS entry, e.g. "Pump"
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  everyDays: integer("every_days").notNull(),
  // The consumable the job takes, structured so a generated task can turn
  // into a part request without retyping the number.
  partName: text("part_name").notNull().default(""),
  partNumber: text("part_number").notNull().default(""),
  modelScope: text("model_scope").array().notNull().default([]), // [] = all models
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const pmSchedules = pgTable("pm_schedules", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  assignee: text("assignee").notNull().default(""),
  everyDays: integer("every_days").notNull(),
  nextDue: text("next_due").notNull(), // YYYY-MM-DD in shop time
  lastDone: text("last_done").notNull().default(""), // blank = never yet done
  paused: boolean("paused").notNull().default(false),
  /**
   * The appointment: the day the CLIENT agreed to have us in. Not the due
   * date - nextDue keeps saying when the cycle fell due, because "due Aug 12,
   * booked Sep 12" is the truth and "due Sep 12" is not. A booked schedule
   * stops nagging until the appointment day; a booked day that passes
   * unworked starts nagging again, wearing the missed date. Cleared when the
   * cycle completes.
   */
  bookedOn: text("booked_on").notNull().default(""),   // YYYY-MM-DD
  bookedNote: text("booked_note").notNull().default(""), // "per J. Alvarez, window 9-12"
  // The part(s) the job takes, carried onto every generated task. `parts` is
  // JSON [{name, number}]; the single name/number pair predates it and is
  // still written by hand-made schedules - readers go through
  // schedulePartsOf(), which falls back to the pair.
  partName: text("part_name").notNull().default(""),
  partNumber: text("part_number").notNull().default(""),
  parts: text("parts").notNull().default(""),
  // The steps, stamped from the procedure the same way `parts` is and owned by
  // the unit from then on. One customer's teardown gains a step the model's
  // does not, and a schedule that re-read the catalog every cycle would lose it
  // - see lib/checklist for the format.
  checklist: text("checklist").notNull().default(""),
  // Which definition stamped this schedule out; null = written by hand. Kept
  // on deletion - the schedule is shop data now, not catalog state.
  // template_id predates the procedures merge and is no longer written.
  templateId: integer("template_id").references(() => pmTemplates.id, { onDelete: "set null" }),
  procedureId: integer("procedure_id").references(() => procedures.id, { onDelete: "set null" }),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("pm_instrument_idx").on(t.instrumentId), index("pm_asset_idx").on(t.assetId)]);

/**
 * What a client is OWED in preventive maintenance, per class of system.
 *
 * "UCSF gets two PMs a year on every mass spec and one on every LC." That is a
 * sentence about a relationship, and there was nowhere to write it down. The
 * app had two neighbouring things and neither says it: pm_schedules is one
 * recurring job on one unit ("flush the lines every 90 days"), which is how the
 * work gets generated and says nothing about what was promised; and
 * agreements.visits_included is a flat count for a whole contract, which cannot
 * tell an MS from an LC.
 *
 * A COUNT PER YEAR, not a cadence in days. Two a year and every 182 days are
 * different promises - the first is satisfied by two visits in any weeks the
 * client will have us, the second is a clock - and the contractual language is
 * always the count. lib/pmPlan turns the count into deadlines when it needs
 * them, and lib/pm keeps owning the cadence arithmetic for schedules.
 *
 * `category` is instruments.category, the shop's own grouping vocabulary
 * ("LC-MS", "GC", "N2 generator"), typed on the fly and never a fixed list -
 * so the plan is written in whatever words that shop already uses for its
 * fleet. The empty string is the catch-all: what every system of theirs gets
 * that no more specific row names. One row per (client, category), because two
 * answers to "how many PMs does an MS get" is the bug this table exists to
 * prevent.
 *
 * Nothing here generates work. A plan is the promise; pm_schedules is the
 * machine; the gap between them is exactly the thing worth seeing, and it is
 * what /maintenance/coverage draws.
 */
export const pmPlans = pgTable("pm_plans", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /** instruments.category, or '' for every system this client owns. */
  category: text("category").notNull().default(""),
  /** How many preventive visits a year. Zero is a real answer: "we do not PM those." */
  perYear: integer("per_year").notNull().default(1),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("pm_plans_org_idx").on(t.orgId),
  unique("pm_plan_org_category_unique").on(t.tenantOrgId, t.orgId, t.category),
]);

// A task belongs to a system, to an asset on its own (a spare on the bench), or
// to both (system work tagged to the unit it happened on). At least one is set.
export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // Open | In progress | Blocked | Done
  state: text("state").notNull().default("Open"),
  assignee: text("assignee").notNull().default(""),
  dueDate: text("due_date").notNull().default(""), // YYYY-MM-DD in shop time, blank = no date
  // '' = hand-made | 'checkout' = auto-generated test | 'pm' = from a maintenance
  // schedule | 'issue' = raised by whoever owns the system saying it is broken |
  // 'pm_request' = the client asking for upkeep (no schedule attached on purpose:
  // completing it must not move a contract's calendar - see lib/pmRequest)
  origin: text("origin").notNull().default(""),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }), // optional: which asset this is about
  // Which schedule generated this task; completing it advances that schedule.
  pmScheduleId: integer("pm_schedule_id").references(() => pmSchedules.id, { onDelete: "set null" }),
  // Which catalog procedure generated it (intake work). Kept so sign-off can
  // tell which tasks are mandatory without matching on titles.
  procedureId: integer("procedure_id").references(() => procedures.id, { onDelete: "set null" }),
  /**
   * What "done" means for a hand-made task: '' = a checkbox, or one of the
   * result vocabulary (pass_fail | measured | note) - "try toggling the button
   * and NOTE whether it toggles" is a pass/fail, not a checkbox. Procedure-made
   * tasks carry their spec on the procedure; this exists so an ad-hoc task can
   * demand an outcome too. The procedure's spec wins when both are set.
   */
  resultType: text("result_type").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  // The job this is part of, when it is part of one. Null is the normal state:
  // most tasks are just the shop's own list. Set null rather than cascade - a
  // work order is a wrapper around work that happened, and deleting the wrapper
  // must not delete the record of the work.
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (t) => [index("tasks_instrument_idx").on(t.instrumentId), index("tasks_work_order_idx").on(t.workOrderId)]);

export const checklistItems = pgTable("checklist_items", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  /**
   * A section label rather than a box: "Remove & Sonicate:" over the two things
   * to remove and sonicate. Not tickable and never counted in the progress
   * figure - see lib/checklist, where a heading is anything ending in a colon,
   * because that is already how people write one.
   */
  heading: boolean("heading").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("checklist_task_idx").on(t.taskId)]);

// Threaded notes on a single checklist item (the model Joe picked: B, collapsed)
export const itemNotes = pgTable("item_notes", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => checklistItems.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("item_notes_item_idx").on(t.itemId)]);

// The conversation on a work order - the job-level thread, above any one task.
// "Client says it worked over the weekend", "bring the long torx" - context an
// engineer needs before they leave, which fits neither a task nor the close-out.
export const workOrderNotes = pgTable("work_order_notes", {
  id: serial("id").primaryKey(),
  workOrderId: integer("work_order_id").notNull().references((): AnyPgColumn => workOrders.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  /**
   * Who wrote it, by the one identifier that cannot be two people - the name
   * is for reading. This decides who may edit it: a thread a client's own
   * editors post in must not let one company rewrite another's words.
   * Blank on rows written before this column existed; see lib/notes.
   */
  authorEmail: text("author_email").notNull().default(""),
  text: text("text").notNull(),
  /** Set the first time it is changed, so a client-visible edit is never silent. */
  editedAt: timestamp("edited_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("wo_notes_wo_idx").on(t.workOrderId)]);

// Task-level notes thread (commentary about the whole job)
export const taskNotes = pgTable("task_notes", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("task_notes_task_idx").on(t.taskId)]);

// The validation shelf of a regulated system: URS, IQ/OQ/PQ protocols and
// reports, certs - each a DOCUMENT WITH A LIFECYCLE, not just a file.
//
// Two rules carry the whole design. A protocol must be approved BEFORE it is
// executed and a report after - that ordering is the first thing an auditor
// checks. And nothing current is ever deleted or overwritten: a revision is a
// NEW row pointing at the one it supersedes, so v1 stays retrievable forever
// under the version it was approved as. Only an unsigned Draft may be removed.
export const validationDocs = pgTable("validation_docs", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  docType: text("doc_type").notNull(),   // vocabulary in lib/gxp DOC_TYPES
  title: text("title").notNull(),
  // Draft | Approved | Executed | Superseded. Executed is for protocols only:
  // "this approved protocol has been run", with the readings and the report
  // documents as the evidence. See lib/gxp for the transition rules.
  state: text("state").notNull().default("Draft"),
  version: integer("version").notNull().default(1),
  supersedesId: integer("supersedes_id").references((): AnyPgColumn => validationDocs.id, { onDelete: "set null" }),
  // The file this document IS, when it lives here as a file. Null for a
  // placeholder row (paper master upstairs) - the lifecycle still applies.
  attachmentId: integer("attachment_id").references(() => attachments.id, { onDelete: "set null" }),
  // Periodic review / validity date, shop-day string, blank = none. Feeds the
  // same expiry attention as dated attachments.
  reviewOn: text("review_on").notNull().default(""),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("validation_docs_instrument_idx").on(t.instrumentId)]);

// Who stands behind a validation document, in which capacity. Same philosophy
// as signoffs: typing your name is the act of signing, a withdrawn signature
// is kept with its reason, and the "Approved" role is what moves a Draft to
// Approved. No tenant stamp - cascades from the doc, like task_results.
export const validationSignatures = pgTable("validation_signatures", {
  id: serial("id").primaryKey(),
  docId: integer("doc_id").notNull().references(() => validationDocs.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("Approved"), // Author | Reviewed | Approved
  signedBy: text("signed_by").notNull(),            // login email
  signerName: text("signer_name").notNull(),        // typed name - the signature
  signerTitle: text("signer_title").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
  revokeReason: text("revoke_reason").notNull().default(""),
}, (t) => [index("validation_signatures_doc_idx").on(t.docId)]);

// What a test actually read. One row per task, because a test task is one
// performance of one test - a PM that runs twice a year generates a new task
// each time, so the history is the tasks, not versions of a row.
//
// No tenant stamp: it cascades from the task, whose tenant already decides who
// may see it, the same as checklist_items and task_notes.
//
// The spec is copied in rather than read back through procedureId. A result is
// a claim about a moment - "5.2, within 4.5-5.5 on the 3rd" - and re-tuning the
// target next year must not silently restate what last year's reading meant.
export const taskResults = pgTable("task_results", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  resultType: text("result_type").notNull().default("pass_fail"), // pass_fail | measured | reading | note
  value: text("value").notNull().default(""),          // as read off the panel, unit and all
  passed: boolean("passed"),                           // null where the spec supports no verdict
  target: text("target").notNull().default(""),        // the spec, frozen at the moment of recording
  tolerancePct: text("tolerance_pct").notNull().default(""),
  // The structured spec it was judged against, frozen like target - re-tuning
  // the criteria next year must not restate what this reading meant.
  acceptance: text("acceptance").notNull().default(""),
  note: text("note").notNull().default(""),            // conditions, what was odd about it
  recordedBy: text("recorded_by").notNull().default(""),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, (t) => [unique("task_result_task").on(t.taskId), index("task_results_task_idx").on(t.taskId)]);

// Gas requirements per system. One row per (instrument, gas); status vocabulary
// lives in src/lib/stages.ts. Tank details go in the free-text note - individual
// tank inventory is deliberately not modeled (yet).
export const instrumentGases = pgTable("instrument_gases", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }), // gases for a standalone asset
  gas: text("gas").notNull(),                          // Helium, Nitrogen, ...
  status: text("status").notNull().default("Connected"), // Connected | Low | Empty | Not connected | Not needed
  note: text("note").notNull().default(""),            // tank #, psi, supplier
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("gases_instrument_idx").on(t.instrumentId), unique("gases_instrument_gas").on(t.instrumentId, t.gas)]);

// Same ownership rule as tasks: a system, a standalone asset, or both.
export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  // part | consumable | kit - consumables (ferrules, septa, liners) share the
  // same lifecycle/cost/audit but get a lighter-weight form. A KIT is the box
  // as sold: one line carrying the money and the PO, with the parts it
  // contains recorded beneath it (see parentPartId) so "when did we last
  // change the plunger seals" is still answerable a year later.
  kind: text("kind").notNull().default("part"),
  /**
   * The kit line this part came out of. Contents are stamped at zero cost -
   * the kit holds the money, and charging both would bill a client twice for
   * one box. Null = an ordinary part somebody fitted on its own.
   *
   * Cascading in the DATABASE, not only in deletePart: contents left behind
   * read as loose parts somebody fitted, which is a worse record than none,
   * and the invariant should not depend on every future caller remembering.
   */
  parentPartId: integer("parent_part_id").references((): AnyPgColumn => parts.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }), // optional: which asset it went into
  name: text("name").notNull(),
  partNumber: text("part_number").notNull().default(""),
  serial: text("serial").notNull().default(""),
  /**
   * Set when what is on order is not a part but a UNIT - a roughing pump, an
   * autosampler - that must join the system's asset list when it arrives.
   * The value is the module kind it becomes ("Pump", "Autosampler"). The
   * request/order/tracking life is the ordinary parts life; this is the flag
   * that makes Received offer an intake instead of being the end of the
   * story. Blank = an ordinary part, which is almost everything.
   */
  moduleKind: text("module_kind").notNull().default(""),
  qty: text("qty").notNull().default(""), // free text, mainly for consumables
  // Custom label/value fields as a JSON array of {k,v} - e.g. GC column ID/length.
  specs: text("specs").notNull().default(""),
  vendor: text("vendor").notNull().default(""),
  po: text("po").notNull().default(""),
  cost: text("cost").notNull().default(""), // free text, the display source of truth
  // Parsed from `cost` server-side on every write (lib/money) so reports can
  // sum spend. Null = never parsed / not money-shaped; 0 is a real zero.
  costCents: integer("cost_cents"),
  // Whose money bought it, stamped at write time from the system's owner then.
  // Cost visibility follows THIS, not the system's current owner: when a system
  // is handed on, the new owner must not inherit sight of what the previous one
  // paid. Null = pre-handoff rows and house-stewarded work, which fall back to
  // the system's owner (correct, since nothing had changed hands yet).
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // The order this was bought on. `po` above is the free text that predates it
  // and is still what gets displayed; this is the link, so "where is the
  // receipt for this part" has an answer that survives somebody's typing.
  poId: integer("po_id").references((): AnyPgColumn => purchaseOrders.id, { onDelete: "set null" }),
  // Asked of somebody else's purchasing department. A client who buys their own
  // parts (their systems, their money) is TOLD what is needed rather than
  // waiting for us to order it - this is who was asked and when, so "Needed"
  // can say whose move it is instead of looking like nobody has done anything.
  requestedOrgId: integer("requested_org_id").references(() => orgs.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at"),
  // The maintenance job this part was requested for, stamped by requestPmPart.
  // The note said so in prose already; this is the queryable version, and it is
  // what lets a contract whose PM includes its parts stop those parts from
  // eating the client's parts allowance (see lib/agreementUsage).
  pmScheduleId: integer("pm_schedule_id").references((): AnyPgColumn => pmSchedules.id, { onDelete: "set null" }),
  /**
   * The job this part was recorded on, when it was recorded from one - the
   * "potential parts" list an engineer builds while diagnosing. Set null on
   * delete: the part outlives its wrapper exactly like a task does.
   */
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  carrier: text("carrier").notNull().default(""),
  tracking: text("tracking").notNull().default(""),
  orderedAt: text("ordered_at").notNull().default(""),
  eta: text("eta").notNull().default(""),
  receivedAt: text("received_at").notNull().default(""),
  /**
   * Who is fabricating this part, when it is being made rather than bought.
   *
   * Only meaningful on the made lane (lib/stages.MAKE_STATES) and CHOSEN
   * there, never inferred from requested_org_id above - who was asked to buy
   * something is a different fact from who is at the printer, and reading one
   * as the other is how a client who took a bracket in house would still have
   * shown on our morning list as somebody we were waiting on to place an
   * order. Null is us, the same reading as instruments.blocked_org_id.
   */
  makerOrgId: integer("maker_org_id").references(() => orgs.id, { onDelete: "set null" }),
  /**
   * The day it came off the printer or the mill - the made lane's answer to
   * received_at, and kept apart from it because a part nobody sent was never
   * received. Blank until it reaches "Made".
   */
  madeAt: text("made_at").notNull().default(""),
  installedAt: text("installed_at").notNull().default(""),
  removedAt: text("removed_at").notNull().default(""),
  // Install/swap detail: what it replaced, serial in/out, where it came from.
  note: text("note").notNull().default(""),
  // See lib/stages.PART_STATES - two lanes, bought and made, sharing both ends.
  status: text("status").notNull().default("Needed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("parts_instrument_idx").on(t.instrumentId)]);

/**
 * Folders in an organization's file store.
 *
 * The primitive that turns a list of files into somewhere you can put things.
 * Scoped to the LOOSE store on purpose: a file that belongs to a system is
 * already in the only place it should be, and moving evidence into "Old stuff"
 * is not filing, it is hiding. See lib/folders, which owns the rules.
 *
 * Deleting one never deletes files - attachments.folder_id goes null and they
 * surface at the root. The action refuses a non-empty folder anyway; this is
 * the backstop for the day something slips past it.
 */
export const folders = pgTable("folders", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** Whose store. Null is the operator's, exactly as on attachments.org_id. */
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  parentId: integer("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("folders_org_idx").on(t.orgId), index("folders_parent_idx").on(t.parentId)]);

/**
 * Bearer links into and out of a file store - see lib/dropShare.
 *
 * A DROP link lets somebody without a login send files IN: the URL is the
 * credential, it targets one store (and optionally one folder), it expires,
 * and it can be revoked. The row survives revocation and expiry so "who could
 * write into our storage, and when" stays answerable.
 */
export const dropLinks = pgTable("drop_links", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** Whose store uploads land in. Null = the operator's own. */
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  /** Which folder, or null for the top level. A dead folder falls back to root. */
  folderId: integer("folder_id").references((): AnyPgColumn => folders.id, { onDelete: "set null" }),
  token: text("token").notNull().unique(),
  label: text("label").notNull().default(""),
  expiresOn: text("expires_on").notNull(),   // YYYY-MM-DD, last working day
  usedCount: integer("used_count").notNull().default(0),
  lastUploadAt: timestamp("last_upload_at"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (t) => [index("drop_links_org_idx").on(t.orgId)]);

/**
 * The outbound twin: named files, readable by whoever holds the URL until it
 * expires or is killed. Files are named at creation from what the creator
 * could read AT THAT MOMENT - the link never grows.
 */
export const shareLinks = pgTable("share_links", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  token: text("token").notNull().unique(),
  label: text("label").notNull().default(""),
  expiresOn: text("expires_on").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
  /**
   * What is on the other side: files (every share before billing existed),
   * an invoice, a quote, or a client's FLEET - the list of systems a peer
   * service company is being shown so they can answer "can you cover this".
   * The viewer branches on this.
   */
  kind: text("kind").notNull().default("files"),
  /** Which org the link speaks to. Money is fetched through THIS, never the URL. */
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
  quoteId: integer("quote_id").references((): AnyPgColumn => quotes.id, { onDelete: "cascade" }),
  /**
   * When it was first opened, and how many times. This IS the Viewed signal
   * the invoice timeline reads - there is no second tracker, because a second
   * tracker is a second answer to "did they see it".
   */
  openedAt: timestamp("opened_at"),
  lastOpenedAt: timestamp("last_opened_at"),
  openCount: integer("open_count").notNull().default(0),
});

// Cascades from both ends: a deleted file leaves every share it was in, and a
// deleted share takes only its rows. No stamp - a child of share_links.
export const shareLinkFiles = pgTable("share_link_files", {
  id: serial("id").primaryKey(),
  shareId: integer("share_id").notNull().references((): AnyPgColumn => shareLinks.id, { onDelete: "cascade" }),
  attachmentId: integer("attachment_id").notNull().references((): AnyPgColumn => attachments.id, { onDelete: "cascade" }),
}, (t) => [index("share_link_files_share_idx").on(t.shareId)]);

/**
 * Which systems a fleet share names.
 *
 * The exact twin of share_link_files, and for the same reason: membership is
 * FROZEN at creation so a link can never grow, while the content each row
 * points at stays live so the peer sees today's serial rather than the one that
 * was fitted in March. The viewer re-checks every id against the link's own org
 * and tenant before rendering, so a system handed to another operator since the
 * link was minted silently drops out instead of riding along.
 */
export const shareLinkSystems = pgTable("share_link_systems", {
  id: serial("id").primaryKey(),
  shareId: integer("share_id").notNull().references((): AnyPgColumn => shareLinks.id, { onDelete: "cascade" }),
  instrumentId: integer("instrument_id").notNull().references((): AnyPgColumn => instruments.id, { onDelete: "cascade" }),
}, (t) => [index("share_link_systems_share_idx").on(t.shareId)]);

export const attachments = pgTable("attachments", {
  /**
   * How this photo sits in a thumbnail: "rot,zoom,x,y", blank for untouched.
   * The stored file is never altered - framing is a preference about display,
   * and cropping evidence to tidy a tile is not a trade worth making. Parsed by
   * lib/photoFrame, which is also the only place that knows the format.
   */
  framing: text("framing").notNull().default(""),
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }), // files for a standalone asset
  // Whose shelf a HOMELESS file sits on - one with no system and no unit.
  // Every organization has its own document library, and null is the
  // operator's. Files that do belong to a record need no stamp: they live in
  // the store of whoever owns that record, which is why a system joining a
  // client's roster brings its paperwork along. See lib/storage.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  /**
   * Which folder in that store holds it. Null = the root, which is where every
   * file was before folders existed and where one lands if its folder goes.
   * Meaningless on a file that belongs to a record - see the folders table.
   */
  folderId: integer("folder_id").references((): AnyPgColumn => folders.id, { onDelete: "set null" }),
  fileName: text("file_name").notNull(),
  // Tune report | Test data | Report | Photo | Manual | Other
  kind: text("kind").notNull().default("Other"),
  description: text("description").notNull().default(""),
  url: text("url").notNull(),         // Vercel Blob URL
  size: integer("size").notNull().default(0), // bytes
  uploadedBy: text("uploaded_by").notNull(),
  // The task this file is evidence FOR - how a mandatory test proves it
  // passed. Null for general documents (manuals, photos, delivery paperwork).
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
  // The job this file belongs to - the photo of the error dialog that came with
  // the request, the report that closed it.
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  // The piece of paper this file IS - the signed contract, the vendor's
  // receipt. Cascade: a document filed against an agreement has no life of its
  // own once the agreement is gone.
  agreementId: integer("agreement_id").references((): AnyPgColumn => agreements.id, { onDelete: "cascade" }),
  // The purchase order this file is the paperwork for - the vendor's receipt or
  // invoice, which is the thing somebody goes looking for at audit time.
  poId: integer("po_id").references((): AnyPgColumn => purchaseOrders.id, { onDelete: "set null" }),
  // Files are opt-in on a for-sale listing, so no report leaks by accident.
  showOnListing: boolean("show_on_listing").notNull().default(false),
  // When this document stops being current - a calibration cert, a service
  // qualification, anything with a validity period. Shop-day string, blank =
  // never expires. The file is not the problem; nobody noticing it lapsed is,
  // so anything dated feeds the expiry attention on the dashboard (lib/gxp).
  expiresOn: text("expires_on").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("attachments_instrument_idx").on(t.instrumentId)]);

/**
 * A release signature: one person, at one moment, stating that a system (or a
 * standalone unit) is fit to hand over. Append-only in spirit - a signature is
 * revoked with a reason rather than edited, and the revocation is kept.
 *
 * `data` freezes what was true at signing (task counts, the mandatory tests and
 * the reports that evidenced them) because that is what the signature actually
 * attests to. The live record keeps moving; the claim does not.
 *
 * Honest limits: identity comes from the authenticated session and intent from
 * a typed name, not from re-entering a password - this instance signs in by
 * magic link, so there is no password to re-challenge. That makes this a strong
 * audited approval, not a 21 CFR 11 electronic signature. Getting there needs a
 * second factor at the moment of signing.
 */
export const signoffs = pgTable("signoffs", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  signedBy: text("signed_by").notNull(),       // authenticated email
  signerName: text("signer_name").notNull(),   // typed at signing, the intent
  signerTitle: text("signer_title").notNull().default(""),
  meaning: text("meaning").notNull().default("Approved for release"),
  note: text("note").notNull().default(""),
  data: jsonb("data").notNull(),               // frozen evidence snapshot
  revokedAt: timestamp("revoked_at"),
  revokedBy: text("revoked_by").notNull().default(""),
  revokedReason: text("revoked_reason").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("signoffs_instrument_idx").on(t.instrumentId), index("signoffs_asset_idx").on(t.assetId)]);

// One row per (system or asset, day): the client-facing end-of-day update.
// Written where the work happens - on the system's or asset's own page - and
// assembled by /eod into one email per client, which is why the row can hang
// off either target. Exactly one of instrument_id / asset_id is set.
export const eodUpdates = pgTable("eod_updates", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD in shop time
  // Whose report this line belonged to ON THIS DATE, stamped at write time and
  // never updated. Reading the owner off the system instead meant a handoff
  // rewrote history: a system sold on Tuesday took Monday's update with it,
  // vanishing from the old client's report and appearing on the new owner's,
  // who had nothing to do with the work. Null is the operator's own group.
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  systemUpdate: text("system_update").notNull().default(""),
  actionItem: text("action_item").notNull().default(""),
  skipped: boolean("skipped").notNull().default(false), // left out of today's email
  /**
   * Written for our own people, not for the client: bench chatter, a note
   * about who to chase, a remark generated by the sheet sync. It shows on the
   * system and in the internal digest, and is excluded from every client-
   * facing render - the EOD report and the partner digest.
   *
   * Anything a machine writes about our own bookkeeping (sheet sync, parity)
   * defaults to internal, because nobody chose to say it to a client.
   */
  internal: boolean("internal").notNull().default(false),

  /**
   * Work that happened off the board entirely: a phone call, a question
   * answered, somebody's engineer walked through a problem. Both instrument_id
   * and asset_id are null on these rows - there is no record to hang them on,
   * which is exactly why they went unlogged. The title is what it WAS, since
   * there is no system name to stand in for it, and it is what marks the row:
   * a row with no instrument, no asset and no title is not one of these.
   *
   * The two unique constraints below still hold, because Postgres counts NULLs
   * as distinct - so a day takes as many of these as the day had.
   */
  title: text("title").notNull().default(""),
  /** Who did it. Not updated_by: the person who helped is rarely the typist. */
  person: text("person").notNull().default(""),
  /**
   * How long it took, for the record. Deliberately NOT a time_entries row:
   * those bill, and hang off a system. This is a note of effort on a line of
   * a report, and calling it billable time would be a different feature with
   * a different set of consequences.
   */
  minutes: integer("minutes").notNull().default(0),

  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("eod_instrument_date").on(t.instrumentId, t.date),
  unique("eod_asset_date").on(t.assetId, t.date),
  index("eod_date_idx").on(t.date),
]);

// Append-only. No update or delete paths exist in the app code, by design.
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  // History outlives the account it describes, so this one is set null on
  // delete rather than cascade - see tenantStamp.
  tenantOrgId: integer("tenant_org_id").references(() => orgs.id, { onDelete: "set null" }),
  actor: text("actor").notNull(),          // email or "sheet-sync"
  instrumentId: integer("instrument_id"),  // nullable: settings changes etc.
  // Set whenever the change concerns an asset, so the asset page can show the
  // same activity feed a system gets. No FK: the log outlives its subjects.
  assetId: integer("asset_id"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull().default(""),
  action: text("action").notNull(),        // human-readable summary
  field: text("field").notNull().default(""),
  oldValue: text("old_value").notNull().default(""),
  newValue: text("new_value").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("audit_instrument_idx").on(t.instrumentId), index("audit_created_idx").on(t.createdAt)]);

export const sheetDiffs = pgTable("sheet_diffs", {
  id: serial("id").primaryKey(),
  runAt: timestamp("run_at").notNull().defaultNow(),
  externalId: text("external_id").notNull(),
  field: text("field").notNull(),
  sheetValue: text("sheet_value").notNull().default(""),
  dbValue: text("db_value").notNull().default(""),
  resolved: boolean("resolved").notNull().default(false),
  resolvedBy: text("resolved_by").notNull().default(""),
  resolution: text("resolution").notNull().default(""), // kept_ours | accepted_sheet
}, (t) => [index("diffs_resolved_idx").on(t.resolved)]);

// Labour logged against a system, in minutes (entered as hours in the UI).
// Feeds the per-system total and, with parts cost, the true cost of a refurb.
export const timeEntries = pgTable("time_entries", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  // System, standalone asset, or both - at least one set, enforced by
  // resolveTarget like every other work row.
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }), // optional: which asset the hours went into
  person: text("person").notNull().default(""),
  date: text("date").notNull(),           // YYYY-MM-DD in shop time
  minutes: integer("minutes").notNull().default(0),
  note: text("note").notNull().default(""),
  loggedBy: text("logged_by").notNull().default(""),
  /**
   * Whether these hours reach an invoice. Defaults true and is defaulted AGAIN
   * at the panel from the agreement's coverage, so hours on a covered system
   * arrive unticked without anybody having to remember. Unbillable hours are
   * still hours: they stay on the record and in job costing.
   */
  billable: boolean("billable").notNull().default(true),
  /** onsite | remote | travel - travel prices at the card's travel percent. */
  category: text("category").notNull().default("onsite"),
  // Which job these hours went into. This is the column an invoice is built
  // from, so it is set null on delete for the same reason as tasks: the hours
  // were worked whatever happens to the paperwork around them.
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("time_instrument_idx").on(t.instrumentId), index("time_work_order_idx").on(t.workOrderId)]);

// Assets: the individual units systems are built from - an LC stack's pump,
// autosampler, detector, a GC's headspace unit. First-class citizens: each has
// its own identity, status, and lifecycle, and can be attached to a system,
// sit on the shelf as a spare (instrument_id null), or be decommissioned.
// Service history is derived: tasks/parts/time tagged with asset_id plus the
// lifecycle rows in asset_events.
export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** This module's own photo. Same pointer-to-an-attachment rule as a system's. */
  photoAttachmentId: integer("photo_attachment_id"),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }), // null = unattached
  /**
   * The module this unit SERVES, when it serves one in particular.
   *
   * A roughing pump is on the system like any other asset - it has its own
   * serial, its own procedures, its own failures - but it belongs to the mass
   * spec rather than to the stack at large, and a triple-quad can have two of
   * them. This says which, and it is a pointer rather than a parent: nothing is
   * nested, nothing cascades, and every list, count and permission check
   * carries on treating the pump as the first-class unit it is.
   *
   * Deliberately not a hierarchy. A child has one parent, and the next support
   * unit through the door is an N2 generator feeding three systems - so
   * containment is a shape that breaks, while a pointer per server does not.
   * One level only, enforced in lib/assetServes: a thing that serves cannot
   * itself be served.
   *
   * Never crosses a system. Detaching or moving either end clears it, because
   * "the pump on G-010 serves the mass spec on G-014" is not a fact about
   * anything.
   */
  servesAssetId: integer("serves_asset_id").references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
  /** What it does for that module, in the words on the hose: "fore-line", "interface". */
  servesRole: text("serves_role").notNull().default(""),
  kind: text("kind").notNull().default("Other"), // Pump, Autosampler, ... (vocabulary in lib/stages.ts)
  model: text("model").notNull().default(""),
  serial: text("serial").notNull().default(""),
  manufacturer: text("manufacturer").notNull().default(""),
  // Whose unit it is - a client name, or blank for our own stock. Independent
  // of whatever system it currently sits in.
  owner: text("owner").notNull().default(""),
  // When the owner is an organization in the portal, this is the visibility
  // link: they see this unit even when it sits on no system of theirs.
  ownerOrgId: integer("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Condition on arrival, in the tech's words. Written once at intake and kept.
  asFound: text("as_found").notNull().default(""),
  /**
   * The order it arrived on, when it was received rather than typed in.
   *
   * Same job parts.po_id does for a consumable: "where is the receipt for this
   * pump" has an answer that survives somebody's memory. Null for a unit
   * entered by hand or imported - most of a migrated fleet - and that null is
   * honest rather than missing.
   */
  poId: integer("po_id").references((): AnyPgColumn => purchaseOrders.id, { onDelete: "set null" }),
  // Resale state - same contract as the instruments columns: while for_sale is
  // true the listing_token URL serves a public, redacted view of this unit.
  forSale: boolean("for_sale").notNull().default(false),
  saleNote: text("sale_note").notNull().default(""),
  listingToken: text("listing_token").notNull().default(""),
  // In service | Spare | Needs attention | Down | Decommissioned (lib/stages.ts)
  status: text("status").notNull().default("In service"),
  location: text("location").notNull().default(""), // where a spare lives: "shelf B"
  note: text("note").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("assets_instrument_idx").on(t.instrumentId)]);

// Asset lifecycle: installed / removed / moved / status changes, with the
// system involved. Merged with tagged work into the asset's service history.
export const assetEvents = pgTable("asset_events", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // installed | removed | moved | status | note
  instrumentId: integer("instrument_id"), // the system involved, if any (no FK: survives system deletion)
  detail: text("detail").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("asset_events_asset_idx").on(t.assetId)]);

// Shared discussion threads between Sierra Spectra and the client. One thread
// per instrument, plus a General board (instrument_id null) for lab-wide items
// like the N2 generator project. Posting requires only a signed-in user -
// clients may post even when the edit toggle is off (talking != editing).
export const discussionPosts = pgTable("discussion_posts", {
  id: serial("id").primaryKey(),
  // Which workspace this was said in. On a staff post it is WHICH service
  // company said it, and that is what makes "internal" mean anything once two of
  // them work the same client's systems - see lib/discussionScope.
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }), // null = General
  author: text("author").notNull(),
  authorEmail: text("author_email").notNull().default(""),
  body: text("body").notNull(),
  // Which organization the author was speaking for; null = the operator's own
  // staff. Stored on the post rather than looked up from the author, because a
  // person can change organizations and a post's audience cannot.
  authorOrgId: integer("author_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // "all" = everyone who can see the thread. "internal" = the author's own
  // organization only, operator included: this is what keeps one company's
  // working talk off every other company's screen.
  audience: text("audience").notNull().default("all"),
  // General board only: whose room the post sits in. The operator sits in every
  // room, each organization only in its own, so the General board is a set of
  // private rooms and never a public square. Null = the operator's own board.
  roomOrgId: integer("room_org_id").references(() => orgs.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("discussion_instrument_idx").on(t.instrumentId), index("discussion_created_idx").on(t.createdAt)]);

// Per-user read marks for discussion threads. threadId 0 = the General board,
// otherwise the instrument id. Drives the "N new" badges.
export const discussionReads = pgTable("discussion_reads", {
  id: serial("id").primaryKey(),
  userEmail: text("user_email").notNull(),
  threadId: integer("thread_id").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
}, (t) => [unique("discussion_reads_user_thread").on(t.userEmail, t.threadId)]);

// RETIRED. The roster: a hand-typed list of names that task assignment and
// @mentions read, kept separate from the logins and drifting from them the
// moment anybody joined or left. Nothing reads it now - lib/directory assembles
// the same answer from the logins that actually exist.
//
// The table stays because dropping one is a one-way door and this holds the only
// record of who was on the roster of an instance that has not upgraded yet.
// Nothing writes to it either.
export const people = pgTable("people", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  org: text("org").notNull().default("sierra"), // sierra | labzen
}, (t) => [unique("people_name_unique").on(t.name)]);

// What a day of service was called, when somebody would rather say it than let
// the procedure list say it. A visit is derived - it is a calendar day with
// finished work on it, with no row of its own - so this is the one thing about
// it that has to be stored, and only for the days anybody bothered to name.
//
// Keyed by record and day. No unique constraint the database can express
// cleanly (one of the two ids is always null, and nulls do not collide), so the
// action reads before it writes.
export const serviceVisits = pgTable("service_visits", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  day: text("day").notNull(),          // YYYY-MM-DD in shop time
  title: text("title").notNull().default(""),
  namedBy: text("named_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("service_visits_instrument_idx").on(t.instrumentId),
  index("service_visits_asset_idx").on(t.assetId),
]);

/**
 * What somebody did, and what went wrong while they did it.
 *
 * Built for one question - "where are the errors" - which is why an ERROR row
 * carries a stack and a page row carries almost nothing. Clicks are
 * deliberately not here: a DOM click tells you a button was pressed, not what
 * broke, and at one row per press it would bury the rows that answer the
 * question. What earns a row is a page somebody opened and a thing that failed
 * on them.
 *
 * The shape follows login_events: who they were AT THAT MOMENT, stamped rather
 * than joined, so a person promoted in March does not rewrite what they were
 * in January.
 */
export const trailEvents = pgTable("trail_events", {
  id: serial("id").primaryKey(),
  // page | error. Two kinds, because two questions: what were they doing, and
  // what blew up. A third for clicks was considered and refused - see above.
  kind: text("kind").notNull().default("page"),
  email: text("email").notNull().default(""),
  role: text("role").notNull().default(""),
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "set null" }),
  orgName: text("org_name").notNull().default(""),
  operatorOrgId: integer("operator_org_id").references(() => orgs.id, { onDelete: "set null" }),
  /**
   * Whose shoes they were standing in, when an owner was viewing as somebody.
   * The banner promises "anything you change is still recorded as you", and a
   * trail that recorded the persona instead would break that promise in the
   * one place somebody goes to find out who did something.
   */
  viewingAs: text("viewing_as").notNull().default(""),
  // The pathname, and the query with identifying values stripped - see
  // lib/trail.safeQuery. Never the raw URL: "?q=<a client's name>" is a
  // search somebody typed, and it is not what finds a bug.
  route: text("route").notNull().default(""),
  query: text("query").notNull().default(""),
  // Errors only: the message, and as much stack as is worth keeping.
  message: text("message").notNull().default(""),
  detail: text("detail").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [
  index("trail_events_at_idx").on(t.at),
  index("trail_events_kind_idx").on(t.kind),
  index("trail_events_email_idx").on(t.email),
]);

/**
 * Something a person noticed and said out loud.
 *
 * The trail above records what the MACHINE noticed - a page opened, an
 * exception thrown. It cannot record the other half, which is most of it: a
 * total that is wrong, a button that does nothing, a label nobody understands.
 * Those throw no exception and leave no row, and until this table the only
 * place they went was somebody's memory.
 *
 * Deliberately not a trail_events kind. A trail row is machine-written,
 * pruned at thirty days and read by one address; a report is authored, has a
 * lifecycle somebody drives, belongs to the workspace whose staff filed it,
 * and must outlive the trail that fed it. Same reasoning that keeps a work
 * order out of the audit log.
 *
 * WHO SEES IT, in both directions. The workspace's own staff see their shop's
 * reports - it is their list, and a queue nobody can watch is a queue people
 * stop filing into. Platform staff see every workspace's, because a bug in
 * the software is not the operator's to fix and a report that stopped at
 * their own settings page would never reach anybody who could act on it.
 */
export const bugReports = pgTable("bug_reports", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** bug (something is wrong) | idea (something could be better). */
  kind: text("kind").notNull().default("bug"),
  /** Their own words. The title is what a list shows; the body is the detail. */
  title: text("title").notNull().default(""),
  body: text("body").notNull().default(""),
  /** "This stopped me working" - the one triage fact worth a checkbox. */
  blocking: boolean("blocking").notNull().default(false),
  /** new | open | fixed | closed */
  status: text("status").notNull().default("new"),
  /**
   * WHERE THEY WERE, captured rather than typed. The single most useful field
   * on a bug report and the one nobody fills in: a person reporting a wrong
   * total does not think to say which page it was on.
   */
  route: text("route").notNull().default(""),
  query: text("query").notNull().default(""),   // scrubbed, see lib/trail.safeQuery
  userAgent: text("user_agent").notNull().default(""),
  viewport: text("viewport").notNull().default(""),   // "390x844", for a phone-only bug
  buildSha: text("build_sha").notNull().default(""),
  /**
   * The reporter's own last few minutes, frozen at the moment they filed.
   *
   * Frozen rather than joined because the trail prunes at thirty days and a
   * report outlives it - a snapshot that dissolves is worse than none, since
   * it reads as complete right up until it is empty. Scoped to the reporter's
   * OWN rows and shown to them on the report itself: what they were doing
   * when it broke, never a record of anybody else's day.
   */
  breadcrumbs: text("breadcrumbs").notNull().default(""),   // JSON, see lib/reports
  reportedBy: text("reported_by").notNull().default(""),
  reportedByName: text("reported_by_name").notNull().default(""),
  /** How it ended, in the words of whoever ended it. */
  resolution: text("resolution").notNull().default(""),
  resolvedBy: text("resolved_by").notNull().default(""),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("bug_reports_status_idx").on(t.status),
  index("bug_reports_tenant_idx").on(t.tenantOrgId),
]);

// A work order: one job, from the ask to the close-out.
//
// The thing this table adds is not storage - tasks, hours, parts and files were
// all already recorded - but a PARENT for them, so that a set of rows is one job
// with a number, a state both sides can read, and an end. Before it, a client's
// request became a task dated today and the only evidence it had been answered
// was somebody remembering to tick that task.
//
// It hangs off a system, or off a standalone unit, the same "at least one is
// set" rule tasks use. The lifecycle and who may move it live in
// lib/workOrders, which is pure - this is only where the state is kept.
export const workOrders = pgTable("work_orders", {
  id: serial("id").primaryKey(),
  // Whose workspace does the work. The number series is per workspace, so two
  // operators on one instance each count from their own WO-1001.
  tenantOrgId: tenantStamp(),
  number: text("number").notNull().default(""),
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  // Who asked. Null = our own staff raised it, which is ordinary: an engineer
  // who finds a second fault while on site opens one himself.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "set null" }),
  requestedBy: text("requested_by").notNull().default(""),
  requestedByEmail: text("requested_by_email").notNull().default(""),
  title: text("title").notNull(),
  // The ask in the requester's own words, kept unedited. What was DONE goes in
  // closeSummary; keeping the two apart is what makes the history readable.
  body: text("body").notNull().default(""),
  // Down | Degraded | Question | Planned - the words the request form offers.
  severity: text("severity").notNull().default("Degraded"),
  // open | active | waiting | resolved | closed | cancelled (lib/workOrders)
  state: text("state").notNull().default("open"),
  assignee: text("assignee").notNull().default(""),
  openedOn: text("opened_on").notNull().default(""),  // YYYY-MM-DD in shop time
  // '' = raised by hand | 'issue' = the client said something is wrong |
  // 'pm_request' = the client asked for upkeep
  origin: text("origin").notNull().default(""),
  // What was done, written to close it. Required by the action, not by the
  // column: a job closed with nothing written on it is how service history turns
  // into a list of dates.
  closeSummary: text("close_summary").notNull().default(""),
  closedBy: text("closed_by").notNull().default(""),
  resolvedAt: timestamp("resolved_at"),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("work_orders_instrument_idx").on(t.instrumentId),
  index("work_orders_asset_idx").on(t.assetId),
  index("work_orders_state_idx").on(t.state),
]);

// ── The part catalog ────────────────────────────────────────────────────────
// What a part number IS.
//
// Part numbers were bare strings in five places - parts, stock_items, po_lines,
// part_prices, and the parts list on a procedure - and normalizePn was the only
// thing making them agree. Nothing anywhere said that AGI-7167-PMK is the
// Agilent 7176 PM kit, so the same number got a different name typed against it
// every time somebody used it, and a kit had no way to say what was in it.
//
// This is the spine those five tables were missing. It is deliberately NOT a
// foreign key from them: they keep storing the number as text, because a part
// arriving on a machine at 2am must not fail to be recorded because nobody has
// catalogued it yet. The catalog resolves a number to a name when it knows one,
// and shrugs when it doesn't.
export const partCatalog = pgTable("part_catalog", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  // Your number. The one on the shelf label and the one people quote.
  partNumber: text("part_number").notNull(),
  name: text("name").notNull().default(""),
  manufacturer: text("manufacturer").notNull().default(""),
  // Their number, when yours is a house number wrapping somebody else's part.
  mfrPartNumber: text("mfr_part_number").notNull().default(""),
  // part | consumable | kit - a kit is a bag of other numbers, sold and stocked
  // as one thing (see partKitLines).
  kind: text("kind").notNull().default("part"),
  // Which module types this suits, for the picker. [] = anything.
  assetTypes: text("asset_types").array().notNull().default([]),
  // Which MODELS it suits, when the number is model-specific - an LC-20 seal
  // kit is not an LC-30 seal kit. [] = any model of the types above.
  models: text("models").array().notNull().default([]),
  note: text("note").notNull().default(""),
  archived: boolean("archived").notNull().default(false),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("part_catalog_pn_idx").on(t.partNumber)]);

// ── Catalog reference library ───────────────────────────────────────────────
// The knowledge that accumulates about a KIND of equipment, filed on the model
// (or module type) rather than on any one unit: the service manual's URL, the
// page about installing the H-ESI needle, the photo of the trick nobody
// remembers. Filed once, it surfaces on every system and unit with matching
// equipment - which is the whole point. A note about one specific unit still
// belongs on that unit's record; this is for what is true of all of them.
export const catalogRefs = pgTable("catalog_refs", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  assetType: text("asset_type").notNull(),          // catalog module type
  model: text("model").notNull().default(""),       // "" = every model of the type
  kind: text("kind").notNull().default("link"),     // 'link' | 'note'
  title: text("title").notNull().default(""),
  // The manual's URL on a link; on a note, an optional image or file URL
  // (a gallery photo, a shelf file) that illustrates it.
  url: text("url").notNull().default(""),
  body: text("body").notNull().default(""),         // the note text
  /**
   * Whose material this is: '' | original | facts | oem. Decides whether the
   * row may travel with a licensed library - see lib/provenance.
   */
  provenance: text("provenance").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("catalog_refs_type_idx").on(t.assetType)]);

// What is in a kit. Lines are part NUMBERS, not catalog ids, for the same reason
// the rest of the system keys on numbers: a kit can list a part nobody has
// catalogued, and should, rather than refusing to be written down.
/**
 * The other numbers this same part answers to.
 *
 * A part number is not one string. The seal you fit is Shimadzu's
 * 228-35145-91, a third party's 5063-6589, and - once your shop wraps it - your
 * own SS-SEAL-01; the box in somebody's hand carries whichever of those the
 * person who sold it printed. part_catalog keeps ONE of each as the display
 * identity (part_number, and mfr_part_number with its manufacturer) because
 * every other table stores a bare string and something has to be the name. This
 * table is the rest, and it is what makes all of them resolve to one described
 * part instead of to three undescribed ones.
 *
 * No tenant stamp: like part_kit_lines, a row here belongs to its catalog entry
 * and dies with it.
 */
export const partNumbers = pgTable("part_numbers", {
  id: serial("id").primaryKey(),
  catalogId: integer("catalog_id").notNull().references((): AnyPgColumn => partCatalog.id, { onDelete: "cascade" }),
  /** 'shop' - another number of ours; 'oem' - somebody else's for the same thing. */
  kind: text("kind").notNull().default("oem"),
  partNumber: text("part_number").notNull(),
  /** Whose number it is. Blank on a shop number, which is ours by definition. */
  manufacturer: text("manufacturer").notNull().default(""),
  note: text("note").notNull().default(""),   // "superseded 2024", "pack of 10"
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("part_numbers_catalog_idx").on(t.catalogId), index("part_numbers_pn_idx").on(t.partNumber)]);

/**
 * What a part looks like.
 *
 * Same reasoning as a model's stock photo (vocab_terms.photo_url): one photo of
 * a check valve is a photo of every check valve of that number, so it belongs
 * to the catalog rather than to any record - it appears wherever the number
 * does, and lands on nobody's file list, nobody's gallery and nobody's storage
 * bill. Several per part because the useful set is usually "the thing", "its
 * label", and "where it goes", and a caption is what tells them apart.
 *
 * Blob-owned rather than an attachment, so removing one deletes the bytes.
 */
export const partPhotos = pgTable("part_photos", {
  id: serial("id").primaryKey(),
  catalogId: integer("catalog_id").notNull().references((): AnyPgColumn => partCatalog.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  caption: text("caption").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  uploadedBy: text("uploaded_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("part_photos_catalog_idx").on(t.catalogId)]);

export const partKitLines = pgTable("part_kit_lines", {
  id: serial("id").primaryKey(),
  kitId: integer("kit_id").notNull().references((): AnyPgColumn => partCatalog.id, { onDelete: "cascade" }),
  partNumber: text("part_number").notNull(),
  name: text("name").notNull().default(""),
  qty: integer("qty").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("part_kit_lines_kit_idx").on(t.kitId)]);

/**
 * A multi-year award: one engagement, several separately-priced 12-month terms.
 *
 * The shape every solicitation asks for and nothing here could hold. "CLIN 0001
 * base year, CLIN 0002 option year 1" is five firm prices of which ONE is
 * committed - the other four are options the client may exercise or walk away
 * from, one at a time, each on its own deadline. A shop that models that as
 * five unrelated contracts finds out it has lost an option year by noticing the
 * money stopped.
 *
 * Each period is still an ordinary `agreements` row, because a period IS a
 * contract: a term, a price, entitlements, a billing cycle. Everything already
 * built - drawdown, coverage, the recurring biller, per-agreement rate cards -
 * goes on working per period with nothing taught about awards. What was missing
 * was only the thread between them and the facts that belong to none of them:
 * whose award number it is, and how long before a period starts the client has
 * to say whether they want it.
 */
export const awards = pgTable("awards", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /** THEIR number for it - the contract or solicitation number they will quote back. */
  number: text("number").notNull().default(""),
  title: text("title").notNull().default(""),
  /** YYYY-MM-DD. Blank = bid, not yet won: the periods are priced and nothing is in force. */
  awardedOn: text("awarded_on").notNull().default(""),
  /**
   * How long before a period begins the client must exercise it. The deadline
   * that gets missed, so it is data rather than something in somebody's diary -
   * 60 days is the common federal shape and is only a default.
   */
  optionNoticeDays: integer("option_notice_days").notNull().default(60),
  /** The quote this was won on, when there was one. Set null so a deleted quote does not take the award. */
  quoteId: integer("quote_id").references((): AnyPgColumn => quotes.id, { onDelete: "set null" }),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("awards_org_idx").on(t.orgId)]);

// ── Service agreements ──────────────────────────────────────────────────────
// The contract, and what it entitles somebody to.
//
// One row per piece of paper: a service contract, their PO, our quote, an
// invoice. The entitlements - visits included, parts allowance - live on the
// contract kind, and what has been DRAWN DOWN against them is never stored here.
// It is summed from the work: parts.cost_cents for parts installed on their
// systems inside the term, and closed work orders for visits. A stored balance
// is a second copy of a number the ledger already has, free to disagree with it,
// and the disagreement is always discovered in front of the customer.
export const agreements = pgTable("agreements", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  // contract | po | quote | invoice
  kind: text("kind").notNull().default("contract"),
  // Their PO number, our quote number - whatever this piece of paper is called.
  number: text("number").notNull().default(""),
  title: text("title").notNull().default(""),
  // draft | active | expired | cancelled. Expiry is derived from endsOn for
  // display; this column is what somebody SET, so a contract can be cancelled
  // early or held in draft while it is being negotiated.
  status: text("status").notNull().default("active"),
  startsOn: text("starts_on").notNull().default(""),  // YYYY-MM-DD
  endsOn: text("ends_on").notNull().default(""),      // blank = open-ended
  // How long before it ends we want to be told. 0 = never.
  renewNoticeDays: integer("renew_notice_days").notNull().default(60),
  // Entitlements. 0 means "not part of this agreement", NOT "zero allowed" -
  // an unlimited-visits contract and a no-visits contract are both real, and
  // the one nobody has filled in must not read as the second.
  visitsIncluded: integer("visits_included").notNull().default(0),
  partsAllowanceCents: integer("parts_allowance_cents").notNull().default(0),
  laborIncludedMinutes: integer("labor_included_minutes").notNull().default(0),
  // Unlimited is a third state, distinct from a cap and from "not included":
  // a full-service contract covers every visit and every part, and usage shows
  // as information rather than as drawdown against a number.
  visitsUnlimited: boolean("visits_unlimited").notNull().default(false),
  partsUnlimited: boolean("parts_unlimited").notNull().default(false),
  // The PM's own parts are part of the PM, so they must not also be drawn from
  // the parts allowance - "1 PM included, parts included" is one thing sold,
  // not two. Off by default: turning it on is a statement about this contract,
  // and flipping every existing one silently would rewrite their numbers.
  pmPartsIncluded: boolean("pm_parts_included").notNull().default(false),
  // What the contract actually includes, when it includes KITS rather than a
  // sum of money: [{partNumber, name, qty}] as JSON, the parts.specs convention.
  // "Two PMs, each with its kit" is how these are sold and quoted; a dollar
  // allowance is a proxy for it that goes wrong the moment a kit's price moves.
  includedKits: text("included_kits").notNull().default(""),
  // What an hour beyond the included ones bills at. Null = not set.
  hourlyRateCents: integer("hourly_rate_cents"),
  valueCents: integer("value_cents"),                 // the contract's value
  // Which of the client's systems THIS contract covers. [] = all of them, so a
  // client can run a full-service contract on one system and a PM-only one on
  // another, each drawing down separately.
  instrumentIds: integer("instrument_ids").array().notNull().default([]),
  /**
   * WHO PROVIDES THE SERVICE. Null = us, the tenant on this row.
   *
   * Without this the app could only hold one kind of relationship - ours - and
   * so it assumed one: every system a client could see was announced as "under
   * service with Sierra Spectra", including a system we had touched exactly
   * once and one whose real contract is with the manufacturer. Visibility is
   * not a relationship, the same way a queue is not an obligation.
   *
   * A third party here is an orgs row with no users and no login, the way a
   * manufacturer name is - a directory entry, not a participant. Two rows can
   * name the same system with different providers, which is the real case
   * where Agilent holds the LC stack and we hold the MS.
   *
   * Null rather than a self-reference so that every row written before this
   * column existed keeps its exact meaning with nothing to backfill.
   */
  providerOrgId: integer("provider_org_id").references(() => orgs.id, { onDelete: "set null" }),
  note: text("note").notNull().default(""),
  /**
   * The multi-year award this is one period of. Null = an ordinary standalone
   * contract, which is nearly all of them.
   *
   * Set null on delete rather than cascade: unpicking an award must not delete
   * the base year's contract along with it, because that term was really in
   * force and really billed.
   */
  awardId: integer("award_id").references((): AnyPgColumn => awards.id, { onDelete: "set null" }),
  /** Which period: 0 is the base year, 1 is option year 1. Meaningless without awardId. */
  periodIndex: integer("period_index").notNull().default(0),
  // ── Recurring billing ────────────────────────────────────────────────────
  // A retainer is the agreement, not a work order: nobody drives out, nobody
  // logs an hour, and the same amount falls due every month regardless. These
  // columns are the standing instruction; billNextOn is the cursor that says
  // which cycle is next and is the ONLY thing that stops a re-run billing the
  // same month twice.
  //
  // 0 months means not recurring - not "every zero months" - the same reading
  // the entitlement columns above already use.
  billEveryMonths: integer("bill_every_months").notNull().default(0),
  billAmountCents: integer("bill_amount_cents").notNull().default(0),
  billDescription: text("bill_description").notNull().default(""),
  // Which day the cycle falls on. A month shorter than the number clamps to
  // its last day, so a contract billed on the 31st bills Feb 28 rather than
  // skipping February.
  billDayOfMonth: integer("bill_day_of_month").notNull().default(1),
  // How far ahead the draft is raised, so somebody has time to look at it
  // before the day it is dated.
  billLeadDays: integer("bill_lead_days").notNull().default(7),
  billNextOn: text("bill_next_on").notNull().default(""),   // YYYY-MM-DD
  billLastOn: text("bill_last_on").notNull().default(""),   // the cycle last raised
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("agreements_org_idx").on(t.orgId), index("agreements_ends_idx").on(t.endsOn)]);

// Stage transition history: one row every time a stage is added to or removed
// from an instrument. Powers the "12d in Checkout" age chips and cycle-time
// metrics. Written by toggleStage/createInstrument/deleteStage; renaming a
// custom stage leaves old rows under the old name (rare, accepted).
export const stageEvents = pgTable("stage_events", {
  id: serial("id").primaryKey(),
  instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  kind: text("kind").notNull(), // added | removed
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("stage_events_instrument_idx").on(t.instrumentId)]);

// Shop vocabulary, defined ahead of use: system categories ("LC-MS") and
// asset models per type ("Autosampler" / "ASI-L"). Pickers everywhere combine
// these terms with values already in use, so a checkout test can be scoped to
// a model the shop hasn't stocked yet. Managed in Settings.
// The equipment catalog: system categories ("LC-MS"), asset types ("Pump"),
// and asset models ("LC-20AD") - curated by the house, shared by everyone on
// the instance, and the ONLY place equipment vocabulary is defined. Every
// picker that names a type, model or category reads from here; there is no
// free-text fallback, so "LC-20" spelled four ways can't happen. Seeded once
// from the fleet in use (see the catalog-seed migration), then curated.
//
// A model hangs off an asset TYPE (which is what a checkout item or PM template
// keys on) and is tagged with the system categories it belongs to, because
// those are different axes: a Detector means FID or TCD on a GC-MS and SPD-20A
// on an LC-MS. Empty categories = every system type, which is both the
// backward-compatible default for models defined before tagging existed and the
// right answer for genuinely universal kit like a control PC.
export const vocabTerms = pgTable("vocab_terms", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  kind: text("kind").notNull(),                        // 'category' | 'asset_type' | 'model'
  assetType: text("asset_type").notNull().default(""), // models only: which asset type
  name: text("name").notNull(),
  // Models only: who makes it. Thirty pumps across seven makers in one pile is
  // unusable, so the catalog groups by this and asset forms fill the unit's
  // manufacturer in from it.
  manufacturer: text("manufacturer").notNull().default(""),
  // Models only: system categories this model appears under. [] = all of them.
  // An array rather than one value because a pump can serve LC-MS and HPLC
  // alike - same reasoning as checkout_items.model_scope.
  categories: text("categories").array().notNull().default([]),
  // What this kind of thing LOOKS like - a stock photo of the model, the module
  // type or the system type. Deliberately NOT an attachment: a catalog photo
  // illustrates a hundred records and belongs to none of them, so it must never
  // turn up in a client's Files, their gallery, or their storage bill. It is one
  // blob URL owned by the catalog row, served through /api/catalog/photo.
  photoUrl: text("photo_url").notNull().default(""),
  photoFraming: text("photo_framing").notNull().default(""),
  // Which gases this kind of equipment needs. Declared once here, applied to
  // every unit and system that matches - adding an Altis should not mean
  // typing "Nitrogen, Argon" again. On a model it means units of that model,
  // on a module type any unit of it, on a system type the system itself.
  gases: text("gases").array().notNull().default([]),
  // The validation package this kind of equipment owes when it lands on a
  // regulated system: a list of DOC_TYPES (lib/gxp). Same declare-once idea as
  // gases - "an Altis needs an IQ protocol, an OQ protocol, and their reports"
  // is said here, and every regulated Altis arrives with the checklist. The
  // package is derived at read time, never copied onto systems, so refining it
  // updates every checklist at once.
  docTypes: text("doc_types").array().notNull().default([]),
  /**
   * Models only: the specification sheet - JSON [{name, value}] rows like
   * "Max pressure: 1300 bar". Freeform names, suggested across siblings so
   * spellings converge. See lib/specs.
   */
  specs: text("specs").notNull().default(""),
  /**
   * The public catalog page (lib/publicCatalog). `published` is the operator's
   * explicit "this may be indexed" - never automatic; `publicSlug` is the URL
   * it lives at, stable once minted so a rename can't orphan a ranked page;
   * `publicSummary` is the one piece of writing on the page that exists
   * nowhere else, which is what earns the indexing.
   */
  published: boolean("published").notNull().default(false),
  publicSlug: text("public_slug").notNull().default(""),
  publicSummary: text("public_summary").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Unique on identity only, not on categories: FID is one model that happens
  // to apply to several system types, not a row per type.
}, (t) => [unique("vocab_term_unique").on(t.kind, t.assetType, t.name)]);

// How one person arranges a record page: which panels sit in which column, in
// what order, and which they've hidden. Per PERSON, not per browser - two
// people sharing a workstation get their own view, and one person's arrangement
// follows them from the bench PC to a laptop.
//
// Keyed by sign-in email like the notification tables, and stored as jsonb
// because the shape belongs to the component: adding a panel or a third column
// later shouldn't need a migration to a table nobody queries by field.
export const uiLayouts = pgTable("ui_layouts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  viewKey: text("view_key").notNull(),   // 'system' | 'asset'
  data: jsonb("data").notNull(),         // { order: string[], right: string[], hidden: string[] }
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [unique("ui_layout_unique").on(t.email, t.viewKey)]);

// One row per event per recipient - the in-app copy of every notification the
// platform sends. Written BEFORE the email goes out, so "the mail was junked"
// never means "the event vanished". Keyed by sign-in email rather than user id
// because recipients (roster mentions, allowlisted clients) can be notified
// before they've ever signed in and created a users row.
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),           // recipient, lowercase
  kind: text("kind").notNull(),             // NOTIFY_KINDS entry (lib/inbox)
  title: text("title").notNull(),           // one line, same voice as the email subject
  href: text("href").notNull().default(""), // in-app path, "" when there's nowhere to go
  createdAt: timestamp("created_at").notNull().defaultNow(),
  readAt: timestamp("read_at"),             // null = unread
}, (t) => [index("notifications_email_idx").on(t.email)]);

// Per-kind email opt-outs. No row = email on: the table only records
// departures from the default, so a fresh install (and every existing user)
// starts with everything enabled and the inbox always gets a row regardless.
/**
 * Emails waiting for the burst they belong to to finish.
 *
 * A row here is an email that HAS NOT been sent and a notification that has
 * already been recorded - lib/notify writes the inbox row first, always, so
 * nothing in this table is load-bearing for what the app knows. Losing the
 * whole table would cost some emails and no facts.
 *
 * `send_after` slides: every new item in the same burst pushes it out again,
 * so the wait measures silence rather than elapsed time. `send_by` does not,
 * and is what stops a burst that never goes quiet from holding its first item
 * forever. See lib/outbox for both.
 *
 * `sent_at` rather than a delete, so a flush that runs twice cannot send
 * twice, and so "why did this arrive late" has an answer on the row.
 */
export const emailOutbox = pgTable("email_outbox", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  kind: text("kind").notNull(),
  /** The inbox sentence - stands alone, and is the fallback in a batch. */
  title: text("title").notNull().default(""),
  href: text("href").notNull().default(""),
  /** What one of these says on its own, kept so a single item is unchanged. */
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  /* The three facts a batch is grouped and worded by: who did it, what to,
     and the bare thing itself. See lib/outbox.batchKey. */
  actor: text("actor").notNull().default(""),
  context: text("context").notNull().default(""),
  item: text("item").notNull().default(""),
  sendAfter: timestamp("send_after").notNull(),
  sendBy: timestamp("send_by").notNull(),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("email_outbox_due_idx").on(t.sentAt, t.sendAfter)]);

export const notificationPrefs = pgTable("notification_prefs", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  kind: text("kind").notNull(),
  emailOn: boolean("email_on").notNull().default(true),
}, (t) => [unique("notification_prefs_unique").on(t.email, t.kind)]);

/**
 * One person's standing connection to an outside file store - today Microsoft,
 * which covers OneDrive and SharePoint through the same API.
 *
 * Per PERSON, never per organization. The connection carries whatever that
 * individual can see in their own tenant, so sharing one between colleagues
 * would quietly hand one person's document library to another. It is also why
 * every read through it is scoped to the signed-in user rather than to their
 * org, which is the opposite of how the rest of this schema works and is
 * deliberate.
 *
 * The refresh token is SEALED (see lib/secretBox), not stored as text: it is a
 * standing key to somebody's files, it does not expire on its own, and a copy of
 * this table on its own must not be enough to use it.
 */
export const cloudConnections = pgTable("cloud_connections", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** Sign-in email, the same identity the notification tables key on. */
  email: text("email").notNull(),
  provider: text("provider").notNull().default("microsoft"),
  /** Who the far end says this is, so a person can tell which account they connected. */
  accountName: text("account_name").notNull().default(""),
  accountEmail: text("account_email").notNull().default(""),
  /** Sealed. Never selected into anything that reaches a browser. */
  refreshToken: text("refresh_token").notNull().default(""),
  /**
   * The short-lived token, also sealed, kept only so that clicking through
   * folders does not pay for a round trip to Microsoft's token endpoint on every
   * click. Treated as a cache: anything unreadable or stale simply refreshes.
   */
  accessToken: text("access_token").notNull().default(""),
  accessExpiresAt: timestamp("access_expires_at"),
  /** What was actually granted, which can be less than what was asked for. */
  scopes: text("scopes").notNull().default(""),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  /** Last time the far end accepted the token. A connection can rot silently. */
  lastUsedAt: timestamp("last_used_at"),
  /** Set when a refresh is refused, so the UI can say why rather than retrying forever. */
  brokenReason: text("broken_reason").notNull().default(""),
}, (t) => [unique("cloud_connection_unique").on(t.email, t.provider)]);

// ── Stock ───────────────────────────────────────────────────────────────────
// Where parts physically live. Three kinds, because "where is it" has three
// different answers in this business: a shelf in the shop, the client's own
// spares cage at their site, or a van/field kit that travels with a tech.
// A room's org is what makes cross-org stock meaningful - a client can let
// their service provider draw from their cage, and a provider can let the
// client see the spares held on their behalf (see stockroomShares).
export const stockrooms = pgTable("stockrooms", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("shop"), // shop | client | mobile
  // Whose stock this is. Null = the house's own.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  // mobile only: whose van or kit, so a tech's own stock is findable by name.
  keeper: text("keeper").notNull().default(""),
  location: text("location").notNull().default(""),
  note: text("note").notNull().default(""),
  archived: boolean("archived").notNull().default(false),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("stockrooms_org_idx").on(t.orgId)]);

// Who else may see or draw from a room, one row per (room, org) - the same
// shape as systemShares. 'issue' is the meaningful grant: it lets another
// organization's editors decrement someone else's inventory.
export const stockroomShares = pgTable("stockroom_shares", {
  id: serial("id").primaryKey(),
  stockroomId: integer("stockroom_id").notNull().references(() => stockrooms.id, { onDelete: "cascade" }),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  access: text("access").notNull().default("view"), // view | issue
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("stockroom_share_unique").on(t.stockroomId, t.orgId),
  index("stockroom_shares_org_idx").on(t.orgId),
]);

// On-hand of one part number in one room. Keyed on the part number as text,
// like the price book, and matched case-insensitively through the same
// normalizePn - inventory and pricing must agree on what "the same part" is.
// Case-insensitive uniqueness on (stockroom_id, part_number) is an expression
// index in drizzle/schema-sync.sql; the ORM can't declare lower().
export const stockItems = pgTable("stock_items", {
  id: serial("id").primaryKey(),
  stockroomId: integer("stockroom_id").notNull().references(() => stockrooms.id, { onDelete: "cascade" }),
  partNumber: text("part_number").notNull(),
  name: text("name").notNull().default(""),
  qty: integer("qty").notNull().default(0),
  // Reorder point. 0 = never suggest reordering this, which is the honest
  // default for a part nobody has decided a floor for yet.
  minQty: integer("min_qty").notNull().default(0),
  bin: text("bin").notNull().default(""),
  // What a unit actually cost, when it's known - set by PO receiving. Null
  // falls back to the price book's best offer when a part is issued.
  unitCostCents: integer("unit_cost_cents"),
  note: text("note").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("stock_items_room_idx").on(t.stockroomId)]);

// The ledger. Counts live on stock_items for fast reads, but every change to
// one appends a move here, so "why does it say four" always has an answer and
// a miscount is a correcting entry rather than a silent overwrite.
export const stockMoves = pgTable("stock_moves", {
  id: serial("id").primaryKey(),
  stockroomId: integer("stockroom_id").notNull().references(() => stockrooms.id, { onDelete: "cascade" }),
  partNumber: text("part_number").notNull(),
  delta: integer("delta").notNull(),  // signed: +in, -out
  kind: text("kind").notNull(),       // receive | issue | adjust | transfer_in | transfer_out | return
  // transfer only: the room on the other end.
  counterpartyId: integer("counterparty_id").references(() => stockrooms.id, { onDelete: "set null" }),
  // issue only: what it went into, and the parts row it became.
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
  assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }),
  partId: integer("part_id").references(() => parts.id, { onDelete: "set null" }),
  reason: text("reason").notNull().default(""),
  actor: text("actor").notNull().default(""),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [index("stock_moves_room_idx").on(t.stockroomId), index("stock_moves_at_idx").on(t.at)]);

// A purchase order: one vendor, one destination shelf, the lines you're buying.
// Raised by hand or from a room's reorder list (which prices itself from the
// price book), then received - and receiving is what puts stock on the shelf,
// so the count and the paperwork can't disagree.
export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  // Human-facing number, assigned at creation and never reused.
  number: text("number").notNull(),
  vendor: text("vendor").notNull(),
  stockroomId: integer("stockroom_id").references(() => stockrooms.id, { onDelete: "set null" }),
  // Whose money. Follows the destination room's org, frozen here because a
  // room can be handed over later and the PO belongs to whoever paid.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "set null" }),
  // draft | sent | partial | received | cancelled
  status: text("status").notNull().default("draft"),
  // The job this was bought for. Null is the normal case and means stock: a PO
  // with a destination room and no work order is restocking the shelf. With a
  // work order it is "we bought this to fix THAT", which is the question the
  // purchasing records could not answer at all before - and the link that lets
  // a client's parts allowance be defended with a receipt.
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  reference: text("reference").notNull().default(""), // vendor quote or confirmation number
  note: text("note").notNull().default(""),
  expectedAt: text("expected_at").notNull().default(""), // free text, like parts.eta
  /**
   * Drop-ship destination. Null is the normal case - the vendor ships to the
   * stockroom above. Set, it means the vendor ships straight to this client
   * site under our paperwork: receiving confirms delivery instead of shelving,
   * and the send step carries the blind-ship instruction.
   */
  shipToSiteId: integer("ship_to_site_id").references((): AnyPgColumn => orgSites.id, { onDelete: "set null" }),
  /** Somebody is waiting on this. Overnight it and say so on the paperwork. */
  urgent: boolean("urgent").notNull().default(false),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  sentAt: timestamp("sent_at"),
  closedAt: timestamp("closed_at"),
  cancelReason: text("cancel_reason").notNull().default(""),
}, (t) => [unique("po_number_unique").on(t.number), index("po_status_idx").on(t.status)]);

export const poLines = pgTable("po_lines", {
  id: serial("id").primaryKey(),
  poId: integer("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  partNumber: text("part_number").notNull(),
  name: text("name").notNull().default(""),
  qtyOrdered: integer("qty_ordered").notNull().default(1),
  // Receiving accumulates here; a line is settled when received >= ordered.
  qtyReceived: integer("qty_received").notNull().default(0),
  unitCents: integer("unit_cents"),  // null = price not agreed yet
  note: text("note").notNull().default(""),
}, (t) => [index("po_lines_po_idx").on(t.poId)]);

// The house price book: what a part number costs from each vendor who sells
// it. One row per (PN, vendor) pair - the OEM's price and every third-party
// price sit side by side, so "request part" can pick the cheapest and an
// engineer filling in a part form sees what the shop last paid. House-curated
// like the catalog; prices are staff data and only ever shown where costs
// already are (lib/redact governs the read side).
//
// Case-insensitive uniqueness on (part_number, vendor) is an expression index
// in drizzle/schema-sync.sql ("part_prices_pn_vendor") - drizzle's pgTable
// can't declare lower() indexes, so the mirror carries it alone.
export const partPrices = pgTable("part_prices", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  partNumber: text("part_number").notNull(),
  vendor: text("vendor").notNull(),
  // The maker's own listing vs a third party. Breaks price ties in the OEM's
  // favor - at the same price, provenance wins.
  isOem: boolean("is_oem").notNull().default(false),
  priceCents: integer("price_cents").notNull(),
  url: text("url").notNull().default(""),   // where to order it
  note: text("note").notNull().default(""), // "min order 5", "returns need an RMA"
  /**
   * Business days from order to THIS VENDOR shipping it. Null is "nobody has
   * asked", which the picker treats as slower than any number - an honest
   * unknown must never beat a known week. Structured here (not in the note)
   * because "fastest supplier" is a sort, and you cannot sort prose.
   */
  leadDays: integer("lead_days"),
  /** VERIFIED to blind-ship: to a client site under OUR paperwork only. */
  dropShips: boolean("drop_ships").notNull().default(false),
  /** Will they expedite/overnight on request (at a cost)? */
  expediteOk: boolean("expedite_ok").notNull().default(false),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Billing. Nothing here stores a balance - see lib/billing and lib/agreements:
// every figure a person reads is summed from rows at render time.
// ---------------------------------------------------------------------------

/**
 * What an hour costs, and how the odd hours are priced.
 *
 * Three rungs, most specific first: a card written against one AGREEMENT beats
 * one written for the ORG, which beats the platform default (both ids null).
 * That is the same layering the digest schedule uses, and lib/rates.resolveRate
 * is the only place that decides it.
 *
 * The multipliers are integer PERCENTAGES, not floats: 150 is time-and-a-half,
 * 50 is travel at half rate. A float multiplier on money is how a $160 hour
 * becomes $239.99999997, and this codebase keeps money in integer cents for
 * exactly that reason.
 */
/**
 * What an organization pays its own people, and therefore what a month of
 * being open costs before a single job is touched.
 *
 * The most sensitive table in the app, and the access rule is the reverse of
 * every other one here: a row belongs to the organization that EMPLOYS the
 * person, and it is readable by that organization's own administrators and by
 * nobody else - not by the operator whose workspace hosts them, not by
 * platform staff. `tenant_org_id` is filed for housekeeping and is explicitly
 * NOT a permission (see lib/payroll.maySeePayroll, which is where the rule
 * lives and is tested). A client keeping payroll here must be able to trust
 * that the shop servicing their instruments cannot read it.
 *
 * Rows are EFFECTIVE-DATED rather than edited in place. A raise in March must
 * not rewrite what January cost - that is the difference between a payroll
 * register and a guess - so a change ends one row and starts another, and any
 * month's cost is summed from whatever was in force during it.
 */
export const payroll = pgTable("payroll", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** WHOSE payroll. The employing organization, and the whole access rule. */
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  /**
   * The person's account, when they have one - what lets somebody see their
   * own row without seeing anybody else's. Blank for a person with no login,
   * which is most of a payroll.
   */
  personEmail: text("person_email").notNull().default(""),
  name: text("name").notNull().default(""),
  title: text("title").notNull().default(""),
  /** salary (annual) | hourly (a wage) | monthly (a retainer, a flat cost) */
  kind: text("kind").notNull().default("salary"),
  /** Read against `kind`: per year, per hour, or per month. */
  amountCents: integer("amount_cents").notNull().default(0),
  /** For hourly people, what a normal week is - the month's cost rides on it. */
  hoursPerWeek: integer("hours_per_week").notNull().default(40),
  /** Part time is a fraction of a person, not a different kind of one. */
  ftePct: integer("fte_pct").notNull().default(100),
  /**
   * Employer costs on top of the pay itself - payroll taxes, insurance, the
   * benefits line. Per person because a contractor carries none and an
   * employee carries a third, and a single company-wide number would quietly
   * overstate one of them.
   */
  burdenPct: integer("burden_pct").notNull().default(0),
  effectiveOn: text("effective_on").notNull().default(""),   // YYYY-MM-DD
  /** Blank = still in force. Set when they leave, or when a raise supersedes. */
  endsOn: text("ends_on").notNull().default(""),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("payroll_org_idx").on(t.orgId)]);

/**
 * Perks: the compensation that is not wages.
 *
 * A phone stipend, a vehicle allowance, a boot allowance, a bonus - money the
 * company has promised a person on top of their pay. Its own table rather
 * than extra payroll rows because a payroll row IS a person (headcount and
 * FTE are counted off it), and a person with a salary and two stipends must
 * not read as three people.
 *
 * Same access family as payroll, enforced by the same rules (lib/payroll):
 * the employing organization's own administrators read and write these, and
 * nobody else. Effective-dated the same way - ending a perk closes it, so
 * what March cost stays what March cost.
 */
export const perks = pgTable("perks", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** The employing organization - the whole access rule, exactly as payroll. */
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  personEmail: text("person_email").notNull().default(""),
  name: text("name").notNull().default(""),        // whose it is, display
  /** What the perk is, in the words on the offer letter: "Phone stipend". */
  title: text("title").notNull().default(""),
  amountCents: integer("amount_cents").notNull().default(0),
  /** monthly | annual | one_off - how the amount is read. */
  cadence: text("cadence").notNull().default("monthly"),
  startsOn: text("starts_on").notNull().default(""),   // YYYY-MM-DD
  /** Blank = still running. One-offs are their own start and end. */
  endsOn: text("ends_on").notNull().default(""),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("perks_org_idx").on(t.orgId)]);

export const rateCards = pgTable("rate_cards", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** Null = the platform default for this workspace. */
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  /** Null = not tied to one paper. Set, it beats the org's card. */
  agreementId: integer("agreement_id").references((): AnyPgColumn => agreements.id, { onDelete: "cascade" }),
  hourlyCents: integer("hourly_cents").notNull().default(0),
  /** Percent of the base rate for after-hours work. 150 = time and a half. */
  afterHoursPct: integer("after_hours_pct").notNull().default(150),
  /** Percent of the base rate for travel time. 50 = half rate. */
  travelPct: integer("travel_pct").notNull().default(50),
  /** Rounding granularity, in minutes. 15 bills a 7-minute call as a quarter hour. */
  minIncrementMin: integer("min_increment_min").notNull().default(15),
  label: text("label").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("rate_cards_org_idx").on(t.orgId)]);

/**
 * Money spent on a job that is neither a part nor an hour: mileage, freight,
 * a night in a motel. Recorded against the work order because that is what it
 * gets billed and costed against.
 */
/**
 * What an expense can be called here - each workspace's own list.
 *
 * The five hardcoded kinds lasted exactly until a real shop's bookkeeping met
 * them: one wants Fuel split from Tolls, another folds both into Vehicle. So
 * the vocabulary is rows, seeded from a starter set when a workspace is
 * created (see lib/expenseCategories) and edited freely after.
 *
 * Expense rows store the NAME as text, not a foreign key - deliberately, and
 * it is the same choice the rest of the app makes for vocabulary: deleting a
 * category removes it from the pickers and nothing else. Last year's "Fuel"
 * receipt still says Fuel, because what a cost was called when it was logged
 * is a historical fact, not a live reference.
 */
/**
 * Routed road miles, remembered. One row per (engineer, site): homes and labs
 * move rarely, routing providers rate-limit and bill, and a page must never
 * wait on one - so the WO page reads this table and a miss is filled in the
 * background of the next save. The coordinate snapshot is the invalidation:
 * when either end has moved, the row no longer matches and is recomputed.
 */
export const driveCache = pgTable("drive_cache", {
  id: serial("id").primaryKey(),
  memberEmail: text("member_email").notNull(),
  siteId: integer("site_id").notNull().references(() => orgSites.id, { onDelete: "cascade" }),
  miles: doublePrecision("miles").notNull(),
  fromLat: doublePrecision("from_lat").notNull(),
  fromLng: doublePrecision("from_lng").notNull(),
  toLat: doublePrecision("to_lat").notNull(),
  toLng: doublePrecision("to_lng").notNull(),
  /** haversine-with-road-factor when the router was unreachable; a routed row replaces it. */
  estimated: boolean("estimated").notNull().default(false),
  computedAt: timestamp("computed_at").notNull().defaultNow(),
}, (t) => [unique("drive_cache_member_site").on(t.memberEmail, t.siteId)]);

export const expenseCategories = pgTable("expense_categories", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("expense_categories_tenant_idx").on(t.tenantOrgId)]);

export const expenses = pgTable("expenses", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /**
   * Null is an OVERHEAD expense - an engineer's internet bill, the shop's
   * software seat - money the business spent that no job caused. It shares
   * this table with job expenses because the row is the same shape and the
   * difference is exactly one fact: whether a work order made it happen.
   * Overhead never reaches an invoice and never joins a job's cost; it has
   * its own room at /money/expenses.
   */
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("other"), // mileage | shipping | per_diem | other
  description: text("description").notNull().default(""),
  amountCents: integer("amount_cents").notNull().default(0),
  incurredOn: text("incurred_on").notNull().default(""), // YYYY-MM-DD in shop time
  /**
   * Whether this reaches the client's invoice. Cost either way - jobCost
   * counts every expense, billable or not, because the money left regardless.
   * What this flag decides is only who ends up paying: unticked on a
   * fixed-price job means "ours to absorb", and the draft never sees it, so
   * nobody has to remember to delete the lunch line before sending.
   */
  billable: boolean("billable").notNull().default(true),
  /** Whose expense, for overhead rows - who gets reimbursed. */
  person: text("person").notNull().default(""),
  /**
   * Which of the client's labs the trip went to. Set null on delete: the
   * receipt outlives the closing of a building.
   */
  siteId: integer("site_id").references(() => orgSites.id, { onDelete: "set null" }),
  loggedBy: text("logged_by").notNull().default(""),
  /**
   * The reimbursement report this row was submitted on. Null = still in the
   * engineer's pool. Set null on report delete so a withdrawn report returns
   * its rows to the pool instead of taking the receipts with it.
   */
  reportId: integer("report_id").references((): AnyPgColumn => expenseReports.id, { onDelete: "set null" }),
  /** The receipt: a photo shot at the counter, or an emailed PDF. Blob URL. */
  receiptUrl: text("receipt_url").notNull().default(""),
  receiptName: text("receipt_name").notNull().default(""),
  /*
   * What the shop's travel rulebook made of this row, written when it was
   * logged. See lib/expensePolicy.
   *
   * Only per diems are ruled on today, and only when a report names a job -
   * that is what supplies the site, and the site plus the claimant's home is
   * what supplies the distance. Everything else stores "" and behaves as it
   * always did.
   *
   * The verdict is STORED rather than recomputed at render, and deliberately:
   * the rulebook is a live setting an owner edits, road miles come from a
   * routing provider, and an engineer's home moves. A claim has to be judged
   * against the rules as they stood when it was filed, or raising the radius
   * next March silently un-flags every claim anybody ever queried.
   */
  allowanceState: text("allowance_state").notNull().default(""), // "" | flagged | approved
  /** What the rulebook said, in the words a reviewer reads. Written either way. */
  allowanceNote: text("allowance_note").notNull().default(""),
  /** Who cleared a flagged row, and when. Blank until somebody does. */
  allowanceBy: text("allowance_by").notNull().default(""),
  allowanceAt: timestamp("allowance_at"),
  /**
   * Nights away, as the claimant answered it. The one fact in the ruling that
   * cannot be recovered from anywhere else - miles come from the job's site
   * and the rates come from the rulebook, but only the person who made the
   * trip knows whether they slept there. Kept so that moving a claim onto a
   * different job re-judges it against the same trip rather than silently
   * demoting an overnight to a day trip.
   */
  allowanceNights: integer("allowance_nights").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("expenses_wo_idx").on(t.workOrderId),
  index("expenses_report_idx").on(t.reportId),
  index("expenses_allowance_idx").on(t.allowanceState),
]);

/**
 * An engineer's reimbursement claim: a batch of their expenses, submitted as
 * one thing to be paid as one thing.
 *
 * The report's total is NOT a column - it is summed from its expense rows at
 * render, the same no-stored-balances rule invoices follow, so editing a row
 * before payout can never leave a stale total for the payout to trust.
 *
 * status: draft | submitted | paid | returned. A report starts as a DRAFT the
 * engineer fills - receipts added straight onto it, or pulled from their
 * unclaimed pool - and submits when the trip is emptied out. Returning keeps
 * the rows ON the report, wearing the reason, so it is fixed in place and
 * resubmitted rather than reassembled.
 */
export const expenseReports = pgTable("expense_reports", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  /** Whose money is owed - a directory name, same convention as expenses.person. */
  person: text("person").notNull(),
  /**
   * What this claim IS, in the filer's own words, and why it happened.
   *
   * A report used to be identified by its person and the span of its rows -
   * "Steve Jones, Jul 12 - Aug 3" - which is enough to tell two apart on a
   * list and nothing like enough to approve one. The owner paying it wants to
   * know it was the Reno install, not "some days in July"; the engineer
   * filing it wants to keep the airport trip separate from the parts run.
   *
   * Both optional. A report with no name still reads as it always did, so
   * nothing that exists becomes wrong, and the empty-handed flow - open a
   * draft, scan receipts into it, submit - still takes no typing at all.
   */
  title: text("title").notNull().default(""),
  purpose: text("purpose").notNull().default(""),
  /**
   * The job this claim is for, open or closed alike - a trip's receipts
   * surface long after the order they belong to wraps, and a claim that
   * cannot name a closed job is a claim that gets filed under nothing.
   *
   * Nullable, and the null is a real answer rather than an unset field: an
   * overhead claim - the internet bill, a software seat - has no job that
   * caused it, the same distinction expenses.work_order_id already draws.
   * The FORM makes the reader choose one or the other; the column just
   * records which. Set null on delete, because the claim outlives the order.
   */
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  status: text("status").notNull().default("submitted"),
  /**
   * Who opened it, which is not always whose money it is: HR opens a claim in
   * an engineer's name from a handful of receipts, and six weeks later the
   * question "who filed this" has one honest answer and it is not `person`.
   *
   * Distinct from submittedBy on purpose. That one is now written when the
   * report is actually SENT for payout - the two were the same address only
   * because the column was set at creation and never touched again.
   */
  openedBy: text("opened_by").notNull().default(""),
  submittedBy: text("submitted_by").notNull().default(""),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  /** Payout facts, written when it is paid. */
  paidOn: text("paid_on").notNull().default(""),        // YYYY-MM-DD
  paidBy: text("paid_by").notNull().default(""),
  paidRef: text("paid_ref").notNull().default(""),      // check number, payroll run
  /** Why it came back, when it did. */
  returnedReason: text("returned_reason").notNull().default(""),
  note: text("note").notNull().default(""),
}, (t) => [
  index("expense_reports_person_idx").on(t.person),
  index("expense_reports_wo_idx").on(t.workOrderId),
]);

/**
 * A bill. Nothing here is a balance: what is owed is
 * lines + fees - payments, summed at render by lib/billing.invoiceBalance, and
 * the status column is a lifecycle word (has it been sent, was it voided), not
 * an arithmetic result. `partial` and `paid` are written when a payment lands
 * because a human wants to see them on a list without the sum; the sum is
 * still the authority, and the two are reconciled by invoiceStanding.
 *
 * workOrderId and agreementId are both nullable: a statement-only invoice for
 * a retainer belongs to neither, and a job invoice belongs to one job.
 */
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  agreementId: integer("agreement_id").references((): AnyPgColumn => agreements.id, { onDelete: "set null" }),
  number: text("number").notNull(),
  // draft | sent | partial | paid | void | referred
  status: text("status").notNull().default("draft"),
  issuedOn: text("issued_on").notNull().default(""),   // YYYY-MM-DD, set at send
  dueOn: text("due_on").notNull().default(""),         // issuedOn + the org's terms
  poNumber: text("po_number").notNull().default(""),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("invoices_org_idx").on(t.orgId),
  index("invoices_wo_idx").on(t.workOrderId),
  unique("invoice_number_unique").on(t.tenantOrgId, t.number),
]);

/**
 * One line. `covered` is the whole reason a $0 invoice exists: the line keeps
 * its real quantity and unit price and prices out at zero, so the client can
 * read what the contract just paid for. `sourceId` points back at the part,
 * time entry or expense the line came from - that is how a redraft knows what
 * it already billed.
 */
export const invoiceLines = pgTable("invoice_lines", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
  // part | labor | travel | expense | tax | fee_ref
  kind: text("kind").notNull().default("part"),
  description: text("description").notNull().default(""),
  detail: text("detail").notNull().default(""),        // the second, quieter line
  qty: integer("qty").notNull().default(1000),          // thousandths, so 4.5 h is 4500
  unitCents: integer("unit_cents").notNull().default(0),
  covered: boolean("covered").notNull().default(false),
  coveredBy: text("covered_by").notNull().default(""),  // the agreement number it burned
  sourceId: integer("source_id"),
  position: integer("position").notNull().default(0),
}, (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)]);

/** Money that arrived. Never edited - a mistake is corrected by another row. */
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  invoiceId: integer("invoice_id").notNull().references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
  method: text("method").notNull().default("check"),   // ach | card | check | other
  amountCents: integer("amount_cents").notNull().default(0),
  reference: text("reference").notNull().default(""),  // check number, Stripe id
  receivedOn: text("received_on").notNull().default(""),
  recordedBy: text("recorded_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("payments_invoice_idx").on(t.invoiceId)]);

/**
 * A late charge, as its own row.
 *
 * It never edits the invoice it belongs to. An invoice that changed after it
 * was sent is one nobody can reconcile against the copy in their inbox, and a
 * fee quietly folded into a line is the kind of thing a client finds and never
 * trusts you about again. `basis` records what it was computed on, so the
 * arithmetic can be explained a year later.
 *
 * Waiving keeps the row. Expect to waive more than you charge; the record of
 * having charged and then waived is the part that is worth anything.
 */
export const invoiceFees = pgTable("invoice_fees", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  invoiceId: integer("invoice_id").notNull().references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull().default(0),
  /** "1.5%/mo on $3,900 undisputed, 41 days past due" - the sentence, kept. */
  basis: text("basis").notNull().default(""),
  postedOn: text("posted_on").notNull().default(""),
  postedBy: text("posted_by").notNull().default(""),
  waived: boolean("waived").notNull().default(false),
  waivedBy: text("waived_by").notNull().default(""),
  waivedReason: text("waived_reason").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("invoice_fees_invoice_idx").on(t.invoiceId)]);

/**
 * "The check goes out Friday." Worth writing down for one reason: the morning
 * after it is broken is the moment the conversation changes, and nobody
 * remembers that date without a row for it.
 */
export const promises = pgTable("promises", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  invoiceId: integer("invoice_id").notNull().references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
  promisedOn: text("promised_on").notNull().default(""),  // the day they said
  byName: text("by_name").notNull().default(""),          // who said it
  note: text("note").notNull().default(""),
  /** Set when the money arrived. Null and past promisedOn = broken. */
  keptOn: text("kept_on"),
  loggedBy: text("logged_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("promises_invoice_idx").on(t.invoiceId)]);

/**
 * A line the client has questioned. It pauses what the reminders ASK for on
 * that line alone: the undisputed remainder keeps aging and keeps being
 * chased, because a question about one cartridge must not buy ninety quiet
 * days on the rest of the bill.
 */
export const disputes = pgTable("disputes", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  invoiceId: integer("invoice_id").notNull().references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
  lineId: integer("line_id").references((): AnyPgColumn => invoiceLines.id, { onDelete: "set null" }),
  reason: text("reason").notNull().default(""),
  openedOn: text("opened_on").notNull().default(""),
  openedBy: text("opened_by").notNull().default(""),
  resolvedOn: text("resolved_on"),
  /** "kept" (the line stands) or "credited" (a negative line was issued). */
  resolution: text("resolution").notNull().default(""),
  resolvedBy: text("resolved_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("disputes_invoice_idx").on(t.invoiceId)]);

/**
 * A rung of the ladder that has actually been climbed. The ladder itself is
 * data in lib/dunning; this is the log of what was sent, which is what
 * nextAction reads to decide what comes next - and what the demand letter
 * cites when it says "we have since sent 3 reminders and a statement".
 */
export const dunningEvents = pgTable("dunning_events", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  invoiceId: integer("invoice_id").notNull().references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
  /** The rung key from lib/dunning.LADDER. */
  rung: text("rung").notNull().default(""),
  /** Who it went to, by name and address, as sent. */
  toName: text("to_name").notNull().default(""),
  toEmail: text("to_email").notNull().default(""),
  /** "auto" from the cron, or the email of whoever pressed the button. */
  sentBy: text("sent_by").notNull().default("auto"),
  note: text("note").notNull().default(""),
  sentOn: text("sent_on").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("dunning_events_invoice_idx").on(t.invoiceId)]);

/**
 * The owner's decision to work for somebody who owes money anyway, with the
 * reason they gave. Enforced in the action, not the form.
 */
export const creditOverrides = pgTable("credit_overrides", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  reason: text("reason").notNull().default(""),
  /** Blank = until it is lifted by hand. YYYY-MM-DD otherwise. */
  untilOn: text("until_on").notNull().default(""),
  grantedBy: text("granted_by").notNull().default(""),
  liftedAt: timestamp("lifted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("credit_overrides_org_idx").on(t.orgId)]);

/**
 * A price, offered.
 *
 * Composed by the same lib/billing function that composes an invoice, from the
 * same rows - so what was quoted and what gets billed are produced by one
 * piece of code rather than two that drift. What a quote adds over an invoice
 * is a date it stops being true and a deposit somebody owes on saying yes.
 */
export const quotes = pgTable("quotes", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
  agreementId: integer("agreement_id").references((): AnyPgColumn => agreements.id, { onDelete: "set null" }),
  number: text("number").notNull(),
  // draft | sent | approved | declined | expired
  status: text("status").notNull().default("draft"),
  title: text("title").notNull().default(""),
  sentOn: text("sent_on").notNull().default(""),
  expiresOn: text("expires_on").notNull().default(""),
  /** Percent due on approval. Zero means nothing is owed until the work is done. */
  depositPct: integer("deposit_pct").notNull().default(0),
  /** Set when the client answers, with their own words in `answerNote`. */
  answeredOn: text("answered_on"),
  answeredBy: text("answered_by").notNull().default(""),
  answerNote: text("answer_note").notNull().default(""),
  /** The deposit invoice approval generated, if it did. */
  depositInvoiceId: integer("deposit_invoice_id").references((): AnyPgColumn => invoices.id, { onDelete: "set null" }),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("quotes_org_idx").on(t.orgId),
  index("quotes_wo_idx").on(t.workOrderId),
  unique("quote_number_unique").on(t.tenantOrgId, t.number),
]);

/** The same shape as an invoice line, for the same reason: one composer. */
export const quoteLines = pgTable("quote_lines", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id").notNull().references((): AnyPgColumn => quotes.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("part"),
  description: text("description").notNull().default(""),
  detail: text("detail").notNull().default(""),
  qty: integer("qty").notNull().default(1000),     // thousandths
  unitCents: integer("unit_cents").notNull().default(0),
  covered: boolean("covered").notNull().default(false),
  coveredBy: text("covered_by").notNull().default(""),
  sourceId: integer("source_id"),
  position: integer("position").notNull().default(0),
}, (t) => [index("quote_lines_quote_idx").on(t.quoteId)]);

// RETIRED: merged into `procedures` (see the procedures-merge migration).
// The table stays because the sync pipeline is additive-only; nothing reads it
// except the older checkout_rules seed migration that fills it.
export const checkoutItems = pgTable("checkout_items", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull(),          // MODULE_KINDS entry or "system"
  kind: text("kind").notNull().default("test"),     // 'task' | 'test'
  name: text("name").notNull(),
  position: integer("position").notNull().default(0), // ordering within its asset type
  // Test-only
  resultType: text("result_type").notNull().default("pass_fail"), // pass_fail | measured | reading | note
  target: text("target"),                           // e.g. "5 mL/min", or the note text
  tolerancePct: numeric("tolerance_pct"),           // only for measured, e.g. 10
  // Task-only
  requiresNote: boolean("requires_note").notNull().default(false),
  consumesPart: boolean("consumes_part").notNull().default(false),
  // [] = all models. For assetType 'system' this holds system types
  // (instruments.model values) instead of asset models.
  modelScope: text("model_scope").array().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// RETIRED: SOP templates (a named bundle of tasks applied to an instrument in
// one tap). The feature went unused and its UI and actions were removed; the
// tables stay because the sync pipeline is additive-only. Nothing reads them.
export const taskTemplates = pgTable("task_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("task_templates_name_unique").on(t.name)]);

export const templateTasks = pgTable("template_tasks", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => taskTemplates.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("template_tasks_template_idx").on(t.templateId)]);

export const templateItems = pgTable("template_items", {
  id: serial("id").primaryKey(),
  templateTaskId: integer("template_task_id").notNull().references(() => templateTasks.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [index("template_items_task_idx").on(t.templateTaskId)]);

// Stage vocabulary: seeded with the nine built-ins (schema-sync.sql), owner
// can recolor any stage and add/rename/delete custom ones in Settings.
// Built-in rows (builtin=true) can't be renamed or deleted - their names are
// referenced by sync, dashboard counts, and the EOD report.
export const stageDefs = pgTable("stage_defs", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  name: text("name").notNull(),
  bg: text("bg").notNull(),
  fg: text("fg").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  builtin: boolean("builtin").notNull().default(false),
}, (t) => [unique("stage_defs_name_unique").on(t.name)]);

// Client sign-in allowlist, editable by the owner in Settings. An entry is
// either an exact email ("jane@labzenllc.com") or a whole domain
// ("@labzenllc.com"). Unioned with the CLIENT_EMAILS env allowlist at sign-in.
export const clientAllowlist = pgTable("client_allowlist", {
  id: serial("id").primaryKey(),
  entry: text("entry").notNull(),
  // Which organization this entry signs in as. Null = unusable (the sign-in
  // gate rejects it), so an entry can't grant access with no scope.
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  // Per-person role: editors work the records, viewers read them. Replaces the
  // old instance-wide "clients can edit" toggle (kept in app_settings for the
  // one-time backfill, ignored since).
  canEdit: boolean("can_edit").notNull().default(false),
  // Whether this person may read their organization's AGREEMENTS - contract
  // value, allowances, what was signed. A lab manager needs them; the tech who
  // logs in to check whether the LC is fixed usually should not, and in some
  // companies must not. Defaults true because that is what everyone at an org
  // could already see: this switch exists to take the privilege away
  // deliberately, never to remove it from people by upgrading.
  canSeeAgreements: boolean("can_see_agreements").notNull().default(true),
  /**
   * Whether this person may read their ORGANIZATION'S PAYROLL - everybody's
   * pay, not just their own. Defaults false and stays false until somebody
   * deliberately turns it on, which is the opposite default from agreements
   * and for an obvious reason.
   */
  canSeePayroll: boolean("can_see_payroll").notNull().default(false),
  /**
   * Whether this person may read their ORGANIZATION'S MONEY - the quotes it
   * has been sent and the invoices it owes, which together are what the
   * relationship has cost. A lab manager signs those off; the technician who
   * logs in to see whether the LC is fixed has no business in them.
   *
   * Defaults TRUE, unlike payroll, and the asymmetry is deliberate. The house
   * side of this rule needs no column at all - an operator has an OWNER role,
   * so restricting the books to the owner is a rule rather than a setting, and
   * it is safe because the owner keeps them. A client organization has no
   * owner role. Shipping this false would leave some labs with nobody at all
   * who could open their own invoice until an operator went in and granted it
   * back, which is a broken account rather than a private one. So the switch
   * exists to take the privilege away deliberately, per person, the way
   * can_see_agreements does - never to remove it from people by upgrading.
   */
  canSeeMoney: boolean("can_see_money").notNull().default(true),
  /**
   * WHICH VIEW THIS PERSON STARTS IN - "lab" or "reseller", blank to follow
   * their organization's own shape.
   *
   * Set by the operator, before the person has ever signed in, which is the
   * whole point: a COO put in charge of the equipment at a reselling company
   * should not have to find a menu on his first morning to stop being shown a
   * pipeline of stock. It is a STARTING point and nothing more - the moment he
   * chooses for himself (users.view_mode) his answer wins and this stops
   * mattering.
   *
   * A value the organization has no view for is refused on the way in and
   * ignored on the way out - see lib/viewMode, which clamps at read time so a
   * company that stops reselling cannot leave its people on a pipeline.
   */
  startView: text("start_view").notNull().default(""),
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("allowlist_entry_unique").on(t.entry)]);

// ── Direct messages ─────────────────────────────────────────────────────────
// A conversation between named people, as opposed to discussion_posts, which
// are attached to a system and read by whoever can see that system.
//
// The distinction is the point. "Is the Altis fixed?" belongs on the Altis,
// where the next engineer will find it. "Can you cover Tuesday?" belongs to
// the two people it concerns and nowhere else - and before this it had to go
// through somebody's personal email, out of reach of the record entirely.
//
// Membership is by EMAIL rather than a user id: this app's identity is an
// email on an allowlist, people arrive before they ever sign in, and a thread
// must survive somebody being re-added under a new row.
export const messageThreads = pgTable("message_threads", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  // Groups may be named; a two-person thread is named by who is in it.
  title: text("title").notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Denormalized so the thread list can sort without reading every message.
  // Safe to denormalize because it is derived from an append-only table and
  // rewritten by the one action that appends.
  lastMessageAt: timestamp("last_message_at").notNull().defaultNow(),
});

export const threadMembers = pgTable("thread_members", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").notNull().references(() => messageThreads.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),   // display only, as of when they joined
  orgName: text("org_name").notNull().default(""),
  // What the unread badge counts from. Null = never opened it.
  lastReadAt: timestamp("last_read_at"),
  addedBy: text("added_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Leaving hides the thread from your list without deleting what was said -
  // the others' copy of the conversation is not yours to remove.
  leftAt: timestamp("left_at"),
}, (t) => [
  index("thread_members_thread_idx").on(t.threadId),
  index("thread_members_email_idx").on(t.email),
  unique("thread_member_unique").on(t.threadId, t.email),
]);

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").notNull().references(() => messageThreads.id, { onDelete: "cascade" }),
  authorEmail: text("author_email").notNull(),
  authorName: text("author_name").notNull().default(""),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Kept, not erased: "deleted by the author" is itself part of a conversation
  // two people may later disagree about.
  deletedAt: timestamp("deleted_at"),
}, (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt)]);

// Singleton row (id = 1)
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  clientAccessEnabled: boolean("client_access_enabled").notNull().default(false),
  clientCanEdit: boolean("client_can_edit").notNull().default(false),
  // Comma-separated list the EOD "Send to LabZen" button emails.
  eodRecipients: text("eod_recipients").notNull().default(""),
  // Which org the Google-sheet tracker and the EOD report belong to. Only
  // systems shared with this org take part in either.
  sheetOrgId: integer("sheet_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // What this instance calls itself. The platform is a product, not a service
  // company: every visible wordmark, page title and email header reads from
  // here so renaming it never needs a deploy. Blank falls back to
  // DEFAULT_BRAND in lib/brand.ts.
  platformName: text("platform_name").notNull().default(""),
  platformTagline: text("platform_tagline").notNull().default(""),
  /**
   * Where an enquiry from the public landing page goes. Its own field rather
   * than reaching for STAFF_EMAILS[0]: that list is an authorization control,
   * and the address a stranger writes to should be a deliberate choice, not a
   * side effect of who happens to be the owner account. Blank hides the
   * buttons rather than mailing nowhere.
   */
  publicContactEmail: text("public_contact_email").notNull().default(""),
  /**
   * How the platform looks, for instances that would rather not be navy. See
   * lib/appearance, which owns the defaults and the validation - blank means
   * "the look the app ships with", so a future change to that default reaches
   * every instance that never expressed a preference.
   *
   * The header colour paints the header bar and tints the page behind it, the
   * same rule an organization's own themeColor follows; it deliberately does
   * NOT move the accents on buttons, titles and tabs, because one hex applied
   * to everything is a redesign rather than a brand.
   */
  headerColor: text("header_color").notNull().default(""),
  /** The spectrum bar, in whole pixels. 0 hides it. */
  spectrumHeight: integer("spectrum_height").notNull().default(3),
  /** Its colour stops, JSON [{c,at}] - see lib/appearance.parseStops. */
  spectrumStops: text("spectrum_stops").notNull().default(""),
  // The service organization that runs this instance - Sierra Spectra here.
  // Distinct from the platform operator role: this is a provider org like any
  // other, so its engagements are shares and its people are org members.
  // Systems the operator creates are shared with it automatically.
  operatorOrgId: integer("operator_org_id").references(() => orgs.id, { onDelete: "set null" }),
  // Optional modules. The sheet tracker, EOD report and daily digest grew out
  // of one operator's workflow; a fresh instance ships with all three off and
  // their crons, nav entries and pages go quiet. This instance keeps them on
  // via a one-time migration.
  sheetSyncEnabled: boolean("sheet_sync_enabled").notNull().default(false),
  eodEnabled: boolean("eod_enabled").notNull().default(false),
  digestEnabled: boolean("digest_enabled").notNull().default(false),
  // The digest schedule for an instance that has named no operator org, where
  // there is no orgs row to hang it on. Same meaning as the columns of those
  // names on orgs; see lib/digest.digestDue.
  digestHour: integer("digest_hour").notNull().default(7),
  digestDays: text("digest_days").notNull().default(""),
  digestLastSentOn: text("digest_last_sent_on").notNull().default(""),
  /**
   * The calendar feed's secret. Blank = no feed. A subscribed phone calendar
   * cannot sign in, so the URL itself is the credential - generated once,
   * rotatable by generating again, and the whole feed dies with a blank.
   */
  calendarToken: text("calendar_token").notNull().default(""),
  // Remote support: reaching a lab PC from the portal. Off until an operator
  // stands up the relay host and sets REMOTE_URL - the pages check both, so a
  // flag flipped before the infrastructure exists says so instead of failing.
  remoteEnabled: boolean("remote_enabled").notNull().default(false),
  // The public, indexable equipment library (app/equipment). Off until an
  // operator decides to be on the open web - and off means OFF: the pages 404
  // and the sitemap empties, not merely that the publish button is hidden.
  publicCatalogEnabled: boolean("public_catalog_enabled").notNull().default(false),
  /**
   * Record what people do - pages opened, and every error thrown at them.
   *
   * OFF by default and deliberately so. This is the one module that watches
   * PEOPLE rather than machines, and on a multi-tenant instance most of those
   * people work for somebody else's company. Turning it on is a decision with
   * a disclosure attached to it, not a default. See lib/trail.
   */
  trailEnabled: boolean("trail_enabled").notNull().default(false),
  // Billing. The prefix is what invoice numbers are built on; the number
  // itself is allocated by scanning the highest one in use, the same
  // read-max-and-retry the work order numbers have always used.
  /**
   * RETIRED: numbering moved to orgs.doc_scheme, which is per service company
   * rather than one setting shared by every tenant on the instance and covers
   * all four document kinds rather than invoices alone. Nothing reads this;
   * the column stays because the sync pipeline is additive-only.
   */
  invoicePrefix: text("invoice_prefix").notNull().default("INV-"),
  /**
   * The platform's cut of ACH volume, in basis points, taken as Stripe's
   * application fee. Zero by default and it must stay zero until somebody
   * decides otherwise: a platform that silently starts taking a percentage of
   * an operator's revenue is a platform they leave.
   */
  platformFeeBps: integer("platform_fee_bps").notNull().default(0),
  /**
   * Days a part spends turning around at the shop when a vendor will not
   * drop-ship: it lands on our dock and goes out again. Added to that route's
   * lead time so "fastest" compares doors-to-door, not vendor promises.
   */
  crossDockDays: integer("cross_dock_days").notNull().default(1),
  /**
   * The name parts ship under. The client's parts relationship is with this
   * brand - every packing slip, and the blind-ship instruction on drop-ship
   * POs, carries it. Distinct from the operator's service brand on purpose.
   */
  partsBrand: text("parts_brand").notNull().default("Ridgeline"),
  /**
   * Fully loaded cost of an hour of labor - wage, burden, van, insurance -
   * used only to show margin beside a bill. Zero means "we have not told it",
   * and the costing view says so rather than reporting a fake 100% margin.
   */
  loadedLaborCents: integer("loaded_labor_cents").notNull().default(0),
  /** Platform-wide billing policy defaults; an org's own jsonb wins. */
  billingPolicy: jsonb("billing_policy"),
  /**
   * The shop's travel rules - radius, per diems, lodging cap. About OUR
   * engineers rather than any client, which is why there is no per-org
   * override the way billing_policy has one. See lib/expensePolicy.
   */
  expensePolicy: jsonb("expense_policy"),
});

/**
 * A lab PC we can reach - the instrument controller running LabSolutions,
 * MassHunter, ChemStation. One row per machine an agent was installed on.
 *
 * This replaces "the PC's password", which is how remote support works today
 * with TeamViewer and UltraViewer: a shared secret that everyone who ever
 * needed access still knows, that is probably on a label, that cannot be
 * revoked without walking to the machine, and that leaves no record of who
 * connected. Here identity comes from the portal session, and every connection
 * writes an audit row naming a person.
 *
 * `orgId` is stamped at enrollment and is whose machine it is. It is deliberately
 * NOT re-derived from the linked system, because comparing the two is what tells
 * us the system has changed hands since the PC was enrolled - see
 * lib/remoteAccess, which turns that into a consent prompt.
 *
 * `nodeId` is the engine's own identifier for the machine. Everything else here
 * is a cache of what the engine knows, so the page still renders a useful list
 * when the relay host is unreachable.
 */
export const remoteDevices = pgTable("remote_devices", {
  id: serial("id").primaryKey(),
  tenantOrgId: tenantStamp(),
  orgId: integer("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  // The system this PC drives, when it drives one. A pointer, so the device
  // survives the system being detached or deleted.
  instrumentId: integer("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
  nodeId: text("node_id").notNull().default(""),
  // The Windows hostname, refreshed from the engine on every reconcile - which
  // is exactly why it cannot hold anything a person typed.
  name: text("name").notNull().default(""),
  // What to call it instead. "DESKTOP-39VTF39" identifies a machine to a domain
  // controller; "Altis PC" identifies it to the engineer who has to pick the
  // right one off a list at eight in the morning.
  nickname: text("nickname").notNull().default(""),
  platform: text("platform").notNull().default("windows"),
  // Staff's answer to "must somebody be at this machine?", overruling the one
  // derived from custody. Null - the normal state - means derive it.
  consentOverride: boolean("consent_override"),
  // Last time the agent said hello. Null until it first does. A cache: the
  // engine is the authority, this is what we can show without it.
  lastSeenAt: timestamp("last_seen_at"),
  enrolledBy: text("enrolled_by").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("remote_device_node_unique").on(t.nodeId),
  index("remote_devices_org_idx").on(t.orgId),
  index("remote_devices_instrument_idx").on(t.instrumentId),
]);
