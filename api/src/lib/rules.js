const {
  findInvoice,
  getInvoiceLineItems,
  getSalesRep,
  getUnitsPurchased,
  getUnitsCredited,
  createCreditMemo,
} = require('./netsuiteClient');
const { getClaimCountToday, recordClaimSubmission } = require('./claimTracking');
const { matchItemWithClaude } = require('./claude');

const WARRANTY_MONTHS = 30; // 2-year warranty + 6-month grace period
const KATHRYN_LAND_REP_ID = '396';
const MAX_CLAIMS_PER_DAY = 3;

async function evaluateClaim(claim, context) {
  const { invoiceNumber, poNumber, accountNumber, styleName, color } = claim;

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

  // Resolve which specific item on the invoice this claim is about. If the
  // invoice only has one line item, that's unambiguously the one — no
  // matching needed, and whatever the customer typed for style/color is
  // irrelevant. Otherwise, match on whatever words of style name + color
  // actually appear in that item's description or code; escalate rather
  // than guess if nothing matches, or if more than one item does.
  const lineItems = await getInvoiceLineItems(invoice.id);

  if (!lineItems.length) {
    return {
      outcome: 'escalate',
      details: { reason: 'Could not find any items on this invoice.' },
    };
  }

  let resolvedItem;

  if (lineItems.length === 1) {
    resolvedItem = lineItems[0];
  } else {
    const tokens = `${styleName || ''} ${color || ''}`
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    const matches = lineItems.filter((item) => {
      const haystack = `${item.style} ${item.color}`.toLowerCase();
      return tokens.length > 0 && tokens.every((t) => haystack.includes(t));
    });

    if (matches.length === 1) {
      resolvedItem = matches[0];
    } else {
      // Zero or multiple literal matches — let Claude use judgment on
      // abbreviations/informal naming before giving up and escalating.
      resolvedItem = await matchItemWithClaude(lineItems, styleName, color, context);

      if (!resolvedItem) {
        return {
          outcome: 'escalate',
          details: {
            reason:
              'Could not confidently match the style/color described to a specific item on this invoice — needs a human to confirm which one.',
            // TEMPORARY DEBUG — remove once field names are confirmed.
            debugLineItems: lineItems,
          },
        };
      }
    }
  }

  const sku = resolvedItem.sku;

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
  const creditMemo = await createCreditMemo({
    invoiceId: invoice.id,
    accountNumber,
    itemInternalId: resolvedItem.itemInternalId,
  });

  return {
    outcome: 'approved',
    details: { creditMemoId: creditMemo.id, invoiceNumber: invoice.tranid, sku },
  };
}

function monthsBetween(start, end) {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

module.exports = { evaluateClaim };
