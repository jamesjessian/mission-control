import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import crypto from 'crypto'

const sm = new SecretsManagerClient()
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient())
const TABLE = process.env.PLAYERS_TABLE
const SECRET_ARN = process.env.GCP_SECRET_ARN

// ── Game definitions ──────────────────────────────────

const GAMES = {
  waffle: {
    label: 'Waffle',
    sheetId: '1Gtx11n7hoLytdG6BhqrjkSLqULruO6GOpixsqNWFe5U',
    sheetName: 'Sheet1',
    dateCol: 1,
    playersCol: 14,
  },
  ows: {
    label: 'OneWordSearch',
    sheetId: '10pGHjeyePzK-1voTb8qIdWFjvQC0Bk-qbKumUZkfklY',
    sheetName: 'puzzles',
    dateCol: 1,
    playersCol: 13,
  },
  stackdown: {
    label: 'Stackdown',
    sheetId: '1xZKjLRuM7Jf6rXQKsK4Vwv0mEoV-GEx6fIwMYyNMwac',
    sheetName: 'Daily',
    dateCol: 1,
    playersCol: 2,
  },
  lettergrams: {
    label: 'Lettergrams',
    sheetId: '1zFKjKoGrUeCCrv8FWAO9EAvUAl9_eRDEOfOvf-y_2Ug',
    sheetName: 'Daily',
    dateCol: 1,
    playersCol: 2,
  },
}

// ── Helpers ───────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().split('T')[0]
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return toDateStr(d)
}

function dateRange(startDate, endDate) {
  const dates = []
  const current = new Date(startDate + 'T12:00:00Z')
  const end = new Date(endDate + 'T12:00:00Z')
  while (current <= end) {
    dates.push(toDateStr(current))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

// ── Google Auth (Service Account JWT) ─────────────────

let cachedServiceAccount = null
let cachedToken = null
let tokenExpiry = 0

async function getServiceAccount() {
  if (cachedServiceAccount) return cachedServiceAccount
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))
  cachedServiceAccount = JSON.parse(SecretString)
  return cachedServiceAccount
}

function base64url(buf) {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken

  const sa = await getServiceAccount()
  const now = Math.floor(Date.now() / 1000)

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }))

  const signingInput = `${header}.${payload}`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(signingInput)
  const signature = base64url(sign.sign(sa.private_key))

  const jwt = `${signingInput}.${signature}`

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant_type:jwt-bearer')}&assertion=${jwt}`,
  })

  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`)
  const data = await resp.json()
  cachedToken = data.access_token
  tokenExpiry = Date.now() + 55 * 60 * 1000
  return cachedToken
}

// ── Google Sheets API ─────────────────────────────────

async function fetchSheetRange(sheetId, range) {
  const token = await getAccessToken()
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) throw new Error(`Sheets API error: ${resp.status} for ${range}`)
  const data = await resp.json()
  return data.values || []
}

// Fetch player counts for a game for given date range
// Strategy: fetch the full date+players columns, filter to requested dates
async function fetchGamePlayers(gameKey, startDate, endDate) {
  const game = GAMES[gameKey]
  // Fetch date and players columns for the whole sheet
  // Use column letters: dateCol=1 -> B, playersCol varies
  const dateColLetter = String.fromCharCode(65 + game.dateCol) // B
  const playersColLetter = colToLetter(game.playersCol)

  // Fetch both columns — we need date (to filter) and players (the value)
  // Fetch a generous range — sheets data starts at row 2
  const range = `${game.sheetName}!${dateColLetter}2:${playersColLetter}`
  const rows = await fetchSheetRange(game.sheetId, range)

  const byDate = {}
  for (const row of rows) {
    const date = row[0] // date column (first in our range)
    const playersIdx = game.playersCol - game.dateCol
    const players = row[playersIdx]
    if (!date || !players) continue
    if (date >= startDate && date <= endDate) {
      byDate[date] = parseInt(String(players).replace(/,/g, '')) || 0
    }
  }

  return byDate
}

function colToLetter(idx) {
  let result = ''
  let n = idx
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26) - 1
  }
  return result
}

// ── DynamoDB Cache ────────────────────────────────────

async function getCachedDates(gameKey, dates) {
  const results = {}
  for (let i = 0; i < dates.length; i += 100) {
    const batch = dates.slice(i, i + 100)
    const { Responses } = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TABLE]: {
          Keys: batch.map(d => ({ pk: `PLAYERS#${gameKey}`, sk: d })),
        },
      },
    }))
    for (const item of (Responses?.[TABLE] || [])) {
      results[item.sk] = item.players
    }
  }
  return results
}

async function cacheDates(gameKey, dateMap) {
  const today = toDateStr(new Date())
  const entries = Object.entries(dateMap)
  for (let i = 0; i < entries.length; i += 25) {
    const batch = entries.slice(i, i + 25)
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE]: batch.map(([date, players]) => ({
          PutRequest: {
            Item: {
              pk: `PLAYERS#${gameKey}`,
              sk: date,
              players,
              cachedAt: Date.now(),
              ttl: Math.floor(Date.now() / 1000) + (
                date === today ? 1800 :
                date >= addDays(today, -2) ? 3600 :
                date >= addDays(today, -30) ? 604800 :
                2592000
              ),
            },
          },
        })),
      },
    }))
  }
}

async function getPlayersForDates(gameKey, dates) {
  if (!dates.length) return {}

  const cached = await getCachedDates(gameKey, dates)
  const uncached = dates.filter(d => !(d in cached))

  if (uncached.length > 0) {
    const sorted = [...uncached].sort()
    const startDate = sorted[0]
    const endDate = sorted[sorted.length - 1]

    const fetched = await fetchGamePlayers(gameKey, startDate, endDate)
    const toCache = {}
    for (const d of uncached) {
      const val = fetched[d] || 0
      cached[d] = val
      toCache[d] = val
    }
    cacheDates(gameKey, toCache).catch(() => {})
  }

  return cached
}

// ── Summarise ─────────────────────────────────────────

function summarise(dateMap, dates) {
  let total = 0
  const daily = []

  for (const d of dates) {
    const players = dateMap[d] || 0
    total += players
    daily.push({ date: d, players })
  }

  // Filter to only days with data for average calculation
  const withData = daily.filter(d => d.players > 0)
  const avg = withData.length ? Math.round(total / withData.length) : 0

  return {
    total,
    avg,
    days: dates.length,
    daysWithData: withData.length,
    daily,
  }
}

// ── Lambda Handler ────────────────────────────────────

export async function handler(event) {
  try {
    // ── Scheduled preload ─────────────────────────────
    if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') {
      console.log('Players cache preload triggered')
      const today = toDateStr(new Date())
      const yesterday = addDays(today, -1)
      const start90 = addDays(yesterday, -89)
      const prevStart90 = addDays(start90, -90)
      const allDates = dateRange(prevStart90, yesterday)

      for (const gameKey of Object.keys(GAMES)) {
        await getPlayersForDates(gameKey, allDates)
      }
      console.log(`Preloaded ${allDates.length} dates × ${Object.keys(GAMES).length} games`)
      return { statusCode: 200, body: JSON.stringify({ preloaded: true }) }
    }

    // ── HTTP request ──────────────────────────────────
    const params = event.queryStringParameters || {}
    const today = toDateStr(new Date())
    const days = Math.min(parseInt(params.days) || 7, 90)
    const yesterday = addDays(today, -1)
    const periodStart = addDays(yesterday, -(days - 1))
    const currentDates = dateRange(periodStart, yesterday)

    const prevEnd = addDays(periodStart, -1)
    const prevStart = addDays(prevEnd, -(days - 1))
    const prevDates = dateRange(prevStart, prevEnd)

    const allDates = [...new Set([...currentDates, ...prevDates])].sort()

    // Fetch all games in parallel
    const gameResults = {}
    await Promise.all(Object.keys(GAMES).map(async (gameKey) => {
      const allData = await getPlayersForDates(gameKey, allDates)
      const current = summarise(allData, currentDates)
      const previous = summarise(allData, prevDates)

      const change = current.total && previous.total
        ? Math.round((current.total - previous.total) / previous.total * 10000) / 100
        : null

      gameResults[gameKey] = {
        label: GAMES[gameKey].label,
        current: {
          ...current,
          startDate: periodStart,
          endDate: yesterday,
        },
        previous: {
          total: previous.total,
          avg: previous.avg,
          days: previous.days,
          daysWithData: previous.daysWithData,
          change,
        },
      }
    }))

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        days,
        startDate: periodStart,
        endDate: yesterday,
        games: gameResults,
      }),
    }
  } catch (err) {
    console.error('Players error:', err)
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to fetch player data' }),
    }
  }
}
