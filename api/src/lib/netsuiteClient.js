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
 * Looks up a single invoice directly by its own number. Returns null if
 * nothing matches, or { ambiguous: true } in the (unexpected) case of more
 * than one invoice sharing a number on the same account.
 */
async function findInvoiceByNumber(accountNumber, invoiceNumber) {
  const rows = await suiteQL(`
    SELECT id, tranid, trandate
    FROM transaction
    WHERE type = 'CustInvc'
      AND tranid = '${escapeSql(invoiceNumber)}'
      AND entity = (SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}')
  `);

  if (!rows.length) return null;
  if (rows.length > 1) return { ambiguous: true };

  return {
    id: rows[0].id,
    tranid: rows[0].tranid,
    trandate: new Date(rows[0].trandate),
  };
}

/**
 * Looks up every invoice tied to a PO number. "PO number" here is actually
 * the Sales Order's own header-level field (otherrefnum), not something
 * stored on the invoice directly. A single Sales Order can be billed as
 * more than one invoice (split shipments are a normal, common pattern here)
 * — so unlike an invoice-number lookup, this deliberately returns all of
 * them rather than treating more than one as ambiguous; the caller
 * disambiguates further using the item being claimed.
 */
async function findInvoicesForPO(accountNumber, poNumber) {
  const [salesOrder] = await suiteQL(`
    SELECT id
    FROM transaction
    WHERE type = 'SalesOrd'
      AND otherrefnum = '${escapeSql(poNumber)}'
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

  return rows.length ? rows[0].amount : null;
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
  findInvoiceByNumber,
  findInvoicesForPO,
  getInvoiceLineItems,
  getLastPaidPrice,
  getSalesRep,
  getUnitsPurchased,
  getUnitsCredited,
  createCreditMemo,
};
