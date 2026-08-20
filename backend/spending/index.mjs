import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'

const sm = new SecretsManagerClient()
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient())
const TABLE = process.env.SPENDING_TABLE
const SECRET_ARN = process.env.SPENDING_SECRET_ARN
const BASE_URL = process.env.BASE_URL // e.g. https://da4yrz16q56ep.cloudfront.net

// ── Credentials ───────────────────────────────────────

let cachedCreds = null

async function getCredentials() {
  if (cachedCreds) return cachedCreds
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))
  cachedCreds = JSON.parse(SecretString)
  return cachedCreds
}

// ── Token Storage ─────────────────────────────────────

async function getToken(provider) {
  const resp = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `TOKEN#${provider}`, sk: 'current' },
  }))
  return resp.Item || null
}

async function saveToken(provider, tokenData) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `TOKEN#${provider}`,
      sk: 'current',
      ...tokenData,
      updatedAt: Date.now(),
    },
  }))
}

async function deleteToken(provider) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: `TOKEN#${provider}`, sk: 'current' },
  }))
}

// ── Transaction Cache ─────────────────────────────────

async function cacheTransactions(provider, accountId, transactions) {
  // Store in batches — each item is a day's transactions for an account
  const byDate = {}
  for (const tx of transactions) {
    const date = (tx.created || tx.bookingDate || '').split('T')[0]
    if (!date) continue
    if (!byDate[date]) byDate[date] = []
    byDate[date].push(tx)
  }

  for (const [date, txs] of Object.entries(byDate)) {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `TX#${provider}#${accountId}`,
        sk: date,
        transactions: txs,
        cachedAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 86400, // 24h TTL
      },
    }))
  }
}

async function getCachedTransactions(provider, accountId, fromDate, toDate) {
  const resp = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': `TX#${provider}#${accountId}`,
      ':from': fromDate,
      ':to': toDate,
    },
  }))
  const txs = []
  for (const item of (resp.Items || [])) {
    txs.push(...(item.transactions || []))
  }
  return txs
}

// ── Monzo API ─────────────────────────────────────────

async function monzoRefreshToken(creds, token) {
  const resp = await fetch('https://api.monzo.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.monzo.clientId,
      client_secret: creds.monzo.clientSecret,
      refresh_token: token.refreshToken,
    }),
  })
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Monzo token refresh failed: ${resp.status} ${err}`)
  }
  const data = await resp.json()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    provider: 'monzo',
  }
}

async function monzoFetch(path, token) {
  const resp = await fetch(`https://api.monzo.com${path}`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  })
  if (resp.status === 401) throw new Error('MONZO_AUTH_EXPIRED')
  if (!resp.ok) throw new Error(`Monzo API error: ${resp.status}`)
  return resp.json()
}

async function getMonzoToken(creds) {
  const token = await getToken('monzo')
  if (!token) return null

  // Refresh if expired (with 5 min buffer)
  if (token.expiresAt && Date.now() > token.expiresAt - 300000) {
    try {
      const refreshed = await monzoRefreshToken(creds, token)
      await saveToken('monzo', refreshed)
      return refreshed
    } catch (err) {
      console.error('Failed to refresh Monzo token:', err.message)
      return null
    }
  }
  return token
}

// ── Normalise Transactions ────────────────────────────

function normaliseMonzoTx(tx) {
  return {
    id: tx.id,
    provider: 'monzo',
    accountId: tx.account_id,
    date: tx.created,
    amount: tx.amount / 100, // pence → pounds
    currency: tx.currency,
    description: tx.merchant?.name || tx.description || tx.counterparty?.name || 'Unknown',
    category: tx.category,
    merchant: tx.merchant?.name || null,
    notes: tx.notes || '',
    settled: tx.settled || '',
    declined: !!tx.decline_reason,
  }
}

// ── Route Handlers ────────────────────────────────────

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
}

function respond(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) }
}

// GET /api/spending/status — which providers are connected
async function handleStatus() {
  const monzo = await getToken('monzo')
  const enableBanking = await getToken('enablebanking')

  return respond(200, {
    providers: {
      monzo: {
        connected: !!monzo,
        expiresAt: monzo?.expiresAt || null,
      },
      enableBanking: {
        connected: !!enableBanking,
        accounts: enableBanking?.accounts || [],
      },
    },
  })
}

// GET /api/spending/auth/monzo — initiate OAuth
async function handleMonzoAuth() {
  const creds = await getCredentials()
  const redirectUri = `${BASE_URL}/api/spending/auth/monzo/callback`
  const state = crypto.randomUUID()

  // Store state for CSRF check
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: 'OAUTH_STATE',
      sk: state,
      createdAt: Date.now(),
      ttl: Math.floor(Date.now() / 1000) + 600, // 10 min
    },
  }))

  const url = new URL('https://auth.monzo.com/')
  url.searchParams.set('client_id', creds.monzo.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)

  return {
    statusCode: 302,
    headers: { Location: url.toString() },
    body: '',
  }
}

// GET /api/spending/auth/monzo/callback — exchange code for token
async function handleMonzoCallback(params) {
  const { code, state } = params

  // Verify state
  const stateItem = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'OAUTH_STATE', sk: state || '' },
  }))
  if (!stateItem.Item) {
    return respond(400, { error: 'Invalid OAuth state' })
  }
  // Clean up state
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'OAUTH_STATE', sk: state },
  }))

  const creds = await getCredentials()
  const redirectUri = `${BASE_URL}/api/spending/auth/monzo/callback`

  const resp = await fetch('https://api.monzo.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: creds.monzo.clientId,
      client_secret: creds.monzo.clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  })

  if (!resp.ok) {
    const err = await resp.text()
    console.error('Monzo token exchange failed:', err)
    return respond(400, { error: 'Failed to connect Monzo' })
  }

  const data = await resp.json()
  await saveToken('monzo', {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    provider: 'monzo',
  })

  // Redirect back to the app
  return {
    statusCode: 302,
    headers: { Location: `${BASE_URL}/#spending-connected` },
    body: '',
  }
}

// GET /api/spending/accounts — list accounts across providers
async function handleAccounts() {
  const creds = await getCredentials()
  const accounts = []

  // Monzo
  const monzoToken = await getMonzoToken(creds)
  if (monzoToken) {
    try {
      const data = await monzoFetch('/accounts?account_type=uk_retail', monzoToken)
      for (const acc of (data.accounts || [])) {
        const bal = await monzoFetch(`/balance?account_id=${acc.id}`, monzoToken)
        accounts.push({
          id: acc.id,
          provider: 'monzo',
          name: 'Monzo',
          type: acc.type,
          balance: bal.balance / 100,
          currency: bal.currency,
          spendToday: bal.spend_today / 100,
        })
      }
    } catch (err) {
      if (err.message === 'MONZO_AUTH_EXPIRED') {
        accounts.push({ provider: 'monzo', error: 'auth_expired' })
      } else {
        console.error('Monzo accounts error:', err.message)
      }
    }
  }

  return respond(200, { accounts })
}

// GET /api/spending/transactions?days=30&provider=monzo
async function handleTransactions(params) {
  const creds = await getCredentials()
  const days = Math.min(parseInt(params.days) || 30, 90)
  const providerFilter = params.provider || null

  const now = new Date()
  const from = new Date(now.getTime() - days * 86400000)
  const fromStr = from.toISOString()
  const allTxs = []

  // Monzo
  if (!providerFilter || providerFilter === 'monzo') {
    const monzoToken = await getMonzoToken(creds)
    if (monzoToken) {
      try {
        const accs = await monzoFetch('/accounts?account_type=uk_retail', monzoToken)
        for (const acc of (accs.accounts || [])) {
          const data = await monzoFetch(
            `/transactions?account_id=${acc.id}&since=${fromStr}&expand[]=merchant`,
            monzoToken
          )
          for (const tx of (data.transactions || [])) {
            if (!tx.decline_reason) {
              allTxs.push(normaliseMonzoTx(tx))
            }
          }
        }
      } catch (err) {
        if (err.message !== 'MONZO_AUTH_EXPIRED') {
          console.error('Monzo transactions error:', err.message)
        }
      }
    }
  }

  // Sort by date descending
  allTxs.sort((a, b) => b.date.localeCompare(a.date))

  // Compute spending summary
  const spending = {}
  let totalSpent = 0
  let totalIncome = 0

  for (const tx of allTxs) {
    if (tx.amount < 0) {
      totalSpent += Math.abs(tx.amount)
      const cat = tx.category || 'general'
      spending[cat] = (spending[cat] || 0) + Math.abs(tx.amount)
    } else {
      totalIncome += tx.amount
    }
  }

  // Round
  totalSpent = Math.round(totalSpent * 100) / 100
  totalIncome = Math.round(totalIncome * 100) / 100
  for (const cat in spending) {
    spending[cat] = Math.round(spending[cat] * 100) / 100
  }

  return respond(200, {
    days,
    transactions: allTxs,
    summary: {
      totalSpent,
      totalIncome,
      net: Math.round((totalIncome - totalSpent) * 100) / 100,
      byCategory: spending,
      avgDailySpend: days ? Math.round(totalSpent / days * 100) / 100 : 0,
    },
  })
}

// DELETE /api/spending/disconnect?provider=monzo
async function handleDisconnect(params) {
  const provider = params.provider
  if (!provider) return respond(400, { error: 'Missing provider' })
  await deleteToken(provider)
  return respond(200, { disconnected: provider })
}

// ── Lambda Handler ────────────────────────────────────

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod
  const path = event.requestContext?.http?.path || event.rawPath || event.path
  const params = event.queryStringParameters || {}

  try {
    // Route matching
    if (method === 'GET' && path.endsWith('/spending/status')) {
      return await handleStatus()
    }
    if (method === 'GET' && path.endsWith('/spending/auth/monzo/callback')) {
      return await handleMonzoCallback(params)
    }
    if (method === 'GET' && path.endsWith('/spending/auth/monzo')) {
      return await handleMonzoAuth()
    }
    if (method === 'GET' && path.endsWith('/spending/accounts')) {
      return await handleAccounts()
    }
    if (method === 'GET' && path.endsWith('/spending/transactions')) {
      return await handleTransactions(params)
    }
    if (method === 'DELETE' && path.endsWith('/spending/disconnect')) {
      return await handleDisconnect(params)
    }

    return respond(404, { error: 'Not found' })
  } catch (err) {
    console.error('Spending error:', err)
    return respond(500, { error: err.message || 'Internal error' })
  }
}
