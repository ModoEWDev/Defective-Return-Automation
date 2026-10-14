const {
  findInvoicesByDocumentNumber,
  resolveAccountNumber,
  getInvoiceLineItems,
  getLastPaidPrice,
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
  const { documentNumber, styleName, color, productType, description } = claim;

  // Gate 0 — resolve whatever account number the customer actually typed
  // to the real one on file. Customers very commonly type only part of it
  // (dropping a letter prefix or everything before a dash), so this needs
  // to be resolved once, up front, and the resolved canonical number used
  // for every check from here on — including the daily cap, so a customer
  // typing their account number slightly differently each time doesn't
  // accidentally dodge or double-count against the limit.
  const resolvedAccount = await resolveAccountNumber(claim.accountNumber);
  if (!resolvedAccount) {
    return {
      outcome: 'invalid',
      details: { reason: "The account number can't be found. Please double-check it and submit the claim again." },
    };
  }
  if (resolvedAccount.ambiguous) {
    return {
      outcome: 'escalate',
      details: { reason: 'More than one account matches the number provided — needs a human to confirm which one.' },
    };
  }
  const accountNumber = resolvedAccount.entityid;

  // Gate 1 — daily claim limit. Checked before anything else so a capped
  // account doesn't consume a NetSuite lookup for nothing.
  const claimsToday = await getClaimCountToday(accountNumber);
  if (claimsToday >= MAX_CLAIMS_PER_DAY) {
    return {
      outcome: 'invalid',
      details: {
        reason:
          'This account has already submitted the maximum number of warranty claims allowed today. Please try again tomorrow, or contact your sales representative if you need to submit more right away.',
      },
    };
  }

  // Gate 2 — Kathryn Land's accounts are always a human decision.
  const salesRep = await getSalesRep(accountNumber);
  if (salesRep === KATHRYN_LAND_REP_ID) {
    return {
      outcome: 'invalid',
      details: {
        reason:
          'This account is managed by a sales representative. Please reach out to your sales representative directly to submit this claim.',
      },
    };
  }

  // Gate 3 — locate candidate invoice(s). Customers don't reliably know
  // whether what they're holding is an invoice number, a PO number, or a
  // Sales Order number, so one lookup tries all three. A single Sales
  // Order can legitimately cover more than one invoice (split shipments
  // are a normal, common pattern here) — rather than treating that as
  // ambiguous, every item across all of them gets gathered, and the
  // style/color the customer gave picks out the specific one.
  const candidateInvoices = await findInvoicesByDocumentNumber(accountNumber, documentNumber);

  if (candidateInvoices.ambiguous) {
    // A data-integrity oddity, not something the customer did wrong — a
    // different number typed correctly won't fix this.
    return {
      outcome: 'escalate',
      details: { reason: 'More than one invoice shares this number — needs a human to confirm which one.' },
    };
  }
  if (!candidateInvoices.length) {
    return {
      outcome: 'invalid',
      details: { reason: "That document number can't be found on your account. Please double-check it and submit the claim again." },
    };
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

  // If the customer picked a product type (Frame/Clip), narrow to only
  // items of that exact type first — this is the deterministic signal
  // that actually distinguishes a frame from its otherwise-identical
  // clip, and resolves the common case immediately without ever needing
  // style/color or Claude's judgment at all.
  const itemsToMatch = productType
    ? allItems.filter((item) => item.productType === productType)
    : allItems;

  if (productType && !itemsToMatch.length) {
    return {
      outcome: 'invalid',
      details: {
        reason: `No ${productType === 'CLIP' ? 'clip' : 'frame'} was found on this invoice matching that selection. Please double-check and submit your claim again.`,
      },
    };
  }

  // If there's only one item (after any product-type filtering) AND the
  // customer didn't type a style/color at all, that's unambiguously the
  // one — nothing to check. But if they DID provide something, even for a
  // single-item invoice, it still has to actually match — leaving the
  // field blank is fine (they may not know it), but typing in something
  // wrong should not be silently waved through.
  let resolvedItem;

  if (itemsToMatch.length === 1 && !styleName && !color) {
    resolvedItem = itemsToMatch[0];
  } else {
    const tokens = `${styleName || ''} ${color || ''}`
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    const matches = itemsToMatch.filter((item) => {
      const haystack = `${item.style} ${item.color}`.toLowerCase();
      return tokens.length > 0 && tokens.every((t) => haystack.includes(t));
    });

    if (matches.length === 1) {
      resolvedItem = matches[0];
    } else {
      // Zero or multiple literal matches — let Claude use judgment on
      // abbreviations/informal naming before giving up.
      const wasGenuinelyAmbiguous = matches.length > 1;
      resolvedItem = await matchItemWithClaude(itemsToMatch, styleName, color, description, context);

      if (!resolvedItem) {
        if (wasGenuinelyAmbiguous) {
          // More than one item shares the same style/color description —
          // typically a frame and its matching clip. Rather than
          // escalating, tell them exactly what to pick/add so they can
          // resolve it themselves on resubmission.
          return {
            outcome: 'invalid',
            details: {
              reason:
                "This invoice has both a frame and a matching clip, and it's not clear which one this claim is about. Please select Frame or Clip in the Product Type field (or specify it in the issue description) and submit your claim again. If both are defective, submit them as two separate claims using \"Add another claim,\" one for the frame and one for the clip.",
            },
          };
        }
        return {
          outcome: 'invalid',
          details: { reason: "The style/color entered can't be found on this invoice. Please double-check it and submit the claim again." },
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
      outcome: 'invalid',
      details: { reason: 'This item has already been credited on this account, so this claim can\'t be processed.' },
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

  // All gates clear — post the credit. Company policy credits the *last
  // paid price* of this exact SKU, which may differ from whatever this
  // particular referenced invoice shows if the account bought it more than
  // once at different prices over time.
  const lastPaidPrice = await getLastPaidPrice(accountNumber, sku);
  const creditMemo = await createCreditMemo({
    invoiceId: invoice.id,
    accountNumber,
    itemInternalId: resolvedItem.itemInternalId,
    amount: lastPaidPrice !== null ? lastPaidPrice : resolvedItem.amount,
  });

  // Only an actual approved credit counts toward the daily cap — a claim
  // that was invalid, escalated, or offered a discount instead never
  // consumed one of the account's 3 allowed claims today.
  await recordClaimSubmission(accountNumber);

  return {
    outcome: 'approved',
    details: { creditMemoId: creditMemo.id, invoiceNumber: invoice.tranid, sku },
  };
}

function monthsBetween(start, end) {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

module.exports = { evaluateClaim };
