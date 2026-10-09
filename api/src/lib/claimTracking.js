const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'WarrantyClaims';
// Static Web Apps' Managed Functions model abstracts away its own internal
// storage account, so AzureWebJobsStorage isn't usable here the way it would
// be on a standalone Function App — this needs its own dedicated connection.
const connectionString = process.env.CLAIM_TRACKING_STORAGE_CONNECTION_STRING;

let tableClientPromise;

async function getTableClient() {
  if (!tableClientPromise) {
    tableClientPromise = (async () => {
      const client = TableClient.fromConnectionString(connectionString, TABLE_NAME);
      await client.createTable().catch((err) => {
        if (err.statusCode !== 409) throw err; // 409 = table already exists
      });
      return client;
    })();
  }
  return tableClientPromise;
}

function todayPartitionKey(accountNumber) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `${accountNumber}_${today}`;
}

async function getClaimCountToday(accountNumber) {
  const client = await getTableClient();
  const partitionKey = todayPartitionKey(accountNumber);
  let count = 0;
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${partitionKey}'` },
  });
  for await (const _ of entities) count++;
  return count;
}

async function recordClaimSubmission(accountNumber) {
  const client = await getTableClient();
  const partitionKey = todayPartitionKey(accountNumber);
  await client.createEntity({
    partitionKey,
    rowKey: `${Date.now()}`,
    submittedAt: new Date().toISOString(),
  });
}

module.exports = { getClaimCountToday, recordClaimSubmission };
