const {
  findInvoiceByNumber,
  findInvoicesForPO,
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

  // Gate 3 — locate candidate invoice(s). An invoice number always points
  // to exactly one invoice. A PO number, though, can legitimately cover
  // more than one invoice — split shipments are a normal, common pattern
  // here — so rather than treating that as ambiguous, gather every item
  // across all of them and let the style/color the customer gave pick out
  // the specific one, the same way it would within a single invoice.
  let candidateInvoices;

  if (invoiceNumber) {
    const invoice = await findInvoiceByNumber(accountNumber, invoiceNumber);
    if (!invoice) {
      return {
        outcome: 'escalate',
        details: { reason: 'Could not locate an invoice matching the number provided.' },
      };
    }
    if (invoice.ambiguous) {
      return {
        outcome: 'escalate',
        details: { reason: 'More than one invoice shares this number — needs a human to confirm which one.' },
      };
    }
    candidateInvoices = [invoice];
  } else {
    candidateInvoices = await findInvoicesForPO(accountNumber, poNumber);
    if (!candidateInvoices.length) {
      return {
        outcome: 'escalate',
        details: { reason: 'Could not locate an invoice matching the number provided.' },
      };
    }
  }

  // Gather every line item across all candidate invoices, each tagged with
  // which invoice it actually belongs to, so whichever one matches carries
  // its own correct invoice/date with it.
  const itemLists = await Promise.all(
    candidateInvoices.map(async (invoice) => {
      const items = await getInvoiceLineItems(invoice.id);
      return items.map((item) => ({ ...item, invoice }));
    })
  );
  const allItems = itemLists.flat();

  if (!allItems.length) {
    return {
      outcome: 'escalate',
      details: { reason: 'Could not find any items on the invoice(s) for this claim.' },
    };
  }

  // If there's only one item total — whether that's one invoice with one
  // line, or several invoices that together only ever produced one item —
  // that's unambiguously the one, no matching needed.
  let resolvedItem;

  if (allItems.length === 1) {
    resolvedItem = allItems[0];
  } else {
    const tokens = `${styleName || ''} ${color || ''}`
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    const matches = allItems.filter((item) => {
      const haystack = `${item.style} ${item.color}`.toLowerCase();
      return tokens.length > 0 && tokens.every((t) => haystack.includes(t));
    });

    if (matches.length === 1) {
      resolvedItem = matches[0];
    } else {
      // Zero or multiple literal matches — let Claude use judgment on
      // abbreviations/informal naming before giving up and escalating.
      resolvedItem = await matchItemWithClaude(allItems, styleName, color, context);

      if (!resolvedItem) {
        return {
          outcome: 'escalate',
          details: {
            reason:
              'Could not confidently match the style/color described to a specific item — needs a human to confirm which one.',
          },
        };
      }
    }
  }

  const invoice = resolvedItem.invoice;
  const monthsSincePurchase = monthsBetween(invoice.trandate, new Date());
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
