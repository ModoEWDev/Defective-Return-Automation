const {
  findInvoice,
  getSalesRep,
  getUnitsPurchased,
  getUnitsCredited,
  createCreditMemo,
} = require('./netsuiteClient');
const { getClaimCountToday, recordClaimSubmission } = require('./claimTracking');

const WARRANTY_MONTHS = 30; // 2-year warranty + 6-month grace period
const KATHRYN_LAND_REP_ID = '396';
const MAX_CLAIMS_PER_DAY = 3;

async function evaluateClaim(claim, context) {
  const { invoiceNumber, poNumber, accountNumber, sku } = claim;

  // Gate 1 — daily claim limit. Checked before anything else so a capped
  // account doesn't consume a NetSuite lookup for nothing.
  const claimsToday = await getClaimCountToday(accountNumber);
  if (claimsToday >= MAX_CLAIMS_PER_DAY) {
    return {
      outcome: 'escalate',
      details: { reason: 'Account has already submitted the maximum warranty claims allowed today.' },
    };
  }

  // Record this submission immediately so it counts toward today's cap
  // regardless of how it's ultimately decided.
  await recordClaimSubmission(accountNumber);

  // Gate 2 — Kathryn Land's accounts are always a human decision.
  const salesRep = await getSalesRep(accountNumber);
  if (salesRep === KATHRYN_LAND_REP_ID) {
    return {
      outcome: 'escalate',
      details: { reason: 'Account is managed by a sales rep who handles claims directly.' },
    };
  }

  // Gate 3 — locate the invoice (by invoice number or PO number, whichever
  // was given) and compute the real warranty window. Deliberately uses
  // NetSuite's own invoice date, never a customer-supplied one.
  const invoice = await findInvoice(accountNumber, { invoiceNumber, poNumber });

  if (!invoice) {
    return {
      outcome: 'escalate',
      details: { reason: 'Could not locate an invoice matching the number provided.' },
    };
  }

  if (invoice.ambiguous) {
    return {
      outcome: 'escalate',
      details: {
        reason: 'More than one invoice matches this PO number — needs a human to pick the right one.',
      },
    };
  }

  const monthsSincePurchase = monthsBetween(invoice.trandate, new Date());

  // Gate 4 — duplicate/volume gate: credited units must stay below purchased units.
  const [purchased, credited] = await Promise.all([
    getUnitsPurchased(accountNumber, sku),
    getUnitsCredited(accountNumber, sku),
  ]);

  if (credited >= purchased) {
    return {
      outcome: 'escalate',
      details: { reason: 'This item appears to already be fully credited on this account.' },
    };
  }

  // Gate 5 — outside the warranty window: offer, don't deny outright.
  if (monthsSincePurchase > WARRANTY_MONTHS) {
    return {
      outcome: 'offer',
      details: {
        reason: 'Purchase is outside the 30-month warranty window.',
        offer: '50% off wholesale price on a replacement frame',
      },
    };
  }

  // All gates clear — post the credit.
  const creditMemo = await createCreditMemo({ invoiceId: invoice.id, accountNumber, sku });

  return {
    outcome: 'approved',
    details: { creditMemoId: creditMemo.id, invoiceNumber: invoice.tranid, sku },
  };
}

function monthsBetween(start, end) {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

module.exports = { evaluateClaim };
