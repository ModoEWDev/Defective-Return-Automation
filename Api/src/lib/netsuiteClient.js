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
  const identifierClause = invoiceNumber
    ? `tranid = '${escapeSql(invoiceNumber)}'`
    : `otherrefnum = '${escapeSql(poNumber)}'`;

  const rows = await suiteQL(`
    SELECT id, tranid, trandate
    FROM transaction
    WHERE type = 'CustInvc'
      AND ${identifierClause}
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
async function createCreditMemo({ invoiceId, accountNumber, sku }) {
  const token = await getAccessToken();

  const [itemRow] = await suiteQL(`
    SELECT id FROM item WHERE itemid = '${escapeSql(sku)}'
  `);
  const [customerRow] = await suiteQL(`
    SELECT id FROM customer WHERE entityid = '${escapeSql(accountNumber)}'
  `);

  if (!itemRow || !customerRow) {
    throw new Error(
      'Could not resolve item or customer internal IDs for credit memo creation.'
    );
  }

  const payload = {
    entity: { id: customerRow.id },
    createdFrom: { id: invoiceId },
    item: {
      items: [
        {
          item: { id: itemRow.id },
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
  getSalesRep,
  getUnitsPurchased,
  getUnitsCredited,
  createCreditMemo,
};
