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
 * Looks up the invoice by whichever identifier the customer actually gave —
 * their invoice number, or their PO number (NetSuite's "otherrefnum" field,
 * the standard place a customer's own purchase order reference is stored
 * on a transaction). Returns null if nothing matches, or an object with
 * ambiguous: true if a PO number matches more than one invoice, since we
 * can't safely guess which one the claim is about.
 */
async function findInvoice(accountNumber, { invoiceNumber, poNumber }) {
  let rows;

  if (invoiceNumber) {
    rows = await suiteQL(`
      SELECT id, tranid, trandate
      FROM transaction
      WHERE type = 'CustInvc'
        AND tranid = '${escapeSql(invoiceNumber)}'
        AND entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
    `);
  } else {
    // "PO number" here turns out to actually be the Sales Order's own
    // transaction number — the invoice doesn't carry a separate PO
    // reference field, it's linked back to the Sales Order it was
    // created from via "createdfrom."
    // The customer-facing "PO #" is NetSuite's own standard header-level
    // field on the Sales Order (otherrefnum) — not a custom field, and not
    // on the invoice itself. Two separate queries rather than a self-join
    // on "transaction" — joining that table to itself seems to trigger an
    // internal engine error regardless of which field is being filtered on.
    const [salesOrder] = await suiteQL(`
      SELECT id
      FROM transaction
      WHERE type = 'SalesOrd'
        AND otherrefnum = '${escapeSql(poNumber)}'
        AND entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
    `);

    if (!salesOrder) return null;

    // createdfrom isn't a real queryable column on "transaction" — NetSuite
    // tracks this relationship through a dedicated linking table instead.
    rows = await suiteQL(`
      SELECT t.id, t.tranid, t.trandate
      FROM previoustransactionlink pt
      JOIN transaction t ON t.id = pt.nextdoc
      WHERE pt.previousdoc = ${Number(salesOrder.id)}
        AND t.type = 'CustInvc'
    `);
  }

  if (!rows.length) return null;
  if (rows.length > 1) return { ambiguous: true };

  return {
    id: rows[0].id,
    tranid: rows[0].tranid,
    trandate: new Date(rows[0].trandate),
  };
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
async function createCreditMemo({ invoiceId, accountNumber, itemInternalId }) {
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
    item: {
      items: [
        {
          item: { id: itemInternalId },
          quantity: 1,
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
  findInvoice,
  getInvoiceLineItems,
  getSalesRep,
  getUnitsPurchased,
  getUnitsCredited,
  createCreditMemo,
};
