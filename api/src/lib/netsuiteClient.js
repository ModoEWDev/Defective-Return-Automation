const { getAccessToken } = require('./netsuiteAuth');

const BASE_URL = `https://${process.env.NETSUITE_ACCOUNT_ID}.suitetalk.api.netsuite.com`;

async function suiteQL(query) {
  const token = await getAccessToken();
  const response = await fetch(`${BASE_URL}/services/rest/query/v1/suiteql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'transient',
    },
    body: JSON.stringify({ q: query }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SuiteQL request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.items || [];
}

/**
 * Looks up invoice(s) from a single customer-provided "document number" —
 * customers generally don't know or care whether what they're holding is
 * an invoice number, a PO number, or a Sales Order number, so this tries
 * all three rather than asking them to classify it:
 *   1. A direct invoice number.
 *   2. A Sales Order's own number, or its PO# field (otherrefnum) — either
 *      way, every invoice that Sales Order was billed into is returned,
 *      since one order can legitimately become more than one invoice
 *      (split shipments are a normal, common pattern here).
 * Returns an array of invoices (possibly more than one, for the Sales
 * Order case), an empty array if nothing matched at all, or
 * { ambiguous: true } in the rare case of a duplicate invoice number.
 */
async function findInvoicesByDocumentNumber(accountNumber, documentNumber) {
  const invoiceRows = await suiteQL(`
    SELECT id, tranid, trandate
    FROM transaction
    WHERE type = 'CustInvc'
      AND tranid = '${escapeSql(documentNumber)}'
      AND entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
  `);

  if (invoiceRows.length === 1) {
    return [
      {
        id: invoiceRows[0].id,
        tranid: invoiceRows[0].tranid,
        trandate: new Date(invoiceRows[0].trandate),
      },
    ];
  }
  if (invoiceRows.length > 1) {
    return { ambiguous: true };
  }

  const [salesOrder] = await suiteQL(`
    SELECT id
    FROM transaction
    WHERE type = 'SalesOrd'
      AND (tranid = '${escapeSql(documentNumber)}' OR otherrefnum = '${escapeSql(documentNumber)}')
      AND entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
  `);

  if (!salesOrder) return [];

  // linkType must be filtered to 'OrdBill' specifically — the same invoice
  // can appear under more than one link type (e.g. 'OrdRvCom'), which would
  // otherwise produce duplicate rows for the same real invoice.
  const rows = await suiteQL(`
    SELECT t.id, t.tranid, t.trandate
    FROM previoustransactionlink pt
    JOIN transaction t ON t.id = pt.nextdoc
    WHERE pt.previousdoc = ${Number(salesOrder.id)}
      AND pt.linktype = 'OrdBill'
      AND t.type = 'CustInvc'
  `);

  return rows.map((row) => ({
    id: row.id,
    tranid: row.tranid,
    trandate: new Date(row.trandate),
  }));
}

/**
 * Resolves whatever account number the customer typed to the real one on
 * file. Customers commonly type only part of it — dropping a letter
 * prefix (PECAA709145 -> 709145) or everything before a dash
 * (703242-011120 -> 011120) — so if an exact match fails, this falls back
 * to matching accounts whose number *ends with* exactly the digits given.
 */
async function resolveAccountNumber(input) {
  const exact = await suiteQL(`
    SELECT entityid FROM customer WHERE entityid = '${escapeSql(input)}'
  `);
  if (exact.length === 1) return { entityid: exact[0].entityid };
  if (exact.length > 1) return { ambiguous: true };

  const digitsOnly = String(input).replace(/[^0-9]/g, '');
  if (!digitsOnly) return null;

  const suffixMatches = await suiteQL(`
    SELECT entityid FROM customer WHERE entityid LIKE '%${escapeSql(digitsOnly)}'
  `);

  if (suffixMatches.length === 1) return { entityid: suffixMatches[0].entityid };
  if (suffixMatches.length > 1) return { ambiguous: true };
  return null;
}

/**
 * The actual company policy: "credit the last paid price of the exact SKU"
 * — meaning the most recent invoice for this item on this account, which
 * may not be the same invoice the customer referenced to identify the
 * claim (they may have bought the same SKU more than once, at different
 * prices over time).
 */
async function getLastPaidPrice(accountNumber, sku) {
  const rows = await suiteQL(`
    SELECT ABS(tl.netamount) AS amount, t.trandate
    FROM transactionline tl
    JOIN transaction t ON t.id = tl.transaction
    JOIN item i ON i.id = tl.item
    WHERE t.type = 'CustInvc'
      AND t.entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
      AND i.itemid = '${escapeSql(sku)}'
    ORDER BY t.trandate DESC
  `);

  return rows.length ? Number(rows[0].amount) : null;
}

/**
 * Finds the standalone Frame or Clip item that corresponds to one part of
 * a combined "OPTICAL & CLIP SET" item — e.g. given the Set's own style
 * name and color ("DARK GREY/SPACE GREY - SET"), finds the standalone
 * Clip SKU ("DARK GREY/SPACE GREY - SUN CLIP") or Frame SKU ("DARK GREY/
 * SPACE GREY") sharing the same style and base color. Verified directly
 * against real items before building this: style name is consistent
 * across siblings, and the color field consistently shares the same base
 * text with only a suffix differing ("- SET", "- SUN CLIP", or nothing).
 */
async function findSiblingComponentSku(styleName, setColor, targetProductType) {
  // Strip the known combo-indicating suffix to get the shared base color.
  const baseColor = setColor.replace(/\s*-\s*SET$/i, '').trim();

  const [sibling] = await suiteQL(`
    SELECT i.id AS itemid, i.itemid AS sku
    FROM item i
    JOIN customlist_modo_product_type pt ON pt.id = i.custitem_modo_product_type
    WHERE i.custitem_modo_style_name = '${escapeSql(styleName)}'
      AND i.custitem_modo_color LIKE '${escapeSql(baseColor)}%'
      AND pt.name = '${escapeSql(targetProductType)}'
  `);

  if (!sibling) return null;
  return { itemInternalId: sibling.itemid, sku: sibling.sku };
}

/**
 * Fallback reference price when a component was never purchased on its
 * own (no real "last paid price" exists for it) — used only for crediting
 * just one part of a combo Set item. Price level 7 ("20% Discount")
 * was verified directly against real sold prices before relying on it:
 * confirmed to exactly match both a frame and clip component's actual
 * historical prices in a real decomposed example.
 */
async function getReferenceComponentPrice(itemInternalId, priceLevel = 7) {
  const [row] = await suiteQL(`
    SELECT unitprice FROM pricing
    WHERE item = ${Number(itemInternalId)} AND pricelevel = ${Number(priceLevel)} AND currency = 1
  `);
  return row ? Number(row.unitprice) : null;
}

async function getSalesRep(accountNumber) {
  const rows = await suiteQL(`
    SELECT salesrep
    FROM customer
    WHERE entityid = '${escapeSql(accountNumber)}'
  `);
  return rows.length ? String(rows[0].salesrep) : null;
}

async function getUnitsPurchased(accountNumber, sku) {
  const rows = await suiteQL(`
    SELECT SUM(ABS(tl.quantity)) AS units
    FROM transactionline tl
    JOIN transaction t ON t.id = tl.transaction
    JOIN item i ON i.id = tl.item
    WHERE t.type = 'CustInvc'
      AND t.entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
      AND i.itemid = '${escapeSql(sku)}'
  `);
  return rows.length ? Number(rows[0].units || 0) : 0;
}

async function getUnitsCredited(accountNumber, sku) {
  const rows = await suiteQL(`
    SELECT SUM(ABS(tl.quantity)) AS units
    FROM transactionline tl
    JOIN transaction t ON t.id = tl.transaction
    JOIN item i ON i.id = tl.item
    WHERE t.type = 'CustCred'
      AND t.entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
      AND i.itemid = '${escapeSql(sku)}'
  `);
  return rows.length ? Number(rows[0].units || 0) : 0;
}

/**
 * Returns the item lines on a given invoice (excluding the transaction's own
 * summary/header line), each with its internal ID, SKU code, and
 * description — used to match a customer's "style name + color" description
 * against an actual item when an invoice has more than one line.
 */
/**
 * Fetches line items directly from the invoice record (not via SuiteQL
 * search). custcol_modo_item_style isn't flagged as available for the
 * Search channel, which makes it invisible to SuiteQL — but reading the
 * record directly uses a different access path that isn't bound by that
 * same restriction.
 *
 * NOTE: this was built without the ability to test the exact shape NetSuite
 * returns for custom column fields on an expanded sublist — the field
 * paths below (line.custcol_modo_item_style, etc.) are the standard pattern,
 * but may need adjusting once tried against a real invoice.
 */
async function getInvoiceLineItems(invoiceId) {
  const token = await getAccessToken();
  const response = await fetch(
    `${BASE_URL}/services/rest/record/v1/invoice/${invoiceId}?expandSubResources=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Invoice record fetch failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const lines = data.item?.items || [];

  // custcol_modo_color (and its SPS fallback) are references to a related
  // "colour" record, not plain strings — NetSuite returns them as an object
  // with a refName holding the actual human-readable name (e.g. "GREEN
  // TORTOISE"), plus an id and a link. style, by contrast, genuinely is a
  // plain string already.
  const colorName = (field) => (field && typeof field === 'object' ? field.refName : field) || '';

  return lines
    .filter((line) => line.item && line.item.id)
    .map((line) => ({
      itemInternalId: line.item.id,
      sku: line.item.refName || '',
      description: '',
      style: line.custcol_modo_item_style || '',
      color: colorName(line.custcol_modo_color) || colorName(line.custcol_sps_productcolorcode),
      // A separate short code (e.g. "BLKG" for "Black Grey Gradient") —
      // customers sometimes type this instead of the full color name.
      colorCode: line.custcol_modo_colorcode || '',
      // Plain string directly on the line itself — "OPTICAL" for the frame,
      // "CLIP" for its separate magnetic sun clip. This is what actually
      // distinguishes a frame from its clip when they otherwise share
      // identical style and color.
      productType: line.custcol_modo_prod_type || '',
      // The actual historical price paid on this specific invoice line —
      // credits must match this exactly, never NetSuite's current default
      // pricing, which can drift from what the customer actually paid.
      amount: Math.abs(line.amount || 0),
    }));
}

/**
 * Creates the credit memo tied to the original invoice and customer.
 *
 * IMPORTANT — this payload shape is a reasonable starting point for NetSuite's
 * REST record API, but credit memo creation is the one step in this whole
 * system that actually moves money. Before this runs against production:
 *   - Confirm this payload against your account's actual credit memo form
 *     (required fields like class/department/location, tax schedule, etc.
 *     vary by NetSuite configuration and aren't guessable from outside).
 *   - Test it against the sandbox account first, on a real invoice/SKU pair,
 *     and check the resulting credit memo in the NetSuite UI before trusting it.
 */
async function createCreditMemo({ invoiceId, accountNumber, itemInternalId, amount }) {
  const token = await getAccessToken();

  const [customerRow] = await suiteQL(`
    SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}'
  `);

  if (!customerRow) {
    throw new Error('Could not resolve customer internal ID for credit memo creation.');
  }

  const payload = {
    entity: { id: customerRow.id },
    createdFrom: { id: invoiceId },
    // "createdFrom" copies header-level defaults from the source invoice,
    // including its shipping cost — explicitly zeroing it here prevents
    // the original shipment's shipping charge from silently riding along
    // on a credit meant only for one defective item.
    shippingCost: 0,
    item: {
      items: [
        {
          item: { id: itemInternalId },
          quantity: 1,
          // Explicitly forces this exact historical amount — without this,
          // NetSuite silently falls back to current default pricing, which
          // can differ from what the customer actually paid.
          amount,
        },
      ],
    },
  };

  const response = await fetch(`${BASE_URL}/services/rest/record/v1/creditMemo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Credit memo creation failed (${response.status}): ${text}`);
  }

  // NetSuite's record API returns the new record's URL in the Location header,
  // not in the response body.
  const location = response.headers.get('Location') || '';
  const id = location.split('/').pop();
  return { id };
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = {
  findInvoicesByDocumentNumber,
  resolveAccountNumber,
  getInvoiceLineItems,
  getLastPaidPrice,
  findSiblingComponentSku,
  getReferenceComponentPrice,
  getSalesRep,
  getUnitsPurchased,
  getUnitsCredited,
  createCreditMemo,
};
