// The fake business behind the demo: a small support desk with customers, orders, and a refund
// ledger. Deliberately plain in-memory objects — this stands in for the host app's OWN database,
// the one busyclaw never touches. Everything governed happens on the way IN and OUT of here.
//
// The customer records carry real-shaped PII (names, emails, phones, IBANs) because that is what
// makes the redaction visible: a tool returns a customer, and what reaches the model is tokens.

export type Customer = {
	id: string;
	name: string;
	email: string;
	phone: string;
	iban: string;
	city: string;
	plan: "free" | "pro" | "enterprise";
	since: string;
};

export type Order = {
	id: string;
	customerId: string;
	description: string;
	amountCents: number;
	placedAt: string;
	status: "delivered" | "shipped" | "cancelled";
};

export type Refund = {
	id: string;
	customerId: string;
	amountCents: number;
	reason: string;
	issuedAt: string;
	/** Which principal the run was acting as when the refund landed. */
	issuedBy: string;
};

const CUSTOMERS: Customer[] = [
	{
		id: "cus_1",
		name: "Maria Schmidt",
		email: "maria.schmidt@bayer-legal.de",
		phone: "+49 151 2345 6789",
		iban: "DE89 3704 0044 0532 0130 00",
		city: "Leverkusen",
		plan: "enterprise",
		since: "2023-04-11",
	},
	{
		id: "cus_2",
		name: "Tomás Oliveira",
		email: "tomas.oliveira@meridian.pt",
		phone: "+351 912 887 340",
		iban: "PT50 0002 0123 1234 5678 9015 4",
		city: "Porto",
		plan: "pro",
		since: "2024-09-02",
	},
	{
		id: "cus_3",
		name: "Aoife Byrne",
		email: "aoife.byrne@corrib.ie",
		phone: "+353 86 774 1120",
		iban: "IE29 AIBK 9311 5212 3456 78",
		city: "Galway",
		plan: "free",
		since: "2026-01-19",
	},
];

const ORDERS: Order[] = [
	{
		id: "ord_1001",
		customerId: "cus_1",
		description: "Annual enterprise licence — 40 seats",
		amountCents: 480000,
		placedAt: "2026-06-01",
		status: "delivered",
	},
	{
		id: "ord_1002",
		customerId: "cus_1",
		description: "Onboarding workshop (2 days)",
		amountCents: 240000,
		placedAt: "2026-06-14",
		status: "cancelled",
	},
	{
		id: "ord_1003",
		customerId: "cus_2",
		description: "Pro plan — annual",
		amountCents: 39900,
		placedAt: "2026-05-20",
		status: "delivered",
	},
	{
		id: "ord_1004",
		customerId: "cus_2",
		description: "Extra storage add-on",
		amountCents: 8900,
		placedAt: "2026-07-02",
		status: "shipped",
	},
	{
		id: "ord_1005",
		customerId: "cus_3",
		description: "Priority support add-on",
		amountCents: 4900,
		placedAt: "2026-07-11",
		status: "delivered",
	},
];

/** The refund ledger. A module-level array so it survives across requests in one server process —
 *  the same lifetime as the claw itself (see lib/claw.ts). */
const REFUNDS: Refund[] = [];

export const desk = {
	findCustomerByEmail(email: string): Customer | undefined {
		const needle = email.trim().toLowerCase();
		return CUSTOMERS.find((c) => c.email.toLowerCase() === needle);
	},
	findCustomerById(id: string): Customer | undefined {
		return CUSTOMERS.find((c) => c.id === id);
	},
	listCustomers(): readonly Customer[] {
		return CUSTOMERS;
	},
	listOrders(customerId: string): readonly Order[] {
		return ORDERS.filter((o) => o.customerId === customerId);
	},
	listRefunds(customerId?: string): readonly Refund[] {
		return customerId === undefined
			? REFUNDS
			: REFUNDS.filter((r) => r.customerId === customerId);
	},
	/** Total refunded since midnight UTC — the number a daily-limit plugin will want to read. */
	refundedTodayCents(): number {
		const dayStart = new Date().toISOString().slice(0, 10);
		return REFUNDS.filter((r) => r.issuedAt.startsWith(dayStart)).reduce(
			(sum, r) => sum + r.amountCents,
			0,
		);
	},
	issueRefund(input: {
		customerId: string;
		amountCents: number;
		reason: string;
		issuedBy: string;
	}): Refund {
		const refund: Refund = {
			id: `ref_${(REFUNDS.length + 1).toString().padStart(4, "0")}`,
			customerId: input.customerId,
			amountCents: input.amountCents,
			reason: input.reason,
			issuedAt: new Date().toISOString(),
			issuedBy: input.issuedBy,
		};
		REFUNDS.push(refund);
		return refund;
	},
	reset(): void {
		REFUNDS.length = 0;
	},
};

export const euros = (cents: number): string =>
	new Intl.NumberFormat("en-IE", {
		style: "currency",
		currency: "EUR",
	}).format(cents / 100);
